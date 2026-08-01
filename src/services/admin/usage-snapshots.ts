/**
 * 租户用量快照刷新函数
 *
 * 由 Cron 定时任务调用，聚合各租户的用量数据写入 tenant_usage_snapshots 表。
 * 避免在管理后台做实时全表 COUNT。
 */
import type { DbType } from "../../db/client";
import { tenants, lotteryDraws, lotteryEntries, lotteryWinners, activityEvents, webhookDeliveries, tenantUsageSnapshots } from "../../db/schema";
import { eq, and, count, sql } from "drizzle-orm";

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