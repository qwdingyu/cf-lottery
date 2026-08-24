/**
 * 管理端抽奖路由
 *
 * 所有路由需要登录认证，数据按 tenant_id 隔离。
 * 活动 CRUD / 发布开奖状态机主闭环；
 * 奖品、运营数据、租户运维、集成域由 setup* 子模块挂载。
 */
import { Hono } from "hono";
import { logError } from "../lib/logger";
import { isInstantResultMode } from "../lib/activity-utils";
import { validatePromotionConfig } from "../lib/promotion-config-schema";
import type { AppEnv } from "../bindings";
import { requireAuth, requireTenantMember } from "../middleware/auth";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { getEnv } from "../lib/platform";
import { lotteryDraws, prizes, prizeCodes, lotteryPrizeTiers, lotteryWinners, lotteryEntries, paymentOrders, tenantMembers, users, tenants, platformMembers, externalConversions, systemConfig, activityEvents, shareRecords } from "../db/schema";
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
  DRAW_STATUS,
  DRAW_STATUS_VALUES,
  ACTIVE_DRAW_STATUSES,
  triggerRewardEarned,
  getSharerIdentityValue,
} from "../services/lottery-service";
import { ACTIVITY_TEMPLATES } from "../lib/activity-templates";
import { parseFlashSaleConfig } from "../lib/flash-sale-config";
import { readSystemConfigMap } from "../lib/system-config-registry";
import { readSystemConfigNumber } from "../services/admin/system-config";
import { enqueuePlatformEvent } from "../services/platform/delivery";
import { setupPrizeRoutes } from "./admin-lottery-prizes";
import { setupTenantOpsRoutes } from "./admin-lottery-tenant-ops";
import { setupIntegrationRoutes } from "./admin-lottery-integrations";
import { setupDrawOpsRoutes } from "./admin-lottery-draw-ops";
import { setupPlatformRoutes } from "./admin-lottery-platform";
import {
  requireTenantRouteCapability,
  requireL2MenuEnabled,
  recordTenantAudit,
  escapeLike,
  csvEscape,
  parseAdminPagination,
  encodeDrawCursor,
  decodeDrawCursor,
  validateProductLink,
  parseEnum,
  tryParseTime,
  normalizeOptionalPositiveInteger,
  normalizeOptionalNonNegativeInteger,
  defaultExperienceForActivity,
  isValidExperienceForActivity,
  mergeJsonTopLevel,
  decorateIdentityDisplay,
} from "./admin-lottery-helpers";
import { readDisabledL2Menus } from "../lib/l2-menu-keys";

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
  "flash_sale",
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
const DRAW_EXPORT_MAX_ROWS = 10_000;
/** 管理端列表专用虚拟筛选值，不会写入 lottery_draws.status。 */
const DRAW_STATUS_FILTER_ACTIVE = "active";
const DRAW_STATUS_FILTERS = new Set<string>([DRAW_STATUS_FILTER_ACTIVE, ...DRAW_STATUS_VALUES]);

const MAX_WINNER_COUNT = 9999;

function parseActivityTime(value: unknown, fieldName: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName}不能为空`);
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`${fieldName}格式无效`);
  }
  return time;
}

function parseWinnerCount(value: unknown, activityKind: string, fieldName = "中奖人数"): number {
  if (value === null || (typeof value === "string" && !value.trim())) {
    throw new Error(`${fieldName}必须为有效数字`);
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > MAX_WINNER_COUNT) {
    throw new Error(`${fieldName}必须为 0-${MAX_WINNER_COUNT} 的整数`);
  }
  if (activityKind === "lottery" && count < 1) {
    throw new Error("抽奖活动中奖人数必须至少为 1");
  }
  return count;
}

function applyDrawListFilters(
  tenantId: string,
  input: {
    status?: string;
    query?: string;
    activityKind?: string;
    createdFrom?: string;
    createdTo?: string;
  },
) {
  const conditions: any[] = [eq(lotteryDraws.tenantId, tenantId)];
  if (input.status === DRAW_STATUS_FILTER_ACTIVE) {
    conditions.push(inArray(lotteryDraws.status, ACTIVE_DRAW_STATUSES));
  } else if (input.status && DRAW_STATUS_FILTERS.has(input.status)) {
    conditions.push(eq(lotteryDraws.status, input.status));
  }
  if (input.query) {
    // 防御性截断：超长搜索字符串无意义且可能影响 SQL 性能（二次审查 2026-08-23）
    const escaped = escapeLike(input.query.trim().slice(0, 100));
    if (escaped) {
      // 搜索支持：标题、publicSlug、ID 前缀匹配（placeholder 承诺"搜索名称 / 奖品 / ID"）
      conditions.push(sql`(
        ${lotteryDraws.title} LIKE ${"%" + escaped + "%"}
        OR ${lotteryDraws.publicSlug} LIKE ${"%" + escaped + "%" }
        OR ${lotteryDraws.id} LIKE ${escaped + "%"}
      )`);
    }
  }
  if (input.activityKind) conditions.push(eq(lotteryDraws.activityKind, input.activityKind));
  if (input.createdFrom) conditions.push(sql`${lotteryDraws.createdAt} >= ${input.createdFrom}`);
  if (input.createdTo) conditions.push(sql`${lotteryDraws.createdAt} <= ${input.createdTo}`);
  return conditions;
}

// 所有租户后台路由都必须同时满足：已登录 + 仍是当前租户成员 + 命中轻量能力门禁。
// requireL2MenuEnabled 在能力门禁之前：L3 禁用的菜单路径直接 403（docs/255）。
adminLotteryRoute.use("*", requireAuth, requireTenantMember(), requireL2MenuEnabled, requireTenantRouteCapability);

// 子模块路由在中间件之后注册，确保所有端点都覆盖认证与权限校验
setupPrizeRoutes(adminLotteryRoute);
setupTenantOpsRoutes(adminLotteryRoute);
setupIntegrationRoutes(adminLotteryRoute);
setupDrawOpsRoutes(adminLotteryRoute);
setupPlatformRoutes(adminLotteryRoute);

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
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.OPEN)));
  const [draftRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.DRAFT)));
  const [drawnRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.DRAWN)));

  // 到期待开奖的定时活动
  const [dueRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, DRAW_STATUS.OPEN),
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
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.OPEN)));

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

  // G-2: 裂变/邀请统计概览
  const [viralRow] = await db
    .select({
      totalSharers: sql<number>`COUNT(*)`,
      totalClicks: sql<number>`COALESCE(SUM(${shareRecords.clickedCount}), 0)`,
      totalInvites: sql<number>`COALESCE(SUM(${shareRecords.joinedCount}), 0)`,
    })
    .from(shareRecords)
    .where(eq(shareRecords.tenantId, tenantId));

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
    /** G-2: 裂变统计概览 */
    viralStats: {
      totalSharers: Number(viralRow?.totalSharers || 0),
      totalClicks: Number(viralRow?.totalClicks || 0),
      totalInvites: Number(viralRow?.totalInvites || 0),
    },
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
// 数据看板增强（docs/267 P1）：参与趋势 + 转化漏斗
// ═════════════════════════════════════════════════════════

/** 参与趋势：按日/周/月聚合新增参与人数，用于趋势图表 */
adminLotteryRoute.get("/dashboard/trend", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { getParticipationTrend } = await import("../services/lottery/dashboard-stats");
  const granularity = (c.req.query("granularity") || "day") as "day" | "week" | "month";
  const days = parseInt(c.req.query("days") || "30", 10) || 30;
  const drawId = c.req.query("drawId") || undefined;

  const trend = await getParticipationTrend(db, tenantId, { granularity, days, drawId });
  return ok(c, { trend });
});

/** 转化漏斗：访问→参与→中奖→领奖各阶段人数与转化率 */
adminLotteryRoute.get("/dashboard/funnel", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { getConversionFunnel } = await import("../services/lottery/dashboard-stats");
  const days = parseInt(c.req.query("days") || "30", 10) || 30;
  const drawId = c.req.query("drawId") || undefined;

  const funnel = await getConversionFunnel(db, tenantId, { days, drawId });
  return ok(c, { funnel });
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
    // L3 全局禁用的 L2 菜单（docs/255）：前端菜单过滤 + 后端中间件强制 403 双保险。
    // 与 requireTenantRouteCapability 共用 lib/l2-menu-keys 同一读取函数，保证两侧一致。
    menuDisabled: await readDisabledL2Menus(db),
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

  // docs/083 P1：status=active 虚拟筛 = 进行中视角（draft/open/paused/drawing），排除 drawn/cancelled。
  // 列表与 CSV 导出共用同一套条件，避免页面看到 A、导出得到 B。
  const conditions = applyDrawListFilters(tenantId, { status, query, activityKind, createdFrom, createdTo });

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

/** 活动列表 CSV 导出 — 复用列表查询条件，强制上限，输出 UTF-8 BOM CSV */
adminLotteryRoute.get("/draws/export", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const status = c.req.query("status") || "";
  const query = c.req.query("query") || "";
  const activityKind = c.req.query("activityKind") || "";
  const createdFrom = c.req.query("createdFrom") || "";
  const createdTo = c.req.query("createdTo") || "";
  const limit = clampInteger(c.req.query("limit"), DRAW_EXPORT_MAX_ROWS, 1, DRAW_EXPORT_MAX_ROWS);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 1_000_000);

  const conditions = applyDrawListFilters(tenantId, { status, query, activityKind, createdFrom, createdTo });

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
    .orderBy(desc(lotteryDraws.createdAt), desc(lotteryDraws.id))
    .limit(limit + 1)
    .offset(offset);

  if (rows.length > limit) {
    return fail(c, `活动导出超过单次上限（${limit}），请缩小筛选条件或使用 offset 分批导出`, 400);
  }

  // 枚举值 → 中文标签映射，让 CSV 导出对运营更友好
  const STATUS_LABELS: Record<string, string> = {
    draft: "草稿", open: "进行中", paused: "已暂停",
    drawing: "开奖中", drawn: "已开奖", cancelled: "已取消",
  };
  const KIND_LABELS: Record<string, string> = {
    lottery: "抽奖", signup_chain: "报名链", reservation: "预约",
    vote: "投票", survey: "问卷", checkin: "签到", waitlist: "候补",
    approval: "审批", claim: "领取",
  };
  const MODE_LABELS: Record<string, string> = {
    open: "开放", roster: "名单", password: "密码", invite_code: "邀请码", registered: "注册用户",
  };
  const RESULT_LABELS: Record<string, string> = {
    manual: "手动开奖", scheduled: "定时开奖", instant: "即时开奖",
  };

  // 构建 CSV（UTF-8 BOM，确保 Excel 正确识别中文）
  const BOM = "\uFEFF";
  const csv = [
    "标题,状态,类型,参与模式,开奖模式,开始时间,结束时间,创建时间,更新时间",
    ...rows.map((r) => {
      return [
        csvEscape(r.title),
        csvEscape(STATUS_LABELS[r.status] || r.status),
        csvEscape(KIND_LABELS[r.activityKind || ""] || r.activityKind || ""),
        csvEscape(MODE_LABELS[r.participationMode || ""] || r.participationMode || ""),
        csvEscape(RESULT_LABELS[r.resultMode || ""] || r.resultMode || ""),
        csvEscape(r.startAt),
        csvEscape(r.endAt),
        csvEscape(r.createdAt),
        csvEscape(r.updatedAt),
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
  // 进行中活动能否修改结构性字段不能只看 status；真正的分界是是否已产生
  // entry / order / winner 事实。零参与活动仍可安全修正错误配置，避免只能取消重建。
  const isLive = draw.status === DRAW_STATUS.OPEN || draw.status === DRAW_STATUS.PAUSED;
  const [entryFact, orderFact, winnerFact] = isLive
    ? await Promise.all([
        db.select({ id: lotteryEntries.id }).from(lotteryEntries)
          .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, draw.id))).limit(1),
        db.select({ id: paymentOrders.id }).from(paymentOrders)
          .where(and(eq(paymentOrders.tenantId, tenantId), eq(paymentOrders.drawId, draw.id))).limit(1),
        db.select({ id: lotteryWinners.id }).from(lotteryWinners)
          .where(and(eq(lotteryWinners.tenantId, tenantId), eq(lotteryWinners.drawId, draw.id))).limit(1),
      ])
    : [[], [], []];
  const hasLifecycleFacts = entryFact.length > 0 || orderFact.length > 0 || winnerFact.length > 0;
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
  // P0 修复（2026-08 审查）：详情不回传密码哈希（避免前端复制/回填把哈希当明文二次哈希），
  // 改为 hasAccessPassword 布尔，供编辑表单显示"已设置密码，留空保持不变"。
  const { accessPassword: _accessPassword, ...drawSafe } = draw;
  return ok(c, {
    draw: { ...drawSafe, hasAccessPassword: Boolean(_accessPassword) },
    tiers,
    editPolicy: {
      isLive,
      hasLifecycleFacts,
      // 前端只把该标志用于交互收口；后端 PATCH 仍是最终权威。
      structuralFieldsLocked: isLive && hasLifecycleFacts,
    },
  });
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

  const usage = await getTenantUsage(db, tenantId);
  if (usage.limits.maxActivities !== null && usage.usage.activities >= usage.limits.maxActivities) {
    return fail(c, `当前套餐最多可保留 ${usage.limits.maxActivities} 个活动，请升级套餐或删除草稿活动`, 400);
  }

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
    expectedParticipants: draw.expectedParticipants,
    showParticipantCount: draw.showParticipantCount,
    showWinnerCount: draw.showWinnerCount,
    showWinnerList: draw.showWinnerList,
    promotionConfig: draw.promotionConfig,
    activityConfig: draw.activityConfig,
    productLink: draw.productLink,  // 复制导流商品链接（参与后展示的 CTA）
    maxSpinsPerEntry: Number(draw.maxSpinsPerEntry || 0),
    status: DRAW_STATUS.DRAFT,
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

    // docs/255 G-5：创建时校验 promotionConfig 结构（referralRewardDefs + viral + flashSale + dailyFree + pity）
    const promoIssues = validatePromotionConfig(body.promotionConfig);
    if (promoIssues) {
      return fail(c, `promotionConfig 配置无效：${promoIssues.join("；")}`, 400);
    }

    const activityKind = parseEnum(body.activityKind, ACTIVITY_KINDS, "活动类型", "lottery");
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
    const participationMode = parseEnum(body.participationMode, PARTICIPATION_MODES, "参与模式", "open");
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
    const drawTrigger = parseEnum(body.drawTrigger, DRAW_TRIGGERS, "开奖触发方式", triggerFallback);

    // 防御性校验：title/description 长度上限防止异常大 payload 消耗存储（二次审查 2026-08-23）
    if (String(body.title || "").length > 200) {
      return fail(c, "活动标题不能超过 200 个字符", 400);
    }
    if (String(body.description || "").length > 5000) {
      return fail(c, "活动描述不能超过 5000 个字符", 400);
    }

    // 运营者可通过系统配置控制活动创建的默认参数（闭环：L3 配置 → L2 生效）
    const configuredDefaultWinnerCount = parseInt(config["draw_default_winner_count"], 10);
    // 运营配置是外部可变输入；钳制到接口允许范围，避免错误配置让所有活动创建都失败。
    const defaultWinnerCount = Number.isInteger(configuredDefaultWinnerCount)
      ? Math.min(MAX_WINNER_COUNT, Math.max(1, configuredDefaultWinnerCount))
      : 1;
    const systemMaxParticipants = parseInt(config["draw_max_participants"], 10) || undefined;
    const requestedMaxParticipants = normalizeOptionalPositiveInteger(body.maxParticipants, "参与人数上限");
    // 方案 C 温和版（docs/239）：秒杀启用且设置了 stockLimit 时，活动级参与上限自动跟随
    // stockLimit，消除「名额 200 但 6 单截单」的运营误解。
    // 红线：运行时 resolveEffectiveStockLimit 的 stockLimit 优先逻辑不变（存量数据行为不变）。
    // 联动后仍走 createDraw 的套餐配额校验（stockLimit 超套餐上限会被拒绝，属预期收紧）。
    let effectiveMaxParticipants = requestedMaxParticipants ?? systemMaxParticipants;
    const promoNode = body.promotionConfig && typeof body.promotionConfig === "object" ? body.promotionConfig : undefined;
    const flashNode = (promoNode as Record<string, unknown> | undefined)?.flashSale
      ?? (promoNode as Record<string, unknown> | undefined)?.flash_sale;
    if (flashNode && typeof flashNode === "object" && !Array.isArray(flashNode)) {
      const flashObj = flashNode as Record<string, unknown>;
      const enabled = flashObj.enabled === true || flashObj.enabled === 1 || flashObj.enabled === "true";
      const stockRaw = flashObj.stockLimit ?? flashObj.stock_limit;
      if (enabled && stockRaw !== undefined && stockRaw !== null && stockRaw !== "") {
        const stockN = Number(stockRaw);
        if (Number.isInteger(stockN) && stockN > 0) {
          effectiveMaxParticipants = stockN;
        }
      }
    }
    // 活动最长持续时间校验：防止运营者设置超长活动占用资源
    const maxDurationDays = parseInt(config["draw_max_duration_days"], 10) || 90;
    const startAt = String(body.startAt || "");
    const endAt = String(body.endAt || "");
    const startMs = parseActivityTime(startAt, "开始时间");
    const endMs = parseActivityTime(endAt, "结束时间");
    if (startMs >= endMs) {
      return fail(c, "参与开始时间必须早于结束时间", 400);
    }
    if (endMs - startMs > maxDurationDays * 86400000) {
      return fail(c, `活动持续时间不能超过 ${maxDurationDays} 天`, 400);
    }

    // lottery + scheduled：若客户端仍传 resultMode=manual，与 drawTrigger 对齐，避免公开页文案说谎
    // lottery + instant：不因 drawAt 误推 scheduled（instant 无 performDraw）
    let resultModeInput = body.resultMode;
    const resolvedResultPeek = resultModeInput !== undefined
      ? parseEnum(resultModeInput, RESULT_MODES, "结果模式", defaultResultModeForActivity(activityKind, drawTrigger))
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

    // maxSpinsPerEntry 仅对「即时开奖的 lottery」生效（createDraw 对非 lottery 强制 0）。
    // 注意：仅 lottery+instant 才做严格校验；其它类型传该字段一律忽略——
    // 生产旧前端（≤8e64bad）因 claim 默认 resultMode=instant，创建 claim 时必传
    // maxSpinsPerEntry=1，严格拒绝会导致「新后端+旧前端」组合下 claim 创建/编辑全挂。
    let maxSpinsPerEntry: number | undefined;
    if (activityKind === "lottery" && resultModeInput === "instant") {
      if (body.maxSpinsPerEntry !== undefined && body.maxSpinsPerEntry !== null && body.maxSpinsPerEntry !== "") {
        const n = Number(body.maxSpinsPerEntry);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return fail(c, "每人抽奖次数须为 1–100 的整数", 400);
        }
        maxSpinsPerEntry = n;
      }
      // 未传 → createDraw 会抛「即时开奖必须设置每人抽奖次数（≥1）」兜底
    }

    // 组合校验：experienceType 必须在 activityKind 的允许白名单内
    const resolvedExperienceType = body.experienceType !== undefined
      ? parseEnum(body.experienceType, EXPERIENCE_TYPES, "互动体验", defaultExperienceForActivity(activityKind, participationMode))
      : defaultExperienceForActivity(activityKind, participationMode);
    if (!isValidExperienceForActivity(activityKind, resolvedExperienceType)) {
      return fail(c, `互动体验 "${resolvedExperienceType}" 不适用于活动类型 "${activityKind}"`, 400);
    }

    const { id, publicSlug } = await createDraw(db, tenantId, {
      title: String(body.title || ""),
      description: String(body.description || ""),
      activityKind,
      participationMode,
      experienceType: resolvedExperienceType,
      drawTrigger,
      resultMode: resultModeInput !== undefined
        ? parseEnum(resultModeInput, RESULT_MODES, "结果模式", defaultResultModeForActivity(activityKind, drawTrigger))
        : undefined,
      allocationPolicy: body.allocationPolicy !== undefined
        ? parseEnum(body.allocationPolicy, ALLOCATION_POLICIES, "名额策略", "capacity")
        : undefined,
      policyVersion: 1,
      startAt: String(body.startAt || ""),
      endAt: String(body.endAt || ""),
      drawAt: body.drawAt || undefined,
      accessPassword: String(body.accessPassword || ""),
      maxParticipants: effectiveMaxParticipants,
      // 预计参与人数（运营参考值）：非负整数，0 表示未设置
      expectedParticipants: body.expectedParticipants !== undefined
        ? (normalizeOptionalNonNegativeInteger(body.expectedParticipants, "预计参与") ?? 0)
        : 0,
      winnerCount: body.winnerCount !== undefined
        ? parseWinnerCount(body.winnerCount, activityKind)
        : parseWinnerCount(defaultWinnerCount, activityKind),
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

  // docs/255 G-5：编辑时校验 promotionConfig 结构（针对 merge 后的完整配置，非仅请求体）
  if (body.promotionConfig !== undefined) {
    const merged = mergeJsonTopLevel(draw.promotionConfig, body.promotionConfig);
    const promoIssues = validatePromotionConfig(JSON.parse(merged));
    if (promoIssues) {
      return fail(c, `promotionConfig 配置无效：${promoIssues.join("；")}`, 400);
    }
  }

  // ── 已开奖：仅允许 { visible: 0|1|true|false } ──
  if (draw.status === DRAW_STATUS.DRAWN) {
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

  if (draw.status === DRAW_STATUS.CANCELLED) {
    return fail(c, "已取消的活动不可编辑", 400);
  }

  // docs/223：进行中（OPEN）与暂停（PAUSED）的活动按是否已有业务事实分层编辑。
  // 零参与、零订单、零结果时仍可完整修正配置；一旦产生事实，只允许安全字段，
  // 避免改写已参与用户的资格、名额、价格、支付或结果语义。
  const isLiveEditable = draw.status === DRAW_STATUS.OPEN || draw.status === DRAW_STATUS.PAUSED;
  if (draw.status !== DRAW_STATUS.DRAFT && !isLiveEditable) {
    return fail(c, "只有草稿状态的活动可以编辑", 400);
  }

  // ── 业务事实查询与分层编辑门禁（DB 异常自然向上传播为 500，不吞成 400）──
  let hasLifecycleFacts = false;
  if (isLiveEditable) {
    const [entryFact, orderFact, winnerFact] = await Promise.all([
      db.select({ id: lotteryEntries.id }).from(lotteryEntries)
        .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId))).limit(1),
      db.select({ id: paymentOrders.id }).from(paymentOrders)
        .where(and(eq(paymentOrders.tenantId, tenantId), eq(paymentOrders.drawId, drawId))).limit(1),
      db.select({ id: lotteryWinners.id }).from(lotteryWinners)
        .where(and(eq(lotteryWinners.tenantId, tenantId), eq(lotteryWinners.drawId, drawId))).limit(1),
    ]);
    hasLifecycleFacts = entryFact.length > 0 || orderFact.length > 0 || winnerFact.length > 0;
    const definedKeys = Object.keys(body || {}).filter((key) => body[key] !== undefined);

    // docs/083：进行中活动不能靠 visible 假下架；必须走 pause/cancel 状态机，
    // 否则公开列表消失而已持有链接的用户仍可能处于参与或支付流程。
    if (definedKeys.includes("visible")) {
      return fail(c, "进行中的活动不能修改可见性，请使用暂停或取消", 400);
    }

    if (hasLifecycleFacts) {
      // LIVE_SAFE_FIELDS 白名单：进行中活动（已有参与/支付/中奖记录）可编辑的安全字段。
      // 判断标准：改动只影响「未来加入者」或「展示层」，绝不改写已参与用户的
      // 资格、名额、价格、支付或结果语义。新增字段必须逐个评估（docs/257 死磕）：
      //
      // accessPassword（2026-08 补充）：只影响密码模式的新加入者，已参与用户不受影响。
      //   运营设置错误密码导致新用户无法加入，需要能修正，不能因此复制整个活动。
      //   更新处（line 1152-1160）已有三态语义：null 清空 / 非空重哈希 / 空串保持。
      //
      // drawAt（2026-08 补充）：开奖时间的修改受 line 1065-1079 运行时校验约束：
      //   drawAt 必须晚于 endAt，而进行中活动的 endAt 只能延长（line 979-985），
      //   因此 drawAt 修改后必然仍指向未来，不会触发"立即开奖"事故。
      //   运营把开奖时间配错（如 1 小时而非 1 天）可以修正，不用复制活动。
      //
      // 明确不加的字段（会改写已参与用户语义，改动需走「复制活动」）：
      //   activityKind/participationMode/experienceType 维度切换、
      //   drawTrigger/resultMode 结果语义、winnerCount/maxSpinsPerEntry 配额、
      //   promotionConfig 中的秒杀价格/库存/支付（flashSale 部分）、publicSlug 链接、
      //   visible 可见性（已由 line 934-936 单独拦截，须走 pause/cancel 状态机）。
      const LIVE_SAFE_FIELDS = new Set([
        "title",
        "description",
        "endAt",
        "expectedParticipants",
        "showParticipantCount",
        "showWinnerCount",
        "showWinnerList",
        "productLink",
        // docs/257 死磕：activityConfig（投票选项图片、问卷字段描述等）的修改
        // 通过 mergeJsonTopLevel 做顶层键级合并，已有数据不受影响。
        // 运营发错选项图片地址后可以修正，不需要为了改一张图复制整个活动。
        "activityConfig",
        "accessPassword",
        "drawAt",
      ]);
      const unsafeFields = definedKeys.filter((key) => !LIVE_SAFE_FIELDS.has(key));
      if (unsafeFields.length > 0) {
        return fail(c, `已有参与或支付记录，进行中的活动不可修改以下字段：${unsafeFields.join("、")}（如需调整请复制活动）`, 400);
      }
    }
  }

  // ── 参数校验（统一 400；parseEnum/parseActivityTime/parseWinnerCount 抛错在此捕获）──
  let maxSpinsUpdate: number | undefined;
  let maxParticipantsUpdate: number | null | undefined;
  let nextActivityKind = draw.activityKind;
  let nextParticipationMode = draw.participationMode;
  let nextExperienceType = draw.experienceType || defaultExperienceForActivity(nextActivityKind, nextParticipationMode);
  let nextDrawTrigger = draw.drawTrigger;
  let nextResultMode = draw.resultMode || nextDrawTrigger;
  let nextAllocationPolicy = draw.allocationPolicy || "capacity";
  let nextWinnerCount: number | undefined;
  // 联动标记：activityKind 切换 / lottery+scheduled 强制对齐时，即使请求体未显式传
  // experienceType/resultMode，也要把联动后的值写入 DB（否则只算不写，语义分裂依旧）。
  let kindChanged = false;
  let resultModeForced = false;

  try {
    // 已产生业务事实后，结束时间只能延长；零参与活动可以完整修正时间窗。
    // docs/226 恢复路径：DB 中旧值可能已被旧 P0 漏洞写入非法时间，此时无法比较长短，
    // 直接放行合法新值覆盖，以便运营修复已污染的活动。
    if (hasLifecycleFacts && body.endAt !== undefined && body.endAt !== null) {
      const currentEndMs = tryParseTime(draw.endAt);
      const nextEnd = parseActivityTime(body.endAt, "结束时间");
      if (currentEndMs !== null && nextEnd < currentEndMs) {
        return fail(c, "进行中的活动结束时间只能延长，不能缩短", 400);
      }
    }

    // 先解析 next* 目标值（含 activityKind 切换时的联动重置），后续校验依赖它们。
    nextActivityKind = body.activityKind === undefined
      ? draw.activityKind
      : parseEnum(body.activityKind, ACTIVITY_KINDS, "活动类型");
    nextParticipationMode = body.participationMode === undefined
      ? draw.participationMode
      : parseEnum(body.participationMode, PARTICIPATION_MODES, "参与模式");
    nextDrawTrigger = body.drawTrigger === undefined
      ? draw.drawTrigger
      : parseEnum(body.drawTrigger, DRAW_TRIGGERS, "开奖触发方式");
    // 切换 activityKind 时联动重置 experienceType/resultMode 到新类型默认值，
    // 避免出现「前端转盘 + 后端接龙」这类语义分裂组合（2026-08 审查 P3/P4）。
    kindChanged = nextActivityKind !== draw.activityKind;
    nextExperienceType = body.experienceType !== undefined
      ? parseEnum(body.experienceType, EXPERIENCE_TYPES, "互动体验")
      : kindChanged
        ? defaultExperienceForActivity(nextActivityKind, nextParticipationMode)
        : draw.experienceType || defaultExperienceForActivity(nextActivityKind, nextParticipationMode);
    // 组合校验：experienceType 必须在 activityKind 的允许白名单内
    if (!isValidExperienceForActivity(nextActivityKind, nextExperienceType)) {
      return fail(c, `互动体验 "${nextExperienceType}" 不适用于活动类型 "${nextActivityKind}"`, 400);
    }
    // lottery + scheduled：与创建路由对齐（docs/115）——resultMode 未显式传或传 manual 时强制 scheduled，
    // 避免「Cron 只扫 scheduled 而 resultMode=manual」导致到点永不自动开奖。
    let nextResultModeInput = body.resultMode === undefined
      ? (kindChanged
          ? defaultResultModeForActivity(nextActivityKind, nextDrawTrigger)
          : draw.resultMode || nextDrawTrigger)
      : parseEnum(body.resultMode, RESULT_MODES, "结果模式");
    if (
      nextActivityKind === "lottery" &&
      nextDrawTrigger === "scheduled" &&
      nextResultModeInput !== "instant" &&
      (body.resultMode === undefined ||
        body.resultMode === null ||
        String(body.resultMode).trim() === "" ||
        String(body.resultMode).trim().toLowerCase() === "manual")
    ) {
      nextResultModeInput = "scheduled";
      resultModeForced = true;
    }
    nextResultMode = nextResultModeInput;
    nextAllocationPolicy = body.allocationPolicy === undefined
      ? draw.allocationPolicy || "capacity"
      : parseEnum(body.allocationPolicy, ALLOCATION_POLICIES, "名额策略");
    nextWinnerCount = body.winnerCount === undefined
      ? undefined
      : parseWinnerCount(body.winnerCount, nextActivityKind);

    // maxSpinsPerEntry：仅对「即时开奖的 lottery」生效（2026-08 审查 P5）。
    // - 即时抽奖：必须 ≥1（0 会锁死抽奖，关闭请走暂停状态机）；
    // - 非即时活动：忽略该字段（兼容旧前端 claim 必传 maxSpins=1 的行为，
    //   避免「新后端+旧前端」组合下 claim 创建/编辑全挂）；
    // - 语义切换（instant → 其它）时联动清除残留配置。
    if (nextActivityKind === "lottery" && nextResultMode === "instant") {
      if (body.maxSpinsPerEntry !== undefined && body.maxSpinsPerEntry !== null && body.maxSpinsPerEntry !== "") {
        const n = Number(body.maxSpinsPerEntry);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return fail(c, "每人抽奖次数须为 1–100 的整数", 400);
        }
        maxSpinsUpdate = n;
      }
    }
    // 联动清除：活动不再即时抽奖时，清掉残留的 maxSpinsPerEntry（避免死配置残留）。
    if (maxSpinsUpdate === undefined && !(nextActivityKind === "lottery" && nextResultMode === "instant") && Number(draw.maxSpinsPerEntry || 0) > 0) {
      maxSpinsUpdate = 0;
    }

    // PATCH 三态语义：未传 = 保持，null 仅允许清空 drawAt，空字符串/非法时间一律拒绝。
    // docs/226 恢复路径：旧值可能已被旧 P0 漏洞写入非法时间。
    // - 若请求体显式提供时间，则严格校验新值；
    // - 若未提供，则保留旧值（即使已污染），不因此阻塞无关编辑；
    // - 扩展检查（只能延长）对污染旧值自动放行，允许运营通过提供合法新值覆盖修复。
    const startMs = body.startAt !== undefined
      ? parseActivityTime(body.startAt, "开始时间")
      : tryParseTime(draw.startAt);
    const endMs = body.endAt !== undefined
      ? parseActivityTime(body.endAt, "结束时间")
      : tryParseTime(draw.endAt);
    if (startMs !== null && endMs !== null && startMs >= endMs) {
      return fail(c, "参与开始时间必须早于结束时间", 400);
    }
    const nextDrawAt = body.drawAt === null
      ? null
      : body.drawAt === undefined
        ? draw.drawAt
        : body.drawAt;
    if (nextDrawAt !== null && nextDrawAt !== undefined) {
      const drawMs = body.drawAt !== undefined
        ? parseActivityTime(body.drawAt, "开奖时间")
        : tryParseTime(draw.drawAt);
      if (body.drawAt !== undefined && drawMs === null) {
        return fail(c, "开奖时间格式无效，请提供有效值", 400);
      }
      if (drawMs !== null && endMs !== null && endMs >= drawMs) {
        return fail(c, "开奖时间必须在参与结束后", 400);
      }
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
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "活动参数无效", 400);
  }

  // maxParticipants 参数解析（400 范围）与套餐配额校验（DB 异常自然 500）
  if (body.maxParticipants !== undefined) {
    try {
      maxParticipantsUpdate = body.maxParticipants === null || body.maxParticipants === ""
        ? null
        : normalizeOptionalPositiveInteger(body.maxParticipants, "参与人数上限");
    } catch (err) {
      return fail(c, err instanceof Error ? err.message : "参与人数上限无效", 400);
    }
  }
  // 方案 C 温和版（docs/239）：秒杀启用且设置了 stockLimit 时，活动级参与上限自动跟随
  // stockLimit（消除「名额 200 但 6 单截单」误解）。红线：运行时 resolveEffectiveStockLimit
  // 的 stockLimit 优先逻辑不变（存量数据行为不变）。
  // 联动基于「合并后的 promotionConfig」（顶层键级 merge），与 update 语句写入的最终值同源；
  // 仅当请求体未显式传 maxParticipants 时联动（显式传了以显式为准，发布预检 error 兜底不一致）。
  // ⚠️ 进行中活动（hasLifecycleFacts）禁止联动：maxParticipants 不在 LIVE_SAFE_FIELDS 白名单，
  // 若联动写库会绕过「进行中活动不可修改参与上限」的门禁，静默篡改已发布活动的容量。
  // 存量不一致的进行中活动保持原值，由发布预检 error 提示运营处理（docs/239 复核修复）。
  if (maxParticipantsUpdate === undefined && !hasLifecycleFacts) {
    const nextPromoRaw = body.promotionConfig !== undefined
      ? mergeJsonTopLevel(draw.promotionConfig, body.promotionConfig)
      : draw.promotionConfig;
    const flashParsed = parseFlashSaleConfig(nextPromoRaw);
    const stock = flashParsed.config?.stockLimit;
    if (stock != null && stock > 0) {
      maxParticipantsUpdate = stock;
    }
  }
  if (maxParticipantsUpdate !== undefined && maxParticipantsUpdate !== null) {
    const quota = await getTenantUsage(db, tenantId);
    if (maxParticipantsUpdate > quota.limits.maxParticipantsPerActivity) {
      return fail(c, `当前套餐单活动最多允许 ${quota.limits.maxParticipantsPerActivity} 人参与，请降低名额或升级套餐`, 403);
    }
  }

  // 防御性校验：title/description 长度上限防止异常大 payload 消耗存储（二次审查 2026-08-23）
  if (body.title !== undefined && String(body.title).length > 200) {
    return fail(c, "活动标题不能超过 200 个字符", 400);
  }
  if (body.description !== undefined && String(body.description).length > 5000) {
    return fail(c, "活动描述不能超过 5000 个字符", 400);
  }

  await db
    .update(lotteryDraws)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.activityKind !== undefined ? { activityKind: nextActivityKind } : {}),
      ...(body.participationMode !== undefined ? { participationMode: nextParticipationMode } : {}),
      // 联动写入：切换 activityKind 时重置 experienceType（kindChanged），
      // lottery+scheduled 对齐 resultMode（resultModeForced）——即使请求体未显式传也写库。
      ...(body.experienceType !== undefined || kindChanged ? { experienceType: nextExperienceType } : {}),
      ...(body.drawTrigger !== undefined ? { drawTrigger: nextDrawTrigger } : {}),
      ...(body.resultMode !== undefined || kindChanged || resultModeForced ? { resultMode: nextResultMode } : {}),
      ...(body.allocationPolicy !== undefined ? { allocationPolicy: nextAllocationPolicy } : {}),
      ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
      ...(body.drawAt !== undefined ? { drawAt: body.drawAt } : {}),
      ...(nextWinnerCount !== undefined ? { winnerCount: nextWinnerCount } : {}),
      ...(body.expectedParticipants !== undefined ? { expectedParticipants: normalizeOptionalNonNegativeInteger(body.expectedParticipants, "预计参与") ?? 0 } : {}),
      ...(maxSpinsUpdate !== undefined ? { maxSpinsPerEntry: maxSpinsUpdate } : {}),
      ...(maxParticipantsUpdate !== undefined ? { maxParticipants: maxParticipantsUpdate } : {}),
      // P0 修复（2026-08 审查）：accessPassword 三态语义——
      //   null → 显式清空密码；""（空串）→ 跳过不修改（编辑表单不回填密码，保存必发空串，
      //   旧实现把空串当"清空"导致编辑任意字段后访问门禁被静默移除）；
      //   非空 → 重新哈希并设置（createDraw 也走 hashAccessPassword，语义一致）。
      ...(body.accessPassword === null
        ? { accessPassword: "" }
        : body.accessPassword !== undefined && String(body.accessPassword || "").trim() !== ""
          ? { accessPassword: await hashAccessPassword(String(body.accessPassword)) }
          : {}),
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
      // P1 修复（2026-08 审查）：promotionConfig / activityConfig 由"整包覆盖"改为"顶层键级 merge"，
      // 前端重建整包时未知键（operational / prizeImage / 未来扩展块）原样保留，杜绝编辑静默擦除配置。
      ...(body.promotionConfig !== undefined
        ? { promotionConfig: mergeJsonTopLevel(draw.promotionConfig, body.promotionConfig) }
        : {}),
      ...(body.activityConfig !== undefined
        ? { activityConfig: mergeJsonTopLevel(draw.activityConfig, body.activityConfig) }
        : {}),
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
    const [publishedDraw] = await db
      .select({
        title: lotteryDraws.title,
        publicSlug: lotteryDraws.publicSlug,
        drawAt: lotteryDraws.drawAt,
      })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);
    if (publishedDraw) {
      // 发布通知只写平台投递队列，不同步调用 QQ/Telegram；入队失败不回滚已发布活动。
      await enqueuePlatformEvent(db, {
        tenantId,
        drawId,
        eventType: "draw.published",
        data: {
          drawName: publishedDraw.title,
          drawAt: publishedDraw.drawAt || "",
          shareUrl: publishedDraw.publicSlug ? `/lottery/${encodeURIComponent(publishedDraw.publicSlug)}` : "",
        },
      }).catch((err) => {
        logError("admin-lottery", `enqueuePlatformEvent draw.published failed for ${drawId}`, err);
      });
    }
    return ok(c, { status: DRAW_STATUS.OPEN });
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
  return ok(c, { status: DRAW_STATUS.PAUSED });
});

/** 恢复活动（paused → open） */
adminLotteryRoute.post("/draws/:id/resume", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const result = await resumeDraw(db, tenantId, drawId);
  if (!result) return fail(c, "活动不存在或未暂停", 400);
  await recordTenantAudit(c, "draw.resume", "lottery_draw", drawId);
  return ok(c, { status: DRAW_STATUS.OPEN });
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
    return ok(c, { status: DRAW_STATUS.CANCELLED });
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
    if (isInstantResultMode(draw.resultMode)) {
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

/**
 * 查询奖励发放失败记录（docs/259 P1-2 补充：运营可查看全量失败）。
 *
 * 数据来源：activity_events 表中 eventType='reward_failed' 的记录。
 * 失败事件由 maybeTriggerReward 的三条奖励路径（grantViralSpinsToSharer /
 * processReferralRewardsEngine / triggerRewardEarned）的 catch 块写入，
 * metadata 中包含 path（失败路径）、error（错误信息）、shareRecordId（关联分享记录）。
 *
 * 为什么用 activity_events 而非独立的 reward_failures 表：
 * reward_failed 事件与其他活动事件（participation_completed / reward_earned 等）共享
 * 同一审计链路，复用 activity_events 的租户隔离 + 时间索引，不引入额外表维护成本。
 * 缺点是 metadataJson 需要 parse，但失败记录量级远小于正常事件，性能可接受。
 */
adminLotteryRoute.get("/draws/:id/rewards/failures", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  try {
    const draw = await getDraw(db, drawId, tenantId);
    if (!draw) return fail(c, "活动不存在", 404);

    const rows = await db
      .select({
        id: activityEvents.id,
        entryId: activityEvents.entryId,
        refCode: activityEvents.refCode,
        createdAt: activityEvents.createdAt,
        metadataJson: activityEvents.metadataJson,
      })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, tenantId),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_failed"),
      ))
      .orderBy(desc(activityEvents.createdAt))
      // 防极端情况：失败记录极多时列表接口可能慢，限制最多返回 200 条
      .limit(200);

    // 过滤掉 cancelRewardPending 的取消记录（status=cancelled）：
    // 这些是支付取消/退款/超时后的正常清理，不是真正的奖励发放失败。
    // 混入会导致运营误点"补发"，对已取消的支付触发不必要的奖励重试。
    const list = rows.map((r) => {
      let meta: Record<string, unknown> = {}
      try { meta = JSON.parse(r.metadataJson || "{}") } catch { /* ignore */ }
      return {
        id: r.id,
        entryId: r.entryId,
        refCode: r.refCode,
        createdAt: r.createdAt,
        path: meta.path || "",
        error: meta.error || "",
        shareRecordId: meta.shareRecordId || "",
        identityType: "",
        identityValue: "",
      }
    }).filter((r) => r.path !== "cancelRewardPending")

    // 批量查询 entryId 对应的身份信息，供 decorateIdentityDisplay 解析为可读名称
    const entryIds = [...new Set(list.map((r) => r.entryId).filter(Boolean))];
    if (entryIds.length > 0) {
      const entries = await db
        .select({
          id: lotteryEntries.id,
          identityType: lotteryEntries.identityType,
          identityValue: lotteryEntries.identityValue,
        })
        .from(lotteryEntries)
        .where(inArray(lotteryEntries.id, entryIds));
      const entryMap = new Map(entries.map((e) => [e.id, e]));
      for (const r of list) {
        const entry = entryMap.get(r.entryId);
        if (entry) {
          r.identityType = entry.identityType || "";
          r.identityValue = entry.identityValue || "";
        }
      }
      await decorateIdentityDisplay(db, list);
    }

    // 保留 identityDisplay 供前端展示，同时清理内部字段
    const result = list.map(({ identityType: _, identityValue: __, ...rest }) => rest);

    return ok(c, { failures: result });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "查询失败", 400);
  }
});

/**
 * 补发奖励（docs/259 P1-2：reward_failed 事件重试入口）。
 *
 * 设计决策：
 * 1. 为什么重新调用 triggerRewardEarned 而非直接发券/发 spins？
 *    triggerRewardEarned 内部有完整的配额检查（perUserPerDay / globalPerDay）+ 事件去重，
 *    重试时会自动跳过已发放的记录，不会超发。直接发券/发 spins 则需要重新实现配额逻辑，
 *    违反"奖励逻辑单一实现"原则。
 *
 * 2. 为什么不用事务包裹批量重试？
 *    triggerRewardEarned 本身包含 DB 写入（reward_earned 事件 + 可能的 webhook 入队），
 *    事务内嵌套事务在 SQLite 下会退化为 savepoint，增加锁持有时间。
 *    逐条独立执行：部分成功部分失败时，审计日志如实记录每条结果，运营可针对性处理。
 *    配额保护确保不会超发（即使两条重试都成功，perUserPerDay 只允许一次）。
 *
 * 3. all=true 语义：批量重试该活动所有失败记录（按 createdAt 正序），
 *    默认只重试最近一条（防止运营误操作批量补发）。
 *
 * 4. entryId 过滤：运营可指定补发某个人的失败记录，而非全部重试。
 *    适用于"某用户反馈未收到奖励"的客服场景。
 */
adminLotteryRoute.post("/draws/:id/rewards/reissue", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  try {
    const draw = await getDraw(db, drawId, tenantId);
    if (!draw) return fail(c, "活动不存在", 404);

    const all = c.req.query("all") === "true";
    const entryIdFilter = c.req.query("entryId")?.trim() || "";

    // 查询该活动下所有 reward_failed 事件，按创建时间正序逐个重试，保证顺序。
    // entryId 过滤：运营可指定补发某个人的失败记录，而非全部重试。
    const conditions = [
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.eventType, "reward_failed"),
    ];
    if (entryIdFilter) {
      conditions.push(eq(activityEvents.entryId, entryIdFilter));
    }
    const allFailures = await db
      .select()
      .from(activityEvents)
      .where(and(...conditions))
      .orderBy(desc(activityEvents.createdAt));

    // 过滤掉 cancelRewardPending 的取消记录：支付取消/退款/超时后的正常清理，
    // 不是真正的奖励发放失败，补发无意义（支付已不存在）
    const failures = allFailures.filter((f) => {
      try {
        const meta = JSON.parse(f.metadataJson || "{}");
        return meta.path !== "cancelRewardPending";
      } catch { return true; }
    });

    if (failures.length === 0) {
      return fail(c, "该活动暂无奖励发放失败记录", 400);
    }

    // 仅重试最近一条（默认行为）
    const targets = all ? failures.reverse() : failures.slice(0, 1);

    // 逐条重试，内部 triggerRewardEarned 已具备配额 + 幂等保护，不会重复发放。
    const results = [];
    for (const f of targets) {
      const sharerEntryId = f.entryId || "";
      const refCode = f.refCode || "";
      if (!sharerEntryId) {
        results.push({ sharerEntryId: "", refCode, triggered: false, reason: "失败事件缺少 entryId" })
        continue
      }
      const sharerIdentity = await getSharerIdentityValue(db, tenantId, drawId, sharerEntryId);
      const result = await triggerRewardEarned(
        db,
        tenantId,
        drawId,
        sharerEntryId,
        sharerIdentity,
        refCode,
        { source: "reissue" },
      );
      results.push({ ...result, refCode })
    }

    const anyTriggered = results.some(r => r.triggered)
    const summary = results.filter(r => r.triggered).map(r => r.sharerEntryId)

    await recordTenantAudit(c, "draw.reward.reissue", "lottery_draw", drawId, {
      all,
      count: results.length,
      triggered: anyTriggered,
      results: summary,
    });

    return ok(c, {
      reissued: anyTriggered,
      reason: all ? `批量重试完成：${results.length} 条，成功 ${summary.length}` : results[0]?.reason || "",
      sharerEntryId: results[0]?.sharerEntryId || "",
      results,
    });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "补发失败", 400);
  }
});

// ── 投票/问卷结果统计（docs/267 P0）──
// GET /api/admin/draws/:id/vote-survey-stats
// 返回投票选项分布或问卷字段答案统计，用于管理端结果面板。
adminLotteryRoute.get("/draws/:id/vote-survey-stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const limit = Math.min(Number(c.req.query("limit") || 20), 100);

  try {
    const { getVoteSurveyStats } = await import("../services/lottery/vote-survey-stats");
    const stats = await getVoteSurveyStats(db, tenantId, drawId, { limit });
    return ok(c, stats as unknown as Record<string, unknown>);
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "查询失败", 400);
  }
});
