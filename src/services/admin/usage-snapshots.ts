/**
 * 租户用量快照刷新函数
 *
 * 由 Cron 定时任务调用，聚合各租户的用量数据写入 tenant_usage_snapshots 表。
 * 避免在管理后台做实时全表 COUNT。
 */
import type { DbType } from "../../db/client";
import { tenants, lotteryDraws, lotteryEntries, lotteryWinners, activityEvents, webhookDeliveries, tenantUsageSnapshots } from "../../db/schema";
import { eq, and, count, sql, max } from "drizzle-orm";

/**
 * 刷新所有租户的用量快照
 *
 * 按租户逐条聚合，避免大范围 GROUP BY 导致的 Turso rows read 激增。
 * 建议在 Cron 中每 5 分钟或每小时执行一次。
 */
export async function refreshAllTenantSnapshots(db: DbType): Promise<{ processed: number }> {
  const allTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  const today = new Date().toISOString().slice(0, 10);
  let processed = 0;

  for (const tenant of allTenants) {
    const tenantId = tenant.id;

    // 活动数（排除取消状态）
    const [activityRow] = await db
      .select({ total: count() })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.tenantId, tenantId), sql`${lotteryDraws.status} <> 'cancelled'`));

    // 参与人数
    const [participantRow] = await db
      .select({ total: count() })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.tenantId, tenantId));

    // 事件数
    const [eventRow] = await db
      .select({ total: count() })
      .from(activityEvents)
      .where(eq(activityEvents.tenantId, tenantId));

    // 中奖人数
    const [winnerRow] = await db
      .select({ total: count() })
      .from(lotteryWinners)
      .where(eq(lotteryWinners.tenantId, tenantId));

    // Webhook 投递数
    const [webhookRow] = await db
      .select({ total: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.tenantId, tenantId));

    // UPSERT：写入或更新今日快照
    await db
      .insert(tenantUsageSnapshots)
      .values({
        tenantId,
        snapshotDate: today,
        activityCount: Number(activityRow?.total ?? 0),
        participantCount: Number(participantRow?.total ?? 0),
        eventCount: Number(eventRow?.total ?? 0),
        winnerCount: Number(winnerRow?.total ?? 0),
        webhookCount: Number(webhookRow?.total ?? 0),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [tenantUsageSnapshots.tenantId, tenantUsageSnapshots.snapshotDate],
        set: {
          activityCount: Number(activityRow?.total ?? 0),
          participantCount: Number(participantRow?.total ?? 0),
          eventCount: Number(eventRow?.total ?? 0),
          winnerCount: Number(winnerRow?.total ?? 0),
          webhookCount: Number(webhookRow?.total ?? 0),
          updatedAt: new Date().toISOString(),
        },
      });

    processed++;
  }

  return { processed };
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
