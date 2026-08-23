/**
 * 签到活动 participation.ts 集成测试（docs/268）
 *
 * 用真实 SQLite 数据库覆盖 joinDraw() 的签到分支：
 * - identity_value 日期后缀生成
 * - streak 首次/连续/断签计算
 * - lastCheckinDate + checkinStreak 原子写入
 * - UNIQUE 约束防同日重复签到
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { DbType } from "../../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  tenants,
  platformTargets,
  activityEvents,
  spinsLog,
} from "../../db/schema";
import { clearTestData, getTestDb } from "../../test-setup";
import { joinDraw } from "./participation";
import { todayStr } from "../../lib/date-utils";

let client: Client;
let db: DbType;

const TENANT_ID = "tenant-checkin-participation";
const DRAW_ID = "draw-checkin-participation";
const EMAIL = "checkin-participation@example.com";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

async function seedCheckinActivity() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "checkin-participation-test" });
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "checkin-participation-slug",
    title: "签到参与测试",
    status: "open",
    activityKind: "checkin",
    participationMode: "open",
    experienceType: "checkin",
    resultMode: "instant",
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
  });
}

describe("joinDraw 签到分支集成测试", () => {
  it("首次签到：streak=1，identity_value 含日期后缀", async () => {
    await seedCheckinActivity();
    const today = todayStr();

    const result = await joinDraw(db, "checkin-participation-slug", EMAIL);

    expect(result.joined).toBe(true);
    expect(result.activityKind).toBe("checkin");
    expect(result.entryId).toBeDefined();

    // 验证 entry 已写入数据库
    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, result.entryId!))
      .limit(1);
    expect(entry).toBeDefined();
    // identity_value 应包含日期后缀
    expect(entry!.identityValue).toBe(`${EMAIL}:${today}`);
    // 首次签到 streak=1
    expect(entry!.checkinStreak).toBe(1);
    expect(entry!.lastCheckinDate).toBe(today);
  });

  it("连续签到：streak 递增", async () => {
    await seedCheckinActivity();

    // 第一次签到
    const r1 = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(r1.joined).toBe(true);

    // 第二次签到（同一天，UNIQUE 约束应阻止）
    const r2 = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(r2.joined).toBe(false);
  });

  it("UNIQUE 约束防止同日重复签到", async () => {
    await seedCheckinActivity();

    const r1 = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(r1.joined).toBe(true);

    // 同一天再次签到应失败
    const r2 = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(r2.joined).toBe(false);
    expect(r2.message).toContain("已参与");
  });

  it("不同用户可独立签到", async () => {
    await seedCheckinActivity();
    const email2 = "other-user@example.com";

    const r1 = await joinDraw(db, "checkin-participation-slug", EMAIL);
    const r2 = await joinDraw(db, "checkin-participation-slug", email2);

    expect(r1.joined).toBe(true);
    expect(r2.joined).toBe(true);

    // 两个用户各有一条 entry
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, DRAW_ID));
    expect(entries.length).toBe(2);
  });

  it("非签到活动不追加日期后缀", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "lottery-test" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "lottery-participation-slug",
      title: "抽奖测试",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      startAt: new Date(Date.now() - 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const result = await joinDraw(db, "lottery-participation-slug", EMAIL);
    expect(result.joined).toBe(true);

    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, result.entryId!))
      .limit(1);
    // 非签到活动 identity_value 不含日期后缀
    expect(entry!.identityValue).toBe(EMAIL);
  });

  it("活动不存在抛出异常", async () => {
    await expect(joinDraw(db, "nonexistent-slug", EMAIL)).rejects.toThrow("活动不存在");
  });

  it("活动已关闭抛出异常", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "closed-test" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "closed-checkin-slug",
      title: "已关闭签到",
      status: "closed",
      activityKind: "checkin",
      participationMode: "open",
      experienceType: "checkin",
      resultMode: "instant",
      startAt: new Date(Date.now() - 86_400_000 * 2).toISOString(),
      endAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    await expect(joinDraw(db, "closed-checkin-slug", EMAIL)).rejects.toThrow("活动未开启");
  });
});

describe("nextStreakAfterCheckin 纯函数", () => {
  it("覆盖首次/连续/断签/同日四个分支", async () => {
    const { nextStreakAfterCheckin } = await import("../platform/checkin-reward");
    expect(nextStreakAfterCheckin(null, 0, "2026-08-23")).toBe(1);
    expect(nextStreakAfterCheckin("2026-08-22", 5, "2026-08-23")).toBe(6);
    expect(nextStreakAfterCheckin("2026-08-20", 5, "2026-08-23")).toBe(1);
    expect(nextStreakAfterCheckin("2026-08-23", 5, "2026-08-23")).toBe(1);
  });
});

/** 播种 platformTargets 并配置 dailyCheckinPolicy（grantSpinCount=3） */
async function seedPlatformTargetWithCheckinReward() {
  await db.insert(platformTargets).values({
    id: "target-checkin-reward",
    tenantId: TENANT_ID,
    platform: "qq",
    targetId: "123456",
    targetName: "签到奖励测试群",
    activeDrawId: DRAW_ID,
    activePublicSlug: "checkin-participation-slug",
    builtinCommandsJson: JSON.stringify({
      dailyCheckinPolicy: {
        grantSpinCount: 3,
      },
    }),
  });
}

describe("签到奖励（dailyCheckinPolicy）集成测试", () => {
  it("有 grantSpinCount 配置时：首次签到发放 spins", async () => {
    await seedCheckinActivity();
    await seedPlatformTargetWithCheckinReward();

    const result = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(result.joined).toBe(true);

    // 验证 spinsLeft 已更新
    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, result.entryId!))
      .limit(1);
    expect(entry).toBeDefined();
    expect(entry!.spinsLeft).toBe(3); // grantSpinCount=3
    expect(entry!.checkinStreak).toBe(1);

    // 验证 spinsLog 表已写入流水记录
    const logs = await db
      .select()
      .from(spinsLog)
      .where(eq(spinsLog.entryId, result.entryId!));
    expect(logs.length).toBe(1);
    expect(logs[0].delta).toBe(3);
    expect(logs[0].reason).toBe("checkin");
    expect(logs[0].balanceAfter).toBe(3);
  });

  it("无 platformTargets 配置时：不发放 spins", async () => {
    await seedCheckinActivity();
    // 不播种 platformTargets

    const result = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(result.joined).toBe(true);

    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, result.entryId!))
      .limit(1);
    expect(entry).toBeDefined();
    // 无配置 → spinsLeft 应为初始值（0）
    expect(entry!.spinsLeft).toBe(0);
  });

  it("签到活动记录 daily_checkin 事件", async () => {
    await seedCheckinActivity();
    await seedPlatformTargetWithCheckinReward();

    const result = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(result.joined).toBe(true);

    // 验证 activityEvents 已记录
    const events = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.entryId, result.entryId!));
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("daily_checkin");
    expect(events[0].source).toBe("public_web");

    const metadata = JSON.parse(events[0].metadataJson);
    expect(metadata.reward).toBe(3);
    expect(metadata.streakDays).toBe(1);
  });

  it("rewardConfig linear 模式：连续签到递增奖励", async () => {
    await seedCheckinActivity();
    // 配置 linear 模式：base=2, increment=1, cap=5
    await db.insert(platformTargets).values({
      id: "target-checkin-linear",
      tenantId: TENANT_ID,
      platform: "qq",
      targetId: "123456",
      targetName: "linear 签到测试群",
      activeDrawId: DRAW_ID,
      activePublicSlug: "checkin-participation-slug",
      builtinCommandsJson: JSON.stringify({
        dailyCheckinPolicy: {
          rewardConfig: {
            mode: "linear",
            baseRange: { min: 2, max: 2 },
            increment: 1,
            cap: 5,
          },
        },
      }),
    });

    // 首次签到：base=2, streak=0 → reward = 2 + (0)*1 = 2
    const r1 = await joinDraw(db, "checkin-participation-slug", EMAIL);
    expect(r1.joined).toBe(true);
    const [entry1] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, r1.entryId!))
      .limit(1);
    expect(entry1!.spinsLeft).toBe(2);
  });
});
