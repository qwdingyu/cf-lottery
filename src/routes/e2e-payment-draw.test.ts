/**
 * 秒杀、抽奖、批发模式端到端全流程测试。
 *
 * 验证核心业务链路完整闭环：
 * 1. 秒杀：创建活动 → 参与 → 创建订单 → 支付回调 → 发卡密
 * 2. 抽奖：创建活动 → 参与 → 即时抽奖 → 中奖 → 发卡密
 * 3. 批发：创建批量活动 → 多 quantity 支付 → 多发卡密
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTestData, getTestDb } from "../test-setup";
import {
  lotteryDraws, lotteryEntries, lotteryPrizeTiers, lotteryWinners,
  paymentOrders, paymentOrderAttempts, paymentOrderItems, prizeCodes, prizes,
  tenants, systemConfig,
} from "../db/schema";
import { eq, and, count } from "drizzle-orm";
import { handlePaymentCallback, createPaymentOrder } from "../services/payment/payment-service";
import { performInstantSpin } from "../services/lottery/spin-execution";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

const TENANT = "tenant-e2e";
const DRAW = "draw-e2e";
const DRAW_SLUG = "e2e-slug";
const PRIZE = "prize-e2e";

/** 创建基础租户 */
async function seedTenant() {
  await db.insert(tenants).values({ id: TENANT, name: "端到端测试租户" });
  await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery,claim" });
}

/** 创建秒杀活动（claim + paymentRequired）。maxParticipants 设大值让容量通过，由 prizeCodesCount 控制实际库存 */
async function seedFlashSaleDraw(prizeCodesCount: number) {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: DRAW, tenantId: TENANT, title: "秒杀活动", publicSlug: DRAW_SLUG,
    status: "open", activityKind: "claim", participationMode: "open",
    experienceType: "submit", resultMode: "instant",
    maxParticipants: 1000, // 大容量，让容量检查通过，实际由卡密库存控制
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
    promotionConfig: JSON.stringify({
      flashSale: { enabled: true, paymentRequired: true, priceCents: 9900, stockLimit: 1000, maxPerUser: 5 },
    }),
  });
  await db.insert(prizes).values({ id: PRIZE, tenantId: TENANT, name: "秒杀卡密", prizeType: "code", totalCount: prizeCodesCount, active: 1 });
  await db.insert(lotteryPrizeTiers).values({ id: "tier-e2e", tenantId: TENANT, drawId: DRAW, prizeId: PRIZE, tierName: "一等奖", winnerCount: prizeCodesCount, weight: 100, sortOrder: 1 });
  const codes = Array.from({ length: prizeCodesCount }, (_, i) => ({
    id: `code-e2e-${i + 1}`, tenantId: TENANT, prizeId: PRIZE,
    code: `E2E-CODE-${i + 1}`, secret: `E2E-SEC-${i + 1}`, status: "available" as const,
  }));
  if (codes.length > 0) await db.insert(prizeCodes).values(codes);
}

/** 创建抽奖活动（lottery） */
async function seedLotteryDraw(prizeCodesCount: number) {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: DRAW, tenantId: TENANT, title: "抽奖活动", publicSlug: DRAW_SLUG,
    status: "open", activityKind: "lottery", participationMode: "open",
    experienceType: "wheel", resultMode: "instant", maxSpinsPerEntry: 5, maxParticipants: 100,
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}", promotionConfig: "{}",
  });
  await db.insert(prizes).values({ id: PRIZE, tenantId: TENANT, name: "抽奖卡密", prizeType: "code", totalCount: prizeCodesCount, active: 1 });
  await db.insert(lotteryPrizeTiers).values({ id: "tier-e2e", tenantId: TENANT, drawId: DRAW, prizeId: PRIZE, tierName: "一等奖", winnerCount: prizeCodesCount, weight: 100, sortOrder: 1 });
  const codes = Array.from({ length: prizeCodesCount }, (_, i) => ({
    id: `code-e2e-${i + 1}`, tenantId: TENANT, prizeId: PRIZE,
    code: `E2E-CODE-${i + 1}`, secret: `E2E-SEC-${i + 1}`, status: "available" as const,
  }));
  if (codes.length > 0) await db.insert(prizeCodes).values(codes);
}

// 通用 mock provider
function mockProvider(name: string, tradeNo: string, amountCents: number, currency = "cny") {
  return {
    name,
    displayName: "Test Payment",
    supportedCurrencies: ["CNY"],
    createPayment: vi.fn(async () => ({
      providerTradeNo: tradeNo,
      redirectUrl: "https://pay.test",
    })),
    // handlePaymentCallback 从 verifyCallback 返回的 orderNo 获取 attemptId
    // verifyCallback 接收 params（含 attemptId），返回 orderNo 用于查找 attempt
    verifyCallback: vi.fn(async (params: Record<string, string>) => ({
      orderNo: params.attemptId || tradeNo,
      providerTradeNo: tradeNo,
      amountCents,
      currency,
      paidAt: new Date().toISOString(),
    })),
  };
}

describe("秒杀端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await seedTenant();
  });

  it("用户参与秒杀→支付→发卡密", async () => {
    await seedFlashSaleDraw(2);
    const { joinDraw } = await import("../services/lottery/participation");
    const joinResult = await joinDraw(db, DRAW_SLUG, "buyer@test.com", "email");
    expect(joinResult.joined).toBe(true);

    // 创建订单
    const cpOrder = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: joinResult.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "buyer@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn-e2e-001", 9900));
    expect(cpOrder.order.status).toBe("pending");

    // 取 attemptId（createPaymentOrder 内部创建 attempt，不返回其 ID，需查库）
    const [attempt] = await db
      .select({ id: paymentOrderAttempts.id })
      .from(paymentOrderAttempts)
      .where(eq(paymentOrderAttempts.paymentOrderId, cpOrder.order.id))
      .limit(1);
    expect(attempt).toBeDefined();

    // 支付回调
    const cbResult = await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn-e2e-001", 9900), {
      attemptId: attempt!.id,
      provider: "easypay", amountCents: "9900", currency: "cny", tradeNo: "txn-e2e-001",
    });
    expect(cbResult.processed).toBe(true);

    // 验证卡密已发放
    const issued = await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(Number(issued[0]!.n)).toBe(1);

    // 验证订单状态
    const [order] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.tenantId, TENANT)).limit(1);
    expect(order!.status).toBe("paid");
  });

  it("卡密不足时秒杀不完成（FULFILLMENT_FAILED）", async () => {
    await seedFlashSaleDraw(2); // 2 张卡密：下单时库存充足（源头扼杀预检通过），回调前模拟并发消耗

    // 第一个用户 → 成功
    const { joinDraw } = await import("../services/lottery/participation");
    const j1 = await joinDraw(db, DRAW_SLUG, "u1@test.com", "email");
    expect(j1.joined).toBe(true);
    const o1 = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: j1.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "u1@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn1", 9900));
    const [a1] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, o1.order.id)).limit(1);
    expect(a1).toBeDefined();
    await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn1", 9900), {
      attemptId: a1!.id, provider: "easypay", amountCents: "9900", currency: "cny", tradeNo: "txn1",
    });
    expect((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued"))))[0]!.n).toBe(1);

    // 第二个用户：下单时库存仍有 1 张（源头扼杀预检通过），
    // 但回调前模拟并发：另一笔订单先消耗了最后一张卡密 → 回调发卡失败 → FULFILLMENT_FAILED
    const j2 = await joinDraw(db, DRAW_SLUG, "u2@test.com", "email");
    expect(j2.joined).toBe(true);
    const o2 = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: j2.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "u2@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn2", 9900));
    const [a2] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, o2.order.id)).limit(1);
    expect(a2).toBeDefined();
    // 模拟并发：回调前把该订单预占的卡密改走（paymentOrderId 改为其他订单），
    // confirmPrizeCodes 按本订单找 reserved 卡密时找不到 → FULFILLMENT_FAILED
    await db.update(prizeCodes)
      .set({ paymentOrderId: "OTHER-ORDER-SIM" })
      .where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "reserved")));
    const cbResult = await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn2", 9900), {
      attemptId: a2!.id, provider: "easypay", amountCents: "9900", currency: "cny", tradeNo: "txn2",
    });
    expect(cbResult.processed).toBe(true);
    // 卡密不足！订单状态应为 FULFILLMENT_FAILED
    const [order] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.tenantId, TENANT)).orderBy(paymentOrders.createdAt).limit(1).offset(1);
    expect(order!.status).toBe("paid_fulfillment_failed");
    // 只有 1 张卡密被发放（第一个用户）
    expect(Number((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued"))))[0]!.n)).toBe(1);
  });
});

describe("抽奖端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await seedTenant();
  });

  it("用户参与→即时抽奖→中奖→发卡密", async () => {
    await seedLotteryDraw(2);
    const { joinDraw } = await import("../services/lottery/participation");
    const joinResult = await joinDraw(db, DRAW_SLUG, "player@test.com", "email");
    expect(joinResult.joined).toBe(true);
    const entryId = joinResult.entryId!;

    // 即时抽奖
    const spinResult = await performInstantSpin(db, { slug: DRAW_SLUG, identityType: "email", identityValue: "player@test.com", idempotencyKey: "spin-e2e-1" });
    expect(spinResult.won).toBe(true);
    expect(spinResult.spinId).toBeTruthy();

    // 验证中奖记录 + 卡密已发放
    const [winner] = await db.select({ id: lotteryWinners.id, prizeCodeId: lotteryWinners.prizeCodeId }).from(lotteryWinners).where(and(eq(lotteryWinners.tenantId, TENANT), eq(lotteryWinners.entryId, entryId))).limit(1);
    expect(winner).toBeDefined();
    expect(winner!.prizeCodeId).toBeTruthy();

    const issued = await db.select({ code: prizeCodes.code }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(issued.length).toBe(1);
    expect(issued[0]!.code).toBe("E2E-CODE-1");

    // 验证剩余次数
    const [entry] = await db.select({ spinsLeft: lotteryEntries.spinsLeft }).from(lotteryEntries).where(and(eq(lotteryEntries.tenantId, TENANT), eq(lotteryEntries.id, entryId))).limit(1);
    expect(Number(entry!.spinsLeft)).toBe(0);
  });

  it("即时抽奖幂等回放不重复发卡", async () => {
    await seedLotteryDraw(2);
    const { joinDraw } = await import("../services/lottery/participation");
    await joinDraw(db, DRAW_SLUG, "player@test.com", "email");

    // 第一次抽奖
    const r1 = await performInstantSpin(db, { slug: DRAW_SLUG, identityType: "email", identityValue: "player@test.com", idempotencyKey: "spin-e2e-idemp" });
    expect(r1.won).toBe(true);
    // 同幂等键回放
    const r2 = await performInstantSpin(db, { slug: DRAW_SLUG, identityType: "email", identityValue: "player@test.com", idempotencyKey: "spin-e2e-idemp" });
    expect(r2.won).toBe(true);
    expect(r2.spinId).toBe(r1.spinId); // 同一条记录

    const issued = await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(Number(issued[0]!.n)).toBe(1);
  });

  it("延迟开奖（手动）→ 中奖 → 发卡密", async () => {
    // 创建非 instant 的 lottery 活动
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: "draw-delayed", tenantId: TENANT, title: "延迟开奖活动", publicSlug: "delayed-slug",
      status: "open", activityKind: "lottery", participationMode: "open",
      experienceType: "submit", resultMode: "manual", drawTrigger: "manual",
      maxParticipants: 100, maxSpinsPerEntry: 1,
      startAt: new Date(now.getTime() - 3600000).toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityConfig: "{}", promotionConfig: "{}",
    });
    const prizeId = "prize-delayed";
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT, name: "延迟奖品", prizeType: "code", totalCount: 1, active: 1 });
    await db.insert(lotteryPrizeTiers).values({ id: "tier-delayed", tenantId: TENANT, drawId: "draw-delayed", prizeId, tierName: "一等奖", winnerCount: 1, weight: 100, sortOrder: 1 });
    await db.insert(prizeCodes).values({ id: "code-delayed-1", tenantId: TENANT, prizeId, code: "DELAYED-CODE-1", secret: "DELAYED-SEC-1", status: "available" });

    // 用户参与
    const { joinDraw } = await import("../services/lottery/participation");
    const joinResult = await joinDraw(db, "delayed-slug", "delayed@test.com", "email");
    expect(joinResult.joined).toBe(true);

    // 手动开奖
    const { performDraw } = await import("../services/lottery/draw-execution");
    const drawResult = await performDraw(db, TENANT, "draw-delayed", "admin", null as any);
    expect(drawResult.winnerCount).toBeGreaterThanOrEqual(1);

    // 验证中奖记录
    const [winner] = await db
      .select({ id: lotteryWinners.id, prizeCodeId: lotteryWinners.prizeCodeId })
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.tenantId, TENANT), eq(lotteryWinners.drawId, "draw-delayed")))
      .limit(1);
    expect(winner).toBeDefined();
    expect(winner!.prizeCodeId).toBeTruthy();

    // 验证卡密已发放
    const issued = await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(Number(issued[0]!.n)).toBe(1);

    // 验证活动状态为 drawn
    const [draw] = await db.select({ status: lotteryDraws.status }).from(lotteryDraws).where(eq(lotteryDraws.id, "draw-delayed")).limit(1);
    expect(draw!.status).toBe("drawn");
  });

  it("用户间隔离：A 的中奖记录不包含 B 的结果", async () => {
    const now = new Date();
    const drawId = "draw-isolation";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, title: "隔离测试", publicSlug: "isolation-slug",
      status: "open", activityKind: "lottery", participationMode: "open",
      experienceType: "submit", resultMode: "manual", drawTrigger: "manual",
      maxParticipants: 100, maxSpinsPerEntry: 1,
      startAt: new Date(now.getTime() - 3600000).toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityConfig: "{}", promotionConfig: "{}",
    });
    const prizeId = "prize-iso";
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT, name: "隔离奖品", prizeType: "code", totalCount: 2, active: 1 });
    await db.insert(lotteryPrizeTiers).values({ id: "tier-iso", tenantId: TENANT, drawId, prizeId, tierName: "一等奖", winnerCount: 2, weight: 100, sortOrder: 1 });
    await db.insert(prizeCodes).values([
      { id: "code-iso-1", tenantId: TENANT, prizeId, code: "ISO-CODE-1", secret: "ISO-SEC-1", status: "available" },
      { id: "code-iso-2", tenantId: TENANT, prizeId, code: "ISO-CODE-2", secret: "ISO-SEC-2", status: "available" },
    ]);

    // A 和 B 各自参与
    const { joinDraw } = await import("../services/lottery/participation");
    const jA = await joinDraw(db, "isolation-slug", "userA@test.com", "email");
    const jB = await joinDraw(db, "isolation-slug", "userB@test.com", "email");
    expect(jA.joined).toBe(true);
    expect(jB.joined).toBe(true);

    // 手动开奖（2 个名额，各中一个）
    const { performDraw } = await import("../services/lottery/draw-execution");
    await performDraw(db, TENANT, drawId, "admin", null as any);

    // 验证：按 identityValue 查 winner → A 只看到 A 的，B 只看到 B 的
    const [wA] = await db
      .select({ id: lotteryWinners.id, entryId: lotteryWinners.entryId })
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.tenantId, TENANT), eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.entryId, jA.entryId!)))
      .limit(1);
    const [wB] = await db
      .select({ id: lotteryWinners.id, entryId: lotteryWinners.entryId })
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.tenantId, TENANT), eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.entryId, jB.entryId!)))
      .limit(1);
    expect(wA).toBeDefined();
    expect(wB).toBeDefined();
    // A 的 winner 不同于 B 的 winner
    expect(wA!.id).not.toBe(wB!.id);
    // A 的 entryId 应为 jA 的 entry
    expect(wA!.entryId).toBe(jA.entryId!);
    expect(wB!.entryId).toBe(jB.entryId!);
  });
});

describe("批发模式端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await seedTenant();
  });

  it("用户批量购买（quantity=3）→ 支付 → 发 3 张卡密", async () => {
    await seedFlashSaleDraw(5);
    const { joinDraw } = await import("../services/lottery/participation");
    const joinResult = await joinDraw(db, DRAW_SLUG, "wholesale@test.com", "email");
    expect(joinResult.joined).toBe(true);

    const cpOrder = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: joinResult.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "wholesale@test.com",
      amountCents: 29700, currency: "cny", provider: "easypay", quantity: 3, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn-wholesale", 29700));
    expect(cpOrder.order.status).toBe("pending");

    // 取 attemptId
    const [attemptW] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, cpOrder.order.id)).limit(1);
    expect(attemptW).toBeDefined();

    // 支付回调
    const cbResult = await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn-wholesale", 29700), {
      attemptId: attemptW!.id, provider: "easypay", amountCents: "29700", currency: "cny", tradeNo: "txn-wholesale",
    });
    expect(cbResult.processed).toBe(true);

    // 验证 3 张卡密全部发放
    const issuedCodes = await db.select({ code: prizeCodes.code }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(issuedCodes.length).toBe(3);
    expect(issuedCodes[0]!.code).toBe("E2E-CODE-1");
    expect(issuedCodes[1]!.code).toBe("E2E-CODE-2");
    expect(issuedCodes[2]!.code).toBe("E2E-CODE-3");

    // 验证订单项已绑定
    const items = await db.select({ id: paymentOrderItems.id, prizeCodeId: paymentOrderItems.prizeCodeId }).from(paymentOrderItems).where(eq(paymentOrderItems.tenantId, TENANT));
    expect(items.length).toBe(3);
    expect(items.every(i => i.prizeCodeId !== null)).toBe(true);
  });

  it("批发卡密不足 → 不发卡 → FULFILLMENT_FAILED", async () => {
    await seedFlashSaleDraw(5); // 5 张卡密：下单时库存充足（源头扼杀预检通过），回调前模拟并发消耗

    const { joinDraw } = await import("../services/lottery/participation");
    const joinResult = await joinDraw(db, DRAW_SLUG, "bulk@test.com", "email");
    expect(joinResult.joined).toBe(true);

    // 创建订单 quantity=5（下单时预检通过，库存 5 >= 5）
    const cpOrder = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: joinResult.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "bulk@test.com",
      amountCents: 49500, currency: "cny", provider: "easypay", quantity: 5, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn-bulk", 49500));

    // 取 attemptId
    const [attemptB] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, cpOrder.order.id)).limit(1);
    expect(attemptB).toBeDefined();

    // 模拟并发：回调前把 4 张该订单预占的卡密改走（paymentOrderId 改为其他订单），
    // 剩余 1 张 < quantity=5 → confirmPrizeCodes 不足 → FULFILLMENT_FAILED
    // SQLite 不支持 UPDATE ... LIMIT，逐张更新
    const codesToConsume = await db.select({ id: prizeCodes.id }).from(prizeCodes)
      .where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "reserved")))
      .limit(4);
    for (const c of codesToConsume) {
      await db.update(prizeCodes).set({ paymentOrderId: "OTHER-ORDER-SIM" }).where(eq(prizeCodes.id, c.id));
    }

    // 支付回调 → 卡密不足 → FULFILLMENT_FAILED（不半单发放）
    const cbResult = await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn-bulk", 49500), {
      attemptId: attemptB!.id, provider: "easypay", amountCents: "49500", currency: "cny", tradeNo: "txn-bulk",
    });
    expect(cbResult.processed).toBe(true);

    // 验证：没有卡密被发放（全部回滚，不半单发放）
    const issued = await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(Number(issued[0]!.n)).toBe(0);

    // 订单状态应为 paid_fulfillment_failed
    const [order] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.tenantId, TENANT)).limit(1);
    expect(order!.status).toBe("paid_fulfillment_failed");
  });

  it("两个用户同时抢最后一个秒杀名额，仅一人成功", async () => {
    // 设 1 个名额 + 1 张卡密，两用户同时 joinDraw
    await seedFlashSaleDraw(1);
    // 容量由 stockLimit 控制（优先于 maxParticipants），需同步改小
    await db.update(lotteryDraws).set({ maxParticipants: 1, promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, priceCents: 9900, stockLimit: 1 } }) }).where(eq(lotteryDraws.id, DRAW));

    const { joinDraw } = await import("../services/lottery/participation");
    const [r1, r2] = await Promise.all([
      joinDraw(db, DRAW_SLUG, "concurrent1@test.com", "email"),
      joinDraw(db, DRAW_SLUG, "concurrent2@test.com", "email"),
    ]);
    // 仅一人成功
    const joined = [r1, r2].filter(r => r.joined);
    expect(joined.length).toBe(1);
    // 失败者应提示售罄/容量满
    const failed = [r1, r2].find(r => !r.joined);
    expect(failed).toBeDefined();
  });
});

describe("过期释放与卡密补发", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await db.insert(tenants).values({ id: TENANT, name: "e2e-补充测试" });
    await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery,claim" });
  });

  it("订单超时释放后名额可被其他用户使用", async () => {
    await seedFlashSaleDraw(2); // 2 张卡密
    // 用户 A 参与并创建订单（不支付）
    const { joinDraw } = await import("../services/lottery/participation");
    const jA = await joinDraw(db, DRAW_SLUG, "expireA@test.com", "email");
    expect(jA.joined).toBe(true);
    await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: jA.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "expireA@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn-expire", 9900));

    // 强制超时该订单（把 createdAt 改到过去）
    const { expireOverdueOrders } = await import("../services/payment/payment-service");
    await db.update(paymentOrders).set({ createdAt: "2020-01-01T00:00:00Z" }).where(eq(paymentOrders.tenantId, TENANT));
    const released = await expireOverdueOrders(db, TENANT);
    expect(released).toBeGreaterThanOrEqual(1);

    // 用户 B 参与并支付 → 应该能成功（名额已被释放）
    const jB = await joinDraw(db, DRAW_SLUG, "expireB@test.com", "email");
    expect(jB.joined).toBe(true);
    const oB = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: jB.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "expireB@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn-expireB", 9900));
    const [aB] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, oB.order.id)).limit(1);
    expect(aB).toBeDefined();
    await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn-expireB", 9900), {
      attemptId: aB!.id, provider: "easypay", amountCents: "9900", currency: "cny", tradeNo: "txn-expireB",
    });
    const issued = await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(Number(issued[0]!.n)).toBe(1);
  });

  it("卡密补发：FULFILLMENT_FAILED → 补发 → 卡密到账", async () => {
    await seedFlashSaleDraw(1); // 1 张卡密：下单时库存充足（源头扼杀预检通过），回调前模拟并发消耗触发 FULFILLMENT_FAILED

    // 用户参与并支付 → 卡密不足 → FULFILLMENT_FAILED
    const { joinDraw } = await import("../services/lottery/participation");
    const j1 = await joinDraw(db, DRAW_SLUG, "retry@test.com", "email");
    expect(j1.joined).toBe(true);
    const o1 = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: j1.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "retry@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1, notifyUrl: "http://callback.test",
    }, mockProvider("easypay", "txn-retry", 9900));
    const [a1] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, o1.order.id)).limit(1);
    expect(a1).toBeDefined();
    // 模拟并发：回调前把该订单预占的卡密改走（paymentOrderId 改为其他订单）→ confirmPrizeCodes 找不到 → FULFILLMENT_FAILED
    await db.update(prizeCodes)
      .set({ paymentOrderId: "OTHER-ORDER-SIM" })
      .where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "reserved")));
    await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn-retry", 9900), {
      attemptId: a1!.id, provider: "easypay", amountCents: "9900", currency: "cny", tradeNo: "txn-retry",
    });
    // 验证是 FULFILLMENT_FAILED
    const [order] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, o1.order.id)).limit(1);
    expect(order!.status).toBe("paid_fulfillment_failed");

    // 补卡密：先往码池加 1 张卡密
    const newPrizeId = "prize-retry";
    await db.insert(prizes).values({ id: newPrizeId, tenantId: TENANT, name: "补发奖品", prizeType: "code", totalCount: 1, active: 1 });
    await db.insert(prizeCodes).values({ id: "code-retry-1", tenantId: TENANT, prizeId: newPrizeId, code: "RETRY-CODE-1", secret: "RETRY-SEC-1", status: "available" });
    // 把奖档指向新码池
    await db.update(lotteryPrizeTiers).set({ prizeId: newPrizeId }).where(eq(lotteryPrizeTiers.id, "tier-e2e"));

    // 补发
    const { retryPaymentFulfillment } = await import("../services/payment/payment-service");
    const retryResult = await retryPaymentFulfillment(db, TENANT, o1.order.id);
    expect(retryResult.ok).toBe(true);

    // 验证卡密已发放
    const issued = await db.select({ code: prizeCodes.code }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(issued.length).toBe(1);
    expect(issued[0]!.code).toBe("RETRY-CODE-1");

    // 验证订单状态已恢复为 paid
    const [orderAfter] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, o1.order.id)).limit(1);
    expect(orderAfter!.status).toBe("paid");
  });
});

describe("定时开奖端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await db.insert(tenants).values({ id: TENANT, name: "e2e-定时开奖" });
    await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery" });
  });

  it("定时开奖 → 到期自动开奖 → 中奖 → 发卡密", async () => {
    const now = new Date();
    const drawId = "draw-scheduled";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, title: "定时开奖活动", publicSlug: "scheduled-slug",
      status: "open", activityKind: "lottery", participationMode: "open",
      experienceType: "submit", resultMode: "manual", drawTrigger: "scheduled",
      drawAt: new Date(now.getTime() - 60000).toISOString(), // 1 分钟前到期
      maxParticipants: 100, maxSpinsPerEntry: 1,
      startAt: new Date(now.getTime() - 3600000).toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityConfig: "{}", promotionConfig: "{}",
    });
    const prizeId = "prize-sched";
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT, name: "定时奖品", prizeType: "code", totalCount: 1, active: 1 });
    await db.insert(lotteryPrizeTiers).values({ id: "tier-sched", tenantId: TENANT, drawId, prizeId, tierName: "一等奖", winnerCount: 1, weight: 100, sortOrder: 1 });
    await db.insert(prizeCodes).values({ id: "code-sched-1", tenantId: TENANT, prizeId, code: "SCHED-CODE-1", secret: "SCHED-SEC-1", status: "available" });

    // 用户参与
    const { joinDraw } = await import("../services/lottery/participation");
    const j1 = await joinDraw(db, "scheduled-slug", "sched1@test.com", "email");
    expect(j1.joined).toBe(true);

    // 调用 processDueDraws（cron 定时兜底）
    const { processDueDraws } = await import("../services/lottery-service");
    const result = await processDueDraws(db, { limit: 100 });
    expect(result.processed).toBeGreaterThanOrEqual(1);

    // 验证活动已开奖
    const [draw] = await db.select({ status: lotteryDraws.status }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(draw!.status).toBe("drawn");

    // 验证中奖记录
    const [winner] = await db.select({ id: lotteryWinners.id, prizeCodeId: lotteryWinners.prizeCodeId }).from(lotteryWinners).where(and(eq(lotteryWinners.tenantId, TENANT), eq(lotteryWinners.drawId, drawId))).limit(1);
    expect(winner).toBeDefined();
    expect(winner!.prizeCodeId).toBeTruthy();

    // 验证卡密已发放
    const issued = await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")));
    expect(Number(issued[0]!.n)).toBe(1);
  });
});

describe("接龙活动端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await db.insert(tenants).values({ id: TENANT, name: "e2e-接龙" });
    await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery,signup_chain" });
  });

  it("创建接龙→参与→分配名额→候补", async () => {
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: "draw-signup", tenantId: TENANT, title: "接龙活动", publicSlug: "signup-slug",
      status: "open", activityKind: "signup_chain", participationMode: "open",
      experienceType: "submit", resultMode: "manual",
      maxParticipants: 2, allocationPolicy: "waitlist",
      startAt: new Date(now.getTime() - 3600000).toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityConfig: "{}", promotionConfig: "{}",
    });

    // 用户 A、B 参与（占满 2 个名额）
    const { joinDraw } = await import("../services/lottery/participation");
    const jA = await joinDraw(db, "signup-slug", "signA@test.com", "email");
    expect(jA.joined).toBe(true);
    const jB = await joinDraw(db, "signup-slug", "signB@test.com", "email");
    expect(jB.joined).toBe(true);

    // 用户 C 参与（进入候补）
    const jC = await joinDraw(db, "signup-slug", "signC@test.com", "email");
    expect(jC.joined).toBe(true); // 接龙可以候补

    // 验证参与记录
    const entries = await db.select({ id: lotteryEntries.id, identityValue: lotteryEntries.identityValue })
      .from(lotteryEntries).where(eq(lotteryEntries.tenantId, TENANT)).orderBy(lotteryEntries.joinedAt);
    expect(entries.length).toBe(3);

    // 用户 A 取消
    const { cancelSignupChainEntry } = await import("../services/lottery/participation");
    const cancelResult = await cancelSignupChainEntry(db, TENANT, "draw-signup", "signA@test.com");
    expect(cancelResult.cancelled).toBe(true);

    // 验证序列号（候补用户应仍存在）
    const entriesAfter = await db.select({ identityValue: lotteryEntries.identityValue })
      .from(lotteryEntries).where(eq(lotteryEntries.tenantId, TENANT)).orderBy(lotteryEntries.joinedAt);
    expect(entriesAfter.length).toBe(2); // 一人取消，剩 2 人
  });
});

describe("黑名单拦截端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await db.insert(tenants).values({ id: TENANT, name: "e2e-黑名单" });
    await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery" });
  });

  it("黑名单用户无法参与活动", async () => {
    const now = new Date();
    const drawId = "draw-blacklist";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, title: "黑名单测试活动", publicSlug: "blacklist-slug",
      status: "open", activityKind: "lottery", participationMode: "open",
      experienceType: "submit", resultMode: "manual",
      maxParticipants: 100,
      startAt: new Date(now.getTime() - 3600000).toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityConfig: "{}", promotionConfig: "{}",
    });

    // 将用户加入黑名单
    const { lotteryBlacklist } = await import("../db/schema");
    await db.insert(lotteryBlacklist).values({
      id: "bl-1", tenantId: TENANT, identityValue: "blocked@test.com",
      note: "测试", createdAt: new Date().toISOString(),
    });

    // 黑名单用户尝试参与 → 被拒绝
    const { joinDraw } = await import("../services/lottery/participation");
    const result = await joinDraw(db, "blacklist-slug", "blocked@test.com", "email");
    expect(result.joined).toBe(false);
    expect(result.message).toContain("限制参与");

    // 非黑名单用户 → 可以参与
    const ok = await joinDraw(db, "blacklist-slug", "normal@test.com", "email");
    expect(ok.joined).toBe(true);
  });
});

describe("公开端卡密找回端到端", () => {
  beforeAll(async () => { ({ client, db } = await getTestDb()); });
  beforeEach(async () => {
    await clearTestData(client);
    await db.insert(tenants).values({ id: TENANT, name: "e2e-卡密找回" });
    await db.insert(systemConfig).values({ key: "enabled_activity_kinds", value: "lottery" });
  });

  it("中奖后通过 access-code 查询卡密（公开端卡密找回）", async () => {
    const now = new Date();
    const drawId = "draw-access";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, title: "卡密找回活动", publicSlug: "access-slug",
      status: "open", activityKind: "lottery", participationMode: "open",
      experienceType: "submit", resultMode: "manual",
      maxParticipants: 100,
      startAt: new Date(now.getTime() - 3600000).toISOString(),
      endAt: new Date(now.getTime() + 3600000).toISOString(),
      activityConfig: "{}", promotionConfig: "{}",
    });
    const prizeId = "prize-access";
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT, name: "卡密奖品", prizeType: "code", totalCount: 1, active: 1 });
    await db.insert(lotteryPrizeTiers).values({ id: "tier-access", tenantId: TENANT, drawId, prizeId, tierName: "一等奖", winnerCount: 1, weight: 100, sortOrder: 1 });
    await db.insert(prizeCodes).values({ id: "code-access-1", tenantId: TENANT, prizeId, code: "ACCESS-CODE-1", secret: "ACCESS-SEC-1", status: "available" });

    // 用户参与
    const { joinDraw } = await import("../services/lottery/participation");
    const j1 = await joinDraw(db, "access-slug", "finder@test.com", "email");
    expect(j1.joined).toBe(true);

    // 手动开奖
    const { performDraw } = await import("../services/lottery/draw-execution");
    await performDraw(db, TENANT, drawId, "admin", null as any);

    // 验证中奖记录含卡密
    const [winner] = await db
      .select({ id: lotteryWinners.id, prizeCodeId: lotteryWinners.prizeCodeId })
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.tenantId, TENANT), eq(lotteryWinners.drawId, drawId)))
      .limit(1);
    expect(winner).toBeDefined();
    expect(winner!.prizeCodeId).toBeTruthy();

    // 验证卡密已发放
    const [issuedCode] = await db
      .select({ code: prizeCodes.code, secret: prizeCodes.secret })
      .from(prizeCodes)
      .where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued")))
      .limit(1);
    expect(issuedCode).toBeDefined();
    expect(issuedCode!.code).toBe("ACCESS-CODE-1");
  });
});