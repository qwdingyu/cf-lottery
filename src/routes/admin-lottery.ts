/**
 * 管理端抽奖路由
 *
 * 所有路由需要登录认证，数据按 tenant_id 隔离。
 * 活动 CRUD / 发布开奖状态机主闭环；
 * 奖品、运营数据、租户运维、集成域由 setup* 子模块挂载。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import { getDb, ok, fail } from "../lib/http";
import { getEnv } from "../lib/platform";
import { lotteryDraws, prizes, prizeCodes, lotteryPrizeTiers, lotteryWinners, lotteryEntries, tenantMembers, users, tenants, platformMembers, externalConversions, systemConfig } from "../db/schema";
import { eq, and, desc, sql, count, inArray } from "drizzle-orm";
import {
  createDraw,
  publishDraw,
  pauseDraw,
  resumeDraw,
  cancelDraw,
  performDraw,
  getDraw,
  getTenantUsage,
  hashAccessPassword,
  defaultResultModeForActivity,
} from "../services/lottery-service";
import { ACTIVITY_TEMPLATES } from "../lib/activity-templates";
import { parseFlashSaleConfig } from "../lib/flash-sale-config";
import { readSystemConfigMap } from "../lib/system-config-registry";
import { readSystemConfigNumber } from "../services/admin/system-config";
import { setupPrizeRoutes } from "./admin-lottery-prizes";
import { setupTenantOpsRoutes } from "./admin-lottery-tenant-ops";
import { setupIntegrationRoutes } from "./admin-lottery-integrations";
import { setupDrawOpsRoutes } from "./admin-lottery-draw-ops";
import {
  requireTenantRouteCapability,
  recordTenantAudit,
  escapeLike,
  parseAdminPagination,
  encodeDrawCursor,
  decodeDrawCursor,
  validateProductLink,
  coerceEnum,
  normalizeOptionalPositiveInteger,
  defaultExperienceForActivity,
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
setupDrawOpsRoutes(adminLotteryRoute);

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
      eq(lotteryDraws.activityKind, "lottery"),
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

  // ═════════════════════════════════════════════════════════
  // 库存预警：检查直付秒杀（paymentRequired=true）的卡密库存
  //
  // 为什么在 dashboard 端点做：运营台概览是统一的信息聚合入口，运营者打开后台
  // 第一时间就能发现卡密不足，避免用户支付后进入 paid_fulfillment_failed。
  // 只查 open 状态的活动，因为只有 open 状态才接受支付。
  // ═════════════════════════════════════════════════════════
  const openDraws = await db
    .select({ id: lotteryDraws.id, title: lotteryDraws.title, promotionConfig: lotteryDraws.promotionConfig })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));

  const flashDrawIds: string[] = [];
  for (const draw of openDraws) {
    const { config } = parseFlashSaleConfig(draw.promotionConfig);
    if (config?.paymentRequired) {
      flashDrawIds.push(draw.id);
    }
  }

  let lowStockCount = 0;
  let criticalStockCount = 0;
  const stockWarnings: Array<{
    drawId: string;
    drawTitle: string;
    prizeName: string;
    availableCount: number;
    stockLimit: number | null;
  }> = [];

  if (flashDrawIds.length > 0) {
    // 查活动关联的码奖品及各码池可用数量（LEFT JOIN 保证 availableCount 为 0 时仍返回行）
    const inventoryRows = await db
      .select({
        drawId: lotteryPrizeTiers.drawId,
        prizeName: prizes.name,
        availableCount: sql<number>`COUNT(${prizeCodes.id})`,
      })
      .from(lotteryPrizeTiers)
      .innerJoin(prizes, and(
        eq(prizes.id, lotteryPrizeTiers.prizeId),
        eq(prizes.tenantId, tenantId),
        eq(prizes.prizeType, "code"),
        eq(prizes.active, 1),
      ))
      .leftJoin(prizeCodes, and(
        eq(prizeCodes.prizeId, lotteryPrizeTiers.prizeId),
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.status, "available"),
      ))
      .where(and(
        eq(lotteryPrizeTiers.tenantId, tenantId),
        inArray(lotteryPrizeTiers.drawId, flashDrawIds),
      ))
      .groupBy(lotteryPrizeTiers.drawId, prizes.name);

    const drawMap = new Map(openDraws.map((d) => [d.id, d]));

    // 从系统配置读取预警阈值（一次查询，循环内复用，避免 N×2 次 systemConfig 查询）
    const warnThreshold = await readSystemConfigNumber(db, "inventory_warn_threshold", 5);
    const criticalThreshold = await readSystemConfigNumber(db, "inventory_critical_threshold", 0);

    for (const row of inventoryRows) {
      const draw = drawMap.get(row.drawId);
      const available = Number(row.availableCount);
      const warning = {
        drawId: row.drawId,
        drawTitle: draw?.title || "",
        prizeName: row.prizeName,
        availableCount: available,
        stockLimit: (() => { const { config } = parseFlashSaleConfig(draw?.promotionConfig || "{}"); return config?.stockLimit ?? null; })(),
      };
      stockWarnings.push(warning);
      if (available <= criticalThreshold) {
        criticalStockCount++;
      } else if (available <= warnThreshold) {
        lowStockCount++;
      }
    }
  }

  return ok(c, {
    openCount: Number(openRow?.count || 0),
    draftCount: Number(draftRow?.count || 0),
    drawnCount: Number(drawnRow?.count || 0),
    dueCount: Number(dueRow?.count || 0),
    failedNotifyCount: Number(failedNotifyRow?.count || 0),
    /** 库存预警：可用卡密 ≤ 5 的直付秒杀活动数 */
    lowStockCount,
    /** 库存预警：卡密已售罄（available=0）的直付秒杀活动数 */
    criticalStockCount,
    /** 库存预警详情（含 drawId、drawTitle、prizeName、availableCount） */
    stockWarnings,
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
/** 活动列表（游标分页，支持状态筛选和搜索）
 *
 * 分页策略（docs/154 P2-1）：
 * - cursor 参数：base64 编码的 (createdAt,id) 复合游标，用于高效顺序翻页（避免 OFFSET 大偏移量性能退化）。
 * - offset 参数：兼容旧版序号跳页（如 AdminPagination 的 @jump 跳转），当 cursor 未提供时使用 offset。
 * - 两者同时提供时 cursor 优先。
 * - 返回 nextCursor 和 hasMore，前端在顺序翻页时用 cursor 传回。
 */
adminLotteryRoute.get("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);
  const cursorParam = c.req.query("cursor") || "";
  const status = c.req.query("status") || "";
  const query = c.req.query("query") || "";
  // 活动类型筛选（047 文档 🔴）：租户创建多种类型活动后可按类型查找
  const activityKind = c.req.query("activityKind") || "";
  // 时间范围筛选（047 文档 🟡）：createdFrom/createdTo 为 ISO 日期，按创建时间过滤
  const createdFrom = c.req.query("createdFrom") || "";
  const createdTo = c.req.query("createdTo") || "";

  const conditions: any[] = [eq(lotteryDraws.tenantId, tenantId)];
  // docs/083 P1：status=active 虚拟筛 = 进行中视角（draft/open/paused/drawing），排除 drawn/cancelled
  // 未知 status 忽略，避免拼错 query 得到空列表误以为无活动
  const ALLOWED_DRAW_STATUS = new Set([
    "active",
    "draft",
    "open",
    "paused",
    "drawing",
    "drawn",
    "cancelled",
  ]);
  if (status === "active") {
    conditions.push(inArray(lotteryDraws.status, ["draft", "open", "paused", "drawing"]));
  } else if (status && ALLOWED_DRAW_STATUS.has(status)) {
    conditions.push(eq(lotteryDraws.status, status));
  }
  if (query) conditions.push(sql`${lotteryDraws.title} LIKE ${'%' + escapeLike(query) + '%'}`);
  if (activityKind) conditions.push(eq(lotteryDraws.activityKind, activityKind));
  if (createdFrom) conditions.push(sql`${lotteryDraws.createdAt} >= ${createdFrom}`);
  if (createdTo) conditions.push(sql`${lotteryDraws.createdAt} <= ${createdTo}`);

  // 游标解码：当 cursor 参数有效时，添加 keyset 分页条件
  // 复合游标 (createdAt, id) 确保排序确定性和唯一性，避免同一毫秒创建多个活动时重复/遗漏
  const cursor = cursorParam ? decodeDrawCursor(cursorParam) : null;
  // 游标条件单独保存，用于 count 查询时排除（总数不应用游标过滤）
  const cursorCondition = cursor
    ? sql`(
      ${lotteryDraws.createdAt} < ${cursor.createdAt}
      OR (
        ${lotteryDraws.createdAt} = ${cursor.createdAt}
        AND ${lotteryDraws.id} < ${cursor.id}
      )
    )`
    : null;
  if (cursorCondition) {
    conditions.push(cursorCondition);
  }

  // 始终多取 1 条，用于判断是否有下一页并生成游标
  // 游标模式：通过 WHERE 条件跳过已看数据；offset 模式：通过 OFFSET 跳过（兼容旧版页码跳转）
  const fetchLimit = limit + 1;

  const queryBuilder = db
    .select()
    .from(lotteryDraws)
    .where(and(...conditions))
    .orderBy(desc(lotteryDraws.createdAt), desc(lotteryDraws.id));

  const rows = cursor !== null
    ? await queryBuilder.limit(fetchLimit)
    : await queryBuilder.limit(fetchLimit).offset(offset);

  // 判断是否有下一页并生成游标
  // 多取 1 条确保 rows.length > limit 时说明还有下一页
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();  // 移除多取的那条
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
  const nextCursor = lastRow ? encodeDrawCursor(lastRow.createdAt, lastRow.id) : "";

  // 查询总数（需排除游标条件，用于 UI 分页栏显示总页数）
  // 游标条件始终追加在 conditions 末尾，用 slice(0,-1) 排除比引用相等（!==）更明确、更不易被重构破坏
  const totalConditions = cursorCondition ? conditions.slice(0, -1) : conditions;
  const [totalRow] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(...totalConditions));

  // 并行查询参与人数
  const counts = await Promise.all(rows.map(async (d) => {
    const [r] = await db.select({ total: count() }).from(lotteryEntries).where(and(eq(lotteryEntries.drawId, d.id), eq(lotteryEntries.tenantId, d.tenantId)));
    return Number(r?.total ?? 0);
  }));
  const draws = rows.map((d, i) => ({ ...d, entryCount: counts[i]! }));

  return ok(c, { draws, total: Number(totalRow?.total ?? 0), nextCursor, hasMore });
});

/** 活动列表 CSV 导出 — 复用列表查询条件，不限制数量，输出 UTF-8 BOM CSV */
adminLotteryRoute.get("/draws/export", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const status = c.req.query("status") || "";
  const query = c.req.query("query") || "";
  const activityKind = c.req.query("activityKind") || "";

  // 复用活动列表的查询条件（不含游标和分页限制）
  const conditions: any[] = [eq(lotteryDraws.tenantId, tenantId)];
  const ALLOWED_DRAW_STATUS = new Set(["active", "draft", "open", "paused", "drawing", "drawn", "cancelled"]);
  if (status && ALLOWED_DRAW_STATUS.has(status)) {
    conditions.push(eq(lotteryDraws.status, status));
  }
  if (query) {
    conditions.push(sql`${lotteryDraws.title} LIKE ${"%" + query + "%"}`);
  }
  if (activityKind) {
    conditions.push(eq(lotteryDraws.activityKind, activityKind));
  }

  const rows = await db
    .select({
      id: lotteryDraws.id,
      title: lotteryDraws.title,
      status: lotteryDraws.status,
      activityKind: lotteryDraws.activityKind,
      participationMode: lotteryDraws.participationMode,
      resultMode: lotteryDraws.resultMode,
      startAt: lotteryDraws.startAt,
      endAt: lotteryDraws.endAt,
      createdAt: lotteryDraws.createdAt,
      updatedAt: lotteryDraws.updatedAt,
    })
    .from(lotteryDraws)
    .where(and(...conditions))
    .orderBy(desc(lotteryDraws.createdAt));

  // 构建 CSV（UTF-8 BOM，确保 Excel 正确识别中文）
  const BOM = "\uFEFF";
  const csv = [
    "标题,状态,类型,参与模式,开奖模式,开始时间,结束时间,创建时间,更新时间",
    ...rows.map((r) => {
      const escape = (s: string | null) => s ? `"${String(s).replace(/"/g, '""')}"` : "";
      return [
        escape(r.title),
        r.status,
        r.activityKind || "",
        r.participationMode || "",
        r.resultMode || "",
        escape(r.startAt),
        escape(r.endAt),
        escape(r.createdAt),
        escape(r.updatedAt),
      ].join(",");
    }),
  ].join("\n");

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="activities_${new Date().toISOString().slice(0, 10)}.csv"`);
  c.header("Cache-Control", "no-store");
  return c.body(BOM + csv);
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
      weight: lotteryPrizeTiers.weight,
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
    maxSpinsPerEntry: Number(draw.maxSpinsPerEntry || 0),
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
        weight: Number(tier.weight || 0),
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
    // docs/115 续审：管理端表单必填 drawAt（文案「系统自动开奖」）却常不传 drawTrigger。
    // coerceEnum 缺省会落 manual → Cron 只扫 scheduled → 到点永不自动开奖。
    // 仅 lottery + 有 drawAt 时推断 scheduled；显式 body.drawTrigger 仍优先。
    const drawAtRaw = body.drawAt ? String(body.drawAt) : "";
    const hasDrawAt = Boolean(drawAtRaw.trim());
    const triggerFallback =
      activityKind === "lottery" && hasDrawAt && body.drawTrigger === undefined
        ? "scheduled"
        : "manual";
    const drawTrigger = coerceEnum(body.drawTrigger, DRAW_TRIGGERS, triggerFallback);

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

    // lottery + scheduled：若客户端仍传 resultMode=manual，与 drawTrigger 对齐，避免公开页文案说谎
    // lottery + instant：不因 drawAt 误推 scheduled（instant 无 performDraw）
    let resultModeInput = body.resultMode;
    const resolvedResultPeek = resultModeInput !== undefined
      ? coerceEnum(resultModeInput, RESULT_MODES, defaultResultModeForActivity(activityKind, drawTrigger))
      : defaultResultModeForActivity(activityKind, drawTrigger);
    if (
      activityKind === "lottery" &&
      drawTrigger === "scheduled" &&
      resolvedResultPeek !== "instant" &&
      (resultModeInput === undefined ||
        resultModeInput === null ||
        String(resultModeInput).trim() === "" ||
        String(resultModeInput).trim().toLowerCase() === "manual")
    ) {
      resultModeInput = "scheduled";
    }

    let maxSpinsPerEntry: number | undefined;
    if (body.maxSpinsPerEntry !== undefined && body.maxSpinsPerEntry !== null && body.maxSpinsPerEntry !== "") {
      const n = Number(body.maxSpinsPerEntry);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        return fail(c, "每人抽奖次数须为 1–100 的整数", 400);
      }
      maxSpinsPerEntry = Math.floor(n);
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
      resultMode: resultModeInput !== undefined
        ? coerceEnum(resultModeInput, RESULT_MODES, defaultResultModeForActivity(activityKind, drawTrigger))
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
      ...(maxSpinsPerEntry !== undefined ? { maxSpinsPerEntry } : {}),
    });
    await recordTenantAudit(c, "draw.create", "lottery_draw", id, { title: String(body.title || "") });
    return ok(c, { id, publicSlug });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "创建活动失败", 400);
  }
});

/** 编辑活动
 *
 * - draft：可改业务字段（时间、标题、配置等）
 * - drawn：仅允许切换 visible（docs/083，对齐 cf-shop）——公示结束后可对用户隐藏，不改已定结果
 * - 其它状态：禁止 PATCH（暂停/取消请走状态机接口）
 */
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

  // ── 已开奖：仅允许 { visible: 0|1|true|false } ──
  if (draw.status === "drawn") {
    const keys = Object.keys(body || {}).filter((k) => body[k] !== undefined);
    if (keys.length !== 1 || body.visible === undefined) {
      return fail(c, "已开奖活动仅可切换可见性", 409);
    }
    const nextVisible = body.visible === true || body.visible === 1 || body.visible === "1" ? 1 : 0;
    await db
      .update(lotteryDraws)
      .set({ visible: nextVisible, updatedAt: new Date().toISOString() })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    await recordTenantAudit(c, "draw.update_visibility", "lottery_draw", drawId, { visible: nextVisible });
    return ok(c, { updated: true, visible: nextVisible });
  }

  if (draw.status !== "draft") return fail(c, "只有草稿状态的活动可以编辑", 400);

  let maxSpinsUpdate: number | undefined;
  if (body.maxSpinsPerEntry !== undefined && body.maxSpinsPerEntry !== null && body.maxSpinsPerEntry !== "") {
    const n = Number(body.maxSpinsPerEntry);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return fail(c, "每人抽奖次数须为 0–100 的整数", 400);
    }
    maxSpinsUpdate = Math.floor(n);
  }

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

  // 编辑时校验 productLink；null / 空对象表示清空导流，不走「必须有 url」校验
  if (body.productLink !== undefined && body.productLink !== null) {
    const isEmptyClear =
      typeof body.productLink === "object" &&
      !Array.isArray(body.productLink) &&
      !String((body.productLink as { url?: string }).url || "").trim();
    if (!isEmptyClear) {
      const err = validateProductLink(body.productLink);
      if (err) return fail(c, err, 400);
    }
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
      ...(maxSpinsUpdate !== undefined ? { maxSpinsPerEntry: maxSpinsUpdate } : {}),
      ...(maxParticipantsUpdate !== undefined ? { maxParticipants: maxParticipantsUpdate } : {}),
      ...(body.accessPassword !== undefined ? { accessPassword: body.accessPassword ? await hashAccessPassword(String(body.accessPassword)) : "" } : {}),
      ...(body.showParticipantCount !== undefined ? { showParticipantCount: body.showParticipantCount ? 1 : 0 } : {}),
      ...(body.showWinnerCount !== undefined ? { showWinnerCount: body.showWinnerCount ? 1 : 0 } : {}),
      ...(body.showWinnerList !== undefined ? { showWinnerList: body.showWinnerList ? 1 : 0 } : {}),
      ...(body.productLink !== undefined
        ? {
            productLink:
              body.productLink === null
                ? "{}"
                : typeof body.productLink === "string"
                  ? body.productLink
                  : JSON.stringify(body.productLink),
          }
        : {}),
      ...(body.promotionConfig !== undefined
        ? {
            promotionConfig:
              body.promotionConfig === null
                ? "{}"
                : typeof body.promotionConfig === "string"
                  ? body.promotionConfig
                  : JSON.stringify(body.promotionConfig),
          }
        : {}),
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
    const result = await publishDraw(db, tenantId, drawId, {
      credentialsEncryptionKey: getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
    });
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
    if (String(draw.resultMode || "") === "instant") {
      return fail(c, "即时开奖活动请由用户 spin，不能统一开奖", 400);
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
