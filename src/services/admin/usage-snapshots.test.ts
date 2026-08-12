/**
 * 租户用量快照刷新函数测试
 *
 * 覆盖：H2 批量聚合路径（GROUP BY + 批量 UPSERT），
 *       空租户、无数据、多次刷新、取消状态过滤、非活跃租户排除等场景。
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import type { DbType } from "../../db/client";
import { getTestDb, clearTestData } from "../../test-setup";
import { tenants, lotteryDraws, lotteryEntries, activityEvents } from "../../db/schema";
import { refreshAllTenantSnapshots, readLatestTenantUsageSnapshotTotals } from "./usage-snapshots";

describe("refreshAllTenantSnapshots", () => {
  let client: Awaited<ReturnType<typeof getTestDb>>["client"];
  let db: DbType;

  beforeAll(async () => {
    ({ client, db } = await getTestDb());
  });

  afterEach(async () => {
    await clearTestData(client);
  });

  it("无活跃租户时返回 processed=0", async () => {
    const result = await refreshAllTenantSnapshots(db);
    expect(result.processed).toBe(0);
  });

  it("有活跃租户但无数据时，快照各 count 为 0", async () => {
    await db.insert(tenants).values({ id: "t1", name: "t1", status: "active" });

    const result = await refreshAllTenantSnapshots(db);
    expect(result.processed).toBe(1);

    const totals = await readLatestTenantUsageSnapshotTotals(db);
    expect(totals.tenantCount).toBe(1);
    expect(totals.activityCount).toBe(0);
    expect(totals.participantCount).toBe(0);
    expect(totals.eventCount).toBe(0);
    expect(totals.winnerCount).toBe(0);
    expect(totals.webhookCount).toBe(0);
    expect(totals.latestSnapshotDate).toBeTruthy();
  });
it("多个租户各有数据时，聚合结果正确", async () => {
    // 租户 t1: 2 个活动 + 3 个参与者 + 5 个事件
    // 租户 t2: 1 个活动 + 2 个参与者 + 0 个事件
    await db.insert(tenants).values([
      { id: "t1", name: "t1", status: "active" },
      { id: "t2", name: "t2", status: "active" },
    ]);

    await db.insert(lotteryDraws).values([
      { id: "d1", tenantId: "t1", publicSlug: "d1", title: "d1", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
      { id: "d2", tenantId: "t1", publicSlug: "d2", title: "d2", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
      { id: "d3", tenantId: "t2", publicSlug: "d3", title: "d3", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
    ]);

    await db.insert(lotteryEntries).values([
      { id: "e1", tenantId: "t1", drawId: "d1", identityType: "email", identityValue: "u1@test.com", displayName: "u1", joinedAt: new Date().toISOString() },
      { id: "e2", tenantId: "t1", drawId: "d1", identityType: "email", identityValue: "u2@test.com", displayName: "u2", joinedAt: new Date().toISOString() },
      { id: "e3", tenantId: "t1", drawId: "d2", identityType: "email", identityValue: "u3@test.com", displayName: "u3", joinedAt: new Date().toISOString() },
      { id: "e4", tenantId: "t2", drawId: "d3", identityType: "email", identityValue: "u4@test.com", displayName: "u4", joinedAt: new Date().toISOString() },
      { id: "e5", tenantId: "t2", drawId: "d3", identityType: "email", identityValue: "u5@test.com", displayName: "u5", joinedAt: new Date().toISOString() },
    ]);

    await db.insert(activityEvents).values([
      { id: "ev1", tenantId: "t1", drawId: "d1", eventType: "view", createdAt: new Date().toISOString() },
      { id: "ev2", tenantId: "t1", drawId: "d1", eventType: "view", createdAt: new Date().toISOString() },
      { id: "ev3", tenantId: "t1", drawId: "d1", eventType: "view", createdAt: new Date().toISOString() },
      { id: "ev4", tenantId: "t1", drawId: "d2", eventType: "view", createdAt: new Date().toISOString() },
      { id: "ev5", tenantId: "t1", drawId: "d2", eventType: "view", createdAt: new Date().toISOString() },
    ]);

    const result = await refreshAllTenantSnapshots(db);
    expect(result.processed).toBe(2);

    const totals = await readLatestTenantUsageSnapshotTotals(db);
    expect(totals.tenantCount).toBe(2);
    expect(totals.activityCount).toBe(3);   // t1:2 + t2:1
    expect(totals.participantCount).toBe(5); // t1:3 + t2:2
    expect(totals.eventCount).toBe(5);        // t1:5 + t2:0
  });

  it("取消状态的活动不计入 activityCount", async () => {
    await db.insert(tenants).values({ id: "t1", name: "t1", status: "active" });
    await db.insert(lotteryDraws).values([
      { id: "d1", tenantId: "t1", publicSlug: "d1", title: "d1", status: "cancelled", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
      { id: "d2", tenantId: "t1", publicSlug: "d2", title: "d2", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
    ]);

    await refreshAllTenantSnapshots(db);
    const totals = await readLatestTenantUsageSnapshotTotals(db);
    expect(totals.activityCount).toBe(1);
  });

  it("多次刷新（今日已有快照）时正确更新（UPSERT）", async () => {
    await db.insert(tenants).values({ id: "t1", name: "t1", status: "active" });
    await db.insert(lotteryDraws).values({ id: "d1", tenantId: "t1", publicSlug: "d1", title: "d1", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" });

    const r1 = await refreshAllTenantSnapshots(db);
    expect(r1.processed).toBe(1);
    let totals = await readLatestTenantUsageSnapshotTotals(db);
    expect(totals.activityCount).toBe(1);

    // 增加活动后第二次刷新
    await db.insert(lotteryDraws).values({ id: "d2", tenantId: "t1", publicSlug: "d2", title: "d2", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" });
    const r2 = await refreshAllTenantSnapshots(db);
    expect(r2.processed).toBe(1);
    totals = await readLatestTenantUsageSnapshotTotals(db);
    expect(totals.activityCount).toBe(2); // 更新后为 2
  });

  it("非活跃租户（inactive/suspended）不被统计", async () => {
    await db.insert(tenants).values([
      { id: "active1", name: "active1", status: "active" },
      { id: "inactive1", name: "inactive1", status: "inactive" },
      { id: "suspended1", name: "suspended1", status: "suspended" },
    ]);

    await db.insert(lotteryDraws).values([
      { id: "d1", tenantId: "active1", publicSlug: "d1", title: "d1", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
      { id: "d2", tenantId: "inactive1", publicSlug: "d2", title: "d2", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
      { id: "d3", tenantId: "suspended1", publicSlug: "d3", title: "d3", status: "open", activityKind: "lottery", startAt: "2026-01-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" },
    ]);

    const result = await refreshAllTenantSnapshots(db);
    expect(result.processed).toBe(1); // 只有 active1 被处理

    const totals = await readLatestTenantUsageSnapshotTotals(db);
    expect(totals.tenantCount).toBe(1);
    expect(totals.activityCount).toBe(1); // 只统计了 active1 的 1 个活动
  });
});