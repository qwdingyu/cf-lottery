/**
 * 管理端抽奖路由
 *
 * 所有路由需要登录认证，数据按 tenant_id 隔离。
 * 使用 lottery-service 处理核心业务逻辑。
 */
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { lotteryDraws, prizes, prizeCodes, lotteryPrizeTiers, lotteryRosterMembers, lotteryInviteCodes, lotteryWinners, lotteryEntries, lotteryBlacklist, apiKeys, webhookConfigs, couponCodes, shareRecords, redemptionCodes, redemptionRecords, auditLogs, tenantMembers, users, tenants, activityOutcomes, platformMembers, activitySubmissions, externalConversions } from "../db/schema";
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
  getDrawEntriesCount,
  getActivityOutcomes,
  getActivityEventSummary,
  getExternalConversionSummary,
  listExternalConversions,
  getTenantUsage,
  hashAccessPassword,
  createWebhookSigningSecret,
  listWebhookDeliveries,
  dispatchWebhookDelivery,
  processPendingWebhookDeliveries,
  createPrize,
  importPrizeCodes,
  defaultResultModeForActivity,
  hashApiKey,
} from "../services/lottery-service";
import { ACTIVITY_TEMPLATES } from "../lib/activity-templates";
import { readSystemConfigMap } from "../lib/system-config-registry";
import { buildPublishCheck } from "../services/publish-check-service";
import { parseActivityConfig } from "../lib/activity-config";

export const adminLotteryRoute = new Hono<AppEnv>();

const ACTIVITY_KINDS = new Set(["lottery", "signup_chain", "reservation", "vote", "survey", "checkin", "waitlist", "approval", "claim"]);
const PARTICIPATION_MODES = new Set(["open", "roster", "password", "invite_code"]);
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
const TENANT_MEMBER_ROLES = new Set(["owner", "admin", "viewer"]);

/**
 * 租户后台能力门禁。
 *
 * 这不是完整 RBAC，也不查数据库权限矩阵；只按 026 基线做路由级能力判断：
 * - GET/HEAD 是租户只读后台能力，owner/admin/viewer 都可访问。
 * - 成员变更会影响租户安全边界，只允许 owner。
 * - 其他写操作只允许 owner/admin。
 *
 * 这样每个 /api/admin/* 请求只多一次 tenant_members 组合索引查询，
 * 避免把权限判断散落到每个业务处理器里，也不会引入重型权限系统。
 */
async function requireTenantRouteCapability(c: Context<AppEnv>, next: Next) {
  const role = c.get("tenantRole");
  const method = c.req.method.toUpperCase();
  const path = new URL(c.req.url).pathname;

  if (method === "GET" || method === "HEAD") {
    await next();
    return;
  }

  if (path.includes("/members") && role !== "owner") {
    return fail(c, "只有租户 owner 可以管理团队成员", 403);
  }

  if (role !== "owner" && role !== "admin") {
    return fail(c, "权限不足", 403);
  }

  await next();
}

function parseTenantMemberRole(value: unknown, fallback = "admin"): string | null {
  const role = String(value ?? fallback).trim();
  return TENANT_MEMBER_ROLES.has(role) ? role : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  const err = error as { message?: unknown; code?: unknown; cause?: { message?: unknown } };
  const message = [err.code, err.message, err.cause?.message].filter(Boolean).join(" ");
  return message.includes("UNIQUE constraint failed");
}

/**
 * 租户侧审计日志写入（L2 敏感操作统一留痕）。
 *
 * 为什么需要：租户管理员（owner/admin）的创建/发布/删除/核销等操作会影响业务数据，
 * 必须可追溯"谁在什么时候做了什么"，支持排障和责任认定。
 * 与平台审计（platform_audit_logs）分开：租户审计只记录本租户内的操作。
 */
async function recordTenantAudit(
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await getDb(c).insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId: c.get("tenantId") as string,
      actorUserId: c.get("userId") as string,
      action,
      targetType,
      targetId,
      metadataJson: JSON.stringify(metadata || {}),
    });
  } catch (err) {
    // 审计失败不影响主业务（审计是尽力而为的留痕，不阻塞操作）
    console.error("[admin] audit write failed:", err);
  }
}

/**
 * 管理端列表统一分页边界。
 *
 * 为什么要集中处理：
 * - `Number("bad")` 会得到 NaN，继续传给 Drizzle 的 limit/offset 可能触发运行时错误。
 * - Cloudflare Workers Free 更怕无边界查询导致响应变慢，Turso 也会增加 rows read。
 * - 后台低频列表可以保留 COUNT/分页，但 limit/offset 必须有默认值和上限。
 */

/** 转义 LIKE 通配符，防止用户输入 % 和 _ 导致全表扫描 DoS */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function parseAdminPagination(c: Context<AppEnv>, fallbackLimit = 50, maxLimit = 200) {
  return {
    limit: clampInteger(c.req.query("limit"), fallbackLimit, 1, maxLimit),
    offset: clampInteger(c.req.query("offset"), 0, 0, 100_000),
  };
}

// 所有租户后台路由都必须同时满足：已登录 + 仍是当前租户成员 + 命中轻量能力门禁。
adminLotteryRoute.use("*", requireAuth, requireTenantMember(), requireTenantRouteCapability);

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

  // 营销 ROI 汇总（近 30 天外部转化数据）
  const roiCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
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

  return ok(c, {
    user,
    tenant: tenant || { id: tenantId, name: "", plan: "free" },
    quota: await getTenantUsage(db, tenantId),
    platformRole: platformMember?.status === "active" ? platformMember.role : null,
  });
});

// ═════════════════════════════════════════════════════════
// 奖品管理
// ═════════════════════════════════════════════════════════

/** 奖品列表 */
adminLotteryRoute.get("/prizes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(prizes)
    .where(eq(prizes.tenantId, tenantId))
    .orderBy(desc(prizes.createdAt));
  return ok(c, { prizes: rows });
});

/** 创建奖品 */
adminLotteryRoute.post("/prizes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ name: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string }>();
  try {
    const { id } = await createPrize(db, tenantId, body);
    return ok(c, { id });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "创建奖品失败", 400);
  }
});

/** 编辑奖品 */
adminLotteryRoute.patch("/prizes/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string; active?: number }>();

  const [existing] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!existing) return fail(c, "奖品不存在", 404);
  if (body.name !== undefined && !String(body.name).trim()) return fail(c, "奖品名称不能为空", 400);

  await db
    .update(prizes)
    .set({
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(body.description !== undefined ? { description: String(body.description).trim() } : {}),
      ...(body.prizeType !== undefined ? { prizeType: body.prizeType } : {}),
      ...(body.imageUrl !== undefined ? { imageUrl: String(body.imageUrl).trim() } : {}),
      ...(body.valueText !== undefined ? { valueText: String(body.valueText).trim() } : {}),
      ...(body.active !== undefined ? { active: body.active ? 1 : 0 } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)));

  return ok(c, { updated: true });
});

/** 导入奖品码 */
adminLotteryRoute.post("/prizes/:id/codes/import", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ codes: Array<{ code: string; secret?: string }> }>();

  if (!body.codes || body.codes.length === 0) {
    return fail(c, "请提供至少一个码", 400);
  }

  await importPrizeCodes(db, tenantId, prizeId, body.codes);
  return ok(c, { imported: body.codes.length });
});

/**
 * 自动生成奖品卡密。
 *
 * 使用 crypto.getRandomValues() 生成抗猜测的唯一码。
 * 字符集排除易混淆字符（0/O/1/I/l），降低运营者人工核对成本。
 */
adminLotteryRoute.post("/prizes/:id/codes/generate", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ count?: number; prefix?: string; codeLength?: number; secretLength?: number }>();

  const count = Math.min(Math.max(Number(body.count) || 10, 1), 1000);
  const prefix = String(body.prefix || "").slice(0, 20);
  const codeLen = Math.min(Math.max(Number(body.codeLength) || 8, 4), 32);
  const secretLen = Math.min(Math.max(Number(body.secretLength) || 0, 0), 32);

  // 排除易混淆字符：0/O、1/I/l
  const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const randomBytes = new Uint8Array(Math.max(codeLen, secretLen) * count);
  crypto.getRandomValues(randomBytes);

  const codes: Array<{ code: string; secret: string }> = [];
  let byteIdx = 0;
  for (let i = 0; i < count; i++) {
    let code = "";
    for (let j = 0; j < codeLen; j++) {
      code += CHARS[randomBytes[byteIdx++]! % CHARS.length]!;
    }
    const fullCode = prefix ? `${prefix}${code}` : code;
    let secret = "";
    for (let j = 0; j < secretLen; j++) {
      secret += CHARS[randomBytes[byteIdx++]! % CHARS.length]!;
    }
    codes.push({ code: fullCode, secret });
  }

  await importPrizeCodes(db, tenantId, prizeId, codes);
  await recordTenantAudit(c, "prize.codes.generate", "prize", prizeId, { count });
  return ok(c, { generated: count });
});

// ═════════════════════════════════════════════════════════
// 活动管理
// ═════════════════════════════════════════════════════════

/** 活动列表（分页，支持状态筛选和搜索） */
adminLotteryRoute.get("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const status = c.req.query("status") || "";
  const query = c.req.query("query") || "";

  const conditions: any[] = [eq(lotteryDraws.tenantId, tenantId)];
  if (status) conditions.push(eq(lotteryDraws.status, status));
  if (query) conditions.push(sql`${lotteryDraws.title} LIKE ${'%' + escapeLike(query) + '%'}`);

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

  return ok(c, { draws: rows, total: Number(totalRow?.total ?? 0) });
});

/** 活动详情 */
adminLotteryRoute.get("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const draw = await getDraw(db, c.req.param("id"), tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  return ok(c, { draw });
});

/** 获取活动模板列表
 *
 * 返回预置活动模板列表，仅包含平台启用的活动类型对应的模板。
 * 每个模板包含：名称、描述、图标、分类、默认配置、创建提示。
 * 模板定义在 src/lib/activity-templates.ts 中维护。
 */
adminLotteryRoute.get("/templates", async (c) => {
  const db = getDb(c);
  const config = await readSystemConfigMap(db, ["enabled_activity_kinds"]);
  const enabledKinds = (config["enabled_activity_kinds"] || "lottery,signup_chain,claim,survey").split(",").map(s => s.trim());
  const filtered = ACTIVITY_TEMPLATES.filter(t => enabledKinds.includes(t.defaults.activityKind));
  return ok(c, { templates: filtered });
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
      "draw_default_winner_count",
      "draw_max_participants",
      "draw_max_duration_days",
    ]);
    const enabledKinds = (config["enabled_activity_kinds"] || "lottery,signup_chain,claim,survey").split(",").map(s => s.trim());
    if (!enabledKinds.includes(activityKind)) {
      return fail(c, `活动类型 "${activityKind}" 当前未启用，请联系平台运营`, 400);
    }
    const participationMode = coerceEnum(body.participationMode, PARTICIPATION_MODES, "open");
    const drawTrigger = coerceEnum(body.drawTrigger, DRAW_TRIGGERS, "manual");

    // 运营者可通过系统配置控制活动创建的默认参数（闭环：L3 配置 → L2 生效）
    const defaultWinnerCount = parseInt(config["draw_default_winner_count"], 10) || 1;
    const systemMaxParticipants = parseInt(config["draw_max_participants"], 10) || undefined;
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
      maxParticipants: body.maxParticipants !== undefined ? Number(body.maxParticipants) : systemMaxParticipants,
      winnerCount: body.winnerCount !== undefined ? Number(body.winnerCount) : defaultWinnerCount,
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

  if (body.maxParticipants !== undefined && body.maxParticipants !== null) {
    const maxParticipants = Number(body.maxParticipants);
    const quota = await getTenantUsage(db, tenantId);
    if (maxParticipants > quota.limits.maxParticipantsPerActivity) {
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
      ...(body.maxParticipants !== undefined ? { maxParticipants: body.maxParticipants ? Number(body.maxParticipants) : null } : {}),
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
      resendApiKey: c.env.RESEND_API_KEY || "",
      emailFrom: c.env.EMAIL_FROM || "",
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
  return ok(c, { winners: rows });
});

/** 候选池 */
adminLotteryRoute.get("/draws/:id/entries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getEntries(db, tenantId, c.req.param("id"));
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

  const entryCount = await getDrawEntriesCount(db, drawId, tenantId);
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

/**
 * CSV 字段转义（防公式注入 + 结构破坏）。
 *
 * 为什么需要：
 * 1. 公式注入：Excel/Sheets 会把以 = + - @ 开头的单元格当公式执行。
 *    恶意参与者可注入 `=HYPERLINK(...)`，运营者打开导出文件时触发。
 * 2. 结构破坏：字段含逗号/引号/换行时，不转义会破坏 CSV 行结构。
 *
 * 处理：危险前缀加 ' 阻止公式；特殊字符字段用双引号包裹（内部引号加倍）。
 *
 * 注意：前端 AdminLotteryView.vue 的 downloadCsv 有相同逻辑（客户端导出），
 * 修改此处时必须同步修改前端版本，保持一致（跨运行环境不强行共享）。
 */
function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  let out = raw;
  if (/^[=+\-@]/.test(out)) {
    out = "'" + out;
  }
  if (/[",\n\r]/.test(out)) {
    out = '"' + out.replace(/"/g, '""') + '"';
  }
  return out;
}

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
  const entryCount = await getDrawEntriesCount(db, drawId, tenantId);
  if (entryCount > MAX_EXPORT_ROWS) {
    return fail(c, `参与人数超出单次导出上限（${MAX_EXPORT_ROWS}），请分批导出或联系平台运营`, 400);
  }

  const winners = await getDrawWinners(db, drawId, tenantId);
  const entries = await getEntries(db, tenantId, drawId, MAX_EXPORT_ROWS);
  const outcomes = draw.activityKind === "lottery" ? [] : await getActivityOutcomes(db, tenantId, drawId, MAX_EXPORT_ROWS);

  // 构建 CSV 内容（所有用户输入经 csvEscape 转义）
  const lines: string[] = [
    "活动名称,状态,参与人数,中奖人数",
    `${csvEscape(draw.title)},${csvEscape(draw.status)},${entries.length},${draw.activityKind === "lottery" ? winners.length : outcomes.length}`,
    "",
    "参与者邮箱,参与时间",
    ...entries.map((e) => `${csvEscape(e.identityValue)},${csvEscape(e.joinedAt)}`),
  ];

  if (draw.activityKind === "lottery") {
    lines.push("", "中奖者邮箱,中奖时间", ...winners.map((w) => `${csvEscape(w.identityValue)},${csvEscape(w.drawnAt)}`));
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
  if (draw.status !== "draft") return fail(c, "仅草稿状态的活动可删除", 400);

  await db
    .delete(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

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
// 审计日志
// ═════════════════════════════════════════════════════════

/** 审计日志列表（支持按操作类型筛选） */
adminLotteryRoute.get("/logs", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const action = c.req.query("action") || "";
  const { limit, offset } = parseAdminPagination(c);

  const conditions = [eq(auditLogs.tenantId, tenantId)];
  if (action) conditions.push(eq(auditLogs.action, action));

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { logs: rows });
});

/**
 * 校验商品链接配置（服务端校验，防止危险协议和超长字段）
 * 返回 null 表示通过，返回字符串表示错误消息
 */
function validateProductLink(link: any): string | null {
  if (!link || typeof link !== "object") return "商品链接配置无效";
  if (typeof link.url !== "string" || !link.url.trim()) return "商品链接不能为空";
  try {
    const url = new URL(link.url);
    if (!["https:", "http:"].includes(url.protocol)) {
      return "商品链接仅支持 http 和 https 协议";
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return "商品链接不能指向本地地址";
    }
    if (url.href.length > 2000) return "商品链接过长";
  } catch {
    return "商品链接格式无效";
  }
  if (typeof link.title === "string" && link.title.length > 200) return "商品名称过长";
  if (typeof link.imageUrl === "string" && link.imageUrl.length > 2000) return "图片链接过长";
  if (typeof link.price === "string" && link.price.length > 50) return "展示价格过长";
  return null;
}

/**
 * 校验 Webhook URL（SSRF 防护）。
 *
 * 为什么需要：Webhook 投递由平台 Worker 发起请求。若允许配置内网/保留地址，
 * 有租户权限的攻击者可利用平台作为代理访问内部服务或云元数据（如 169.254.169.254）。
 *
 * 防护范围：
 * - 仅 http/https
 * - 拒绝 localhost / 127.0.0.1 / ::1
 * - 拒绝私网 IP（10.x / 172.16-31.x / 192.168.x）
 * - 拒绝云元数据（169.254.169.254）和其他保留地址
 *
 * 注：域名解析后的 IP（DNS rebinding）无法在 URL 层面检测，MVP 接受该残余风险。
 */
function validateWebhookUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL 格式无效";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Webhook 仅支持 http 和 https 协议";
  }
  const hostname = parsed.hostname.toLowerCase();
  // 本机地址
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "Webhook 不能指向本地地址";
  }
  // IPv4 私网/保留地址检查（处理 IPv4 和 IPv6 映射）
  const ipv4 = hostname.replace(/^\[|\]$/g, "");
  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(ipv4);
  if (isIpv4) {
    const parts = ipv4.split(".").map(Number);
    const [a, b] = parts;
    const isPrivate =
      a === 10 ||                                // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||       // 172.16.0.0/12
      (a === 192 && b === 168) ||                // 192.168.0.0/16
      a === 127 ||                               // 127.0.0.0/8
      a === 0 ||                                 // 0.0.0.0/8
      (a === 169 && b === 254) ||                // 169.254.0.0/16（含云元数据）
      (a === 100 && b >= 64 && b <= 127);        // 100.64.0.0/10（CGN）
    if (isPrivate) return "Webhook 不能指向内网地址";
  }
  if (parsed.href.length > 2000) return "Webhook URL 过长";
  return null;
}

function coerceEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === "signup_chain") return "list";
  if (activityKind === "reservation") return "calendar";
  if (activityKind === "vote") return "ballot";
  if (activityKind === "survey") return "form";
  if (activityKind === "checkin") return "checkin";
  if (activityKind === "waitlist") return "queue";
  if (activityKind === "approval") return "form";
  if (activityKind === "claim") return "reveal";
  return defaultExperienceForParticipation(participationMode);
}

// defaultResultModeForActivity 已从 ../services/lottery-service 导入，此处不再重复定义。

/** 安全解析 JSON 字符串 */
function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ═════════════════════════════════════════════════════════
// 参与者黑名单
// ═════════════════════════════════════════════════════════

/** 黑名单列表 */
adminLotteryRoute.get("/blacklist", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);

  const rows = await db
    .select()
    .from(lotteryBlacklist)
    .where(eq(lotteryBlacklist.tenantId, tenantId))
    .orderBy(desc(lotteryBlacklist.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { items: rows });
});

/** 添加黑名单 */
adminLotteryRoute.post("/blacklist", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ identityValue: string; note?: string }>();
  const email = String(body.identityValue || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  const blacklistId = crypto.randomUUID();
  await db.insert(lotteryBlacklist).values({
    id: blacklistId,
    tenantId,
    identityValue: email,
    note: String(body.note || "").trim(),
  });

  await recordTenantAudit(c, "blacklist.add", "blacklist", blacklistId, { identityValue: email });
  return ok(c, { added: true });
});

/** 删除黑名单 */
adminLotteryRoute.delete("/blacklist/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const id = c.req.param("id");

  await db
    .delete(lotteryBlacklist)
    .where(and(eq(lotteryBlacklist.id, id), eq(lotteryBlacklist.tenantId, tenantId)));

  await recordTenantAudit(c, "blacklist.remove", "blacklist", id);
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 租户成员管理
// ═════════════════════════════════════════════════════════

/** 成员列表 */
adminLotteryRoute.get("/members", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;

  const rows = await db
    .select({
      userId: tenantMembers.userId,
      role: tenantMembers.role,
      username: users.username,
      createdAt: tenantMembers.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(tenantMembers.userId, users.id))
    .where(eq(tenantMembers.tenantId, tenantId))
    .orderBy(desc(tenantMembers.createdAt));

  return ok(c, { members: rows });
});

/** 添加成员 */
adminLotteryRoute.post("/members", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ username: string; role?: string }>();
  const username = String(body.username || "").trim();
  const role = parseTenantMemberRole(body.role);
  if (!role) return fail(c, "成员角色无效，仅支持 owner/admin/viewer", 400);

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (!user) return fail(c, "用户不存在", 404);

  const [existing] = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, user.id)))
    .limit(1);
  if (existing) return fail(c, "该用户已是团队成员", 409);

  const quota = await getTenantUsage(db, tenantId);
  if (quota.limits.maxMembers !== null) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(tenantMembers)
      .where(eq(tenantMembers.tenantId, tenantId));
    if (Number(total || 0) >= quota.limits.maxMembers) {
      return fail(c, `当前套餐最多允许 ${quota.limits.maxMembers} 名团队成员`, 403);
    }
  }

  await db.insert(tenantMembers).values({
    tenantId,
    userId: user.id,
    role,
  });

  return ok(c, { added: true });
});

/** 修改成员角色（仅 owner；禁止自我降权，避免租户后台无人可管） */
adminLotteryRoute.patch("/members/:userId", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const targetUserId = c.req.param("userId");
  const body = await c.req.json<{ role: string }>();
  const role = parseTenantMemberRole(body.role, "");

  if (!role) return fail(c, "成员角色无效，仅支持 owner/admin/viewer", 400);
  // 角色变更是租户安全边界操作；禁止 owner 把自己改成 viewer/admin 后失去管理入口。
  if (targetUserId === c.get("userId")) return fail(c, "不能修改自己的角色", 400);

  const result = await db
    .update(tenantMembers)
    .set({ role })
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetUserId)));
  if ((result.rowsAffected ?? 0) === 0) return fail(c, "成员不存在", 404);
  return ok(c, { updated: true });
});

/** 删除成员 */
adminLotteryRoute.delete("/members/:userId", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const userId = c.req.param("userId");

  if (userId === c.get("userId")) return fail(c, "不能删除自己", 400);

  await db
    .delete(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));

  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 统计概览
// ═════════════════════════════════════════════════════════

/** 租户级别统计概览 */
adminLotteryRoute.get("/stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const tenantUsage = await getTenantUsage(db, tenantId);

  const [drawCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.tenantId, tenantId));

  const [openCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));

  const [drawnCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "drawn")));

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [recentEntries] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), sql`${lotteryEntries.joinedAt} >= ${sevenDaysAgo}`));

  // 后台低频概览允许做租户级 COUNT：它消耗 Turso rows read 和等待时间，
  // 但不应被误判为 Worker CPU 热点。公开参与热路径仍禁止依赖该类累计统计。
  const [totalEntries] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.tenantId, tenantId));

  const [winnerCount] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.tenantId, tenantId));

  return ok(c, {
    totalDraws: Number(drawCount?.total ?? 0),
    openDraws: Number(openCount?.total ?? 0),
    drawnDraws: Number(drawnCount?.total ?? 0),
    totalParticipants: Number(totalEntries?.total ?? 0),
    recentParticipants: Number(recentEntries?.total ?? 0),
    totalWinners: Number(winnerCount?.total ?? 0),
    plan: tenantUsage.plan,
    limits: tenantUsage.limits,
    usage: { ...tenantUsage.usage, participants: Number(totalEntries?.total ?? 0) },
  });
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
      identityValue: lotteryEntries.identityValue,
      joinedAt: lotteryEntries.joinedAt,
    })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId)))
    .orderBy(lotteryEntries.joinedAt);

  return ok(c, { entries, total: entries.length });
});

// ═════════════════════════════════════════════════════════
// API 密钥管理
// ═════════════════════════════════════════════════════════

/** API 密钥列表 */
adminLotteryRoute.get("/api-keys", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select({ id: apiKeys.id, name: apiKeys.name, key: apiKeys.key, active: apiKeys.active, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.createdAt));
  return ok(c, { keys: rows });
});

/** 创建 API 密钥 */
adminLotteryRoute.post("/api-keys", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ name: string }>();
  const name = String(body.name || "").trim();
  if (!name) return fail(c, "请输入密钥名称", 400);

  const key = "cl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  // 明文只返回一次（前端弹窗展示），库中只存哈希，防止数据库泄漏时密钥全量暴露
  const keyHash = await hashApiKey(key);
  const apiKeyId = crypto.randomUUID();
  await db.insert(apiKeys).values({ id: apiKeyId, tenantId, name, key: keyHash });
  await recordTenantAudit(c, "apikey.create", "api_key", apiKeyId, { name });
  return ok(c, { key });
});

/** 删除 API 密钥 */
adminLotteryRoute.delete("/api-keys/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const apiKeyId = c.req.param("id");
  await db.delete(apiKeys).where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.tenantId, tenantId)));
  await recordTenantAudit(c, "apikey.delete", "api_key", apiKeyId);
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// Webhook 配置管理
// ═════════════════════════════════════════════════════════

/** Webhook 列表 */
adminLotteryRoute.get("/webhooks", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select({
      id: webhookConfigs.id,
      tenantId: webhookConfigs.tenantId,
      url: webhookConfigs.url,
      events: webhookConfigs.events,
      active: webhookConfigs.active,
      lastSentAt: webhookConfigs.lastSentAt,
      lastError: webhookConfigs.lastError,
      createdAt: webhookConfigs.createdAt,
      updatedAt: webhookConfigs.updatedAt,
    })
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, tenantId))
    .orderBy(desc(webhookConfigs.createdAt));
  return ok(c, { webhooks: rows });
});

/** 创建 Webhook */
adminLotteryRoute.post("/webhooks", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ url: string; events?: string[] }>();
  const url = String(body.url || "").trim();
  if (!url) return fail(c, "请输入 Webhook URL", 400);
  const urlError = validateWebhookUrl(url);
  if (urlError) return fail(c, urlError, 400);

  const quota = await getTenantUsage(db, tenantId);
  if (quota.limits.maxWebhooks !== null) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, 1)));
    if (Number(total || 0) >= quota.limits.maxWebhooks) {
      return fail(c, `当前套餐最多允许 ${quota.limits.maxWebhooks} 个 Webhook`, 403);
    }
  }

  const signingSecret = createWebhookSigningSecret();
  const webhookId = crypto.randomUUID();
  await db.insert(webhookConfigs).values({
    id: webhookId,
    tenantId,
    url,
    events: JSON.stringify(body.events || ["draw.completed", "prize.issued"]),
    signingSecret,
  });
  await recordTenantAudit(c, "webhook.create", "webhook_config", webhookId, { url });
  return ok(c, { created: true, signingSecret });
});

/** 删除 Webhook */
adminLotteryRoute.delete("/webhooks/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const webhookId = c.req.param("id");
  await db.delete(webhookConfigs).where(and(eq(webhookConfigs.id, webhookId), eq(webhookConfigs.tenantId, tenantId)));
  await recordTenantAudit(c, "webhook.delete", "webhook_config", webhookId);
  return ok(c, { deleted: true });
});

/** Webhook 投递记录 */
adminLotteryRoute.get("/webhook-deliveries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const deliveries = await listWebhookDeliveries(db, tenantId, limit, offset);
  return ok(c, { deliveries });
});

/** 重试单条 Webhook 投递 */
adminLotteryRoute.post("/webhook-deliveries/:id/retry", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const result = await dispatchWebhookDelivery(db, tenantId, c.req.param("id"));
  return ok(c, result);
});

/** 批量处理待重试 Webhook 投递 */
adminLotteryRoute.post("/webhook-deliveries/process", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ limit?: number }>().catch((): { limit?: number } => ({}));
  const result = await processPendingWebhookDeliveries(db, tenantId, fetch, clampInteger(body.limit, 20, 1, 100));
  return ok(c, result);
});

// ═════════════════════════════════════════════════════════
// 优惠券码池管理
// ═════════════════════════════════════════════════════════

/** 优惠券列表 */
adminLotteryRoute.get("/coupons", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const rows = await db
    .select()
    .from(couponCodes)
    .where(eq(couponCodes.tenantId, tenantId))
    .orderBy(desc(couponCodes.createdAt))
    .limit(limit).offset(offset);
  return ok(c, { coupons: rows });
});

/** 批量导入优惠券 */
adminLotteryRoute.post("/coupons/import", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ codes: string[]; label?: string; expiresAt?: string }>();
  if (!body.codes || body.codes.length === 0) return fail(c, "请提供至少一个码", 400);
  let count = 0;
  let skipped = 0;
  for (const code of body.codes) {
    try {
      await db.insert(couponCodes).values({
        id: crypto.randomUUID(), tenantId, code: code.trim(),
        label: body.label || "", expiresAt: body.expiresAt || null,
      });
      count++;
    } catch (err) {
      // 只把唯一索引冲突视为“重复券码”跳过；其他数据库错误必须暴露，避免导入半成功却不可感知。
      if (!isUniqueConstraintError(err)) throw err;
      skipped++;
    }
  }
  return ok(c, { imported: count, skipped });
});

/** 核销优惠券（CAS 条件更新防止并发重复核销） */
adminLotteryRoute.post("/coupons/redeem", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ code: string }>();
  const code = String(body.code || "").trim();
  if (!code) return fail(c, "请输入优惠券码", 400);

  // CAS 条件更新：仅当 status = 'available' 时更新为 redeemed
  const result = await db.update(couponCodes)
    .set({ status: "redeemed", redeemedAt: new Date().toISOString() })
    .where(and(eq(couponCodes.tenantId, tenantId), eq(couponCodes.code, code), eq(couponCodes.status, "available")));

  if ((result.rowsAffected ?? 0) === 0) {
    return fail(c, "优惠券不存在或已使用", 404);
  }

  const [coupon] = await db
    .select({ label: couponCodes.label })
    .from(couponCodes)
    .where(and(eq(couponCodes.tenantId, tenantId), eq(couponCodes.code, code)))
    .limit(1);

  await recordTenantAudit(c, "coupon.redeem", "coupon_code", code);
  return ok(c, { redeemed: true, label: coupon?.label || "" });
});

// ═════════════════════════════════════════════════════════
// 租户品牌配置（白标）
// ═════════════════════════════════════════════════════════

/** 获取品牌配置 */
adminLotteryRoute.get("/brand", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [tenant] = await db.select({ brandConfig: tenants.brandConfig }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);
  const config = tryParseJson(tenant.brandConfig);
  return ok(c, { config });
});

/** 更新品牌配置 */
adminLotteryRoute.put("/brand", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<any>();
  const config = {
    logo: body.logo || "",
    primaryColor: body.primaryColor || "",
    companyName: body.companyName || "",
    domain: body.domain || "",
  };
  await db.update(tenants).set({ brandConfig: JSON.stringify(config), updatedAt: new Date().toISOString() }).where(eq(tenants.id, tenantId));
  return ok(c, { config });
});

// ═════════════════════════════════════════════════════════
// 分享裂变统计
// ═════════════════════════════════════════════════════════

/** 分享统计 */
adminLotteryRoute.get("/draws/:id/shares", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const rows = await db
    .select()
    .from(shareRecords)
    .where(and(eq(shareRecords.tenantId, tenantId), eq(shareRecords.drawId, drawId)))
    .orderBy(desc(shareRecords.createdAt));
  const totalClicks = rows.reduce((s, r) => s + r.clickedCount, 0);
  const totalJoins = rows.reduce((s, r) => s + r.joinedCount, 0);
  return ok(c, { shares: rows, totalClicks, totalJoins, sharerCount: rows.length });
});

// ═════════════════════════════════════════════════════════
// 兑换码管理（运营者生成，终端用户兑换）
// ═════════════════════════════════════════════════════════

/** 生成唯一兑换码 */

// 兑换码平台管理入口已迁移到 /api/platform/redemption-codes。
// 租户侧只保留兑换接口：/api/admin/redemption-codes/redeem

/** 兑换历史记录（租户侧：查看本租户的兑换记录） */
adminLotteryRoute.get("/redemption-records", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));

  const rows = await db
    .select()
    .from(redemptionRecords)
    .where(eq(redemptionRecords.tenantId, tenantId))
    .orderBy(desc(redemptionRecords.redeemedAt))
    .limit(limit).offset(offset);

  return ok(c, { records: rows });
});

/** 兑换码兑换（租户侧：输入兑换码，获得额度）
 *
 * 使用 CAS（条件更新）防止并发超发：
 *   UPDATE redemption_codes SET used_count = used_count + 1
 *   WHERE id = ? AND used_count < max_uses AND status = 'active'
 * 如果影响行数为 0，说明兑换码已被用完或失效。
 */
adminLotteryRoute.post("/redemption-codes/redeem", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ code: string }>();
  const codeInput = String(body.code || "").trim().toUpperCase();

  if (!codeInput) return fail(c, "请输入兑换码", 400);

  try {
    const grant = await withDbTransaction(db, async (tx) => {
      // 查找兑换码和发放额度必须与后续 CAS、租户加额、兑换记录同事务提交。
      // 否则网络抖动或写锁错误会留下“码已用但额度未到账”的半成功状态。
      const [codeRecord] = await tx
        .select()
        .from(redemptionCodes)
        .where(eq(redemptionCodes.code, codeInput))
        .limit(1);

      if (!codeRecord) throw new RedeemError("兑换码不存在", 404);
      if (codeRecord.status !== "active") throw new RedeemError("兑换码已失效", 400);
      if (new Date() > new Date(codeRecord.expiresAt)) throw new RedeemError("兑换码已过期", 400);

      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + codeRecord.durationDays * 86400000).toISOString();

      // CAS 条件更新：原子递增 used_count，只有未用完且状态仍 active 时才成功。
      const updateResult = await tx.update(redemptionCodes)
        .set({
          usedCount: sql`used_count + 1`,
          status: sql`CASE WHEN used_count + 1 >= max_uses THEN 'used' ELSE 'active' END`,
          updatedAt: now,
        })
        .where(and(
          eq(redemptionCodes.id, codeRecord.id),
          eq(redemptionCodes.status, "active"),
          sql`used_count < max_uses`,
        ));

      if ((updateResult.rowsAffected ?? 0) === 0) {
        throw new RedeemError("兑换码已被使用", 409);
      }

      await tx.update(tenants).set({
        extraActivityQuota: sql`COALESCE(extra_activity_quota, 0) + ${codeRecord.activityQuota}`,
        extraParticipantQuota: sql`COALESCE(extra_participant_quota, 0) + ${codeRecord.participantQuota}`,
        extraQuotaExpiresAt: expiresAt,
        updatedAt: now,
      }).where(eq(tenants.id, tenantId));

      const [tenant] = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      await tx.insert(redemptionRecords).values({
        id: crypto.randomUUID(),
        codeId: codeRecord.id,
        code: codeInput,
        tenantId,
        tenantName: tenant?.name || "",
        activityQuotaGranted: codeRecord.activityQuota,
        participantQuotaGranted: codeRecord.participantQuota,
        durationDaysGranted: codeRecord.durationDays,
        expiresAt,
        redeemedAt: now,
      });

      return {
        activityQuota: codeRecord.activityQuota,
        participantQuota: codeRecord.participantQuota,
        expiresAt,
      };
    });

    await recordTenantAudit(c, "redemption.redeem", "redemption_code", codeInput);
    return ok(c, { redeemed: true, ...grant });
  } catch (err) {
    if (err instanceof RedeemError) return fail(c, err.message, err.status);
    throw err;
  }
});

class RedeemError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
