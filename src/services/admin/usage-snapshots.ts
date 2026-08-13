/**
 * 租户用量快照刷新函数
 *
 * 由 Cron 定时任务调用，聚合各租户的用量数据写入 tenant_usage_snapshots 表。
 * 避免在管理后台做实时全表 COUNT。
 *
 * 优化（H2）：5 条 GROUP BY 批量聚合替代 N+1 逐租户 COUNT，一次批量 UPSERT。
 * 背景：activity_events 已有 (tenant_id, draw_id, event_type, created_at) 联合索引，
 * 各组查询均可走索引覆盖扫描。
 */
import type { DbType } from "../../db/client";
import { tenants, lotteryDraws, lotteryEntries, lotteryWinners, activityEvents, webhookDeliveries, tenantUsageSnapshots } from "../../db/schema";
import { eq, and, count, sql, max } from "drizzle-orm";
import { todayStr } from "../platform/checkin-reward";

/**
 * 从批查询结果构建 { tenantId → count } 映射。
 * 全部租户即使某表无记录也以 0 兜底，确保快照完整。
 */
function buildCountMap(rows: { tenantId: string; total: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.tenantId, Number(row.total));
  }
  return map;
}

/**
 * 刷新所有租户的用量快照
 *
 * 替代方案对比：
 *  - 旧方案（N+1）：逐租户 5 次 COUNT + 1 UPSERT = 6N 次查询
 *  - 新方案（批量）：5 批 GROUP BY + 1 批 UPSERT = 6 次查询（无论租户数）
 *
 * 建议在 Cron 中每 5 分钟或每小时执行一次。
 */
export async function refreshAllTenantSnapshots(db: DbType): Promise<{ processed: number }> {
  const allTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  if (allTenants.length === 0) return { processed: 0 };

  // snapshotDate 用本地时区「今日」（与签到/每日免费 todayStr 一致）。
  // 若用 UTC 日期，UTC+8 等偏移时区下管理员看到的「今日快照」会挂到昨天日期。
  const today = todayStr();
  const now = new Date().toISOString();

  // 5 条批量 GROUP BY 查询（替代 5N 条逐租户 COUNT）
  // 每个查询返回 { tenantId, total }[]，无记录的租户不会出现在结果中
  const [activityRows, participantRows, eventRows, winnerRows, webhookRows] = await Promise.all([
    db
      .select({ tenantId: lotteryDraws.tenantId, total: count() })
      .from(lotteryDraws)
      .where(sql`${lotteryDraws.status} <> 'cancelled'`)
      .groupBy(lotteryDraws.tenantId),
    db
      .select({ tenantId: lotteryEntries.tenantId, total: count() })
      .from(lotteryEntries)
      .groupBy(lotteryEntries.tenantId),
    db
      .select({ tenantId: activityEvents.tenantId, total: count() })
      .from(activityEvents)
      .groupBy(activityEvents.tenantId),
    db
      .select({ tenantId: lotteryWinners.tenantId, total: count() })
      .from(lotteryWinners)
      .groupBy(lotteryWinners.tenantId),
    db
      .select({ tenantId: webhookDeliveries.tenantId, total: count() })
      .from(webhookDeliveries)
      .groupBy(webhookDeliveries.tenantId),
  ]);

  // 构建 tenantId → count 映射
  const activityMap = buildCountMap(activityRows);
  const participantMap = buildCountMap(participantRows);
  const eventMap = buildCountMap(eventRows);
  const winnerMap = buildCountMap(winnerRows);
  const webhookMap = buildCountMap(webhookRows);

  // 组装批量插入值，无记录的租户 count 为 0
  const snapshotValues = allTenants.map((t) => ({
    tenantId: t.id,
    snapshotDate: today,
    activityCount: activityMap.get(t.id) ?? 0,
    participantCount: participantMap.get(t.id) ?? 0,
    eventCount: eventMap.get(t.id) ?? 0,
    winnerCount: winnerMap.get(t.id) ?? 0,
    webhookCount: webhookMap.get(t.id) ?? 0,
    updatedAt: now,
  }));

  // 批量 UPSERT：已有今日快照则更新，无则插入
  // 使用 excluded.column 引用 INSERT 子句的值，确保每行独立更新
  await db
    .insert(tenantUsageSnapshots)
    .values(snapshotValues)
    .onConflictDoUpdate({
      target: [tenantUsageSnapshots.tenantId, tenantUsageSnapshots.snapshotDate],
      set: {
        activityCount: sql`excluded.activity_count`,
        participantCount: sql`excluded.participant_count`,
        eventCount: sql`excluded.event_count`,
        winnerCount: sql`excluded.winner_count`,
        webhookCount: sql`excluded.webhook_count`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  return { processed: allTenants.length };
}

/**
 * 读取所有租户的最新快照汇总。
 *
 * 平台统计页不再逐表扫 lottery_entries / lottery_winners / activity_events / webhook_deliveries，
 * 而是汇总每个租户最新的一条快照，避免对热表做全量 COUNT。
 */
export async function readLatestTenantUsageSnapshotTotals(db: DbType): Promise<{
  activityCount: number;
  participantCount: number;
  eventCount: number;
  winnerCount: number;
  webhookCount: number;
  tenantCount: number;
  latestSnapshotDate: string | null;
}> {
  const latestSnapshotPerTenant = db
    .select({
      tenantId: tenantUsageSnapshots.tenantId,
      snapshotDate: max(tenantUsageSnapshots.snapshotDate).as("snapshotDate"),
    })
    .from(tenantUsageSnapshots)
    .groupBy(tenantUsageSnapshots.tenantId)
    .as("latest_snapshot_per_tenant");

  const rows = await db
    .select({
      tenantId: tenantUsageSnapshots.tenantId,
      snapshotDate: tenantUsageSnapshots.snapshotDate,
      activityCount: tenantUsageSnapshots.activityCount,
      participantCount: tenantUsageSnapshots.participantCount,
      eventCount: tenantUsageSnapshots.eventCount,
      winnerCount: tenantUsageSnapshots.winnerCount,
      webhookCount: tenantUsageSnapshots.webhookCount,
    })
    .from(tenantUsageSnapshots)
    .innerJoin(
      latestSnapshotPerTenant,
      and(
        eq(tenantUsageSnapshots.tenantId, latestSnapshotPerTenant.tenantId),
        eq(tenantUsageSnapshots.snapshotDate, latestSnapshotPerTenant.snapshotDate),
      ),
    );

  const totals = {
    activityCount: 0,
    participantCount: 0,
    eventCount: 0,
    winnerCount: 0,
    webhookCount: 0,
    tenantCount: rows.length,
    latestSnapshotDate: null as string | null,
  };

  for (const row of rows) {
    totals.activityCount += Number(row.activityCount || 0);
    totals.participantCount += Number(row.participantCount || 0);
    totals.eventCount += Number(row.eventCount || 0);
    totals.winnerCount += Number(row.winnerCount || 0);
    totals.webhookCount += Number(row.webhookCount || 0);
    if (!totals.latestSnapshotDate || row.snapshotDate > totals.latestSnapshotDate) {
      totals.latestSnapshotDate = row.snapshotDate;
    }
  }

  return totals;
}
