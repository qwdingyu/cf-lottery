/**
 * engine-powered 推荐奖励：单条奖励级容错（docs/255 复审 B2）
 *
 * 单独成文件的原因：需要用 vi.mock 让某个奖励出口抛异常，
 * 而 mock 是文件级的，不能污染 referral-rewards-engine.test.ts 的真实出口断言。
 *
 * 验证的不变式：一个 rewardId 的出口抛异常时，
 * ① processReferralRewardsEngine 自身不抛（参与主流程不受影响）；
 * ② records 里排在后面的 rewardId 仍然正常发放（不被连带丢失）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, clearTestData } from "../../test-setup";
import type { DbType } from "../../db/client";
import type { Client } from "@libsql/client";
import { lotteryDraws, lotteryEntries, shareRecords, couponCodes } from "../../db/schema";

// grantBonusSpin 抛异常，grantBonusCoupon 保持真实实现
vi.mock("./reward-exits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reward-exits")>();
  return {
    ...actual,
    grantBonusSpin: vi.fn(async () => {
      throw new Error("simulated exit failure");
    }),
  };
});

const { processReferralRewardsEngine } = await import("./referral-rewards-engine");

const TENANT = "tenant-referral-engine-isolation";

let db: DbType;
let client: Client;

beforeEach(async () => {
  const t = await getTestDb();
  db = t.db;
  client = t.client;
  await client.execute({
    sql: "INSERT OR IGNORE INTO tenants (id, name, plan, status) VALUES (?, 'T','free','active')",
    args: [TENANT],
  });
});

afterEach(async () => {
  await clearTestData(client);
});

describe("processReferralRewardsEngine 单条奖励级容错", () => {
  it("某个出口抛异常时不影响后续 rewardId 的发放，且函数自身不抛", async () => {
    const promotionConfig = JSON.stringify({
      referralRewardDefs: [
        // 排在前面的 bonus_spin 会抛异常
        { rewardId: "boom", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_spin" } },
        // 排在后面的 bonus_coupon 必须仍然发出
        { rewardId: "ok", type: "FIXED", target: "SOURCE", fixedAmount: "1", metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" } },
      ],
    });

    const drawId = crypto.randomUUID();
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: `iso${drawId.slice(0, 6)}`,
      title: "isolation test",
      description: "",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      drawTrigger: "manual",
      resultMode: "instant",
      startAt: new Date(now.getTime() - 3600_000).toISOString(),
      endAt: new Date(now.getTime() + 86400_000).toISOString(),
      winnerCount: 1,
      maxSpinsPerEntry: 10,
      promotionConfig,
    });

    const entryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "iso-sharer@test.com",
      spinsLeft: 0,
      spinsTotalGranted: 0,
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
      joinedCount: 1,
      rewardMilestonesGranted: "[]",
      leaderboardRewardedAt: "",
    });

    const couponId = crypto.randomUUID();
    await db.insert(couponCodes).values({
      id: couponId,
      tenantId: TENANT,
      drawId,
      code: `CP-${couponId.slice(0, 8)}`,
      label: "invite",
      status: "available",
    });

    const draw = { id: drawId, tenantId: TENANT, activityKind: "lottery", maxSpinsPerEntry: 10, promotionConfig };

    // ① 自身不抛
    await expect(processReferralRewardsEngine(db, draw, shareRecordId)).resolves.toBeUndefined();

    // ② 后续 rewardId 正常发放，且只写它自己的标记
    const issued = await db.select().from(couponCodes).where(eq(couponCodes.status, "issued"));
    expect(issued).toHaveLength(1);
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.id, shareRecordId));
    expect(JSON.parse(share?.rewardMilestonesGranted || "[]")).toEqual(["ok"]);
  });
});
