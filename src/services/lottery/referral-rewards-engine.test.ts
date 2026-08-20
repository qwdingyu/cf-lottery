/**
 * engine-powered 推荐奖励集成测（docs/250）
 *
 * 覆盖：配置解析、bonus_spin 发放、bonus_coupon 发券、幂等性、
 * 无配置跳过、maxSpins 裁剪、码池耗尽。
 *
 * 使用真实数据库（getTestDb），与生产 schema 同源。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, clearTestData } from "../../test-setup";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import {
  lotteryDraws,
  lotteryEntries,
  shareRecords,
  couponCodes,
  spinsLog,
} from "../../db/schema";
import { processReferralRewardsEngine, normalizeReferralRewardDefs } from "./referral-rewards-engine";

const TENANT = "tenant-referral-engine";

async function seedDraw(
  db: DbType,
  opts?: {
    promotionConfig?: string;
    maxSpins?: number;
    activityKind?: string;
  },
) {
  const id = crypto.randomUUID();
  const slug = `re${id.slice(0, 6)}`;
  const now = new Date();
  const startAt = new Date(now.getTime() - 3600_000).toISOString();
  const endAt = new Date(now.getTime() + 86400_000 * 7).toISOString();

  await db.insert(lotteryDraws).values({
    id,
    tenantId: TENANT,
    publicSlug: slug,
    title: "referral engine test",
    description: "",
    status: "open",
    activityKind: opts?.activityKind ?? "lottery",
    participationMode: "open",
    experienceType: "wheel",
    drawTrigger: "manual",
    resultMode: "instant",
    startAt,
    endAt,
    winnerCount: 1,
    maxSpinsPerEntry: opts?.maxSpins ?? 10,
    promotionConfig: opts?.promotionConfig ?? "{}",
  });
  return id;
}

async function seedSharer(
  db: DbType,
  drawId: string,
  opts?: { joinedCount?: number; spinsLeft?: number; spinsTotalGranted?: number },
) {
  const entryId = crypto.randomUUID();
  await db.insert(lotteryEntries).values({
    id: entryId,
    tenantId: TENANT,
    drawId,
    identityType: "email",
    identityValue: `sharer-${entryId.slice(0, 6)}@test.com`,
    spinsLeft: opts?.spinsLeft ?? 0,
    spinsTotalGranted: opts?.spinsTotalGranted ?? 0,
    spinsViralEarned: 0,
  });

  const shareRecordId = crypto.randomUUID();
  await db.insert(shareRecords).values({
    id: shareRecordId,
    tenantId: TENANT,
    drawId,
    sharerEntryId: entryId,
    shareCode: `sc${shareRecordId.slice(0, 8)}`,
    clickedCount: 0,
    joinedCount: opts?.joinedCount ?? 1,
    rewardMilestonesGranted: "[]",
    leaderboardRewardedAt: "",
  });

  return { entryId, shareRecordId };
}

async function seedCoupon(db: DbType, drawId: string, label = "invite") {
  const id = crypto.randomUUID();
  await db.insert(couponCodes).values({
    id,
    tenantId: TENANT,
    drawId,
    code: `CP-${id.slice(0, 8)}`,
    label,
    status: "available",
  });
  return id;
}

describe("normalizeReferralRewardDefs", () => {
  it("空/非数组 → 空数组", () => {
    expect(normalizeReferralRewardDefs(null)).toEqual([]);
    expect(normalizeReferralRewardDefs(undefined)).toEqual([]);
    expect(normalizeReferralRewardDefs("not-array")).toEqual([]);
    expect(normalizeReferralRewardDefs([])).toEqual([]);
  });

  it("合法条目保留", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m1");
  });

  it("缺 rewardId/type/target → 剔除", () => {
    const defs = normalizeReferralRewardDefs([
      { type: "FIXED", target: "SOURCE", fixedAmount: "2" }, // 缺 rewardId
      { rewardId: "m2", target: "SOURCE", fixedAmount: "2" }, // 缺 type
      { rewardId: "m3", type: "FIXED", fixedAmount: "2" }, // 缺 target
      { rewardId: "m4", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } }, // 合法
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m4");
  });

  it("未知 rewardExit → 剔除", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "unknown_exit" } },
    ]);
    expect(defs.length).toBe(0);
  });

  it("缺 metadata.rewardExit → 默认 bonus_spin 保留", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2" },
    ]);
    expect(defs.length).toBe(1);
  });

  it("非法 type → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "INVALID", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      { rewardId: "m2", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } }, // 合法
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m2");
  });

  it("非法 target → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "INVALID", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
    ]);
    expect(defs.length).toBe(0);
  });

  it("FIXED 缺 fixedAmount 或 <=0 → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", metadata: { rewardExit: "bonus_spin" } }, // 缺 fixedAmount
      { rewardId: "m2", type: "FIXED", target: "SOURCE", fixedAmount: "0", metadata: { rewardExit: "bonus_spin" } }, // 0
      { rewardId: "m3", type: "FIXED", target: "SOURCE", fixedAmount: "-1", metadata: { rewardExit: "bonus_spin" } }, // 负
      { rewardId: "m4", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } }, // 合法
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.rewardId).toBe("m4");
  });

  it("重复 rewardId → 剔除（docs/254 校验）", () => {
    const defs = normalizeReferralRewardDefs([
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "5", metadata: { rewardExit: "bonus_spin" } }, // 重复
    ]);
    expect(defs.length).toBe(1);
    expect(defs[0]!.fixedAmount).toBe("2");
  });
});

describe("processReferralRewardsEngine", () => {
  let db: DbType;
  let client: Client;

  beforeEach(async () => {
    ({ db, client } = await getTestDb());
    await clearTestData(client);
  });

  afterEach(async () => {
    await clearTestData(client);
  });

  it("无 referralRewardDefs 配置 → 跳过，不报错", async () => {
    const drawId = await seedDraw(db, { promotionConfig: JSON.stringify({ viral: { enabled: true } }) });
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId,
      tenantId: TENANT,
      activityKind: "lottery",
      maxSpinsPerEntry: 10,
      promotionConfig: JSON.stringify({ viral: { enabled: true } }),
    }, shareRecordId);

    // 无 spins 变化
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(0);
  });

  it("bonus_spin 里程碑：邀请 1 人 → 发放 2 次", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId,
      tenantId: TENANT,
      activityKind: "lottery",
      maxSpinsPerEntry: 10,
      promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(2);
    expect(Number(entry?.spinsTotalGranted ?? 0)).toBe(2);

    // 幂等标记已写入
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    expect(JSON.parse(share?.rewardMilestonesGranted || "[]")).toContain("m1");
  });

  it("幂等性：同一 rewardId 二次触发不重复发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    // 第一次触发
    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // 第二次触发（模拟再次归因）
    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    // 只发放一次
    expect(Number(entry?.spinsLeft ?? 0)).toBe(2);
  });

  it("maxSpins 裁剪：发放超过 maxSpins 时按实际可发额度", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "5", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    // maxSpins=3，但奖励要发 5 次 → 只发 3 次
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 3 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 3, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(3);
  });

  it("bonus_coupon 发券：邀请 1 人 → 发放优惠券", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite");
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // 优惠券已发放（status=issued）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.tenantId, TENANT));
    expect(coupon?.status).toBe("issued");
  });

  it("bonus_coupon 码池耗尽 → 跳过，不报错", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    // 不 seed 优惠券 → 码池为空
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // 不报错，无优惠券发放
    const coupons = await db.select().from(couponCodes).where(eq(couponCodes.tenantId, TENANT));
    expect(coupons.length).toBe(0);
  });

  it("conditions 条件过滤：不满足条件不发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m5", type: "FIXED", target: "SOURCE", fixedAmount: "5", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "5" }], metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    // joinedCount=1 < 5 → 不满足条件
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(0);
  });

  it("conditions 条件满足：joinedCount>=3 发放", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m3", type: "FIXED", target: "SOURCE", fixedAmount: "5", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "3" }], metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 3 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(5);
  });

  it("spins_log 审计：发放后写入流水", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, entryId));
    expect(logs.length).toBe(1);
    expect(logs[0]?.delta).toBe(2);
    expect(logs[0]?.reason).toBe("viral");
    expect(logs[0]?.refId).toBe("engine:m1");
  });

  it("非 lottery 类型 + bonus_spin 出口 → 跳过，不发放（docs/252 §2.2）", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2", metadata: { rewardExit: "bonus_spin" } },
      ],
    });
    // activityKind = claim（非 lottery）
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10, activityKind: "claim" });
    const { entryId, shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "claim", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    // spins 不增加（bonus_spin 对非 lottery 跳过）
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(Number(entry?.spinsLeft ?? 0)).toBe(0);
    // 不写 spins_log
    const logs = await db.select().from(spinsLog).where(eq(spinsLog.entryId, entryId));
    expect(logs.length).toBe(0);
  });

  it("bonus_coupon 发券填充 recipientEmail（docs/252 §2.3）", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        { rewardId: "c1", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });
    const drawId = await seedDraw(db, { promotionConfig, maxSpins: 10 });
    await seedCoupon(db, drawId, "invite");
    // email 身份分享者
    const { shareRecordId } = await seedSharer(db, drawId, { joinedCount: 1 });

    await processReferralRewardsEngine(db, {
      id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig,
    }, shareRecordId);

    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.tenantId, TENANT));
    expect(coupon?.status).toBe("issued");
    // recipientEmail 应填充为分享者邮箱（seedSharer 用 sharer-xxx@test.com）
    expect(coupon?.recipientEmail).toMatch(/@test\.com$/);
  });
});