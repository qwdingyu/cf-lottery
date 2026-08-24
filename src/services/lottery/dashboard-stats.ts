/**
 * 管理后台数据看板统计服务（docs/267 P1）
 *
 * 提供两类只读统计 API：
 * 1. 参与趋势（participationTrend）：按日/周/月聚合参与人数，用于趋势图表
 * 2. 转化漏斗（conversionFunnel）：访问→参与→中奖→领奖各阶段人数
 *
 * 所有查询均为只读聚合，不影响业务逻辑。
 */
import type { DbType } from "../../db/client";
import { eq, and, sql } from "drizzle-orm";
import {
  lotteryEntries,
  lotteryWinners,
  activityEvents,
} from "../../db/schema";

// ═══════════════════════════════════════════════════════
// 参与趋势
// ═══════════════════════════════════════════════════════

/** 参与趋势数据点 */
export interface TrendDataPoint {
  /** 日期标签（YYYY-MM-DD / YYYY-MM-DD~MM-DD / YYYY-MM） */
  label: string;
  /** 该时段新增参与人数 */
  newParticipants: number;
}

/** 参与趋势查询参数 */
export interface TrendOptions {
  /** 聚合粒度：day / week / month，默认 day */
  granularity?: "day" | "week" | "month";
  /** 回溯天数，默认 30，最大 365 */
  days?: number;
  /** 可选：限定活动 ID，不传则统计该租户全部活动 */
  drawId?: string;
}

/**
 * 查询参与趋势数据。
 *
 * SQLite 日期处理：使用 date(createdAt) 提取 YYYY-MM-DD，
 * 再按 granularity 格式化为周/月标签。
 */
export async function getParticipationTrend(
  db: DbType,
  tenantId: string,
  options?: TrendOptions,
): Promise<TrendDataPoint[]> {
  const granularity = options?.granularity || "day";
  const days = Math.max(1, Math.min(365, options?.days || 30));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  // 构建日期分组表达式
  // day:  date(joined_at) → '2026-08-24'
  // week: date(joined_at, 'weekday 1', '-7 days') → 该周周一
  // month: substr(date(joined_at), 1, 7) → '2026-08'
  let dateExpr: ReturnType<typeof sql>;
  let dateFormat: string;
  switch (granularity) {
    case "week":
      dateExpr = sql`date(${lotteryEntries.joinedAt}, 'weekday 1', '-7 days')`;
      dateFormat = "week";
      break;
    case "month":
      dateExpr = sql`substr(${lotteryEntries.joinedAt}, 1, 7)`;
      dateFormat = "month";
      break;
    default:
      dateExpr = sql`date(${lotteryEntries.joinedAt})`;
      dateFormat = "day";
  }

  const conditions = [
    eq(lotteryEntries.tenantId, tenantId),
    sql`${lotteryEntries.joinedAt} >= ${cutoff}`,
  ];
  if (options?.drawId) {
    conditions.push(eq(lotteryEntries.drawId, options.drawId));
  }

  const rows = await db
    .select({
      label: dateExpr.as("label"),
      count: sql<number>`COUNT(DISTINCT ${lotteryEntries.id})`,
    })
    .from(lotteryEntries)
    .where(and(...conditions))
    .groupBy(dateExpr)
    .orderBy(dateExpr);

  // 补充缺失日期（趋势图需要连续时间轴）
  if (dateFormat !== "day") {
    return rows.map((r) => ({ label: String(r.label ?? ""), newParticipants: Number(r.count) }));
  }

  const result: TrendDataPoint[] = [];
  const labelCountMap = new Map(rows.map((r) => [String(r.label ?? ""), Number(r.count)]));
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const label = d.toISOString().slice(0, 10);
    result.push({
      label,
      newParticipants: labelCountMap.get(label) ?? 0,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════
// 转化漏斗
// ═══════════════════════════════════════════════════════

/** 漏斗阶段数据 */
export interface FunnelStage {
  /** 阶段名称 */
  stage: string;
  /** 该阶段人数 */
  count: number;
  /** 占上一阶段的百分比（0-100），第一阶段为 100 */
  conversionRate: number;
}

/** 转化漏斗查询参数 */
export interface FunnelOptions {
  /** 回溯天数，默认 30，最大 365 */
  days?: number;
  /** 可选：限定活动 ID */
  drawId?: string;
}

/**
 * 查询转化漏斗数据。
 *
 * 漏斗阶段：
 * 1. 访问（page_view 事件）
 * 2. 参与（lottery_entries）
 * 3. 中奖（lottery_winners）
 * 4. 领奖（notificationStatus=sent，表示通知已发送/已领）
 */
export async function getConversionFunnel(
  db: DbType,
  tenantId: string,
  options?: FunnelOptions,
): Promise<FunnelStage[]> {
  const days = Math.max(1, Math.min(365, options?.days || 30));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  // 阶段 1：访问（page_view 事件，按 entryId 去重）
  const viewConditions = [
    eq(activityEvents.tenantId, tenantId),
    eq(activityEvents.eventType, "page_view"),
    sql`${activityEvents.createdAt} >= ${cutoff}`,
  ];
  if (options?.drawId) {
    viewConditions.push(eq(activityEvents.drawId, options.drawId));
  }
  const [viewRow] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${activityEvents.entryId})` })
    .from(activityEvents)
    .where(and(...viewConditions));

  // 阶段 2：参与（lottery_entries）
  const joinConditions = [
    eq(lotteryEntries.tenantId, tenantId),
    sql`${lotteryEntries.joinedAt} >= ${cutoff}`,
  ];
  if (options?.drawId) {
    joinConditions.push(eq(lotteryEntries.drawId, options.drawId));
  }
  const [joinRow] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${lotteryEntries.id})` })
    .from(lotteryEntries)
    .where(and(...joinConditions));

  // 阶段 3：中奖（lottery_winners）
  const winConditions = [
    eq(lotteryWinners.tenantId, tenantId),
    sql`${lotteryWinners.drawnAt} >= ${cutoff}`,
  ];
  if (options?.drawId) {
    winConditions.push(eq(lotteryWinners.drawId, options.drawId));
  }
  const [winRow] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${lotteryWinners.id})` })
    .from(lotteryWinners)
    .where(and(...winConditions));

  // 阶段 4：领奖（notificationStatus=sent 表示通知已发送/已领取）
  const deliverConditions = [
    eq(lotteryWinners.tenantId, tenantId),
    eq(lotteryWinners.notificationStatus, "sent"),
    sql`${lotteryWinners.drawnAt} >= ${cutoff}`,
  ];
  if (options?.drawId) {
    deliverConditions.push(eq(lotteryWinners.drawId, options.drawId));
  }
  const [deliverRow] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${lotteryWinners.id})` })
    .from(lotteryWinners)
    .where(and(...deliverConditions));

  const views = Number(viewRow?.count ?? 0);
  const joins = Number(joinRow?.count ?? 0);
  const wins = Number(winRow?.count ?? 0);
  const delivers = Number(deliverRow?.count ?? 0);

  return [
    { stage: "访问", count: views, conversionRate: 100 },
    { stage: "参与", count: joins, conversionRate: views > 0 ? round10(joins / views * 100) : 0 },
    { stage: "中奖", count: wins, conversionRate: joins > 0 ? round10(wins / joins * 100) : 0 },
    { stage: "领奖", count: delivers, conversionRate: wins > 0 ? round10(delivers / wins * 100) : 0 },
  ];
}

/** 四舍五入到一位小数 */
function round10(n: number): number {
  return Math.round(n * 10) / 10;
}
