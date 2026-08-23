/**
 * calibrateActiveParticipantCounts 单测（docs/262 H1 修复验证）。
 *
 * 测试覆盖：
 * 1. diff > 0（计数器偏低，有超卖风险）→ 触发告警，返回 alerted=1，DB 值不被修改
 * 2. diff < 0（quantity>1 正常场景或计数器偏高）→ 不告警，返回 alerted=0
 * 3. diff = 0（完全一致）→ 不告警，返回 alerted=0
 * 4. 非 open/paused 状态的活动 → 不检测
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { lotteryDraws, lotteryEntries } from "../../db/schema";
import { clearTestData, getTestDb } from "../../test-setup";
import { calibrateActiveParticipantCounts } from "./participation";

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

const TENANT = "tenant-calibrate-test";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

/** 创建测试活动 */
async function seedDraw(
  overrides: Partial<typeof lotteryDraws.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  await db.insert(lotteryDraws).values({
    id,
    tenantId: TENANT,
    publicSlug: `calibrate-${id.slice(0, 8)}`,
    title: "校准测试活动",
    status: "open",
    activityKind: "lottery",
    experienceType: "wheel",
    resultMode: "instant",
    participationMode: "open",
    startAt: new Date(Date.now() - 86400000).toISOString(),
    endAt: new Date(Date.now() + 86400000).toISOString(),
    winnerCount: 1,
    activeParticipantCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

/** 创建测试 entry */
async function seedEntry(
  drawId: string,
  overrides: Partial<typeof lotteryEntries.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  await db.insert(lotteryEntries).values({
    id,
    tenantId: TENANT,
    drawId,
    identityType: "email",
    identityValue: `user-${id.slice(0, 8)}@test.com`,
    joinedAt: new Date().toISOString(),
    paymentStatus: "reserved",
    ...overrides,
  });
  return id;
}

describe("calibrateActiveParticipantCounts 告警行为", () => {
  it("diff > 0（计数器偏低）→ 告警且不修改 DB", async () => {
    // 活动 currentCount=2，但有 3 个有效 entry → diff=+1，计数器偏低
    const drawId = await seedDraw({ activeParticipantCount: 2 });
    await seedEntry(drawId);
    await seedEntry(drawId);
    await seedEntry(drawId);

    const alerted = await calibrateActiveParticipantCounts(db);
    expect(alerted).toBe(1);

    // DB 值不被修改（只读告警）
    const [draw] = await db
      .select({ activeParticipantCount: lotteryDraws.activeParticipantCount })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId));
    expect(draw?.activeParticipantCount).toBe(2); // 保持原值
  });

  it("diff < 0（quantity>1 正常场景）→ 不告警", async () => {
    // 活动 currentCount=5，但只有 2 个有效 entry（模拟 quantity>1）→ diff=-3，不告警
    const drawId = await seedDraw({ activeParticipantCount: 5 });
    await seedEntry(drawId);
    await seedEntry(drawId);

    const alerted = await calibrateActiveParticipantCounts(db);
    expect(alerted).toBe(0);
  });

  it("diff = 0（完全一致）→ 不告警", async () => {
    // 活动 currentCount=3，有 3 个有效 entry → diff=0，不告警
    const drawId = await seedDraw({ activeParticipantCount: 3 });
    await seedEntry(drawId);
    await seedEntry(drawId);
    await seedEntry(drawId);

    const alerted = await calibrateActiveParticipantCounts(db);
    expect(alerted).toBe(0);
  });

  it("非 open/paused 状态 → 不检测", async () => {
    // drawn 状态的活动，即使 diff>0 也不告警
    const drawId = await seedDraw({ status: "drawn", activeParticipantCount: 0 });
    await seedEntry(drawId);

    const alerted = await calibrateActiveParticipantCounts(db);
    expect(alerted).toBe(0);
  });

  it("expired/pending 状态的 entry 不计入 entryCount", async () => {
    // 活动 currentCount=1，1 个有效 entry + 2 个 expired entry → diff=0，不告警
    const drawId = await seedDraw({ activeParticipantCount: 1 });
    await seedEntry(drawId, { paymentStatus: "reserved" }); // 有效
    await seedEntry(drawId, { paymentStatus: "expired" }); // 无效
    await seedEntry(drawId, { paymentStatus: "" }); // 无效

    const alerted = await calibrateActiveParticipantCounts(db);
    expect(alerted).toBe(0);
  });
});
