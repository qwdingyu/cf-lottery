/**
 * 管理端抽奖路由
 *
 * 所有路由需要登录认证，数据按 tenant_id 隔离。
 * 活动 CRUD / 发布开奖 / 名单与导出等主闭环；
 * 奖品、租户运维、集成域由 setup* 子模块挂载。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { getEnv } from "../lib/platform";
import { lotteryDraws, prizes, prizeCodes, lotteryPrizeTiers, lotteryRosterMembers, lotteryInviteCodes, lotteryWinners, lotteryEntries, shareRecords, tenantMembers, users, tenants, activityOutcomes, platformMembers, activitySubmissions, externalConversions, systemConfig, emailAccessCodes, activityEvents } from "../db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
import {
  createDraw,
  publishDraw,
  pauseDraw,
  resumeDraw,
  cancelDraw,
  performDraw,
  getDraw,
  getDrawWinners,
  getEntries,
  getActivityOutcomes,
  getActivityEventSummary,
  getExternalConversionSummary,
  listExternalConversions,
  getTenantUsage,
  hashAccessPassword,
  defaultResultModeForActivity,
} from "../services/lottery-service";
import { ACTIVITY_TEMPLATES } from "../lib/activity-templates";
import { readSystemConfigMap } from "../lib/system-config-registry";
import { buildPublishCheck } from "../services/publish-check-service";
import { parseActivityConfig } from "../lib/activity-config";
import { setupPrizeRoutes } from "./admin-lottery-prizes";
import { setupTenantOpsRoutes } from "./admin-lottery-tenant-ops";
import { setupIntegrationRoutes } from "./admin-lottery-integrations";
import {
  requireTenantRouteCapability,
  recordTenantAudit,
  escapeLike,
  parseAdminPagination,
  decorateIdentityDisplay,
  csvEscape,
  validateProductLink,
  coerceEnum,
  normalizeOptionalPositiveInteger,
  defaultExperienceForActivity,
  isUniqueConstraintError,
} from "./admin-lottery-helpers";

export const adminLotteryRoute = new Hono<AppEnv>();

const ACTIVITY_KINDS = new Set(["lottery", "signup_chain", "reservation", "vote", "survey", "checkin", "waitlist", "approval", "claim"]);
const PARTICIPATION_MODES = new Set(["open", "roster", "password", "invite_code", "registered"]);
const EXPERIENCE_TYPES = new Set([
  "submit",
  "wheel",
  "slot",
  "scratch",
  "card",
  "list",
  "calendar",
  "form",
  "ballot",
  "quiz",
  "checkin",
  "queue",
  "reveal",
  "grid",
]);
const DRAW_TRIGGERS = new Set(["manual", "scheduled"]);
const RESULT_MODES = new Set([
  "manual",
  "scheduled",
  "instant",
  "ordered_assignment",
  "capacity_assignment",
  "vote_tally",
  "review_decision",
  "no_result",
]);
const ALLOCATION_POLICIES = new Set(["capacity", "waitlist", "fifo", "priority", "random", "weighted_random", "approval"]);

// 所有租户后台路由都必须同时满足：已登录 + 仍是当前租户成员 + 命中轻量能力门禁。
adminLotteryRoute.use("*", requireAuth, requireTenantMember(), requireTenantRouteCapability);

// 子模块路由在中间件之后注册，确保所有端点都覆盖认证与权限校验
setupPrizeRoutes(adminLotteryRoute);
setupTenantOpsRoutes(adminLotteryRoute);
setupIntegrationRoutes(adminLotteryRoute);

// ═════════════════════════════════════════════════════════
// 运营台概览
// ═════════════════════════════════════════════════════════

/** 运营台概览：活动统计 + 待处理事项 */
adminLotteryRoute.get("/dashboard", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const now = new Date().toISOString();
  const tenantUsage = await getTenantUsage(db, tenantId);

  // 活动状态统计
  const [openRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
  const [draftRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "draft")));
  const [drawnRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "drawn")));

  // 到期待开奖的定时活动
  const [dueRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
      sql`${lotteryDraws.drawAt} <= ${now}`,
    ));

  // 通知失败的中奖者
  const [failedNotifyRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryWinners)
    .where(and(
      eq(lotteryWinners.tenantId, tenantId),
      eq(lotteryWinners.notificationStatus, "failed"),
    ));

  // 营销 ROI 汇总（天数由 platform system_config.dashboard_roi_days 控制，默认 30 天）
  const [roiDaysCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "dashboard_roi_days")).limit(1);
  const roiDays = Math.max(1, Math.min(365, parseInt(roiDaysCfg?.value || "30", 10) || 30));
  const roiCutoff = new Date(Date.now() - roiDays * 86400000).toISOString();
  const [roiRow] = await db
    .select({
      totalConversions: sql<number>`COUNT(*)`,
      totalAmountCents: sql<number>`COALESCE(SUM(${externalConversions.amountCents}), 0)`,
    })
    .from(externalConversions)
    .where(and(
      eq(externalConversions.tenantId, tenantId),
      sql`${externalConversions.occurredAt} >= ${roiCutoff}`,
    ));

  // 按转化类型分组统计
  const conversionTypeRows = await db
    .select({
      conversionType: externalConversions.conversionType,
      count: sql<number>`COUNT(*)`,
      amountCents: sql<number>`COALESCE(SUM(${externalConversions.amountCents}), 0)`,
    })
    .from(externalConversions)
    .where(and(
      eq(externalConversions.tenantId, tenantId),
      sql`${externalConversions.occurredAt} >= ${roiCutoff}`,
    ))
    .groupBy(externalConversions.conversionType);

  return ok(c, {
    openCount: Number(openRow?.count || 0),
    draftCount: Number(draftRow?.count || 0),
    drawnCount: Number(drawnRow?.count || 0),
    dueCount: Number(dueRow?.count || 0),
    failedNotifyCount: Number(failedNotifyRow?.count || 0),
    plan: tenantUsage.plan,
    limits: tenantUsage.limits,
    usage: tenantUsage.usage,
    roi: {
      roiDays,
      totalConversions: Number(roiRow?.totalConversions || 0),
      totalAmountCents: Number(roiRow?.totalAmountCents || 0),
      byType: conversionTypeRows.map(r => ({
        type: r.conversionType,
        count: Number(r.count),
        amountCents: Number(r.amountCents),
      })),
    },
  });
});

// ═════════════════════════════════════════════════════════
// 当前用户
// ═════════════════════════════════════════════════════════

/** 获取当前用户信息（含租户信息和平台角色） */
adminLotteryRoute.get("/me", async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const tenantId = c.get("tenantId") as string;

  const [user] = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return fail(c, "用户不存在", 404);

  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  // 同时查询平台成员身份，前端根据 platformRole 决定是否展示平台后台入口。
  // 查一次主键即可，不消耗显著的 rows read。
  const [platformMember] = await db
    .select({ role: platformMembers.role, status: platformMembers.status })
    .from(platformMembers)
    .where(eq(platformMembers.userId, userId))
    .limit(1);

  // 查询用户的所有租户 membership（支持多租户切换）
  const memberships = await db
    .select({
      tenantId: tenantMembers.tenantId,
      role: tenantMembers.role,
      tenantName: tenants.name,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId));

  return ok(c, {
    user,
    tenant: tenant || { id: tenantId, name: "", plan: "free" },
    quota: await getTenantUsage(db, tenantId),
    platformRole: platformMember?.status === "active" ? platformMember.role : null,
    tenants: memberships.map((m) => ({
      id: m.tenantId,
      name: m.tenantName,
      role: m.role,
    })),
  });
});

// ═════════════════════════════════════════════════════════
// 奖品管理
// ═════════════════════════════════════════════════════════

/** 奖品列表 */
/** 活动列表（分页，支持状态筛选和搜索） */
adminLotteryRoute.get("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const status = c.req.query("status") || "";
  const query = c.req.query("query") || "";
  // 活动类型筛选（047 文档 🔴）：租户创建多种类型活动后可按类型查找
  const activityKind = c.req.query("activityKind") || "";
  // 时间范围筛选（047 文档 🟡）：createdFrom/createdTo 为 ISO 日期，按创建时间过滤
  const createdFrom = c.req.query("createdFrom") || "";
  const createdTo = c.req.query("createdTo") || "";

  const conditions: any[] = [eq(lotteryDraws.tenantId, tenantId)];
  if (status) conditions.push(eq(lotteryDraws.status, status));
  if (query) conditions.push(sql`${lotteryDraws.title} LIKE ${'%' + escapeLike(query) + '%'}`);
  if (activityKind) conditions.push(eq(lotteryDraws.activityKind, activityKind));
  if (createdFrom) conditions.push(sql`${lotteryDraws.createdAt} >= ${createdFrom}`);
  if (createdTo) conditions.push(sql`${lotteryDraws.createdAt} <= ${createdTo}`);

  const rows = await db
    .select()
    .from(lotteryDraws)
    .where(and(...conditions))
    .orderBy(desc(lotteryDraws.createdAt))
    .limit(limit)
    .offset(offset);

  // 查询总数
  const [totalRow] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(...conditions));

  // 并行查询参与人数
  const counts = await Promise.all(rows.map(async (d) => {
    const [r] = await db.select({ total: count() }).from(lotteryEntries).where(eq(lotteryEntries.drawId, d.id));
    return Number(r?.total ?? 0);
  }));
  const draws = rows.map((d, i) => ({ ...d, entryCount: counts[i]! }));

  return ok(c, { draws, total: Number(totalRow?.total ?? 0) });
});

/** 活动详情 */
adminLotteryRoute.get("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const draw = await getDraw(db, c.req.param("id"), tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  // 同时查询奖项配置（供编辑回填）
  const tiers = await db
    .select({
      id: lotteryPrizeTiers.id,
      prizeId: lotteryPrizeTiers.prizeId,
      tierName: lotteryPrizeTiers.tierName,
      winnerCount: lotteryPrizeTiers.winnerCount,
      sortOrder: lotteryPrizeTiers.sortOrder,
      prizeName: prizes.name,
      prizeType: prizes.prizeType,
    })
    .from(lotteryPrizeTiers)
    .leftJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.tenantId, tenantId)))
    .where(and(eq(lotteryPrizeTiers.drawId, draw.id), eq(lotteryPrizeTiers.tenantId, tenantId)))
    .orderBy(lotteryPrizeTiers.sortOrder);
  return ok(c, { draw, tiers });
});

/** 获取活动模板列表
 *
 * 返回预置活动模板列表，仅包含平台启用的活动类型对应的模板。
 * 每个模板包含：名称、描述、图标、分类、默认配置、创建提示。
 * 模板定义在 src/lib/activity-templates.ts 中维护。
 */
adminLotteryRoute.get("/templates", async (c) => {
  const db = getDb(c);
  const config = await readSystemConfigMap(db, ["enabled_activity_kinds", "enabled_participation_modes"]);
  const enabledKinds = (config["enabled_activity_kinds"] || "lottery,signup_chain,claim,survey").split(",").map(s => s.trim());
  const enabledParticipationModes = (config["enabled_participation_modes"] || "open,registered,roster,password,invite_code").split(",").map(s => s.trim());
  const filtered = ACTIVITY_TEMPLATES.filter(t => enabledKinds.includes(t.defaults.activityKind));
  return ok(c, { templates: filtered, enabledKinds, enabledParticipationModes });
});

/** 复制活动（复制配置，不包括参与数据）
 *
 * 复制完整活动配置到新活动，生成新的 public_slug。
 * 复制内容：标题、描述、活动类型、参与模式、体验类型、时间设置、密码、容量、奖品配置、导流配置。
 * 不复制：参与记录、中奖记录、审计日志、事件数据。
 * 新活动标题自动添加"（副本）"后缀，状态为 draft。
 */
adminLotteryRoute.post("/draws/:id/copy", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  // 复制活动配置，生成新的 public_slug（取 UUID 前 8 位，不可枚举）
  const newId = crypto.randomUUID();
  const newSlug = crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();

  // 插入新活动记录，复制源活动的全部配置字段
  await db.insert(lotteryDraws).values({
    id: newId,
    tenantId,
    publicSlug: newSlug,
    title: `${draw.title}（副本）`,  // 自动添加副本后缀，避免混淆
    description: draw.description,
    activityKind: draw.activityKind,
    participationMode: draw.participationMode,
    experienceType: draw.experienceType,
    drawTrigger: draw.drawTrigger,
    resultMode: draw.resultMode,
    allocationPolicy: draw.allocationPolicy,
    policyVersion: draw.policyVersion,
    startAt: draw.startAt,
    endAt: draw.endAt,
    drawAt: draw.drawAt,
    accessPassword: draw.accessPassword,
    maxParticipants: draw.maxParticipants,
    winnerCount: draw.winnerCount,
    showParticipantCount: draw.showParticipantCount,
    showWinnerCount: draw.showWinnerCount,
    showWinnerList: draw.showWinnerList,
    promotionConfig: draw.promotionConfig,
    activityConfig: draw.activityConfig,
    productLink: draw.productLink,  // 复制导流商品链接（参与后展示的 CTA）
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  // 复制奖项配置（抽奖活动）：复制 lottery_prize_tiers 到新活动
  if (draw.activityKind === "lottery") {
    const tiers = await db
      .select()
      .from(lotteryPrizeTiers)
      .where(and(eq(lotteryPrizeTiers.drawId, drawId), eq(lotteryPrizeTiers.tenantId, tenantId)));
    for (const tier of tiers) {
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(),
        tenantId,
        drawId: newId,
        prizeId: tier.prizeId,
        tierName: tier.tierName,
        winnerCount: tier.winnerCount,
        sortOrder: tier.sortOrder,
      });
    }
  }

  return ok(c, { id: newId, publicSlug: newSlug, title: `${draw.title}（副本）` });
});

/** 创建活动 */
adminLotteryRoute.post("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<any>();

  try {
    // 创建活动时校验 productLink
    if (body.productLink) {
      const err = validateProductLink(body.productLink);
      if (err) return fail(c, err, 400);
    }

    const activityKind = coerceEnum(body.activityKind, ACTIVITY_KINDS, "lottery");
    // 校验活动类型是否在平台启用列表中，同时读取运营侧配置的默认参数
    const config = await readSystemConfigMap(db, [
      "enabled_activity_kinds",
      "enabled_participation_modes",
      "draw_default_winner_count",
      "draw_max_participants",
      "draw_max_duration_days",
    ]);
    const enabledKinds = (config["enabled_activity_kinds"] || "lottery,signup_chain,claim,survey").split(",").map(s => s.trim());
    if (!enabledKinds.includes(activityKind)) {
      return fail(c, `活动类型 "${activityKind}" 当前未启用，请联系平台运营`, 400);
    }
    const participationMode = coerceEnum(body.participationMode, PARTICIPATION_MODES, "open");
    // 校验参与模式是否在平台启用列表中（L3 平台运营者配置）
    const enabledModes = (config["enabled_participation_modes"] || "open,registered,roster,password,invite_code").split(",").map(s => s.trim());
    if (!enabledModes.includes(participationMode)) {
      return fail(c, `参与模式 "${participationMode}" 当前未启用，请联系平台运营`, 400);
    }
    const drawTrigger = coerceEnum(body.drawTrigger, DRAW_TRIGGERS, "manual");

    // 运营者可通过系统配置控制活动创建的默认参数（闭环：L3 配置 → L2 生效）
    const defaultWinnerCount = parseInt(config["draw_default_winner_count"], 10) || 1;
    const systemMaxParticipants = parseInt(config["draw_max_participants"], 10) || undefined;
    const requestedMaxParticipants = normalizeOptionalPositiveInteger(body.maxParticipants, "参与人数上限");
    // 活动最长持续时间校验：防止运营者设置超长活动占用资源
    const maxDurationDays = parseInt(config["draw_max_duration_days"], 10) || 90;
    const startAt = String(body.startAt || "");
    const endAt = String(body.endAt || "");
    if (startAt && endAt) {
      const durationMs = new Date(endAt).getTime() - new Date(startAt).getTime();
      if (durationMs > maxDurationDays * 86400000) {
        return fail(c, `活动持续时间不能超过 ${maxDurationDays} 天`, 400);
      }
    }

    const { id, publicSlug } = await createDraw(db, tenantId, {
      title: String(body.title || ""),
      description: String(body.description || ""),
      activityKind,
      participationMode,
      experienceType: body.experienceType !== undefined
        ? coerceEnum(body.experienceType, EXPERIENCE_TYPES, defaultExperienceForActivity(activityKind, participationMode))
        : undefined,
      drawTrigger,
      resultMode: body.resultMode !== undefined
        ? coerceEnum(body.resultMode, RESULT_MODES, defaultResultModeForActivity(activityKind, drawTrigger))
        : undefined,
      allocationPolicy: body.allocationPolicy !== undefined
        ? coerceEnum(body.allocationPolicy, ALLOCATION_POLICIES, "capacity")
        : undefined,
      policyVersion: 1,
      startAt: String(body.startAt || ""),
      endAt: String(body.endAt || ""),
      drawAt: body.drawAt || undefined,
      accessPassword: String(body.accessPassword || ""),
      maxParticipants: requestedMaxParticipants ?? systemMaxParticipants,
      winnerCount: body.winnerCount !== undefined ? Number(body.winnerCount) : defaultWinnerCount,
      // 055a P1：模板 defaults 的展示开关可在创建时写入（createDraw 本就支持；此前路由未透传）
      ...(body.showParticipantCount !== undefined ? { showParticipantCount: body.showParticipantCount ? 1 : 0 } : {}),
      ...(body.showWinnerCount !== undefined ? { showWinnerCount: body.showWinnerCount ? 1 : 0 } : {}),
      ...(body.showWinnerList !== undefined ? { showWinnerList: body.showWinnerList ? 1 : 0 } : {}),
      productLink: body.productLink ? JSON.stringify(body.productLink) : "{}",
      promotionConfig: body.promotionConfig && typeof body.promotionConfig === "object" ? JSON.stringify(body.promotionConfig) : "{}",
      activityConfig: body.activityConfig !== undefined
        ? (typeof body.activityConfig === "string" ? body.activityConfig : JSON.stringify(body.activityConfig))
        : "{}",
    });
    await recordTenantAudit(c, "draw.create", "lottery_draw", id, { title: String(body.title || "") });
    return ok(c, { id, publicSlug });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "创建活动失败", 400);
  }
});

/** 编辑活动 */
adminLotteryRoute.patch("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<any>();

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "只有草稿状态的活动可以编辑", 400);

  // 校验时间顺序（如果一起修改了时间）
  const startAt = body.startAt ?? draw.startAt;
  const endAt = body.endAt ?? draw.endAt;
  const drawAt = body.drawAt ?? draw.drawAt;
  if (new Date(startAt) >= new Date(endAt)) {
    return fail(c, "参与开始时间必须早于结束时间", 400);
  }
  if (drawAt && new Date(endAt) >= new Date(drawAt)) {
    return fail(c, "开奖时间必须在参与结束后", 400);
  }

  // 编辑时校验 productLink
  if (body.productLink !== undefined) {
    const err = validateProductLink(body.productLink);
    if (err) return fail(c, err, 400);
  }

  let maxParticipantsUpdate: number | null | undefined;
  if (body.maxParticipants !== undefined) {
    try {
      maxParticipantsUpdate = body.maxParticipants === null || body.maxParticipants === ""
        ? null
        : normalizeOptionalPositiveInteger(body.maxParticipants, "参与人数上限");
    } catch (err) {
      return fail(c, err instanceof Error ? err.message : "参与人数上限无效", 400);
    }
  }

  if (maxParticipantsUpdate !== undefined && maxParticipantsUpdate !== null) {
    const quota = await getTenantUsage(db, tenantId);
    if (maxParticipantsUpdate > quota.limits.maxParticipantsPerActivity) {
      return fail(c, `当前套餐单活动最多允许 ${quota.limits.maxParticipantsPerActivity} 人参与，请降低名额或升级套餐`, 403);
    }
  }

  await db
    .update(lotteryDraws)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.activityKind !== undefined ? { activityKind: coerceEnum(body.activityKind, ACTIVITY_KINDS, "lottery") } : {}),
      ...(body.participationMode !== undefined ? { participationMode: coerceEnum(body.participationMode, PARTICIPATION_MODES, draw.participationMode) } : {}),
      ...(body.experienceType !== undefined ? { experienceType: coerceEnum(body.experienceType, EXPERIENCE_TYPES, draw.experienceType || defaultExperienceForActivity(draw.activityKind || "lottery", draw.participationMode)) } : {}),
      ...(body.drawTrigger !== undefined ? { drawTrigger: coerceEnum(body.drawTrigger, DRAW_TRIGGERS, draw.drawTrigger) } : {}),
      ...(body.resultMode !== undefined ? { resultMode: coerceEnum(body.resultMode, RESULT_MODES, draw.resultMode || draw.drawTrigger) } : {}),
      ...(body.allocationPolicy !== undefined ? { allocationPolicy: coerceEnum(body.allocationPolicy, ALLOCATION_POLICIES, draw.allocationPolicy || "capacity") } : {}),
      ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
      ...(body.drawAt !== undefined ? { drawAt: body.drawAt } : {}),
      ...(body.winnerCount !== undefined ? { winnerCount: Number(body.winnerCount) } : {}),
      ...(maxParticipantsUpdate !== undefined ? { maxParticipants: maxParticipantsUpdate } : {}),
      ...(body.accessPassword !== undefined ? { accessPassword: body.accessPassword ? await hashAccessPassword(String(body.accessPassword)) : "" } : {}),
      ...(body.showParticipantCount !== undefined ? { showParticipantCount: body.showParticipantCount ? 1 : 0 } : {}),
      ...(body.showWinnerCount !== undefined ? { showWinnerCount: body.showWinnerCount ? 1 : 0 } : {}),
      ...(body.showWinnerList !== undefined ? { showWinnerList: body.showWinnerList ? 1 : 0 } : {}),
      ...(body.productLink !== undefined ? { productLink: typeof body.productLink === "string" ? body.productLink : JSON.stringify(body.productLink) } : {}),
      ...(body.promotionConfig !== undefined ? { promotionConfig: typeof body.promotionConfig === "string" ? body.promotionConfig : JSON.stringify(body.promotionConfig) } : {}),
      ...(body.activityConfig !== undefined ? { activityConfig: typeof body.activityConfig === "string" ? body.activityConfig : JSON.stringify(body.activityConfig) } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

  return ok(c, { updated: true });
});

// ═════════════════════════════════════════════════════════
// 活动生命周期（状态机）
//
// 活动状态流转：
//   draft ──→ open ──→ drawing ──→ drawn
//               │                      ↑
//               ├──→ paused → open ────┘（恢复后可继续参与或开奖）
//               └──→ cancelled（终结态，不可恢复）
//
// 关键约束：
// - 只有 open 状态的活动可以参与（joinDraw 校验）
// - 只有 open 状态的活动可以开奖（performDraw CAS 原子锁）
// - paused 恢复后仍然是 open（参与者不受影响）
// ═════════════════════════════════════════════════════════

/** 发布活动（draft → open） */
adminLotteryRoute.post("/draws/:id/publish", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  try {
    const result = await publishDraw(db, tenantId, drawId);
    if (!result) return fail(c, "活动不存在或已发布", 400);
    await recordTenantAudit(c, "draw.publish", "lottery_draw", drawId);
    return ok(c, { status: "open" });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "发布失败", 400);
  }
});

/** 暂停活动（open → paused） */
adminLotteryRoute.post("/draws/:id/pause", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const result = await pauseDraw(db, tenantId, drawId);
  if (!result) return fail(c, "活动不存在或未开启", 400);
  await recordTenantAudit(c, "draw.pause", "lottery_draw", drawId);
  return ok(c, { status: "paused" });
});

/** 恢复活动（paused → open） */
adminLotteryRoute.post("/draws/:id/resume", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const result = await resumeDraw(db, tenantId, drawId);
  if (!result) return fail(c, "活动不存在或未暂停", 400);
  await recordTenantAudit(c, "draw.resume", "lottery_draw", drawId);
  return ok(c, { status: "open" });
});

/** 取消活动（draft/open/paused → cancelled） */
adminLotteryRoute.post("/draws/:id/cancel", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  try {
    const result = await cancelDraw(db, tenantId, drawId);
    if (!result) return fail(c, "活动不存在或无法取消", 400);
    await recordTenantAudit(c, "draw.cancel", "lottery_draw", drawId);
    return ok(c, { status: "cancelled" });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "取消失败", 400);
  }
});

/** 手动开奖 */
adminLotteryRoute.post("/draws/:id/draw", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const userId = c.get("userId") as string;
  const drawId = c.req.param("id");

  try {
    const draw = await getDraw(db, drawId, tenantId);
    if (!draw) return fail(c, "活动不存在", 404);
    if (draw.activityKind !== "lottery") {
      return fail(c, "该活动类型不需要开奖", 400);
    }
    const result = await performDraw(db, tenantId, drawId, userId, {
      resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
      emailFrom: getEnv(c, "EMAIL_FROM") || "",
    });
    return ok(c, result);
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "开奖失败", 400);
  }
});

/** 中奖名单 */
adminLotteryRoute.get("/draws/:id/winners", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getDrawWinners(db, c.req.param("id"), tenantId);
  // L2 可读性：user_id 身份（registered）解析为用户名(邮箱)，email 身份原样
  await decorateIdentityDisplay(db, rows);
  return ok(c, { winners: rows });
});

/** 候选池 */
adminLotteryRoute.get("/draws/:id/entries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getEntries(db, tenantId, c.req.param("id"));
  await decorateIdentityDisplay(db, rows);
  return ok(c, { entries: rows });
});

/** 审核申请：批准或拒绝（仅 approval 活动可用）
 *
 * 审核流程：
 * 1. 用户提交申请 → 创建 lottery_entry 参与记录
 * 2. 管理员审查 → 调用此 API 批准或拒绝
 * 3. 审批结果写入 activity_outcomes 表，outcomeType='review'
 * 4. 通过后可通过 Webhook 通知用户（需额外配置）
 *
 * 注意：审批结果一旦写入不可撤回，如需重新审核需重新提交申请。
 */
adminLotteryRoute.post("/draws/:id/review", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ entryId: string; decision: "approved" | "rejected"; reason?: string }>();
  if (!body.entryId || !body.decision) return fail(c, "请指定参与记录和审批结果", 400);

  // 校验活动存在且是审批类型
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "approval") return fail(c, "仅审核活动支持审批操作", 400);

  // 校验参与记录存在且属于该活动
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.id, body.entryId)))
    .limit(1);
  if (!entry) return fail(c, "参与记录不存在", 404);

  const now = new Date().toISOString();
  // 写入审批结果到 activity_outcomes 表
  // outcomeType='review' 区分于接龙的 'assignment'
  // status 记录审批结论：approved/rejected
  await db.insert(activityOutcomes).values({
    id: crypto.randomUUID(),
    tenantId,
    drawId,
    entryId: body.entryId,
    outcomeType: "review",          // 区分于接龙的 assignment
    status: body.decision,          // approved | rejected
    sequenceNo: 0,                  // 审批不涉及排序
    resultKey: body.decision,       // 与 status 一致，便于前端按 resultKey 筛选
    resultLabel: body.decision === "approved" ? "已通过" : "已拒绝",
    metadataJson: JSON.stringify({ reason: body.reason || "" }), // 审批理由存 metadata
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return ok(c, { reviewed: true, decision: body.decision });
});

/** 通用活动结果（接龙/预约/候补等非抽奖活动） */
adminLotteryRoute.get("/draws/:id/outcomes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  const rows = await getActivityOutcomes(db, tenantId, drawId);
  return ok(c, { outcomes: rows });
});

/** 候选池统计 */
adminLotteryRoute.get("/draws/:id/stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const [entryRow] = await db.select({ total: count() }).from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId));
  const entryCount = Number(entryRow?.total ?? 0);
  const events = await getActivityEventSummary(db, tenantId, drawId);
  const externalConversions = await getExternalConversionSummary(db, tenantId, drawId);
  return ok(c, { entryCount, events, externalConversions });
});

/** 活动事件汇总：导流漏斗基础事实，不代表外部成交 */
adminLotteryRoute.get("/draws/:id/events/summary", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  return ok(c, await getActivityEventSummary(db, tenantId, drawId));
});

/**
 * 活动提交记录（问卷答案/投票选项/资料领取 payload）。
 * 033 基线：所有玩法的动态表单数据统一走 activity_submissions 表。
 */
adminLotteryRoute.get("/draws/:id/submissions", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const { limit, offset } = parseAdminPagination(c, 50, 200);

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const [{ total: totalCount }] = await db
    .select({ total: count() })
    .from(activitySubmissions)
    .where(and(eq(activitySubmissions.tenantId, tenantId), eq(activitySubmissions.drawId, drawId)));

  const rows = await db
    .select()
    .from(activitySubmissions)
    .where(and(eq(activitySubmissions.tenantId, tenantId), eq(activitySubmissions.drawId, drawId)))
    .orderBy(desc(activitySubmissions.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { submissions: rows, total: Number(totalCount) });
});

/** 投票统计：按活动配置中的固定选项统计票数（仅 vote 活动可用）
 *
 * 投票参与者身份仍然是邮箱/手机号，不能再用 lottery_entries.identity_value 当选项统计。
 * 正式投票选择只允许来自 activity_config.options，并保存到 activity_submissions.payload_json.optionId。
 */
adminLotteryRoute.get("/draws/:id/tally", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  // 校验活动存在且是投票类型
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "vote") return fail(c, "仅投票活动支持票数统计", 400);

  const config = parseActivityConfig(draw.activityConfig);
  if (!config || config.kind !== "vote") return fail(c, "投票选项配置无效", 400);
  const optionIds = new Set(config.options.map((option) => option.id));

  // 管理后台统计是低频查询，允许数据库侧 GROUP BY；热路径提交不做此类聚合。
  const rows = await db
    .select({
      optionId: sql<string>`json_extract(${activitySubmissions.payloadJson}, '$.optionId')`,
      count: count(),
    })
    .from(activitySubmissions)
    .where(and(eq(activitySubmissions.tenantId, tenantId), eq(activitySubmissions.drawId, drawId)))
    .groupBy(sql`json_extract(${activitySubmissions.payloadJson}, '$.optionId')`)
    .orderBy(desc(count()));

  const tally = config.options.map((option) => {
    const row = rows.find((item) => String(item.optionId || "") === option.id);
    return {
      optionId: option.id,
      label: option.label,
      description: option.description,
      imageUrl: option.imageUrl,
      count: Number(row?.count || 0),
    };
  });
  const unknown = rows
    .filter((row) => row.optionId && !optionIds.has(String(row.optionId)))
    .map((row) => ({ optionId: String(row.optionId), count: Number(row.count || 0) }));

  return ok(c, { tally, unknown, total: tally.reduce((sum, row) => sum + row.count, 0) });
});

/** 外部转化回传列表：只展示外部系统显式回传的事实 */
adminLotteryRoute.get("/draws/:id/conversions", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const { limit, offset } = parseAdminPagination(c);

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const conversions = await listExternalConversions(db, tenantId, drawId, limit, offset);
  const summary = await getExternalConversionSummary(db, tenantId, drawId);
  return ok(c, { conversions, summary });
});

/** 导出 CSV
 *
 * 限制：单次导出最多 10,000 条参与记录，超出时提示用户缩小范围。
 * 10ms CPU 和 128MB 内存不适合一次性生成大文件，大活动应分批导出。
 * 安全：所有用户输入字段经 csvEscape 转义，防止公式注入。
 */
adminLotteryRoute.get("/draws/:id/export", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const MAX_EXPORT_ROWS = 10000;

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  // 先检查总参与人数，超出限制时提示
  const [exportCountRow] = await db.select({ total: count() }).from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId));
  const entryCount = Number(exportCountRow?.total ?? 0);
  if (entryCount > MAX_EXPORT_ROWS) {
    return fail(c, `参与人数超出单次导出上限（${MAX_EXPORT_ROWS}），请分批导出或联系平台运营`, 400);
  }

  const winners = await getDrawWinners(db, drawId, tenantId);
  const entries = await getEntries(db, tenantId, drawId, MAX_EXPORT_ROWS);
  const outcomes = draw.activityKind === "lottery" ? [] : await getActivityOutcomes(db, tenantId, drawId, MAX_EXPORT_ROWS);
  // L2 可读性：CSV 中的参与者/中奖者用可读身份（registered 用户显示用户名(邮箱)）
  await decorateIdentityDisplay(db, winners);
  await decorateIdentityDisplay(db, entries);

  // 构建 CSV 内容（所有用户输入经 csvEscape 转义）
  const lines: string[] = [
    "活动名称,状态,参与人数,中奖人数",
    `${csvEscape(draw.title)},${csvEscape(draw.status)},${entries.length},${draw.activityKind === "lottery" ? winners.length : outcomes.length}`,
    "",
    "参与者,参与时间",
    ...entries.map((e) => `${csvEscape((e as any).identityDisplay || e.identityValue)},${csvEscape(e.joinedAt)}`),
  ];

  if (draw.activityKind === "lottery") {
    lines.push("", "中奖者,中奖时间", ...winners.map((w) => `${csvEscape((w as any).identityDisplay || w.identityValue)},${csvEscape(w.drawnAt)}`));
  } else {
    lines.push(
      "",
      "参与记录ID,状态,参与顺序,名额序号,结果说明,确认时间",
      ...outcomes.map((o) => `${csvEscape(o.entryId)},${csvEscape(o.status)},${csvEscape(o.sequenceNo)},${csvEscape(o.assignmentNo ?? "")},${csvEscape(o.resultLabel)},${csvEscape(o.decidedAt || "")}`),
    );
  }

  return c.text(lines.join("\n"), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="draw-${drawId}.csv"`,
  });
});

/** 删除活动（仅草稿状态可删除） */
adminLotteryRoute.delete("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status === "open" || draw.status === "drawing") return fail(c, "进行中的活动不可删除，请先暂停或取消", 400);

  // ★ 级联删除子记录：先删子表，再删主表（FK 约束）
  await withDbTransaction(db, async (tx) => {
    await tx.delete(lotteryPrizeTiers).where(and(eq(lotteryPrizeTiers.drawId, drawId), eq(lotteryPrizeTiers.tenantId, tenantId)));
    await tx.delete(lotteryRosterMembers).where(and(eq(lotteryRosterMembers.drawId, drawId), eq(lotteryRosterMembers.tenantId, tenantId)));
    await tx.delete(lotteryInviteCodes).where(and(eq(lotteryInviteCodes.drawId, drawId), eq(lotteryInviteCodes.tenantId, tenantId)));
    await tx.delete(lotteryWinners).where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));
    await tx.delete(lotteryEntries).where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.tenantId, tenantId)));
    await tx.delete(activitySubmissions).where(and(eq(activitySubmissions.drawId, drawId), eq(activitySubmissions.tenantId, tenantId)));
    await tx.delete(activityEvents).where(and(eq(activityEvents.drawId, drawId), eq(activityEvents.tenantId, tenantId)));
    await tx.delete(activityOutcomes).where(and(eq(activityOutcomes.drawId, drawId), eq(activityOutcomes.tenantId, tenantId)));
    await tx.delete(shareRecords).where(and(eq(shareRecords.drawId, drawId), eq(shareRecords.tenantId, tenantId)));
    await tx.delete(emailAccessCodes).where(eq(emailAccessCodes.drawId, drawId));
    await tx.delete(lotteryDraws).where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
  });

  await recordTenantAudit(c, "draw.delete", "lottery_draw", drawId);
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// P0 运营工具：补发码 + 重发通知 + 发布前校验
// ═════════════════════════════════════════════════════════

/** 奖项配置：替换活动的整组奖项 */
adminLotteryRoute.post("/draws/:id/tiers", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{
    tiers: Array<{ prizeId: string; tierName?: string; winnerCount?: number; sortOrder?: number }>;
  }>();

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status, activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "lottery") return fail(c, "只有抽奖活动需要配置奖项", 400);
  if (draw.status !== "draft") return fail(c, "只有草稿状态的活动可以配置奖项", 400);
  if (!Array.isArray(body.tiers) || body.tiers.length === 0) return fail(c, "请至少配置一个奖项", 400);
  if (body.tiers.length > 10) return fail(c, "单个活动最多配置 10 个奖项", 400);

  const normalizedTiers: Array<{
    id: string;
    tenantId: string;
    drawId: string;
    prizeId: string;
    tierName: string;
    winnerCount: number;
    sortOrder: number;
  }> = [];
  const seenPrizeIds = new Set<string>();

  for (const [index, tier] of body.tiers.entries()) {
    const prizeId = String(tier.prizeId || "").trim();
    const tierName = String(tier.tierName || `奖项 ${index + 1}`).trim().slice(0, 50);
    const winnerCount = Number(tier.winnerCount ?? 1);
    const sortOrder = Number(tier.sortOrder ?? (index + 1) * 100);

    if (!prizeId) return fail(c, "奖项必须选择奖品", 400);
    if (seenPrizeIds.has(prizeId)) return fail(c, "同一奖品不能重复配置为多个奖项", 400);
    if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 1000) return fail(c, "中奖名额必须是 1-1000 的整数", 400);
    if (!Number.isFinite(sortOrder)) return fail(c, "奖项排序值无效", 400);

    const [prize] = await db
      .select({ id: prizes.id })
      .from(prizes)
      .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId), eq(prizes.active, 1)))
      .limit(1);
    if (!prize) return fail(c, "奖品不存在或已停用", 404);

    seenPrizeIds.add(prizeId);
    normalizedTiers.push({
      id: crypto.randomUUID(),
      tenantId,
      drawId,
      prizeId,
      tierName,
      winnerCount,
      sortOrder: Math.trunc(sortOrder),
    });
  }

  // 替换整组奖项比逐条增删改更适合轻量 SaaS：前端保存当前表格即可，避免复杂同步状态。
  await withDbTransaction(db, async (tx) => {
    await tx.delete(lotteryPrizeTiers).where(and(eq(lotteryPrizeTiers.drawId, drawId), eq(lotteryPrizeTiers.tenantId, tenantId)));
    await tx.insert(lotteryPrizeTiers).values(normalizedTiers);
  });

  return ok(c, { tiers: normalizedTiers });
});

/** 补发奖品码（中奖者无码时运营手动补发） */
adminLotteryRoute.post("/draws/:id/winners/:winnerId/retry-code", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [winner] = await db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.id, c.req.param("winnerId")), eq(lotteryWinners.tenantId, tenantId)))
    .limit(1);

  if (!winner) return fail(c, "中奖记录不存在", 404);
  if (winner.prizeCodeId) return fail(c, "已有奖品码，无需补发", 400);

  // 获取奖项配置，找到对应的奖品 ID
  const [tier] = await db
    .select({ prizeId: lotteryPrizeTiers.prizeId })
    .from(lotteryPrizeTiers)
    .where(eq(lotteryPrizeTiers.id, winner.tierId))
    .limit(1);

  if (!tier?.prizeId) return fail(c, "未配置奖品，无法补发", 400);

  // 原子锁码：从奖品码池中取一条 available 的记录
  const lockResult = await db
    .update(prizeCodes)
    .set({ status: "issued", winnerId: winner.entryId, issuedAt: new Date().toISOString() })
    .where(and(
      eq(prizeCodes.prizeId, tier.prizeId),
      eq(prizeCodes.status, "available"),
      eq(prizeCodes.tenantId, tenantId),
    ));

  if ((lockResult.rowsAffected ?? 0) === 0) {
    return fail(c, "奖品码库存不足", 400);
  }

  // 查询刚锁定的码
  const [lockedCode] = await db
    .select({ id: prizeCodes.id })
    .from(prizeCodes)
    .where(and(
      eq(prizeCodes.prizeId, tier.prizeId),
      eq(prizeCodes.winnerId, winner.entryId),
      eq(prizeCodes.tenantId, tenantId),
    ))
    .limit(1);

  // 更新中奖记录的 prize_code_id
  await db
    .update(lotteryWinners)
    .set({ prizeCodeId: lockedCode?.id || "" })
    .where(eq(lotteryWinners.id, winner.id));

  return ok(c, { prizeCodeId: lockedCode?.id || "" });
});

/** 重发中奖通知 */
adminLotteryRoute.post("/draws/:id/winners/:winnerId/resend", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [winner] = await db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.id, c.req.param("winnerId")), eq(lotteryWinners.tenantId, tenantId)))
    .limit(1);

  if (!winner) return fail(c, "中奖记录不存在", 404);

  // 重置通知状态
  await db
    .update(lotteryWinners)
    .set({ notificationStatus: "pending", notificationError: "" })
    .where(eq(lotteryWinners.id, winner.id));

  return ok(c, { retry: true });
});

/** 发布前校验 */
adminLotteryRoute.get("/draws/:id/publish-check", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const check = await buildPublishCheck(db, tenantId, drawId);
  if (!check) return fail(c, "活动不存在", 404);
  return ok(c, check);
});

/** 导入名单成员（roster 模式） */
adminLotteryRoute.post("/draws/:id/roster", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ members: Array<{ email: string; name?: string }> }>();

  if (!body.members || body.members.length === 0) {
    return fail(c, "请提供至少一个成员", 400);
  }

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "仅草稿状态的活动可导入名单", 400);

  let imported = 0;
  let skipped = 0;
  for (const m of body.members) {
    try {
      await db.insert(lotteryRosterMembers).values({
        id: crypto.randomUUID(),
        tenantId,
        drawId,
        identityValue: m.email.trim().toLowerCase(),
        displayName: m.name || "",
      });
      imported++;
    } catch (err) {
      // 只把唯一索引冲突视为“重复名单”跳过；数据库锁、字段缺失等真实故障不能静默吞掉。
      if (!isUniqueConstraintError(err)) throw err;
      skipped++;
    }
  }

  return ok(c, { imported, skipped });
});

/** 生成邀请码（invite_code 模式） */
adminLotteryRoute.post("/draws/:id/invite-codes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ count?: number; maxUses?: number }>();

  const count = clampInteger(body.count, 10, 1, 1000);
  const maxUses = clampInteger(body.maxUses, 1, 1, 1000);

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "仅草稿状态的活动可生成邀请码", 400);

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomUUID().slice(0, 8).toUpperCase();
    await db.insert(lotteryInviteCodes).values({
      id: crypto.randomUUID(),
      tenantId,
      drawId,
      code,
      maxUses,
    });
    codes.push(code);
  }

  return ok(c, { codes, count: codes.length });
});

// ═════════════════════════════════════════════════════════
// 接龙模式：参与列表
// ═════════════════════════════════════════════════════════

/** 接龙参与列表（按参与时间排序） */
adminLotteryRoute.get("/draws/:id/signup-list", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "signup_chain") return fail(c, "该活动不是接龙模式", 400);

  const entries = await db
    .select({
      id: lotteryEntries.id,
      identityType: lotteryEntries.identityType,
      identityValue: lotteryEntries.identityValue,
      joinedAt: lotteryEntries.joinedAt,
    })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId)))
    .orderBy(lotteryEntries.joinedAt);

  // L2 可读性：registered（user_id 身份）解析为用户名(邮箱)
  await decorateIdentityDisplay(db, entries);

  return ok(c, { entries, total: entries.length });
});

