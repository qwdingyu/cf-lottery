/**
 * 数据看板统计服务集成测试（docs/267 P1）
 *
 * 覆盖：
 * 1. 参与趋势：按日聚合 + 缺失日期填充 + 按活动过滤
 * 2. 转化漏斗：四阶段人数 + 转化率计算
 * 3. 空数据返回
 * 4. 多租户隔离
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { Client } from "@libsql/client";
import type { DbType } from "../../db/client";
import {
  tenants,
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  activityEvents,
} from "../../db/schema";
import { clearTestData, getTestDb } from "../../test-setup";
import { getParticipationTrend, getConversionFunnel } from "./dashboard-stats";

let client: Client;
let db: DbType;

const TENANT = "tenant-dashboard-stats";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

async function seedTenant() {
  await db.insert(tenants).values({ id: TENANT, name: "dash-test" });
}

async function seedDraw(drawId: string) {
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId: TENANT,
    publicSlug: `slug-${Date.now()}`,
    title: "看板测试活动",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    startAt: new Date(Date.now() - 86_400_000 * 60).toISOString(),
    endAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe("参与趋势", () => {
  it("按日聚合参与人数 + 缺失日期填充", async () => {
    await seedTenant();
    const drawId = `draw-trend-${Date.now()}`;
    await seedDraw(drawId);

    // 3 天前和 1 天前各参与 1 人
    await db.insert(lotteryEntries).values([
      {
        id: `e1-${Date.now()}`, tenantId: TENANT, drawId,
        identityType: "email", identityValue: "a@ex.com",
        spinsLeft: 0, spinsTotalGranted: 0, joinedAt: daysAgo(3),
      },
      {
        id: `e2-${Date.now()}`, tenantId: TENANT, drawId,
        identityType: "email", identityValue: "b@ex.com",
        spinsLeft: 0, spinsTotalGranted: 0, joinedAt: daysAgo(1),
      },
    ]);

    const trend = await getParticipationTrend(db, TENANT, { granularity: "day", days: 5 });
    expect(trend).toHaveLength(5);
    // 3 天前和 1 天前各有 1 人
    const day3 = trend.find((t) => t.label === new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10));
    const day1 = trend.find((t) => t.label === new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10));
    expect(day3?.newParticipants).toBe(1);
    expect(day1?.newParticipants).toBe(1);
    // 其他日期为 0
    const day0 = trend.find((t) => t.label === new Date().toISOString().slice(0, 10));
    expect(day0?.newParticipants).toBe(0);
  });

  it("按周聚合", async () => {
    await seedTenant();
    const drawId = `draw-trend-w-${Date.now()}`;
    await seedDraw(drawId);

    await db.insert(lotteryEntries).values({
      id: `e-w-${Date.now()}`, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "w@ex.com",
      spinsLeft: 0, spinsTotalGranted: 0, joinedAt: new Date().toISOString(),
    });

    const trend = await getParticipationTrend(db, TENANT, { granularity: "week", days: 30 });
    expect(trend.length).toBeGreaterThan(0);
    expect(trend.some((t) => t.newParticipants > 0)).toBe(true);
  });

  it("按活动过滤", async () => {
    await seedTenant();
    const drawA = `draw-filter-a-${Date.now()}`;
    const drawB = `draw-filter-b-${Date.now()}`;
    await seedDraw(drawA);
    await seedDraw(drawB);

    await db.insert(lotteryEntries).values([
      {
        id: `e-fa-${Date.now()}`, tenantId: TENANT, drawId: drawA,
        identityType: "email", identityValue: "fa@ex.com",
        spinsLeft: 0, spinsTotalGranted: 0, joinedAt: new Date().toISOString(),
      },
      {
        id: `e-fb-${Date.now()}`, tenantId: TENANT, drawId: drawB,
        identityType: "email", identityValue: "fb@ex.com",
        spinsLeft: 0, spinsTotalGranted: 0, joinedAt: new Date().toISOString(),
      },
    ]);

    const trendA = await getParticipationTrend(db, TENANT, { drawId: drawA, days: 1 });
    const totalA = trendA.reduce((s, t) => s + t.newParticipants, 0);
    expect(totalA).toBe(1);
  });

  it("空数据返回全零趋势", async () => {
    await seedTenant();
    const trend = await getParticipationTrend(db, TENANT, { days: 3 });
    expect(trend).toHaveLength(3);
    expect(trend.every((t) => t.newParticipants === 0)).toBe(true);
  });
});

describe("转化漏斗", () => {
  it("四阶段人数 + 转化率", async () => {
    await seedTenant();
    const drawId = `draw-funnel-${Date.now()}`;
    await seedDraw(drawId);

    // 5 个访问
    for (let i = 0; i < 5; i++) {
      await db.insert(activityEvents).values({
        id: `evt-v-${i}-${Date.now()}`, tenantId: TENANT, drawId,
        entryId: `entry-v-${i}`, eventType: "page_view",
      });
    }
    // 3 个参与
    for (let i = 0; i < 3; i++) {
      await db.insert(lotteryEntries).values({
        id: `entry-f-${i}-${Date.now()}`, tenantId: TENANT, drawId,
        identityType: "email", identityValue: `f${i}@ex.com`,
        spinsLeft: 0, spinsTotalGranted: 0, joinedAt: new Date().toISOString(),
      });
    }
    // 1 个中奖（已通知）
    await db.insert(lotteryWinners).values({
      id: `winner-f-${Date.now()}`, tenantId: TENANT, drawId,
      tierId: "tier-1", entryId: "entry-f-0", spinId: "spin-sent",
      identityType: "email", identityValue: "f0@ex.com",
      notificationStatus: "sent",
    });
    // 1 个中奖（未通知）
    await db.insert(lotteryWinners).values({
      id: `winner-f2-${Date.now()}`, tenantId: TENANT, drawId,
      tierId: "tier-1", entryId: "entry-f-1", spinId: "spin-pending",
      identityType: "email", identityValue: "f1@ex.com",
      notificationStatus: "pending",
    });

    const funnel = await getConversionFunnel(db, TENANT, { days: 1 });
    expect(funnel).toHaveLength(4);

    expect(funnel[0]!.stage).toBe("访问");
    expect(funnel[0]!.count).toBe(5);
    expect(funnel[0]!.conversionRate).toBe(100);

    expect(funnel[1]!.stage).toBe("参与");
    expect(funnel[1]!.count).toBe(3);
    expect(funnel[1]!.conversionRate).toBe(60); // 3/5 = 60%

    expect(funnel[2]!.stage).toBe("中奖");
    expect(funnel[2]!.count).toBe(2);
    expect(funnel[2]!.conversionRate).toBeCloseTo(66.7, 0); // 2/3 ≈ 66.7%

    expect(funnel[3]!.stage).toBe("领奖");
    expect(funnel[3]!.count).toBe(1); // 只有 notificationStatus=sent 的算领奖
    expect(funnel[3]!.conversionRate).toBe(50); // 1/2 = 50%
  });

  it("空数据返回全零漏斗", async () => {
    await seedTenant();
    const funnel = await getConversionFunnel(db, TENANT, { days: 7 });
    expect(funnel).toHaveLength(4);
    expect(funnel.every((s) => s.count === 0)).toBe(true);
    // 第一阶段始终 100%
    expect(funnel[0]!.conversionRate).toBe(100);
  });

  it("多租户隔离", async () => {
    await seedTenant();
    await db.insert(tenants).values({ id: "tenant-other", name: "other" });
    const drawId = `draw-iso-${Date.now()}`;
    await seedDraw(drawId);

    // TENANT 的活动
    await db.insert(lotteryEntries).values({
      id: `e-iso-${Date.now()}`, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "iso@ex.com",
      spinsLeft: 0, spinsTotalGranted: 0, joinedAt: new Date().toISOString(),
    });

    // 其他租户的活动
    const otherDraw = `draw-other-${Date.now()}`;
    await db.insert(lotteryDraws).values({
      id: otherDraw, tenantId: "tenant-other", publicSlug: `slug-o-${Date.now()}`,
      title: "other", status: "open", activityKind: "lottery",
      participationMode: "open", experienceType: "wheel", resultMode: "instant",
      startAt: daysAgo(30), endAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: `e-other-${Date.now()}`, tenantId: "tenant-other", drawId: otherDraw,
      identityType: "email", identityValue: "other@ex.com",
      spinsLeft: 0, spinsTotalGranted: 0, joinedAt: new Date().toISOString(),
    });

    const trend = await getParticipationTrend(db, TENANT, { days: 1 });
    const total = trend.reduce((s, t) => s + t.newParticipants, 0);
    expect(total).toBe(1); // 只有 TENANT 的 1 条

    const funnel = await getConversionFunnel(db, TENANT, { days: 1 });
    expect(funnel[1]!.count).toBe(1); // 参与只有 TENANT 的 1 条
  });
});
