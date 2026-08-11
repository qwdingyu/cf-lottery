/**
 * 秒杀、抽奖、批发模式端到端全流程测试。
 *
 * 验证核心业务链路完整闭环：
 * 1. 秒杀：创建活动 → 参与 → 创建订单 → 支付回调 → 发卡密
 * 2. 抽奖：创建活动 → 参与 → 即时抽奖 → 中奖 → 发卡密
 * 3. 批发：创建批量活动 → 多 quantity 支付 → 多发卡密
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { clearTestData, getTestDb } from "../test-setup";
import {
  lotteryDraws, lotteryEntries, lotteryPrizeTiers, lotterySpins, lotteryWinners,
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

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
};

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
      flashSale: { enabled: true, paymentRequired: true, priceCents: 9900, stockLimit: 1000 },
    }),
  });
  await db.insert(prizes).values({ id: PRIZE, tenantId: TENANT, name: "秒杀卡密", prizeType: "code", totalCount: prizeCodesCount, active: 1 });
  await db.insert(lotteryPrizeTiers).values({ id: "tier-e2e", tenantId: TENANT, drawId: DRAW, prizeId: PRIZE, tierName: "一等奖", winnerCount: prizeCodesCount, weight: 100, sortOrder: 1 });
  const codes = Array.from({ length: prizeCodesCount }, (_, i) => ({
    id: `code-e2e-${i + 1}`, tenantId: TENANT, prizeId: PRIZE,
    code: `E2E-CODE-${i + 1}`, secret: `E2E-SEC-${i + 1}`, status: "available" as const,
  }));
  await db.insert(prizeCodes).values(codes);
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
  await db.insert(prizeCodes).values(codes);
}

// 通用 mock provider
function mockProvider(name: string, tradeNo: string, amountCents: number, currency = "cny") {
  return {
    name,
    createPayment: vi.fn(async () => ({ url: "https://pay.test", tradeNo })),
    // handlePaymentCallback 从 verifyCallback 返回的 orderNo 获取 attemptId
    // verifyCallback 接收 params（含 attemptId），返回 orderNo 用于查找 attempt
    verifyCallback: vi.fn(async (params: Record<string, string>) => ({
      ok: true as const, tradeNo, amountCents, currency,
      orderNo: params.attemptId || tradeNo,
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
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1,
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
    await seedFlashSaleDraw(1); // 仅 1 张卡密

    // 第一个用户 → 成功
    const { joinDraw } = await import("../services/lottery/participation");
    const j1 = await joinDraw(db, DRAW_SLUG, "u1@test.com", "email");
    expect(j1.joined).toBe(true);
    const o1 = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: j1.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "u1@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1,
    }, mockProvider("easypay", "txn1", 9900));
    const [a1] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, o1.order.id)).limit(1);
    expect(a1).toBeDefined();
    await handlePaymentCallback(db, TENANT, mockProvider("easypay", "txn1", 9900), {
      attemptId: a1!.id, provider: "easypay", amountCents: "9900", currency: "cny", tradeNo: "txn1",
    });
    expect((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT), eq(prizeCodes.status, "issued"))))[0]!.n).toBe(1);

    // 第二个用户 → 卡密不足 → FULFILLMENT_FAILED
    const j2 = await joinDraw(db, DRAW_SLUG, "u2@test.com", "email");
    expect(j2.joined).toBe(true);
    const o2 = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: j2.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "u2@test.com",
      amountCents: 9900, currency: "cny", provider: "easypay", quantity: 1,
    }, mockProvider("easypay", "txn2", 9900));
    const [a2] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, o2.order.id)).limit(1);
    expect(a2).toBeDefined();
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
      amountCents: 29700, currency: "cny", provider: "easypay", quantity: 3,
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
    await seedFlashSaleDraw(2); // 仅 2 张卡密

    const { joinDraw } = await import("../services/lottery/participation");
    const joinResult = await joinDraw(db, DRAW_SLUG, "bulk@test.com", "email");
    expect(joinResult.joined).toBe(true);

    // 创建订单 quantity=5（远超卡密库存）
    const cpOrder = await createPaymentOrder(db, {
      tenantId: TENANT, drawId: DRAW, entryId: joinResult.entryId!,
      buyerIdentityType: "email", buyerIdentityValue: "bulk@test.com",
      amountCents: 49500, currency: "cny", provider: "easypay", quantity: 5,
    }, mockProvider("easypay", "txn-bulk", 49500));

    // 取 attemptId
    const [attemptB] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, cpOrder.order.id)).limit(1);
    expect(attemptB).toBeDefined();

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
});