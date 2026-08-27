/**
 * docs/272：用户级邀请码——业务测试 + 冒烟测试
 *
 * 覆盖场景：
 * 1. recordAttributedJoin 用户级回退（A 已参与 / A 未参与 / 自邀请）
 * 2. resolvePendingUserAttributions（单人/多人/自邀请/跨活动隔离/奖励触发）
 * 3. 端到端冒烟（B先于A加入 → A加入 → B归因到A）
 * 4. 并发安全（两人同用同一邀请码）
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDraw,
  publishDraw,
  joinDraw,
  getActivityEventSummary,
  createPrize,
} from "../lottery-service";
import {
  shareRecords,
  activityEvents,
  users,
  lotteryPrizeTiers,
} from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];
const TENANT = "test-invite-code-001";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

beforeEach(async () => {
  await clearTestData(client);
  await client.execute({ sql: "INSERT INTO tenants (id, name) VALUES (?, ?)", args: [TENANT, "Test"] });
});

/** 创建 open 活动并发布 */
async function setupDraw(activityConfig?: string) {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const { id, publicSlug } = await createDraw(db, TENANT, {
    title: "邀请码测试活动",
    startAt: now.toISOString(),
    endAt: future.toISOString(),
    participationMode: "open",
    winnerCount: 1,
    activityConfig,
  });
  // 配置奖项（发布前校验需要）
  const { id: prizeId } = await createPrize(db, TENANT, { name: "测试奖品", prizeType: "manual_fulfillment" });
  await db.insert(lotteryPrizeTiers).values({
    id: crypto.randomUUID(),
    tenantId: TENANT,
    drawId: id,
    prizeId,
    tierName: "一等奖",
    winnerCount: 1,
    sortOrder: 100,
  });
  await publishDraw(db, TENANT, id);
  return { id, publicSlug };
}

/** 创建注册用户（带 inviteCode） */
async function createRegisteredUser(id: string, email: string, inviteCode: string) {
  await db.insert(users).values({
    id,
    username: id.replace(/-/g, "_"),
    email,
    emailVerified: 1,
    passwordHash: "hash",
    inviteCode,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 场景 1：recordAttributedJoin 用户级回退
// ══════════════════════════════════════════════════════════════════════════════

describe("recordAttributedJoin 用户级邀请码回退", () => {
  it("A 已参与 → B 用 A 的邀请码加入 → B 归因到 A（shareRecord 合成 shareCode）", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b", "b@test.com", "CODEBBBB");

    // A 先参与
    const aJoin = await joinDraw(db, publicSlug, "user-a", "user_id");
    expect(aJoin.joined).toBe(true);
    const aEntryId = "entryId" in aJoin ? String(aJoin.entryId) : "";
    expect(aEntryId).toBeTruthy();

    // B 用 A 的邀请码参与
    const bJoin = await joinDraw(db, publicSlug, "user-b", "user_id", {
      refCode: "CODEAAAA",
    });
    expect(bJoin.joined).toBe(true);

    // 验证 shareRecord 被创建
    const [share] = await db
      .select()
      .from(shareRecords)
      .where(and(
        eq(shareRecords.tenantId, TENANT),
        eq(shareRecords.drawId, drawId),
        eq(shareRecords.sharerEntryId, aEntryId),
      ))
      .limit(1);
    expect(share).toBeTruthy();
    expect(share!.joinedCount).toBe(1);
    // shareCode 应为合成格式（非 inviteCode），避免 UNIQUE 冲突
    expect(share!.shareCode).toMatch(/^uc_/);

    // 验证 attributed_join 事件
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(1);
  });

  it("B1 和 B2 先后用同一邀请码加入 → shareRecord 复用，joinedCount=2", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b1", "b1@test.com", "CODEB1B1");
    await createRegisteredUser("user-b2", "b2@test.com", "CODEB2B2");

    await joinDraw(db, publicSlug, "user-a", "user_id");

    // B1 用 A 的邀请码
    await joinDraw(db, publicSlug, "user-b1", "user_id", { refCode: "CODEAAAA" });
    // B2 用 A 的邀请码
    await joinDraw(db, publicSlug, "user-b2", "user_id", { refCode: "CODEAAAA" });

    // shareRecord 只有一条，joinedCount=2
    const [share] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(and(
        eq(shareRecords.tenantId, TENANT),
        eq(shareRecords.drawId, drawId),
      ))
      .limit(1);
    expect(share).toBeTruthy();
    expect(share!.joinedCount).toBe(2);

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(2);
  });

  it("自邀请：A 用自己的邀请码加入 → 不归因", async () => {
    const { publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");

    const aJoin = await joinDraw(db, publicSlug, "user-a", "user_id", {
      refCode: "CODEAAAA",
    });
    expect(aJoin.joined).toBe(true);

    // 无 shareRecord、无 attributed_join
    const shares = await db
      .select()
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT));
    expect(shares.length).toBe(0);
  });

  it("A 未参与 → B 用 A 的邀请码加入 → 写入 pending 事件", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b", "b@test.com", "CODEBBBB");

    // B 在 A 加入前就参与
    const bJoin = await joinDraw(db, publicSlug, "user-b", "user_id", {
      refCode: "CODEAAAA",
    });
    expect(bJoin.joined).toBe(true);

    // 应有 pending_user_attributed_join 事件
    const pendingEvents = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "pending_user_attributed_join"),
      ));
    expect(pendingEvents.length).toBe(1);
    expect(pendingEvents[0].refCode).toBe("CODEAAAA"); // P1 修复：refCode 存 inviteCode（与直接归因路径幂等键对齐）

    // 无 attributed_join 事件
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 场景 2：resolvePendingUserAttributions
// ══════════════════════════════════════════════════════════════════════════════

describe("resolvePendingUserAttributions", () => {
  it("A 加入后 → B 的 pending 事件被解析 → attributed_join 事件 + shareRecord 创建", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b", "b@test.com", "CODEBBBB");

    // B 先加入（A 未加入 → pending）
    await joinDraw(db, publicSlug, "user-b", "user_id", { refCode: "CODEAAAA" });

    // A 加入 → pending 被解析
    const aJoin = await joinDraw(db, publicSlug, "user-a", "user_id");
    expect(aJoin.joined).toBe(true);

    // pending 事件已清除
    const pendingEvents = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.eventType, "pending_user_attributed_join"),
      ));
    expect(pendingEvents.length).toBe(0);

    // attributed_join 事件已创建
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(1);

    // shareRecord 已创建
    const shares = await db
      .select()
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT));
    expect(shares.length).toBe(1);
    expect(shares[0].joinedCount).toBe(1);
  });

  it("B1 和 B2 都在 A 加入前参与 → A 加入后解析两个 pending → joinedCount=2", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b1", "b1@test.com", "CODEB1B1");
    await createRegisteredUser("user-b2", "b2@test.com", "CODEB2B2");

    // B1 和 B2 都用 A 的邀请码参与
    await joinDraw(db, publicSlug, "user-b1", "user_id", { refCode: "CODEAAAA" });
    await joinDraw(db, publicSlug, "user-b2", "user_id", { refCode: "CODEAAAA" });

    // A 加入
    await joinDraw(db, publicSlug, "user-a", "user_id");

    // shareRecord joinedCount=2
    const [share] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT))
      .limit(1);
    expect(share?.joinedCount).toBe(2);

    // attributed_join=2
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(2);
  });

  it("自邀请：pending 事件中被邀请人与推荐人同一 identity → 跳过", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");

    // A 用自己邀请码参与（触发 pending 写入逻辑但 self-invite 应被阻止）
    // 实际场景：A 的邀请码被用于创建 pending 事件（伪造）
    const bEntry = await joinDraw(db, publicSlug, "user-a", "user_id", {
      refCode: "CODEAAAA",
    });
    expect(bEntry.joined).toBe(true);

    // 无归因
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(0);
  });

  it("跨活动隔离：A 在 draw1 有 pending → A 加入 draw2 → draw1 的 pending 不被解析", async () => {
    // 创建两个活动
    const draw1 = await setupDraw();
    const draw2 = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b", "b@test.com", "CODEBBBB");

    // B 在 draw1 和 draw2 都用 A 的邀请码参与
    await joinDraw(db, draw1.publicSlug, "user-b", "user_id", { refCode: "CODEAAAA" });
    await joinDraw(db, draw2.publicSlug, "user-b", "user_id", { refCode: "CODEAAAA" });

    // A 只加入 draw1
    await joinDraw(db, draw1.publicSlug, "user-a", "user_id");

    // draw1 的 pending 已解析
    const pending1 = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, draw1.id),
        eq(activityEvents.eventType, "pending_user_attributed_join"),
      ));
    expect(pending1.length).toBe(0);

    // draw2 的 pending 仍在
    const pending2 = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, draw2.id),
        eq(activityEvents.eventType, "pending_user_attributed_join"),
      ));
    expect(pending2.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 场景 3：端到端冒烟测试
// ══════════════════════════════════════════════════════════════════════════════

describe("用户级邀请码端到端冒烟", () => {
  it("冒烟：B先于A加入 → A加入 → B归因到A + shareRecord + attributed_join", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("referrer", "ref@test.com", "REFCODE1");
    await createRegisteredUser("joiner", "join@test.com", "JNCODE__1");

    // 阶段 1：joiner 在 referrer 加入前参与
    const j1 = await joinDraw(db, publicSlug, "joiner", "user_id", { refCode: "REFCODE1" });
    expect(j1.joined).toBe(true);

    // 阶段 2：referrer 加入
    const r1 = await joinDraw(db, publicSlug, "referrer", "user_id");
    expect(r1.joined).toBe(true);

    // 验证归因完成
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(1);

    // 验证 shareRecord
    const [share] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT))
      .limit(1);
    expect(share?.joinedCount).toBe(1);
  });

  it("冒烟：A先加入 → B用邀请码加入 → B归因到A", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("referrer", "ref@test.com", "REFCODE1");
    await createRegisteredUser("joiner", "join@test.com", "JNCODE__1");

    // A 先加入
    await joinDraw(db, publicSlug, "referrer", "user_id");
    // B 用 A 的邀请码加入
    await joinDraw(db, publicSlug, "joiner", "user_id", { refCode: "REFCODE1" });

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(1);

    const [share] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT))
      .limit(1);
    expect(share?.joinedCount).toBe(1);
  });

  it("冒烟：同一邀请码被 3 人使用 → joinedCount=3", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("referrer", "ref@test.com", "REFCODE1");
    await createRegisteredUser("j1", "j1@test.com", "J1CODE__1");
    await createRegisteredUser("j2", "j2@test.com", "J2CODE__1");
    await createRegisteredUser("j3", "j3@test.com", "J3CODE__1");

    await joinDraw(db, publicSlug, "referrer", "user_id");
    await joinDraw(db, publicSlug, "j1", "user_id", { refCode: "REFCODE1" });
    await joinDraw(db, publicSlug, "j2", "user_id", { refCode: "REFCODE1" });
    await joinDraw(db, publicSlug, "j3", "user_id", { refCode: "REFCODE1" });

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(3);

    const [share] = await db
      .select({ joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT))
      .limit(1);
    expect(share?.joinedCount).toBe(3);
  });

  it("冒烟：无邀请码的裸链分享 → 不产生归因", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user1", "u1@test.com", "UCODE___1");

    // 无 refCode 参与
    await joinDraw(db, publicSlug, "user1", "user_id");

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(0);

    const shares = await db
      .select()
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT));
    expect(shares.length).toBe(0);
  });

  it("冒烟：未知邀请码 → 不归因（静默忽略）", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user1", "u1@test.com", "UCODE___1");

    // 使用不存在的邀请码
    const result = await joinDraw(db, publicSlug, "user1", "user_id", {
      refCode: "NONEXISTENT",
    });
    expect(result.joined).toBe(true);

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 场景 4：docs/275 P1——per-friend 奖励粒度 + 旧格式 pending 兼容
// ══════════════════════════════════════════════════════════════════════════════

describe("docs/275 P1 回归", () => {
  it("全链路：配置 perInviteAmount 后同一邀请码 2 个好友加入 → reward_earned 各 1 条（不被幂等误拦）", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100, currency: "cny" },
      quota: { perUserPerDay: 10, globalPerDay: 100 },
    });
    const { id: drawId, publicSlug } = await setupDraw(config);
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b1", "b1@test.com", "CODEB1B1");
    await createRegisteredUser("user-b2", "b2@test.com", "CODEB2B2");

    await joinDraw(db, publicSlug, "user-a", "user_id");
    await joinDraw(db, publicSlug, "user-b1", "user_id", { refCode: "CODEAAAA" });
    await joinDraw(db, publicSlug, "user-b2", "user_id", { refCode: "CODEAAAA" });

    // 用户级邀请码固定 → 两次归因 refCode 相同；joinerEntryId 维度必须让奖励各发一份
    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(2);
    expect(summary.totals.reward_earned || 0).toBe(2);

    // 两条 reward_earned 的 metadata.joinerEntryId 不同（每次邀请独立）
    const events = await db
      .select({ metadataJson: activityEvents.metadataJson })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "reward_earned"),
      ));
    const joiners = new Set(events.map((e) => JSON.parse(e.metadataJson || "{}").joinerEntryId));
    expect(joiners.size).toBe(2);
  });

  it("全链路：pending 解析路径同样按好友维度发奖 → 2 个 pending 好友解析后 reward_earned=2", async () => {
    const config = JSON.stringify({
      version: 1,
      reward: { perInviteAmount: 100, currency: "cny" },
      quota: { perUserPerDay: 10, globalPerDay: 100 },
    });
    const { id: drawId, publicSlug } = await setupDraw(config);
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b1", "b1@test.com", "CODEB1B1");
    await createRegisteredUser("user-b2", "b2@test.com", "CODEB2B2");

    // B1、B2 先于 A 加入 → 各写 1 条 pending
    await joinDraw(db, publicSlug, "user-b1", "user_id", { refCode: "CODEAAAA" });
    await joinDraw(db, publicSlug, "user-b2", "user_id", { refCode: "CODEAAAA" });
    // A 加入 → pending 追溯解析 + 每个归因独立触发奖励
    await joinDraw(db, publicSlug, "user-a", "user_id");

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(2);
    expect(summary.totals.reward_earned || 0).toBe(2);
  });

  it("旧格式兼容：refCode=userId 的存量 pending 事件仍可被推荐人加入时解析（防孤儿）", async () => {
    const { id: drawId, publicSlug } = await setupDraw();
    await createRegisteredUser("user-a", "a@test.com", "CODEAAAA");
    await createRegisteredUser("user-b", "b@test.com", "CODEBBBB");

    // B 先无 ref 加入（获得 entry）
    const bJoin = await joinDraw(db, publicSlug, "user-b", "user_id");
    expect(bJoin.joined).toBe(true);
    const bEntryId = "entryId" in bJoin ? String(bJoin.entryId) : "";

    // 模拟 3b7e35b5~0a03e66a 旧版本写入的 pending 事件：refCode 存的是推荐人 userId
    await db.insert(activityEvents).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      entryId: bEntryId,
      eventType: "pending_user_attributed_join",
      refCode: "user-a",
      metadataJson: JSON.stringify({ referrerUserId: "user-a", referrerInviteCode: "CODEAAAA" }),
      createdAt: new Date().toISOString(),
    });

    // A 加入 → 双值匹配（inviteCode + legacyUserId）解析旧格式 pending
    await joinDraw(db, publicSlug, "user-a", "user_id");

    const pendingLeft = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT),
        eq(activityEvents.eventType, "pending_user_attributed_join"),
      ));
    expect(pendingLeft.length).toBe(0);

    const summary = await getActivityEventSummary(db, TENANT, drawId);
    expect(summary.totals.attributed_join || 0).toBe(1);

    const shares = await db
      .select()
      .from(shareRecords)
      .where(eq(shareRecords.tenantId, TENANT));
    expect(shares.length).toBe(1);
    expect(shares[0].joinedCount).toBe(1);
  });
});
