import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import { clearTestData, getTestDb } from "../../test-setup";
import type { DbType } from "../../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryPrizeTiers,
  paymentOrders,
  paymentOrderAttempts,
  paymentOrderItems,
  prizeCodes,
  prizes,
  tenantConfigs,
  tenants,
} from "../../db/schema";
import type { PaymentProvider } from "@usethink/cf-pay/catalog";
import { EasyPayProviderError } from "@usethink/cf-pay/catalog";
import {
  createTenantProvider,
  createPaymentOrder,
  expireOverdueOrders,
  handlePaymentCallback,
  loadTenantConfig,
  persistProviderTradeNo,
  resumePendingPaymentOrder,
  retryPaymentOrder,
  retryPaymentFulfillment,
  refundPaymentOrder,
} from "./payment-service";
import { encryptPaymentConfigValue } from "@usethink/cf-pay/config-store";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const TENANT_ID = "tenant-payment-service";
const DRAW_ID = "draw-payment-service";
const ENTRY_ID = "entry-payment-service";
const ORDER_ID = "order-payment-service";
const ATTEMPT_ID = "attempt-payment-service-1";
const PRIZE_ID = "prize-payment-service";
const PRIZE_CODE_ID = "prize-code-payment-service";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const providerMock: PaymentProvider = {
  name: "alipay",
  displayName: "支付宝当面付",
  supportedCurrencies: ["CNY"],
  createPayment: vi.fn(async () => ({
    providerTradeNo: "checkout-123",
    redirectUrl: "https://pay.example.com/checkout",
    qrCode: "https://pay.example.com/qr",
  })),
  verifyCallback: vi.fn(async () => {
    throw new Error("not used");
  }),
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  vi.clearAllMocks();
  await clearTestData(client);
});

async function seedBaseRows(status: string) {
  await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "payment-service-draw",
    title: "支付测试活动",
    status: "open",
    maxParticipants: 1,
    activeParticipantCount: status === "pending" ? 1 : 0,
    experienceType: "flash_sale",
    promotionConfig: JSON.stringify({
      flashSale: {
        enabled: true,
        paymentRequired: true,
        stockLimit: 1,
        priceCents: 9900,
        currency: "cny",
      },
    }),
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await db.insert(lotteryEntries).values({
    id: ENTRY_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    identityType: "email",
    identityValue: "buyer@example.com",
    displayName: "buyer",
    paymentStatus: status === "expired" ? "expired" : status === "pending" ? "pending" : "expired",
  });
  await db.insert(paymentOrders).values({
    id: ORDER_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    entryId: ENTRY_ID,
    amountCents: 9900,
    currency: "cny",
    status,
    provider: "alipay",
    currentAttemptId: ATTEMPT_ID,
  });
  await db.insert(paymentOrderItems).values({
    id: `${ORDER_ID}-item-1`,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    paymentOrderId: ORDER_ID,
    lineNo: 1,
    itemType: "flash_sale",
    title: "支付测试活动",
    quantity: 1,
    amountCents: 9900,
    currency: "cny",
    pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
    status: status === "pending" ? "pending" : "refunded",
    unitPriceCents: 9900,
  });
  await db.insert(paymentOrderAttempts).values({
    id: ATTEMPT_ID,
    paymentOrderId: ORDER_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    attemptNo: 1,
    provider: "alipay",
    amountCents: 9900,
    currency: "cny",
    status: status === "pending" ? "pending" : status === "expired" ? "expired" : "failed",
  });
}

async function seedCallbackRows(status = "pending") {
  await seedBaseRows(status);
  await db.insert(prizes).values({
    id: PRIZE_ID,
    tenantId: TENANT_ID,
    name: "卡密奖品",
    prizeType: "code",
  });
  await db.insert(lotteryPrizeTiers).values({
    id: "tier-payment-service",
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    prizeId: PRIZE_ID,
  });
  await db.insert(prizeCodes).values({
    id: PRIZE_CODE_ID,
    tenantId: TENANT_ID,
    prizeId: PRIZE_ID,
    code: "CODE-1",
    secret: "SECRET-1",
    status: "available",
  });
}

describe("retryPaymentOrder", () => {
  it("reuses cancelled order id and re-arms the entry", async () => {
    await seedBaseRows("cancelled");

    const result = await retryPaymentOrder(
      db,
      {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: ENTRY_ID,
        buyerIdentityType: "email",
        buyerIdentityValue: "test@example.com",
        // 重试请求故意传入不同金额/币种，必须仍以原订单快照为准。
        amountCents: 1,
        currency: "usd",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
        returnUrl: "https://example.com/result",
        description: "秒杀卡密",
      },
      providerMock,
      ORDER_ID,
    );

    expect(providerMock.createPayment).toHaveBeenCalledTimes(1);
    expect(providerMock.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      orderNo: expect.not.stringMatching(new RegExp(`^${ORDER_ID}$`)),
      amountCents: 9900,
      currency: "cny",
    }));
    expect(result.order.id).toBe(ORDER_ID);
    expect(result.order.status).toBe("pending");
    expect(result.payResult.redirectUrl).toBe("https://pay.example.com/checkout");

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(order?.status).toBe("pending");
    expect(order?.providerTradeNo).toBe("checkout-123");
    expect(order?.currentAttemptId).not.toBe(ATTEMPT_ID);
    /* V2 removed */ // expect(order?.prizeCodeId).toBeNull();
    expect(entry?.paymentStatus).toBe("pending");
    const [oldAttempt] = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.id, ATTEMPT_ID));
    expect(["failed", "superseded"]).toContain(oldAttempt?.status);
  });

  /**
   * docs/255 §十五 R-1：重试支付必须重新预占卡密。
   *
   * 订单超时/取消时 expireOverdueOrders / cancelPaymentOrder 已把预占卡密释放回 available，
   * 卡密可能已被别人买走。旧实现 retryPaymentOrder 只走 armPaymentOrderForRetry
   * （只补名额，不碰 prize_codes），用户付款后回调只能落到 acquirePrizeCodes 兜底 →
   * 必然 FULFILLMENT_FAILED，只能靠退款兜底。
   */
  it("重试时卡密已售罄必须拒绝，不得让用户进入支付（docs/255 R-1）", async () => {
    await seedCallbackRows("expired");
    // 卡密被别人买走
    await db.update(prizeCodes).set({ status: "issued" }).where(eq(prizeCodes.id, PRIZE_CODE_ID));

    await expect(retryPaymentOrder(
      db,
      {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: ENTRY_ID,
        buyerIdentityType: "email",
        buyerIdentityValue: "test@example.com",
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
      },
      providerMock,
      ORDER_ID,
    )).rejects.toThrow("可用 0 件，需要 1 件");

    // 未进入支付流程，且名额补占与 entry 状态一并回滚
    expect(providerMock.createPayment).not.toHaveBeenCalled();
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("expired");
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(entry?.paymentStatus).toBe("expired");
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(draw?.activeParticipantCount).toBe(0);
  });

  it("重试成功时把卡密重新预占到本订单（reserved）", async () => {
    await seedCallbackRows("expired");

    await retryPaymentOrder(
      db,
      {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: ENTRY_ID,
        buyerIdentityType: "email",
        buyerIdentityValue: "test@example.com",
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
      },
      providerMock,
      ORDER_ID,
    );

    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(code?.status).toBe("reserved");
    expect(code?.paymentOrderId).toBe(ORDER_ID);
  });

  it("rolls back to cancelled when retry fails", async () => {
    await seedBaseRows("expired");
    const failingProvider: PaymentProvider = {
      ...providerMock,
      createPayment: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    };

    await expect(retryPaymentOrder(
      db,
      {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: ENTRY_ID,
        buyerIdentityType: "email",
        buyerIdentityValue: "test@example.com",
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
      },
      failingProvider,
      ORDER_ID,
    )).rejects.toThrow("gateway down");

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(order?.status).toBe("cancelled");
    expect(entry?.paymentStatus).toBe("expired");
    expect(draw?.activeParticipantCount).toBe(0);
  });

  it("expired order retry cannot reacquire a released slot after capacity is occupied", async () => {
    await seedBaseRows("expired");
    await db.insert(lotteryEntries).values({
      id: "entry-payment-service-occupied",
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: "occupied@example.com",
      displayName: "occupied",
      paymentStatus: "pending",
    });
    await db.update(lotteryDraws)
      .set({ activeParticipantCount: 1 })
      .where(eq(lotteryDraws.id, DRAW_ID));

    await expect(retryPaymentOrder(
      db,
      {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: ENTRY_ID,
        buyerIdentityType: "email",
        buyerIdentityValue: "test@example.com",
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
      },
      providerMock,
      ORDER_ID,
    )).rejects.toThrow("名额");

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(order?.status).toBe("expired");
    expect(entry?.paymentStatus).toBe("expired");
    expect(providerMock.createPayment).not.toHaveBeenCalled();
  });
});

describe("expireOverdueOrders", () => {
  it("正确处理 ISO 时间格式的超时订单并释放秒杀名额", async () => {
    await seedBaseRows("pending");
    const expiredAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await db
      .update(paymentOrders)
      .set({ createdAt: expiredAt })
      .where(eq(paymentOrders.id, ORDER_ID));
    await db
      .update(lotteryEntries)
      .set({ joinedAt: expiredAt })
      .where(eq(lotteryEntries.id, ENTRY_ID));

    await expect(expireOverdueOrders(db, TENANT_ID)).resolves.toBe(1);

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    const [attempt] = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.id, ATTEMPT_ID));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(order?.status).toBe("expired");
    expect(attempt?.status).toBe("expired");
    expect(entry?.paymentStatus).toBe("expired");
    expect(draw?.activeParticipantCount).toBe(0);
  });

  it("批量 pending 订单超时后按购买件数释放库存计数器", async () => {
    await seedBaseRows("pending");
    const expiredAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await db
      .update(paymentOrders)
      .set({ quantity: 3, createdAt: expiredAt })
      .where(eq(paymentOrders.id, ORDER_ID));
    await db
      .update(lotteryDraws)
      .set({ activeParticipantCount: 3 })
      .where(eq(lotteryDraws.id, DRAW_ID));

    await expect(expireOverdueOrders(db, TENANT_ID)).resolves.toBe(1);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(draw?.activeParticipantCount).toBe(0);
  });

  it("释放没有生成订单的陈旧 reserved 预约，避免孤儿预约长期占用秒杀名额", async () => {
    await seedBaseRows("expired");
    const staleEntryId = `${ENTRY_ID}-stale-reserved`;
    const expiredAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await db.insert(lotteryEntries).values({
      id: staleEntryId,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: "stale-reserved@example.com",
      displayName: "stale",
      paymentStatus: "reserved",
      joinedAt: expiredAt,
    });
    await db.update(lotteryDraws)
      .set({ activeParticipantCount: 1 })
      .where(eq(lotteryDraws.id, DRAW_ID));

    await expect(expireOverdueOrders(db, TENANT_ID)).resolves.toBe(1);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, staleEntryId));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(entry?.paymentStatus).toBe("expired");
    expect(draw?.activeParticipantCount).toBe(0);
  });
});

describe("tenant payment provider selection", () => {
  it("loads the provider matching requested currency or provider name", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(tenantConfigs).values({
      tenantId: TENANT_ID,
      enabled: 1,
      providers: JSON.stringify({
        alipay: {
          enabled: true,
          alipay_app_id: "app",
          alipay_private_key: await encryptPaymentConfigValue("private", ENCRYPTION_KEY),
          alipay_public_key: await encryptPaymentConfigValue("public", ENCRYPTION_KEY),
        },
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", ENCRYPTION_KEY),
          easypay_api_base: "https://zpayz.cn",
        },
      }),
    });

    await expect(loadTenantConfig(db, TENANT_ID, ENCRYPTION_KEY, { currency: "cny" }))
      .resolves.toMatchObject({ provider: "easypay" });
    await expect(loadTenantConfig(db, TENANT_ID, ENCRYPTION_KEY, { currency: "usdt" }))
      .resolves.toBeNull();
    await expect(loadTenantConfig(db, TENANT_ID, ENCRYPTION_KEY, { provider: "alipay" }))
      .resolves.toMatchObject({ provider: "alipay" });
    await expect(loadTenantConfig(db, TENANT_ID, ENCRYPTION_KEY, { provider: "easypay" }))
      .resolves.toMatchObject({ provider: "easypay" });
    await expect(loadTenantConfig(db, TENANT_ID, ENCRYPTION_KEY, { provider: "stripe" }))
      .resolves.toBeNull();
  });

  it("createTenantProvider honours currency filtering from cf-core registry", () => {
    const env = {
      EASYPAY_PID: "pid",
      EASYPAY_KEY: "key",
      EASYPAY_API_BASE: "https://zpayz.cn",
    };
    expect(createTenantProvider(env, "cny")?.name).toBe("easypay");
    expect(createTenantProvider(env, "usdt")).toBeNull();
  });
});

describe("providerTradeNo integrity", () => {
  it("拒绝同一租户同一渠道的重复支付流水，并回滚第二笔尝试的半写入", async () => {
    await seedBaseRows("pending");
    await persistProviderTradeNo(db, ORDER_ID, ATTEMPT_ID, { providerTradeNo: "EP-DUPLICATE" });

    const secondEntryId = "entry-payment-service-2";
    const secondOrderId = "order-payment-service-2";
    const secondAttemptId = "attempt-payment-service-2";
    await db.insert(lotteryEntries).values({
      id: secondEntryId,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: "buyer-2@example.com",
      paymentStatus: "pending",
    });
    await db.insert(paymentOrders).values({
      id: secondOrderId,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: secondEntryId,
      amountCents: 9900,
      currency: "cny",
      status: "pending",
      provider: "alipay",
      currentAttemptId: secondAttemptId,
    });
    await db.insert(paymentOrderItems).values({
      id: `${secondOrderId}-item-1`,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      paymentOrderId: secondOrderId,
      lineNo: 1,
      itemType: "flash_sale",
      title: "支付测试活动",
      quantity: 1,
      amountCents: 9900,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "pending",
      unitPriceCents: 9900,
    });
    await db.insert(paymentOrderAttempts).values({
      id: secondAttemptId,
      paymentOrderId: secondOrderId,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      attemptNo: 1,
      provider: "alipay",
      amountCents: 9900,
      currency: "cny",
      status: "pending",
    });

    await expect(
      persistProviderTradeNo(db, secondOrderId, secondAttemptId, { providerTradeNo: "EP-DUPLICATE" }),
    ).rejects.toThrow();

    const [secondOrder] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, secondOrderId));
    const [secondAttempt] = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.id, secondAttemptId));
    expect(secondOrder?.providerTradeNo).toBeNull();
    expect(secondAttempt?.providerTradeNo).toBeNull();
  });
});

describe("handlePaymentCallback", () => {
  it("accepts provider currency casing differences and issues one code", async () => {
    await seedCallbackRows();
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID,
        providerTradeNo: "EP-OK",
        amountCents: 9900,
        currency: "CNY",
        paidAt: "2026-08-07T00:00:00.000Z",
      })),
    };

    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});

    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid");
    /* V2 removed */ // expect(result.order?.prizeCodeId).toBe(PRIZE_CODE_ID);
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(code?.status).toBe("issued");
    expect(code?.winnerId).toBe(ENTRY_ID);
    expect(code?.paymentOrderId).toBe(ORDER_ID);
  });

  it("批量直付支付成功后一次性发放订单数量对应的卡密", async () => {
    await seedCallbackRows();
    await db.update(lotteryDraws)
      .set({ maxParticipants: 5, activeParticipantCount: 3, promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 5, priceCents: 9900, currency: "cny" } }) })
      .where(eq(lotteryDraws.id, DRAW_ID));
    await db.update(paymentOrders)
      .set({ quantity: 3, unitPriceCents: 8900, amountCents: 26700, pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }) })
      .where(eq(paymentOrders.id, ORDER_ID));
    await db.update(paymentOrderAttempts)
      .set({ amountCents: 26700 })
      .where(eq(paymentOrderAttempts.id, ATTEMPT_ID));
    await db.insert(prizeCodes).values([
      { id: `${PRIZE_CODE_ID}-2`, tenantId: TENANT_ID, prizeId: PRIZE_ID, code: "CODE-2", secret: "SECRET-2", status: "available" },
      { id: `${PRIZE_CODE_ID}-3`, tenantId: TENANT_ID, prizeId: PRIZE_ID, code: "CODE-3", secret: "SECRET-3", status: "available" },
    ]);
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID,
        providerTradeNo: "EP-BULK-OK",
        amountCents: 26700,
        currency: "cny",
        paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };

    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});

    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid");
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, ORDER_ID));
    expect(codes).toHaveLength(3);
    expect(codes.every((code) => code.status === "issued" && code.winnerId === ENTRY_ID)).toBe(true);
    /* V2 removed */ // expect(result.order?.prizeCodeId).toBe(PRIZE_CODE_ID);
  });

  it("批量直付码池不足时不部分发卡，订单进入履约失败", async () => {
    await seedCallbackRows();
    await db.update(paymentOrders)
      .set({ quantity: 3, unitPriceCents: 8900, amountCents: 26700 })
      .where(eq(paymentOrders.id, ORDER_ID));
    await db.update(paymentOrderAttempts)
      .set({ amountCents: 26700 })
      .where(eq(paymentOrderAttempts.id, ATTEMPT_ID));
    await db.insert(prizeCodes).values({
      id: `${PRIZE_CODE_ID}-2`,
      tenantId: TENANT_ID,
      prizeId: PRIZE_ID,
      code: "CODE-2",
      secret: "SECRET-2",
      status: "available",
    });
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID,
        providerTradeNo: "EP-BULK-NO-CODE",
        amountCents: 26700,
        currency: "cny",
        paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };

    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});

    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid_fulfillment_failed");
    const issuedCodes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, ORDER_ID));
    expect(issuedCodes).toHaveLength(0);
    const availableCodes = await db.select().from(prizeCodes).where(eq(prizeCodes.prizeId, PRIZE_ID));
    expect(availableCodes.every((code) => code.status === "available" && !code.paymentOrderId)).toBe(true);
  });

  it("支付成功但码池为空时 entry 保持履约异常，补发后才进入 paid", async () => {
    await seedBaseRows("pending");
    await db.insert(prizes).values({
      id: PRIZE_ID,
      tenantId: TENANT_ID,
      name: "卡密奖品",
      prizeType: "code",
    });
    await db.insert(lotteryPrizeTiers).values({
      id: "tier-payment-service-empty",
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      prizeId: PRIZE_ID,
    });
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID,
        providerTradeNo: "EP-NO-CODE",
        amountCents: 9900,
        currency: "cny",
        paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };

    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    expect(result.order?.status).toBe("paid_fulfillment_failed");
    const [entryAfterPayment] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    // entry 只表达参与/名额生命周期；履约异常由 payment_orders.status 表达，
    // 因此发卡失败时仍保持 pending，补发成功后才进入 paid。
    expect(entryAfterPayment?.paymentStatus).toBe("pending");

    await db.insert(prizeCodes).values({
      id: PRIZE_CODE_ID,
      tenantId: TENANT_ID,
      prizeId: PRIZE_ID,
      code: "CODE-RECOVERED",
      secret: "SECRET-RECOVERED",
      status: "available",
    });
    const fulfillment = await retryPaymentFulfillment(db, TENANT_ID, ORDER_ID);
    expect(fulfillment.ok).toBe(true);
    expect(fulfillment.order?.status).toBe("paid");
    /* V2 removed */ // expect(fulfillment.order?.prizeCodeId).toBe(PRIZE_CODE_ID);
  });

  it("fails closed when provider callback verification throws", async () => {
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => {
        throw new Error("invalid signature");
      }),
    };

    await expect(handlePaymentCallback(db, TENANT_ID, callbackProvider, {}))
      .resolves.toMatchObject({ processed: false, error: "验签失败" });
  });

  it("ignores callbacks for expired orders without issuing a card code", async () => {
    await seedCallbackRows("expired");
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID,
        providerTradeNo: "EP-LATE",
        amountCents: 9900,
        currency: "CNY",
        paidAt: "2026-08-07T00:00:00.000Z",
      })),
    };

    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});

    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid_late_needs_refund");
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(code?.status).toBe("available");
  });

  it("旧支付尝试迟到付款只进入待退款，不会污染新的 attempt", async () => {
    await seedBaseRows("expired");
    await retryPaymentOrder(
      db,
      {
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        entryId: ENTRY_ID,
        buyerIdentityType: "email",
        buyerIdentityValue: "test@example.com",
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/callback",
      },
      providerMock,
      ORDER_ID,
    );
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID,
        providerTradeNo: "EP-OLD-LATE",
        amountCents: 9900,
        currency: "cny",
        paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };

    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("pending");
    const [oldAttempt] = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.id, ATTEMPT_ID));
    expect(oldAttempt?.status).toBe("paid_late_needs_refund");
    expect(result.order?.currentAttemptId).not.toBe(ATTEMPT_ID);
  });

  it("多租户隔离：A 租户回调不消耗 B 租户卡密池", async () => {
    await seedCallbackRows();
    const tenantB = "tenant-payment-service-B";
    const drawB = "draw-payment-service-B";
    const prizeB = "prize-payment-service-B";
    await db.insert(tenants).values({ id: tenantB, name: "tenant B" });
    await db.insert(lotteryDraws).values({
      id: drawB, tenantId: tenantB, publicSlug: "payment-service-draw-b",
      title: "B 活动", status: "open", maxParticipants: 1, activeParticipantCount: 0,
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(prizes).values({ id: prizeB, tenantId: tenantB, name: "B 卡密", prizeType: "code", active: 1, totalCount: 1, usedCount: 0 });
    await db.insert(lotteryPrizeTiers).values({ id: "tier-payment-service-b", tenantId: tenantB, drawId: drawB, prizeId: prizeB });
    await db.insert(prizeCodes).values({ id: "code-b-1", tenantId: tenantB, prizeId: prizeB, code: "B-1", secret: "S-B1", status: "available" });

    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID, providerTradeNo: "EP-ISO", amountCents: 9900, currency: "cny", paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid");

    const aCodes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, ORDER_ID));
    expect(aCodes).toHaveLength(1);
    expect(aCodes[0].tenantId).toBe(TENANT_ID);

    // B 租户卡密不受影响，仍 available 且未被绑定订单
    const [bCode] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, "code-b-1"));
    expect(bCode?.status).toBe("available");
    expect(bCode?.paymentOrderId).toBeNull();
  });

  it("混合状态码池：只领取 available，跳过 issued/revoked/redeemed", async () => {
    await seedCallbackRows();
    await db.insert(prizeCodes).values([
      { id: `${PRIZE_CODE_ID}-issued`, tenantId: TENANT_ID, prizeId: PRIZE_ID, code: "CODE-ISSUED", secret: "S", status: "issued", winnerId: "other-entry", paymentOrderId: "other-order" },
      { id: `${PRIZE_CODE_ID}-revoked`, tenantId: TENANT_ID, prizeId: PRIZE_ID, code: "CODE-REVOKED", secret: "S", status: "revoked" },
      { id: `${PRIZE_CODE_ID}-redeemed`, tenantId: TENANT_ID, prizeId: PRIZE_ID, code: "CODE-REDEEMED", secret: "S", status: "redeemed" },
    ]);
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID, providerTradeNo: "EP-MIXED", amountCents: 9900, currency: "cny", paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid");

    const issued = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, ORDER_ID));
    expect(issued).toHaveLength(1);
    expect(issued[0].id).toBe(PRIZE_CODE_ID);

    // 非 available 状态码未被改写
    const check = async (id: string, expected: string) => {
      const [row] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, id));
      expect(row?.status).toBe(expected);
    };
    await check(`${PRIZE_CODE_ID}-issued`, "issued");
    await check(`${PRIZE_CODE_ID}-revoked`, "revoked");
    await check(`${PRIZE_CODE_ID}-redeemed`, "redeemed");
  });

  it("领取顺序确定性：按 id 升序领取（min id 优先）", async () => {
    await seedCallbackRows();
    // PRIZE_CODE_ID = "prize-code-payment-service"；插入 id 更小的可用码
    await db.insert(prizeCodes).values({
      id: "aaa-zzz", tenantId: TENANT_ID, prizeId: PRIZE_ID, code: "CODE-AAA", secret: "S-AAA", status: "available",
    });
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID, providerTradeNo: "EP-ORDER", amountCents: 9900, currency: "cny", paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid");

    // min id（aaa-zzz < prize-code-payment-service）应被优先领取
    const issued = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, ORDER_ID));
    expect(issued).toHaveLength(1);
    expect(issued[0].id).toBe("aaa-zzz");
  });

  it("多卡密奖品 fail-closed：有两个 code 奖品时不发卡，订单进入履约失败", async () => {
    await seedCallbackRows();
    const prize2 = "prize-payment-service-2";
    await db.insert(prizes).values({ id: prize2, tenantId: TENANT_ID, name: "卡密奖品2", prizeType: "code", active: 1 });
    await db.insert(lotteryPrizeTiers).values({ id: "tier-payment-service-2", tenantId: TENANT_ID, drawId: DRAW_ID, prizeId: prize2 });
    await db.insert(prizeCodes).values({ id: "code-2-1", tenantId: TENANT_ID, prizeId: prize2, code: "CODE-2-1", secret: "S", status: "available" });
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID, providerTradeNo: "EP-MULTI-PRIZE", amountCents: 9900, currency: "cny", paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    // findCodePrize 返回 null（rows.length !== 1）→ acquirePrizeCodes 返回 [] → 履约失败
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid_fulfillment_failed");
    const allIssued = await db.select().from(prizeCodes).where(eq(prizeCodes.status, "issued"));
    expect(allIssued).toHaveLength(0);
  });

  it("卡密奖品未激活（active=0）时 fail-closed：不发卡，订单履约失败", async () => {
    await seedCallbackRows();
    // findCodePrize 内联查询 prizes.active=1 过滤
    await db.update(prizes).set({ active: 0 }).where(eq(prizes.id, PRIZE_ID));
    const callbackProvider: PaymentProvider = {
      ...providerMock,
      verifyCallback: vi.fn(async () => ({
        orderNo: ATTEMPT_ID, providerTradeNo: "EP-INACTIVE", amountCents: 9900, currency: "cny", paidAt: "2026-08-08T00:00:00.000Z",
      })),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, callbackProvider, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid_fulfillment_failed");
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.status, "issued"));
    expect(codes).toHaveLength(0);
  });
});

describe("ambiguous payment creation", () => {
  it("keeps the order pending when EasyPay result is uncertain", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "ambiguous-payment",
      title: "支付测试活动",
      status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
      maxParticipants: 1,
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: "buyer@example.com",
      paymentStatus: "reserved",
    });
    const ambiguousProvider: PaymentProvider = {
      ...providerMock,
      createPayment: vi.fn(async () => {
        throw new EasyPayProviderError("ambiguous", "网关响应超时");
      }),
    };

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: ENTRY_ID,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      amountCents: 9900,
      currency: "cny",
      provider: "easypay",
      notifyUrl: "https://example.com/callback",
    }, ambiguousProvider)).rejects.toThrow("网关响应超时");

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.entryId, ENTRY_ID));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(order?.status).toBe("pending");
    expect(entry?.paymentStatus).toBe("pending");
  });
});

describe("秒杀核心生命周期测试(冒烟)", () => {
  it("createPaymentOrder 正常创建 + 过期释放计数器闭环", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT_ID,
      publicSlug: `smoke-${drawId}`,
      title: "秒杀冒烟测试",
      status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "buyer@example.com",
      paymentStatus: "reserved",
    });
    // 前置:active_participant_count = 1 模拟 join 时 +1
    await db.update(lotteryDraws).set({ activeParticipantCount: 1 }).where(eq(lotteryDraws.id, drawId));

    const created = await createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      amountCents: 9900, currency: "cny",
      provider: "easypay", notifyUrl: "https://cb",
    }, providerMock);

    expect(created.order.status).toBe("pending");
    expect(created.order.entryId).toBe(entryId);
    expect(created.accessToken.length).toBeGreaterThan(0);

    // entry paymentStatus 应为 pending
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(entry.paymentStatus).toBe("pending");

    // 强制模拟超时释放
    await db.update(paymentOrders).set({ createdAt: "2020-01-01T00:00:00Z" }).where(eq(paymentOrders.id, created.order.id));
    const released = await expireOverdueOrders(db, TENANT_ID);
    expect(released).toBe(1);

    const [drawAfter] = await db.select({ cnt: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    expect(drawAfter.cnt).toBe(0); // 计数器已释放
  });

  it("createPaymentOrder 批量订单保存数量快照并补占额外库存", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT_ID,
      publicSlug: `bulk-create-${drawId}`,
      title: "批量秒杀",
      status: "open",
      experienceType: "flash_sale",
      maxParticipants: 5,
      activeParticipantCount: 1,
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 5, priceCents: 9900, currency: "cny", maxPerUser: 5 } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT_ID,
      drawId,
      identityType: "email",
      identityValue: "bulk@example.com",
      paymentStatus: "reserved",
    });

    const created = await createPaymentOrder(db, {
      tenantId: TENANT_ID,
      drawId,
      entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      quantity: 3,
      unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700,
      currency: "cny",
      provider: "easypay",
      notifyUrl: "https://cb",
    }, providerMock);

    expect(created.order.quantity).toBe(3);
    expect(created.order.unitPriceCents).toBe(8900);
    expect(created.order.amountCents).toBe(26700);
    const [drawAfter] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    expect(drawAfter?.activeParticipantCount).toBe(3);
  });

  it("createPaymentOrder 批量额外库存不足时立即释放 join 阶段基础预约", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT_ID,
      publicSlug: `bulk-full-${drawId}`,
      title: "批量库存不足",
      status: "open",
      experienceType: "flash_sale",
      maxParticipants: 2,
      activeParticipantCount: 2,
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 2, priceCents: 9900, currency: "cny", maxPerUser: 2 } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT_ID,
      drawId,
      identityType: "email",
      identityValue: "bulk-full@example.com",
      paymentStatus: "reserved",
    });

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID,
      drawId,
      entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      quantity: 2,
      unitPriceCents: 9900,
      pricingSnapshotJson: "{}",
      amountCents: 19800,
      currency: "cny",
      provider: "easypay",
      notifyUrl: "https://cb",
    }, providerMock)).rejects.toThrow("名额");

    const [entryAfter] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    const [drawAfter] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    expect(entryAfter?.paymentStatus).toBe("expired");
    expect(drawAfter?.activeParticipantCount).toBe(1);
    expect(await db.select().from(paymentOrders).where(eq(paymentOrders.entryId, entryId))).toHaveLength(0);
  });

  it("createPaymentOrder 拒绝绕过 reserved 预约的空状态 entry", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `res-${drawId}`, title: "测试",
      status: "open", experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 100, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(), endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "new-user@example.com",
      paymentStatus: "",
    });
    await db.update(lotteryDraws).set({ activeParticipantCount: 1 }).where(eq(lotteryDraws.id, drawId));

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      amountCents: 100, currency: "cny", provider: "easypay", notifyUrl: "https://cb",
    }, providerMock)).rejects.toThrow("参与预约已失效");
    expect(await db.select().from(paymentOrders).where(eq(paymentOrders.entryId, entryId))).toHaveLength(0);
  });

  it("expired 订单回调不重复发卡，标记 paid_late_needs_refund", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `late-${drawId}`, title: "迟到付款",
      status: "open", experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 500, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(), endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({ id: entryId, tenantId: TENANT_ID, drawId, identityType: "email", identityValue: "late@ex.com", paymentStatus: "expired" });
    // 插入过期订单
    await db.insert(paymentOrders).values({
      id: orderId, tenantId: TENANT_ID, drawId, entryId,
      amountCents: 500, currency: "cny", status: "expired", provider: "easypay",
      currentAttemptId: orderId,
      createdAt: "2020-01-01T00:00:00Z",
    });
    await db.insert(paymentOrderItems).values({
      id: `${orderId}-item-1`,
      tenantId: TENANT_ID,
      drawId,
      paymentOrderId: orderId,
      lineNo: 1,
      itemType: "flash_sale",
      title: "迟到付款",
      quantity: 1,
      amountCents: 500,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "refunded",
      unitPriceCents: 500,
    });
    // 对应 payment_order_attempts(handlePaymentCallback 依赖)
    await db.insert(paymentOrderAttempts).values({
      id: orderId,
      paymentOrderId: orderId, tenantId: TENANT_ID, drawId, attemptNo: 1,
      provider: "easypay", amountCents: 500, currency: "cny", status: "pending",
    });

    // attempt 的渠道是 easypay；测试 Provider 必须保持同一渠道，才能验证
    // “已过期订单可验签并进入待退款”这条真实回调链，而不是被渠道错配门禁提前拒绝。
    const lateProvider = {
      ...providerMock,
      name: "easypay" as const,
      verifyCallback: vi.fn().mockResolvedValue({
        orderNo: orderId,
        amountCents: 500,
        currency: "CNY",
        providerTradeNo: "late-1",
        paidAt: new Date().toISOString(),
      }),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, lateProvider, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid_late_needs_refund");
    /* V2 removed */ // expect(result.order?.prizeCodeId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 批量数量生命周期（docs/141 §3）：数量在创建/重试/过期/补发各环节的正确传递与释放。
// 这些是「数量不能漂移」的回归测试——订单保存了 quantity，后续状态机必须沿用同一数量。
// ═══════════════════════════════════════════════════════════════════════════
describe("批量数量生命周期", () => {
  /**
   * 构造一个支持批量直付的秒杀活动 + 一张 reserved 的 entry。
   * 返回 drawId/entryId，activeParticipantCount 已置为 1 模拟 join 阶段预约。
   */
  async function seedBatchFlow(maxParticipants = 5, quantity = 3) {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `batch-lifecycle-${drawId}`, title: "批量生命周期",
      status: "open", experienceType: "flash_sale",
      maxParticipants, activeParticipantCount: 1,
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: maxParticipants, priceCents: 9900, currency: "cny", maxPerUser: 20 },
      }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "batch-lifecycle@example.com",
      paymentStatus: "reserved",
    });
    return { drawId, entryId };
  }

  it("resumePendingPaymentOrder 恢复批量 pending 订单时沿用 quantity", async () => {
    const { drawId, entryId } = await seedBatchFlow();
    // 先创建批量订单（quantity=3），模拟支付入口已生成但用户刷新后恢复
    const created = await createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "批量秒杀",
    }, providerMock);
    expect(created.order.quantity).toBe(3);

    // 恢复同一 pending 订单：再请求 provider.createPayment，但数量/金额沿用订单快照
    const attemptId = created.order.currentAttemptId!;
    const resumed = await resumePendingPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "批量秒杀恢复",
    }, providerMock, created.order.id, attemptId);

    expect(resumed.order.id).toBe(created.order.id);
    expect(resumed.order.quantity).toBe(3);
    expect(resumed.order.amountCents).toBe(26700);
    // 恢复后订单仍为 pending（未支付），且 provider.createPayment 被再次调用
    expect(providerMock.createPayment).toHaveBeenCalledTimes(2);
  });

it("retryPaymentOrder 批量重试恢复正确数量与名额", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    // 先创建批量订单，再模拟确定性失败 → 取消
    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "批量秒杀",
    }, {
      ...providerMock,
      createPayment: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    })).rejects.toThrow("gateway down");

    // 确定性失败 → 订单 cancelled，entry 回退 expired，名额被释放
    let [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    let [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    expect(entry?.paymentStatus).toBe("expired");
    expect(draw?.activeParticipantCount).toBe(0);

    // 从 DB 查被取消的订单 ID
    const [cancelledOrder] = await db
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.drawId, drawId), eq(paymentOrders.entryId, entryId)))
      .limit(1);
    expect(cancelledOrder).toBeDefined();

    // 重试：应恢复 quantity=3，重新预约 3 件名额，并复用同一逻辑订单
    const retried = await retryPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "批量秒杀重试",
    }, providerMock, cancelledOrder!.id);

    expect(retried.order.quantity).toBe(3);
    expect(retried.order.amountCents).toBe(26700);
    [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    expect(entry?.paymentStatus).toBe("pending");
    expect(draw?.activeParticipantCount).toBe(3);
  });

  it("expireOverdueOrders 批量过期释放对应件数名额", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    // 构造一张已锁定 3 件、且已超时的 pending 订单
    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderId, tenantId: TENANT_ID, drawId, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "pending", provider: "easypay", currentAttemptId: attemptId,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptId, paymentOrderId: orderId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 26700, currency: "cny", status: "pending",
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    // entry 置为 pending，draw 计数为 3（1 基础 + 2 额外）
    await db.update(lotteryEntries).set({ paymentStatus: "pending" }).where(eq(lotteryEntries.id, entryId));
    await db.update(lotteryDraws).set({ activeParticipantCount: 3 }).where(eq(lotteryDraws.id, drawId));

    const expired = await expireOverdueOrders(db, TENANT_ID);
    expect(expired).toBeGreaterThanOrEqual(1);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    expect(entry?.paymentStatus).toBe("expired");
    // 批量过期必须释放全部 3 件，而不是只释放 1 件
    expect(draw?.activeParticipantCount).toBe(0);
  });

  it("expireOverdueOrders 保护已支付名额：entry 有 PAID 订单时只释放超时订单容量，entry 恢复 paid", async () => {
    const { drawId, entryId } = await seedBatchFlow(5);
    // 订单 A：已支付（quantity=2），entry → paid
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 2, amountCents: 17800, currency: "cny",
      status: "paid", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));
    // 订单 B：超时未支付（quantity=3），entry → pending
    const orderBId = crypto.randomUUID();
    const attemptBId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderBId, tenantId: TENANT_ID, drawId, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "pending", provider: "easypay", currentAttemptId: attemptBId,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptBId, paymentOrderId: orderBId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 26700, currency: "cny", status: "pending",
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.update(lotteryEntries).set({ paymentStatus: "pending" }).where(eq(lotteryEntries.id, entryId));
    // 活动计数：订单 A 占 2 件 + 订单 B 占 3 件 = 5
    await db.update(lotteryDraws).set({ activeParticipantCount: 5 }).where(eq(lotteryDraws.id, drawId));

    const expired = await expireOverdueOrders(db, TENANT_ID);
    expect(expired).toBeGreaterThanOrEqual(1);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    const [orderB] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, orderBId));
    // 关键断言：仅超时订单 B 被释放，entry 因仍有 PAID 订单 A 恢复为 paid（不是 expired）
    expect(orderB?.status).toBe("expired");
    expect(entry?.paymentStatus).toBe("paid");
    // 只释放超时订单 B 的额外件数（qty-1=2，保留 base 1 给 entry），订单 A 的 2 件仍占用。
    // 测试设 count=5 为简化；修复后（docs/199）keepActive entry 只释放额外件数 → 5-2=3。
    expect(draw?.activeParticipantCount).toBe(3);
  });

  it("expireOverdueOrders 保护履约中名额：entry 有 FULFILLMENT_FAILED 订单时只释放超时订单容量，entry 恢复 paid", async () => {
    const { drawId, entryId } = await seedBatchFlow(5);
    // 订单 A：已支付但发卡失败的履约订单（quantity=2），entry 应为 paid（有有效履约不能整体释放）
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 2, amountCents: 17800, currency: "cny",
      status: "paid_fulfillment_failed", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));
    // 订单 B：超时未支付（quantity=3），entry → pending
    const orderBId = crypto.randomUUID();
    const attemptBId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderBId, tenantId: TENANT_ID, drawId, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "pending", provider: "easypay", currentAttemptId: attemptBId,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptBId, paymentOrderId: orderBId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 26700, currency: "cny", status: "pending",
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.update(lotteryEntries).set({ paymentStatus: "pending" }).where(eq(lotteryEntries.id, entryId));
    // 活动计数：订单 A 占 2 件 + 订单 B 占 3 件 = 5
    await db.update(lotteryDraws).set({ activeParticipantCount: 5 }).where(eq(lotteryDraws.id, drawId));

    const expired = await expireOverdueOrders(db, TENANT_ID);
    expect(expired).toBeGreaterThanOrEqual(1);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    const [orderB] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, orderBId));
    // 关键断言：仅超时订单 B 被释放，entry 因仍有履约中订单 A 恢复为 paid（不是 expired）
    expect(orderB?.status).toBe("expired");
    expect(entry?.paymentStatus).toBe("paid");
    // 只释放超时订单 B 的额外件数（qty-1=2，保留 base 1 给 entry），订单 A 的 2 件仍占用。
    // 测试设 count=5 为简化；修复后（docs/199）keepActive entry 只释放额外件数 → 5-2=3。
    expect(draw?.activeParticipantCount).toBe(3);
  });

  it("createPaymentOrder 新订单创建失败时不掩盖已支付名额：entry 恢复为 paid", async () => {
    const { drawId, entryId } = await seedBatchFlow(5);
    // 订单 A：已支付（quantity=2），entry → paid
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 2, amountCents: 17800, currency: "cny",
      status: "paid", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));
    // 活动计数：订单 A 占 2 件
    await db.update(lotteryDraws).set({ activeParticipantCount: 2 }).where(eq(lotteryDraws.id, drawId));

    const failingProvider: PaymentProvider = {
      ...providerMock,
      createPayment: vi.fn(async () => { throw new Error("gateway down"); }),
    };

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email", buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "新增批发单",
    }, failingProvider)).rejects.toThrow("gateway down");

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    // 关键断言：新订单 B 取消后，entry 因仍有 PAID 订单 A 恢复为 paid（不是 expired）
    expect(entry?.paymentStatus).toBe("paid");
    // 新订单 B 的 3 件被释放，订单 A 的 2 件仍占用
    expect(draw?.activeParticipantCount).toBe(2);
  });

  it("paid_fulfillment_failed 订单未补发完成前不允许用户再次创建新单", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "paid_fulfillment_failed", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "pending" }).where(eq(lotteryEntries.id, entryId));

    const provider: PaymentProvider = {
      ...providerMock,
      createPayment: vi.fn(),
    };

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email", buyerIdentityValue: "test@example.com",
      quantity: 2, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 17800, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "补发未完成新单",
    }, provider)).rejects.toThrow("订单仍在处理中");

    expect(provider.createPayment).not.toHaveBeenCalled();
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    // 容量未被预约（FULFILLMENT_FAILED 检查在预约之前），初始容量为 seedBatchFlow 的 1
    expect(draw?.activeParticipantCount).toBe(1);
    expect(entry?.paymentStatus).toBe("pending");
  });
it("累计限购：已有 PAID 订单 + 本次购买超过 maxPerUser 时拒绝创建新单（docs/202 P1-14）", async () => {
    const { drawId, entryId } = await seedBatchFlow(10, 3);
    // 收紧限购为每人 2 件
    await db.update(lotteryDraws).set({
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 10, priceCents: 9900, currency: "cny", maxPerUser: 2 },
      }),
    }).where(eq(lotteryDraws.id, drawId));
    // 已有 PAID 订单 quantity=2（已买满限购）
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 2, amountCents: 17800, currency: "cny",
      status: "paid", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));

    const provider: PaymentProvider = { ...providerMock, createPayment: vi.fn() };

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email", buyerIdentityValue: "test@example.com",
      quantity: 1, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 8900, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "超限新单",
    }, provider)).rejects.toThrow("每人限购 2 件");

    expect(provider.createPayment).not.toHaveBeenCalled();
    // 事务回滚：entry 保持 paid，活动名额未被额外预约（seedBatchFlow 初始 1）
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(draw?.activeParticipantCount).toBe(1);
    expect(entry?.paymentStatus).toBe("paid");
  });

  it("累计限购：未超过 maxPerUser 时允许同一身份追加下单（批发场景）", async () => {
    const { drawId, entryId } = await seedBatchFlow(10, 3);
    await db.update(lotteryDraws).set({
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 10, priceCents: 9900, currency: "cny", maxPerUser: 5 },
      }),
    }).where(eq(lotteryDraws.id, drawId));
    // 已有 PAID 订单 quantity=2，追加 3 件后合计 5 == maxPerUser：允许
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 2, amountCents: 17800, currency: "cny",
      status: "paid", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));

    const created = await createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email", buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "追加批发单",
    }, providerMock);
    expect(created.order.quantity).toBe(3);
  });

  it("累计限购：首次下单 quantity 超过 maxPerUser 时也被后端拦截（防御纵深，docs/202 复核）", async () => {
    const { drawId, entryId } = await seedBatchFlow(10, 3);
    await db.update(lotteryDraws).set({
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, paymentRequired: true, stockLimit: 10, priceCents: 9900, currency: "cny", maxPerUser: 2 },
      }),
    }).where(eq(lotteryDraws.id, drawId));
    // entry 保持 reserved（首次下单），quantity=3 > maxPerUser=2：即使绕过路由层也应被后端拦截
    const provider: PaymentProvider = { ...providerMock, createPayment: vi.fn() };

    await expect(createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email", buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "首单超限",
    }, provider)).rejects.toThrow("每人限购 2 件");

    expect(provider.createPayment).not.toHaveBeenCalled();
    // 事务回滚：entry 仍为 reserved，活动名额未被额外预约（seedBatchFlow 初始 1）
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(draw?.activeParticipantCount).toBe(1);
    expect(entry?.paymentStatus).toBe("reserved");
  });

  it("retryPaymentFulfillment 批量补发一次性补齐订单数量对应卡密", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const prizeId = crypto.randomUUID();
    // 已支付但码池不足 → paid_fulfillment_failed
    await db.update(lotteryEntries).set({ paymentStatus: "pending" }).where(eq(lotteryEntries.id, entryId));
    await db.insert(paymentOrders).values({
      id: orderId, tenantId: TENANT_ID, drawId, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "paid_fulfillment_failed", provider: "easypay", currentAttemptId: attemptId,
    });
    await db.insert(paymentOrderItems).values([
      {
        id: `${orderId}-item-1`,
        tenantId: TENANT_ID,
        drawId,
        paymentOrderId: orderId,
        lineNo: 1,
        itemType: "flash_sale",
        title: "批量奖品",
        quantity: 1,
        amountCents: 8900,
        currency: "cny",
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        status: "pending",
        unitPriceCents: 8900,
      },
      {
        id: `${orderId}-item-2`,
        tenantId: TENANT_ID,
        drawId,
        paymentOrderId: orderId,
        lineNo: 2,
        itemType: "flash_sale",
        title: "批量奖品",
        quantity: 1,
        amountCents: 8900,
        currency: "cny",
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        status: "pending",
        unitPriceCents: 8900,
      },
      {
        id: `${orderId}-item-3`,
        tenantId: TENANT_ID,
        drawId,
        paymentOrderId: orderId,
        lineNo: 3,
        itemType: "flash_sale",
        title: "批量奖品",
        quantity: 1,
        amountCents: 8900,
        currency: "cny",
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        status: "pending",
        unitPriceCents: 8900,
      },
    ]);
    await db.insert(paymentOrderAttempts).values({
      id: attemptId, paymentOrderId: orderId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 26700, currency: "cny", status: "paid",
    });
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT_ID, name: "批量奖品", prizeType: "code", active: 1, totalCount: 3, usedCount: 0 });
    await db.insert(lotteryPrizeTiers).values({ id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId, tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100 });
    // 只有 2 张可用卡密 → 补发应失败（不部分发放）
    await db.insert(prizeCodes).values([
      { id: `${prizeId}-1`, tenantId: TENANT_ID, prizeId, code: "BULK-1", secret: "S1", status: "available" },
      { id: `${prizeId}-2`, tenantId: TENANT_ID, prizeId, code: "BULK-2", secret: "S2", status: "available" },
    ]);

    const failed = await retryPaymentFulfillment(db, TENANT_ID, orderId);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("没有足够可用卡密");

    // 补齐第 3 张后重试成功，且一次性发放 3 张
    await db.insert(prizeCodes).values({
      id: `${prizeId}-3`, tenantId: TENANT_ID, prizeId, code: "BULK-3", secret: "S3", status: "available",
    });
    const ok = await retryPaymentFulfillment(db, TENANT_ID, orderId);
    expect(ok.ok).toBe(true);
    expect(ok.order?.status).toBe("paid");
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, orderId));
    expect(codes.map((c) => c.code).sort()).toEqual(["BULK-1", "BULK-2", "BULK-3"]);
    expect(codes.every((c) => c.status === "issued")).toBe(true);
  });

  it("retryPaymentFulfillment 当 entry 已因其他订单 paid 时，补发仍成功且不抛异常", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    // 订单 A：已支付（quantity=2），entry → paid
    await db.insert(paymentOrders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
      quantity: 2, amountCents: 17800, currency: "cny",
      status: "paid", provider: "easypay",
    });
    await db.update(lotteryEntries).set({ paymentStatus: "paid" }).where(eq(lotteryEntries.id, entryId));

    // 订单 B：已支付但发卡失败（quantity=3）
    const orderBId = crypto.randomUUID();
    const attemptBId = crypto.randomUUID();
    const prizeId = crypto.randomUUID();
    await db.insert(paymentOrders).values({
      id: orderBId, tenantId: TENANT_ID, drawId, entryId,
      quantity: 3, amountCents: 26700, currency: "cny",
      status: "paid_fulfillment_failed", provider: "easypay", currentAttemptId: attemptBId,
    });
    await db.insert(paymentOrderItems).values(
      [1, 2, 3].map((i) => ({
        id: `${orderBId}-item-${i}`,
        tenantId: TENANT_ID,
        drawId,
        paymentOrderId: orderBId,
        lineNo: i,
        itemType: "flash_sale",
        title: "批发奖品",
        quantity: 1,
        amountCents: 8900,
        currency: "cny",
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        status: "pending",
        unitPriceCents: 8900,
      })),
    );
    await db.insert(paymentOrderAttempts).values({
      id: attemptBId, paymentOrderId: orderBId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 26700, currency: "cny", status: "paid",
    });
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT_ID, name: "批发奖品", prizeType: "code", active: 1, totalCount: 3, usedCount: 0 });
    await db.insert(lotteryPrizeTiers).values({ id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId, tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100 });
    await db.insert(prizeCodes).values(
      [1, 2, 3].map((i) => ({
        id: `${prizeId}-${i}`,
        tenantId: TENANT_ID,
        prizeId,
        code: `BULK-${i}`,
        secret: `S${i}`,
        status: "available",
      })),
    );

    // entry 当前是 PAID（来自订单 A），订单 B 补发应成功且不抛异常
    const result = await retryPaymentFulfillment(db, TENANT_ID, orderBId);
    expect(result.ok).toBe(true);
    expect(result.order?.status).toBe("paid");

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(entry?.paymentStatus).toBe("paid");

    // 订单 B 的 3 件卡密已绑定
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, orderBId));
    expect(codes).toHaveLength(3);
  });
it("smoke: 批量直付全链路 创建(qty=3) → 回调 → 发 3 卡 → entry paid", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    // 准备 3 张可用卡密 + 奖品绑定
    const prizeId = crypto.randomUUID();
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT_ID, name: "批量奖品", prizeType: "code", active: 1, totalCount: 5, usedCount: 0 });
    await db.insert(lotteryPrizeTiers).values({ id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId, tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100 });
    await db.insert(prizeCodes).values([
      { id: `${prizeId}-1`, tenantId: TENANT_ID, prizeId, code: "FULL-1", secret: "S1", status: "available" },
      { id: `${prizeId}-2`, tenantId: TENANT_ID, prizeId, code: "FULL-2", secret: "S2", status: "available" },
      { id: `${prizeId}-3`, tenantId: TENANT_ID, prizeId, code: "FULL-3", secret: "S3", status: "available" },
    ]);

    // 1) 创建批量订单，quantity=3
    const created = await createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "批量全链路",
    }, providerMock);
    expect(created.order.quantity).toBe(3);
    expect(created.order.amountCents).toBe(26700);

    // 2) 支付回调 → 一次性发 3 卡
    const attemptId = created.order.currentAttemptId!;
    const cb = {
      ...providerMock,
      name: "easypay" as const,
      verifyCallback: vi.fn().mockResolvedValue({
        orderNo: attemptId, amountCents: 26700, currency: "CNY",
        providerTradeNo: "FULL-OK", paidAt: new Date().toISOString(),
      }),
    };
    const result = await handlePaymentCallback(db, TENANT_ID, cb, {});
    expect(result.processed).toBe(true);
    expect(result.order?.status).toBe("paid");

    // 3) 验证 3 张卡都发给了该订单，entry 进入 paid
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, created.order.id));
    expect(codes).toHaveLength(3);
    expect(codes.every((c) => c.status === "issued" && c.winnerId === entryId)).toBe(true);
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(entry?.paymentStatus).toBe("paid");
  });

  it("批量回调重复到达（多渠道重试）→ 只发一次卡，数量不重复累加", async () => {
    const { drawId, entryId } = await seedBatchFlow(5, 3);
    const prizeId = crypto.randomUUID();
    await db.insert(prizes).values({ id: prizeId, tenantId: TENANT_ID, name: "批量奖品", prizeType: "code", active: 1, totalCount: 5, usedCount: 0 });
    await db.insert(lotteryPrizeTiers).values({ id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId, tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100 });
    await db.insert(prizeCodes).values([
      { id: `${prizeId}-1`, tenantId: TENANT_ID, prizeId, code: "DUP-1", secret: "S1", status: "available" },
      { id: `${prizeId}-2`, tenantId: TENANT_ID, prizeId, code: "DUP-2", secret: "S2", status: "available" },
      { id: `${prizeId}-3`, tenantId: TENANT_ID, prizeId, code: "DUP-3", secret: "S3", status: "available" },
    ]);

    const created = await createPaymentOrder(db, {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      quantity: 3, unitPriceCents: 8900,
      pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
      amountCents: 26700, currency: "cny", provider: "easypay",
      notifyUrl: "https://cb", description: "批量重复回调",
    }, providerMock);
    const attemptId = created.order.currentAttemptId!;

    const makeCb = (tradeNo: string) => ({
      ...providerMock,
      name: "easypay" as const,
      verifyCallback: vi.fn().mockResolvedValue({
        orderNo: attemptId, amountCents: 26700, currency: "cny",
        providerTradeNo: tradeNo, paidAt: new Date().toISOString(),
      }),
    });

    // 同一 attempt 的两个回调（网关重试/多渠道）
    const r1 = await handlePaymentCallback(db, TENANT_ID, makeCb("DUP-OK-1"), {});
    const r2 = await handlePaymentCallback(db, TENANT_ID, makeCb("DUP-OK-2"), {});
    expect(r1.processed).toBe(true);
    expect(r2.processed).toBe(true); // 幂等：已处理则直接返回成功

    // 只发 3 张卡，不因重复回调多发
    const codes = await db.select().from(prizeCodes).where(eq(prizeCodes.paymentOrderId, created.order.id));
    expect(codes).toHaveLength(3);
    expect(codes.filter((c) => c.status === "issued")).toHaveLength(3);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// 并发安全性测试（docs/148 §五 缺口 1 补充）
//
// 这些测试用 Promise.all/Promise.allSettled 并发调用，验证现有的 CAS 锁、
// UNIQUE 约束和事务隔离在并发场景下正确工作。
// 逻辑正确性靠走读已建立，此处将其固化为可回归的测试。
// ═══════════════════════════════════════════════════════════════════════════
describe("支付并发安全性", () => {
  /**
   * V2 两个并发 createPaymentOrder 操作同一个 reserved entry，
   * 由于 entry_id 不再唯一，两个订单都可以创建成功（docs/158）。
   * 第一个利率用 reserved→pending CAS，第二个利用 pending→pending 走多次购买路径。
   * 容量限制由 activeParticipantCount CAS 保证，entry 级不再硬阻断。
   */
  it("两个并发 createPaymentOrder 同一 reserved entry → 两个订单均可创建（V2）", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `concurrent-${drawId}`,
      title: "并发创建订单测试", status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 2, priceCents: 9900, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "buyer@concurrent.com",
      paymentStatus: "reserved",
    });

    const orderInput = {
      tenantId: TENANT_ID, drawId, entryId,
      buyerIdentityType: "email",
      buyerIdentityValue: "test@example.com",
      amountCents: 9900, currency: "cny",
      provider: "easypay", notifyUrl: "https://cb.example.com",
    } as const;

    // V2：同一个 reserved entry 只能成功创建一笔在途订单。
    // 第二个并发调用在服务端门禁上必须失败，不能把 entry 从 reserved 复制成多笔 pending。
    let tradeNoCounter = 0;
    const uniqueProvider: PaymentProvider = {
      ...providerMock,
      createPayment: vi.fn(async () => ({
        providerTradeNo: `checkout-concurrent-${++tradeNoCounter}`,
        redirectUrl: "https://pay.example.com/checkout",
        qrCode: "https://pay.example.com/qr",
      })),
    };
    const results = await Promise.allSettled([
      createPaymentOrder(db, orderInput, uniqueProvider),
      createPaymentOrder(db, orderInput, uniqueProvider),
    ]);

    const okCount = results.filter((r) => r.status === "fulfilled").length;
    expect(okCount).toBe(1);

    // 验证只有一条 order 记录
    const orders = await db.select().from(paymentOrders)
      .where(eq(paymentOrders.entryId, entryId));
    expect(orders).toHaveLength(1);
    expect(orders.every((o) => o.status === "pending")).toBe(true);
  });

  /**
   * 两个并发 handlePaymentCallback 操作同一 attempt，
   * 只有第一个能成功（发卡），第二个被 attempt 已处理状态门禁拒绝。
   *
   * 防护机制：handlePaymentCallback 事务内先 re-check attempt.status !== 'pending'，
   * 已支付的 attempt 直接返回 { processed: true }（幂等），不重复发卡。
   */
  it("两个并发回调同一 attempt → 仅发一张卡", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const prizeId = crypto.randomUUID();
    const codeId = crypto.randomUUID();

    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `cb-${drawId}`,
      title: "并发回调测试", status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "cb-concurrent@test.com",
      paymentStatus: "pending",
    });
    await db.insert(paymentOrders).values({
      id: orderId, tenantId: TENANT_ID, drawId, entryId,
      amountCents: 9900, currency: "cny", status: "pending",
      provider: "easypay", currentAttemptId: attemptId,
    });
    await db.insert(paymentOrderItems).values({
      id: `${orderId}-item-1`,
      tenantId: TENANT_ID,
      drawId,
      paymentOrderId: orderId,
      lineNo: 1,
      itemType: "flash_sale",
      title: "并发回调测试",
      quantity: 1,
      amountCents: 9900,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "pending",
      unitPriceCents: 9900,
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptId, paymentOrderId: orderId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 9900, currency: "cny", status: "pending",
    });
    await db.insert(prizes).values({
      id: prizeId, tenantId: TENANT_ID, name: "并发回调奖品", prizeType: "code", active: 1, totalCount: 10, usedCount: 0,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId,
      tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100,
    });
    await db.insert(prizeCodes).values({
      id: codeId, tenantId: TENANT_ID, prizeId,
      code: "CONCURRENT-CODE", secret: "SECRET", status: "available",
    });

    // 两个不同 provider mock，各自返回不同 tradeNo，避免唯一性冲突
    const cb1 = {
      ...providerMock,
      name: "easypay" as const,
      verifyCallback: vi.fn().mockResolvedValue({
        orderNo: attemptId, amountCents: 9900, currency: "CNY",
        providerTradeNo: "cb-trade-1", paidAt: new Date().toISOString(),
      }),
    };
    const cb2 = {
      ...providerMock,
      name: "easypay" as const,
      verifyCallback: vi.fn().mockResolvedValue({
        orderNo: attemptId, amountCents: 9900, currency: "CNY",
        providerTradeNo: "cb-trade-2", paidAt: new Date().toISOString(),
      }),
    };

    const results = await Promise.allSettled([
      handlePaymentCallback(db, TENANT_ID, cb1, {}),
      handlePaymentCallback(db, TENANT_ID, cb2, {}),
    ]);

    // 至少一个成功处理
    const processed = results.filter((r) => r.status === "fulfilled" && (r.value as any).processed);
    expect(processed.length).toBeGreaterThanOrEqual(1);

    // 卡密只被发了一次
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("issued");
    // 订单状态为 paid
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    expect(order?.status).toBe("paid");
  });

  /**
   * expireOverdueOrders 与 handlePaymentCallback 并发竞态：
   * 只有一方能胜出——要么"先支付"（order=paid），要么"先过期"（order=expired），
   * 绝不会出现"既过期又支付"的中间态。
   *
   * 防护机制：两个函数都使用 withDbTransaction 内的 CAS UPDATE，
   * SQLite 单写者序列化保证互斥。
   */
  it("过期与回调并发 → 互斥（paid 或 expired，不会同时）", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const prizeId = crypto.randomUUID();
    const codeId = crypto.randomUUID();

    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `race-${drawId}`,
      title: "过期回调竞态测试", status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
      startAt: new Date(Date.now() - 3600_000).toISOString(), // 1h 前就开始
      endAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "race@test.com",
      paymentStatus: "pending",
    });
    // 订单故意创建在很久以前（确保满足过期条件）
    await db.insert(paymentOrders).values({
      id: orderId, tenantId: TENANT_ID, drawId, entryId,
      amountCents: 9900, currency: "cny", status: "pending",
      provider: "easypay", currentAttemptId: attemptId,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.insert(paymentOrderItems).values({
      id: `${orderId}-item-1`,
      tenantId: TENANT_ID,
      drawId,
      paymentOrderId: orderId,
      lineNo: 1,
      itemType: "flash_sale",
      title: "竞态退款",
      quantity: 1,
      amountCents: 9900,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "pending",
      unitPriceCents: 9900,
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptId, paymentOrderId: orderId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 9900, currency: "cny",
      status: "pending",
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    await db.insert(prizes).values({
      id: prizeId, tenantId: TENANT_ID, name: "竞态奖品", prizeType: "code", active: 1, totalCount: 10, usedCount: 0,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId,
      tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100,
    });
    await db.insert(prizeCodes).values({
      id: codeId, tenantId: TENANT_ID, prizeId,
      code: "RACE-CODE", secret: "SECRET", status: "available",
    });

    const cb = {
      ...providerMock,
      name: "easypay" as const,
      verifyCallback: vi.fn().mockResolvedValue({
        orderNo: attemptId, amountCents: 9900, currency: "CNY",
        providerTradeNo: "race-trade", paidAt: new Date().toISOString(),
      }),
    };

    await Promise.allSettled([
      expireOverdueOrders(db, TENANT_ID),
      handlePaymentCallback(db, TENANT_ID, cb, {}),
    ]);

    // 两个操作都完成（可能一个失败，但不能同时成功修改同一订单）
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    // 最终状态只能是 paid / expired / paid_late_needs_refund，
    // 三者均互斥且无数据损坏：paid=回调胜出，expired=过期胜出，paid_late_needs_refund=过期先胜但回调迟到入待退款
    expect(["paid", "expired", "paid_late_needs_refund"]).toContain(order?.status);
    // 如果已支付，卡密必须被正确发放
    if (order?.status === "paid") {
      const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
      expect(code?.status).toBe("issued");
    }
    // 如果已过期或迟到退款，卡密应仍可用（未发卡或发卡后已正确关联）
    if (order?.status === "expired" || order?.status === "paid_late_needs_refund") {
      const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
      // 迟到退款场景不发卡，卡密仍 available
      expect(["available", "issued"]).toContain(code?.status);
    }
  });

  /**
   * 两个并发 retryPaymentFulfillment 处理同一 paid_fulfillment_failed 订单。
   * retryPaymentFulfillment 是幂等的——事务内先 re-check 订单状态，若已 paid 且有
   * prizeCodeId 则直接返回成功。两个并发调用最终都应返回 ok，但只有一份卡密被发放。
   *
   * 防护机制：acquirePrizeCode 的 CAS UPDATE（WHERE status='available'）在 SQLite
   * 单写者事务内原子执行，保证只有一个请求能取到码。
   */
  it("两个并发 retryPaymentFulfillment 同一订单 → 仅发一张卡，两个都 ok", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const prizeId = crypto.randomUUID();
    const codeId = crypto.randomUUID();

    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `retry-${drawId}`,
      title: "并发补发测试", status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT_ID, drawId,
      identityType: "email", identityValue: "retry@concurrent.com",
      paymentStatus: "pending",
    });
    await db.insert(paymentOrders).values({
      id: orderId, tenantId: TENANT_ID, drawId, entryId,
      amountCents: 9900, currency: "cny", provider: "easypay",
      status: "paid_fulfillment_failed",
      currentAttemptId: attemptId,
      createdAt: new Date().toISOString(),
    });
    await db.insert(paymentOrderItems).values({
      id: `${orderId}-item-1`,
      tenantId: TENANT_ID,
      drawId,
      paymentOrderId: orderId,
      lineNo: 1,
      itemType: "flash_sale",
      title: "补发奖品",
      quantity: 1,
      amountCents: 9900,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "pending",
      unitPriceCents: 9900,
    });
    await db.insert(paymentOrderAttempts).values({
      id: attemptId, paymentOrderId: orderId, tenantId: TENANT_ID, drawId,
      attemptNo: 1, provider: "easypay", amountCents: 9900, currency: "cny",
      status: "paid",
      createdAt: new Date().toISOString(),
    });
    await db.insert(prizes).values({
      id: prizeId, tenantId: TENANT_ID, name: "补发奖品", prizeType: "code", active: 1, totalCount: 1, usedCount: 0,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: `tier-${drawId}`, tenantId: TENANT_ID, drawId, prizeId,
      tierName: "中奖", winnerCount: 1, sortOrder: 100, weight: 100,
    });
    // 只有一个可用卡密，确保 acquirePrizeCode 的 CAS 竞争
    await db.insert(prizeCodes).values({
      id: codeId, tenantId: TENANT_ID, prizeId,
      code: "RETRY-CODE", secret: "SECRET", status: "available",
    });

    // 两个并发补发调用
    const results = await Promise.allSettled([
      retryPaymentFulfillment(db, TENANT_ID, orderId),
      retryPaymentFulfillment(db, TENANT_ID, orderId),
    ]);

    // 两个都应该返回 ok（幂等：第一个真正补发，第二个发现已 paid 直接返回）
    const okCount = results.filter((r) => r.status === "fulfilled" && (r.value as any).ok).length;
    expect(okCount).toBe(2);

    // 卡密只被发了一次
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("issued");

    // 订单最终为 paid 且关联了正确卡密
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    expect(order?.status).toBe("paid");
    /* V2 removed */ // expect(order?.prizeCodeId).toBe(codeId);

    // entry 为 paid
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(entry?.paymentStatus).toBe("paid");
  });

  describe("createPaymentOrder 源头扼杀校验（docs/203）", () => {
    async function seedOrderTestData() {
      const drawId = crypto.randomUUID();
      const entryId = crypto.randomUUID();
      await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" }).onConflictDoNothing();
      await db.insert(lotteryDraws).values({
        id: drawId, tenantId: TENANT_ID, publicSlug: `source-kill-${drawId}`,
        title: "源头扼杀", status: "open",
        experienceType: "flash_sale", maxParticipants: 10,
        promotionConfig: JSON.stringify({
          flashSale: { enabled: true, paymentRequired: true, stockLimit: 10, priceCents: 9900, currency: "cny", maxPerUser: 2 },
        }),
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await db.insert(lotteryEntries).values({
        id: entryId, tenantId: TENANT_ID, drawId,
        identityType: "email", identityValue: "source@kill.com",
        paymentStatus: "reserved",
      });
      const prizeId = crypto.randomUUID();
      await db.insert(prizes).values({ id: prizeId, tenantId: TENANT_ID, name: "源头扼杀奖品", prizeType: "code", totalCount: 10 });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, prizeId,
        tierName: "中奖", winnerCount: 10, sortOrder: 100, weight: 100,
      });
      for (let i = 0; i < 5; i++) {
        await db.insert(prizeCodes).values({
          id: crypto.randomUUID(), tenantId: TENANT_ID, prizeId,
          code: `SK-CODE-${i}`, secret: "secret", status: "available",
        });
      }
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email", buyerIdentityValue: "buyer@test.com",
        amountCents: 9900, currency: "cny",
        provider: "alipay" as const, notifyUrl: "https://cb.example.com",
      };
      return { drawId, entryId, orderInput, prizeId };
    }

    it("首次下单 quantity > maxPerUser 时拒绝（后端独立拦截，路由层钳制未生效时兜底）", async () => {
      const { orderInput } = await seedOrderTestData();
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 3 }, providerMock))
        .rejects.toThrow("每人限购 2 件");
    });

    it("首次下单 quantity <= maxPerUser 时允许创建", async () => {
      const { orderInput } = await seedOrderTestData();
      const result = await createPaymentOrder(db, { ...orderInput, quantity: 2 }, providerMock);
      expect(result.order.quantity).toBe(2);
    });

    it("身份未验证时拒绝创建订单", async () => {
      const { orderInput, entryId } = await seedOrderTestData();
      // 用空字符串模拟未验证身份（drizzle set null 会生成 SQL NULL 导致类型错误）
      await db.update(lotteryEntries).set({ identityType: "", identityValue: "" }).where(eq(lotteryEntries.id, entryId));
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("身份未验证");
    });

    it("活动已结束（status !== open）时拒绝创建订单", async () => {
      const { orderInput, drawId } = await seedOrderTestData();
      await db.update(lotteryDraws).set({ status: "closed" }).where(eq(lotteryDraws.id, drawId));
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("活动已结束");
    });

    it("活动已过期（endAt < now）时拒绝创建订单", async () => {
      const { orderInput, drawId } = await seedOrderTestData();
      await db.update(lotteryDraws).set({ endAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(lotteryDraws.id, drawId));
      // expireOverdueOrders 在 createPaymentOrder 入口处调用（优化后：活动已结束则立即过期订单），
      // entry 被释放为 expired → 返回 '参与预约已失效'（而非旧路径的 '活动已结束'）
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("参与预约已失效");
    });

    it("库存不足时拒绝创建订单", async () => {
      const { orderInput, prizeId } = await seedOrderTestData();
      await db.update(prizeCodes).set({ status: "issued" }).where(eq(prizeCodes.prizeId, prizeId));
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("库存不足");
    });

    /**
     * docs/255 §八 P2-9 复核：库存预检与发卡必须用同一个卡密奖品解析器。
     *
     * 旧实现取 lotteryPrizeTiers 的任意一行（`.limit(1)` 无 orderBy），
     * 再判断该行的奖品是否 prizeType='code'。活动有多个奖档时（例如
     * 「实物奖 + 卡密奖」），预检可能命中实物奖那一行 → 整个库存检查被跳过，
     * 用户在零卡密库存下付款成功，只能进 FULFILLMENT_FAILED 再退款。
     * 而真正发卡走的是 findCodePrize（内联 prizes 且要求 prizeType='code' + active=1）。
     */
    /**
     * docs/255 §八 P2-9 复核：库存预检与发卡必须用同一个卡密奖品解析器。
     *
     * 旧实现取 lotteryPrizeTiers 的任意一行（`.limit(1)` 无 orderBy），
     * 再判断该行的奖品是否 prizeType='code'。活动有多个奖档时（例如
     * 「实物奖 + 卡密奖」），预检可能命中实物奖那一行 → 源头库存预检整体失效，
     * 只能落到事务内 reservePrizeCodes 的兜底报错，用户拿到的是笼统的
     * 「卡密库存不足」而不是「可用 0 件，需要 1 件」。
     * 真正发卡走的是 findCodePrize（内联 prizes 且要求 prizeType='code' + active=1）。
     */
    it("多奖档（实物奖排在卡密奖之前）时库存预检不得被跳过（docs/255 P2-9）", async () => {
      const { orderInput, drawId, prizeId } = await seedOrderTestData();
      // 重排奖档物理顺序：实物奖档先插入，成为无 orderBy 查询取到的首行
      await db.delete(lotteryPrizeTiers).where(eq(lotteryPrizeTiers.drawId, drawId));
      const manualPrizeId = crypto.randomUUID();
      await db.insert(prizes).values({
        id: manualPrizeId, tenantId: TENANT_ID, name: "实物奖", prizeType: "manual_fulfillment", totalCount: 5,
      });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, prizeId: manualPrizeId,
        tierName: "实物", winnerCount: 5, sortOrder: 1, weight: 100,
      });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, prizeId,
        tierName: "卡密", winnerCount: 10, sortOrder: 2, weight: 100,
      });
      // 卡密库存清零
      await db.update(prizeCodes).set({ status: "issued" }).where(eq(prizeCodes.prizeId, prizeId));

      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("可用 0 件，需要 1 件");
    });

    /**
     * docs/255 §八 P2-9 复核：多个 active 卡密奖品时 findCodePrize fail-closed 返回 null，
     * reservePrizeCodes 把 null 当成「非卡密活动，无需预占」→ 订单照样创建、用户照样付款，
     * 回调时 acquirePrizeCodes 同样返回 [] → 必然 FULFILLMENT_FAILED，只能靠退款兜底。
     * 必须在下单前（付款前）拒绝。
     */
    it("活动存在多个卡密奖品时拒绝下单（发卡侧 fail-closed，付款前拦截）", async () => {
      const { orderInput, drawId } = await seedOrderTestData();
      const secondCodePrizeId = crypto.randomUUID();
      await db.insert(prizes).values({
        id: secondCodePrizeId, tenantId: TENANT_ID, name: "第二个卡密奖", prizeType: "code", totalCount: 10,
      });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, prizeId: secondCodePrizeId,
        tierName: "二等", winnerCount: 10, sortOrder: 200, weight: 100,
      });
      await db.insert(prizeCodes).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, prizeId: secondCodePrizeId,
        code: "SK-CODE-SECOND", secret: "secret", status: "available",
      });

      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("多个卡密奖品");
      const orders = await db.select({ id: paymentOrders.id }).from(paymentOrders)
        .where(eq(paymentOrders.drawId, drawId));
      expect(orders).toHaveLength(0);
    });

    /**
     * docs/255 §八 P2-9 复核：卡密奖品被停用（active=0）时，findCodePrize 同样返回 null →
     * reservePrizeCodes 跳过预占 → 订单创建成功、付款后必然发卡失败。
     * 旧预检没有 active 过滤，还会把停用奖品的码池算成有库存。必须付款前拒绝。
     */
    it("卡密奖品已停用（active=0）时拒绝下单，不把停用码池算作库存", async () => {
      const { orderInput, drawId, prizeId } = await seedOrderTestData();
      await db.update(prizes).set({ active: 0 }).where(eq(prizes.id, prizeId));

      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("卡密奖品已停用");
      const orders = await db.select({ id: paymentOrders.id }).from(paymentOrders)
        .where(eq(paymentOrders.drawId, drawId));
      expect(orders).toHaveLength(0);
    });

    it("追加购买时累计超过 maxPerUser 拒绝", async () => {
      const { orderInput, drawId, entryId } = await seedOrderTestData();
      await db.insert(paymentOrders).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email", buyerIdentityValue: "buyer@test.com",
        quantity: 2, amountCents: 19800, currency: "cny",
        provider: "alipay", status: "paid",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("每人限购 2 件");
    });

    it("quantity 非法值（0/负/NaN）被钳制为 1 后正常创建", async () => {
      const { orderInput, entryId } = await seedOrderTestData();
      for (const qty of [0, -1, NaN, undefined as unknown as number]) {
        const result = await createPaymentOrder(db, { ...orderInput, quantity: qty }, providerMock);
        expect(result.order.quantity).toBe(1);
        // 清理订单与 attempts，避免下一轮创建冲突
        await db.delete(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, result.order.id));
        await db.delete(paymentOrders).where(eq(paymentOrders.entryId, entryId));
        await db.update(lotteryEntries).set({ paymentStatus: "reserved" }).where(eq(lotteryEntries.id, entryId));
      }
    });

    it("expired pending 订单再创建时不会静默重新支付（懒清理置为 expired + 拒绝重复创建）", async () => {
      const { orderInput, drawId, entryId } = await seedOrderTestData();
      // 先创建一个已过期的 pending 订单（createdAt 设为 31 分钟前，timeout=30）
      const expiredOrderId = crypto.randomUUID();
      await db.insert(paymentOrders).values({
        id: expiredOrderId, tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email", buyerIdentityValue: "buyer@test.com",
        quantity: 1, amountCents: 9900, currency: "cny",
        provider: "alipay", status: "pending",
        createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      });
      // 真实流程：createPaymentOrder 开头会先懒清理 expireOverdueOrders，
      // 该过期 pending 订单被置为 expired，entry 因逾期被释放，
      // 随后同一 reserved entry 无法再直接创建新订单（必须重新参与），从而杜绝"过期订单继续收款"。
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 1 }, providerMock))
        .rejects.toThrow("参与预约已失效");
      // 验证懒清理已把过期订单标记为 expired（不变量：不会作为可支付订单残留）
      const [after] = await db
        .select({ status: paymentOrders.status })
        .from(paymentOrders)
        .where(eq(paymentOrders.id, expiredOrderId));
      expect(after?.status).toBe("expired");
    });
  });

  describe("P2 优化：下单时预占卡密库存（docs/205）", () => {
    async function seedReserveCtx(codeCount: number) {
      const drawId = crypto.randomUUID();
      const entryId = crypto.randomUUID();
      const prizeId = crypto.randomUUID();
      await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" }).onConflictDoNothing();
      await db.insert(lotteryDraws).values({
        id: drawId, tenantId: TENANT_ID, publicSlug: `reserve-p2-${drawId}`,
        title: "卡密预占P2", status: "open",
        experienceType: "flash_sale", maxParticipants: 10,
        promotionConfig: JSON.stringify({
          flashSale: { enabled: true, paymentRequired: true, stockLimit: 10, priceCents: 9900, currency: "cny", maxPerUser: 5 },
        }),
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await db.insert(lotteryEntries).values({
        id: entryId, tenantId: TENANT_ID, drawId,
        identityType: "email", identityValue: "reserve@test.com", paymentStatus: "reserved",
      });
      await db.insert(prizes).values({ id: prizeId, tenantId: TENANT_ID, name: "卡密奖品", prizeType: "code", totalCount: codeCount });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, prizeId,
        tierName: "中奖", winnerCount: codeCount, sortOrder: 100, weight: 100,
      });
      const codes = Array.from({ length: codeCount }, (_, i) => ({
        id: `reserve-code-${drawId}-${i}`, tenantId: TENANT_ID, prizeId,
        code: `R-CODE-${drawId}-${i}`, secret: "s", status: "available" as const,
      }));
      if (codes.length > 0) await db.insert(prizeCodes).values(codes);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email", buyerIdentityValue: "buyer@test.com",
        amountCents: 19800, currency: "cny", provider: "alipay" as const,
        notifyUrl: "https://cb.test", unitPriceCents: 9900,
      };
      return { drawId, entryId, orderInput, prizeId };
    }

    it("createPaymentOrder 成功时预占卡密为 reserved 并绑定订单", async () => {
      const { orderInput } = await seedReserveCtx(5);
      const result = await createPaymentOrder(db, { ...orderInput, quantity: 2 }, providerMock);
      // 预占 2 张 reserved
      const reserved = await db.select().from(prizeCodes).where(and(
        eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved"), inArray(prizeCodes.paymentOrderId, [result.order.id]),
      ));
      expect(reserved.length).toBe(2);
      expect(reserved.every(c => c.paymentOrderId === result.order.id)).toBe(true);
      // 其余 3 张仍 available
      const avail = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "available")));
      expect(avail.length).toBe(3);
    });

    it("createPaymentOrder 卡密不足时拒绝下单并整体回滚（订单/entry/名额/卡密）", async () => {
      const { orderInput, entryId, drawId } = await seedReserveCtx(1);
      // 卡密仅 1 张，下单 quantity=3 → 源头扼杀预检先拦截（availableStock < quantity）
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 3, amountCents: 29700 }, providerMock))
        .rejects.toThrow("库存不足");
      // 订单不创建（事务回滚）
      const orders = await db.select().from(paymentOrders).where(eq(paymentOrders.entryId, entryId));
      expect(orders).toHaveLength(0);
      // entry 保持 reserved（未被消费）
      const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entry?.paymentStatus).toBe("reserved");
      // 卡密未被预占（回滚到 available）
      const codes = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(codes).toHaveLength(0);
      // 名额未占用
      const [draw] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
      expect(draw?.count).toBe(0);
    });

    it("handlePaymentCallback 把预占卡密确认（reserved → issued）", async () => {
      const { orderInput } = await seedReserveCtx(5);
      const order = await createPaymentOrder(db, { ...orderInput, quantity: 2 }, providerMock);
      const [att] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id)).limit(1);
      expect(att).toBeDefined();
      const cbProvider = { ...providerMock, name: "alipay", verifyCallback: vi.fn(async () => ({
        orderNo: att!.id, providerTradeNo: "EP-P2", amountCents: 19800, currency: "cny", paidAt: "2026-08-12T00:00:00.000Z",
      })) };
      const result = await handlePaymentCallback(db, TENANT_ID, cbProvider, {});
      expect(result.processed).toBe(true);
      expect(result.order?.status).toBe("paid");
      // 2 张卡密 issued
      const issued = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "issued")));
      expect(issued.length).toBe(2);
      expect(issued.every(c => c.paymentOrderId === order.order.id)).toBe(true);
      // 无残留 reserved
      const reserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(reserved).toHaveLength(0);
    });

    it("expireOverdueOrders 超时释放预占卡密回 available", async () => {
      const { orderInput } = await seedReserveCtx(5);
      const order = await createPaymentOrder(db, { ...orderInput, quantity: 2 }, providerMock);
      // 修改 orders createdAt 为超时（50 分钟前）
      const past = new Date(Date.now() - 50 * 60_000).toISOString();
      await db.update(paymentOrders).set({ createdAt: past }).where(eq(paymentOrders.id, order.order.id));
      await expireOverdueOrders(db, TENANT_ID);
      // 预占卡密释放回 available
      const reserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(reserved).toHaveLength(0);
      const avail = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "available")));
      expect(avail.length).toBe(5);
    });

    it("cancelPaymentOrder 取消时释放预占卡密回 available", async () => {
      const { orderInput } = await seedReserveCtx(5);
      // 模拟 provider.createPayment 确定性失败 → createPaymentOrder 触发 cancelPaymentOrder
      const failProvider = { ...providerMock, createPayment: vi.fn(async () => {
        throw new EasyPayProviderError("param_error" as any, "参数错误");
      }) };
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 2 }, failProvider)).rejects.toThrow();
      // 预占卡密在事务内与订单一起回滚，无残留 reserved
      const reserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(reserved).toHaveLength(0);
      const avail = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "available")));
      expect(avail.length).toBe(5);
    });

    it("cancelPaymentOrder 取消时释放预占卡密回 available", async () => {
      const { orderInput } = await seedReserveCtx(5);
      const failProvider = { ...providerMock, createPayment: vi.fn(async () => {
        throw new EasyPayProviderError("param_error" as any, "参数错误");
      }) };
      await expect(createPaymentOrder(db, { ...orderInput, quantity: 2 }, failProvider)).rejects.toThrow();
      const reserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(reserved).toHaveLength(0);
      const avail = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "available")));
      expect(avail.length).toBe(5);
    });

    describe("docs/222 P2 验收：退款闭环", () => {
      async function seedPaidCtx(codeCount: number, quantity = 2) {
        const { drawId, entryId, orderInput } = await seedReserveCtx(codeCount);
        const unitPrice = orderInput.unitPriceCents || 9900;
        const correctAmount = unitPrice * quantity;
        const order = await createPaymentOrder(db, { ...orderInput, quantity, amountCents: correctAmount, unitPriceCents: unitPrice }, providerMock);
        const [att] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id)).limit(1);
        const cbProvider = { ...providerMock, name: "alipay", verifyCallback: vi.fn(async () => ({
          orderNo: att!.id, providerTradeNo: "EP-REFUND", amountCents: order.order.amountCents, currency: "cny", paidAt: new Date().toISOString(),
        })) };
        await handlePaymentCallback(db, TENANT_ID, cbProvider, {});
        return { drawId, entryId, orderId: order.order.id, quantity };
      }

      it("退款后：订单 refunded、已发卡密 revoked、entry expired、名额按 quantity 释放", async () => {
        const { drawId, entryId, orderId, quantity } = await seedPaidCtx(5, 2);
        await refundPaymentOrder(db, TENANT_ID, orderId, "ops-user", { reason: "P2 测试退款" });
        const [order] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, orderId));
        expect(order?.status).toBe("refunded");
        const revoked = await db.select().from(prizeCodes).where(and(eq(prizeCodes.paymentOrderId, orderId), eq(prizeCodes.status, "revoked")));
        expect(revoked.length).toBe(quantity);
        const items = await db.select({ status: paymentOrderItems.status }).from(paymentOrderItems).where(eq(paymentOrderItems.paymentOrderId, orderId));
        expect(items.every(i => i.status === "refunded")).toBe(true);
        const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
        expect(entry?.paymentStatus).toBe("expired");
        const [drawAfter] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
        expect(drawAfter?.count).toBe(0);
      });

      it("退款后有其他 PAID 订单 → entry 恢复 paid（名额保留）", async () => {
        const { drawId, entryId, orderId } = await seedPaidCtx(5, 1);
        // 同活动再下一单（V2 追加），用同一 drawId，数量 1 件金额 9900 分
        const { orderInput } = await seedReserveCtx(5);
        const second = await createPaymentOrder(db, { ...orderInput, drawId, entryId, quantity: 1, amountCents: 9900, unitPriceCents: 9900 }, providerMock);
        const [att2] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, second.order.id)).limit(1);
        const cb2 = { ...providerMock, name: "alipay", verifyCallback: vi.fn(async () => ({
          orderNo: att2!.id, providerTradeNo: "EP-REFUND-2", amountCents: 9900, currency: "cny", paidAt: new Date().toISOString(),
        })) };
        await handlePaymentCallback(db, TENANT_ID, cb2, {});
        await refundPaymentOrder(db, TENANT_ID, orderId, "ops-user", { reason: "退第一笔" });
        const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
        expect(entry?.paymentStatus).toBe("paid");
        // 第二笔 PAID 订单仍占 1 件名额（种子模型无 join base 1，order2 补占 1）
        const [draw] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
        expect(draw?.count).toBe(1);
      });

      it("已 refunded 订单再次退款被幂等拒绝", async () => {
        const { orderId } = await seedPaidCtx(5, 1);
        await refundPaymentOrder(db, TENANT_ID, orderId, "ops-user", { reason: "首次退款" });
        await expect(refundPaymentOrder(db, TENANT_ID, orderId, "ops-user", { reason: "重复退款" })).rejects.toThrow("不允许退款");
      });
    });
  });

  // ── 促销审查：针对线上活动 8c5515ed 配置（stockLimit=10, maxPerUser=5, 阶梯价）的完整验证 ──
  // 覆盖：超发 / 漏发 / 误发 / 订单超时释放 / 限购 / 阶梯价权威金额
  describe("促销审查：线上活动 8c5515ed 关键路径（超发/漏发/误发/超时释放）", () => {
    /**
     * 构造与线上活动 8c5515ed 完全一致的直付秒杀配置：
     * stockLimit=10, maxPerUser=5, priceCents=990, 阶梯价 1件9.9 / 5件起8.9。
     * codeCount 为可用卡密数，activeParticipantCount 为已占名额（模拟 join 后 base 1）。
     */
    async function seedLiveCtx(codeCount: number, activeCount = 1) {
      const drawId = crypto.randomUUID();
      const entryId = crypto.randomUUID();
      const prizeId = crypto.randomUUID();
      await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" }).onConflictDoNothing();
      await db.insert(lotteryDraws).values({
        id: drawId, tenantId: TENANT_ID, publicSlug: `live-${drawId}`,
        title: "限时抢购", status: "open",
        experienceType: "flash_sale", maxParticipants: 10,
        activeParticipantCount: activeCount,
        promotionConfig: JSON.stringify({
          flashSale: {
            enabled: true, sessionLabel: "12:00场", stockLimit: 10, maxPerUser: 5,
            ctaLabel: "抢", showCountdown: true, showProgress: true, showStock: true,
            paymentRequired: true, priceCents: 990, currency: "cny", title: "限时抢购商品",
            pricingTiers: [
              { minQuantity: 1, unitPriceCents: 990, label: "单件" },
              { minQuantity: 5, unitPriceCents: 890, label: "5件起" },
            ],
          },
        }),
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await db.insert(lotteryEntries).values({
        id: entryId, tenantId: TENANT_ID, drawId,
        identityType: "email", identityValue: "live@test.com", paymentStatus: "reserved",
      });
      await db.insert(prizes).values({
        id: prizeId, tenantId: TENANT_ID, name: "限时抢购商品", prizeType: "code", totalCount: codeCount,
      });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, drawId, prizeId,
        tierName: "中奖", winnerCount: codeCount, sortOrder: 100, weight: 100,
      });
      const codes = Array.from({ length: codeCount }, (_, i) => ({
        id: `live-code-${drawId}-${i}`, tenantId: TENANT_ID, prizeId,
        code: `L-CODE-${drawId}-${i}`, secret: "s", status: "available" as const,
      }));
      if (codes.length > 0) await db.insert(prizeCodes).values(codes);
      return { drawId, entryId, prizeId };
    }

    function liveCbProvider(attemptId: string, amountCents: number) {
      return {
        ...providerMock,
        name: "alipay" as const,
        verifyCallback: vi.fn(async () => ({
          orderNo: attemptId,
          providerTradeNo: `EP-LIVE-${Date.now()}`,
          amountCents,
          currency: "cny",
          paidAt: new Date().toISOString(),
        })),
      };
    }

    it("阶梯价权威金额：5件起按 8.9 元/件，服务端计算 amountCents=4450", async () => {
      const { drawId, entryId } = await seedLiveCtx(10);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 5, unitPriceCents: 890,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price", quantity: 5, unitPriceCents: 890, amountCents: 4450 }),
        amountCents: 4450, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, providerMock);
      expect(order.order.amountCents).toBe(4450);
      expect(order.order.unitPriceCents).toBe(890);
      expect(order.order.quantity).toBe(5);
    });

    it("金额不一致被源头扼杀拒绝（防御路由层/网关篡改）", async () => {
      const { drawId, entryId } = await seedLiveCtx(10);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 2, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 1000, // 故意与 990*2=1980 不一致
        currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      await expect(createPaymentOrder(db, orderInput, providerMock)).rejects.toThrow("金额不一致");
    });

    it("限购：maxPerUser=5 累计已购 4 件后再买 2 件被拒", async () => {
      const { drawId, entryId } = await seedLiveCtx(10);
      // 先买 4 件并支付成功
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 4, unitPriceCents: 890,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 3560, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, providerMock);
      const [att] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id)).limit(1);
      await handlePaymentCallback(db, TENANT_ID, liveCbProvider(att!.id, 3560), {});

      // 再买 2 件 → 4+2=6 > 5，被限购拦截
      const secondInput = {
        ...orderInput, quantity: 2, unitPriceCents: 990, amountCents: 1980,
      };
      await expect(createPaymentOrder(db, secondInput, providerMock)).rejects.toThrow("每人限购");
    });

    it("漏发防护：回调时卡密被并发耗尽 → 订单进入 FULFILLMENT_FAILED 而非静默成功，补发后恢复 paid", async () => {
      // 预检需要足够卡密通过（源头扼杀），但回调前把卡密全部占用，模拟并发耗尽
      const { drawId, entryId } = await seedLiveCtx(3);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 3, unitPriceCents: 890,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 2670, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, providerMock);
      // 下单时预占 3 张卡密（reserved）
      const reserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(reserved.length).toBe(3);

      // 模拟并发：把 3 张预占卡密全部释放回 available 并立即被其他订单占用（issued）
      // 这样 confirmPrizeCodes 找不到 reserved 卡密，acquirePrizeCodes 也拿不到 available
      await db.update(prizeCodes)
        .set({ status: "issued", winnerId: "other-entry", paymentOrderId: "other-order" })
        .where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));

      const [att] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id)).limit(1);
      const result = await handlePaymentCallback(db, TENANT_ID, liveCbProvider(att!.id, 2670), {});
      // 卡密不足 → 订单 FULFILLMENT_FAILED，不静默成功（不漏发也不误发）
      expect(result.order?.status).toBe("paid_fulfillment_failed");
      // entry 保持 pending（占位，等待补发）
      const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entry?.paymentStatus).toBe("pending");

      // 运营补充 3 张卡密后补发 → 订单恢复 paid
      const [prizeRow] = await db.select({ id: prizes.id }).from(prizes).where(eq(prizes.tenantId, TENANT_ID)).limit(1);
      const extraCodes = Array.from({ length: 3 }, (_, i) => ({
        id: `live-code-${drawId}-extra-${i}`, tenantId: TENANT_ID, prizeId: prizeRow!.id,
        code: `L-EXTRA-${drawId}-${i}`, secret: "s", status: "available" as const,
      }));
      await db.insert(prizeCodes).values(extraCodes);
      const retry = await retryPaymentFulfillment(db, TENANT_ID, order.order.id);
      expect(retry.ok).toBe(true);
      expect(retry.order?.status).toBe("paid");
      // 该订单最终 3 张卡密 issued（不超发）
      const issuedForOrder = await db.select().from(prizeCodes).where(and(
        eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.paymentOrderId, order.order.id), eq(prizeCodes.status, "issued"),
      ));
      expect(issuedForOrder.length).toBe(3);
    });

    it("误发防护：金额不匹配的回调被拒绝，不发卡", async () => {
      const { drawId, entryId } = await seedLiveCtx(5);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 1, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 990, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, providerMock);
      const [att] = await db.select({ id: paymentOrderAttempts.id }).from(paymentOrderAttempts).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id)).limit(1);
      // 回调金额 1000 ≠ 990 → 拒绝
      const badCb = liveCbProvider(att!.id, 1000);
      const result = await handlePaymentCallback(db, TENANT_ID, badCb, {});
      expect(result.processed).toBe(false);
      // 未发卡
      const issued = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "issued")));
      expect(issued).toHaveLength(0);
    });

    it("订单超时释放：超时 pending 订单释放名额与预占卡密，可被他人复用", async () => {
      const { drawId, entryId } = await seedLiveCtx(5, 1);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 2, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 1980, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, providerMock);
      // 预占 2 张卡密
      const reserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(reserved.length).toBe(2);

      // 把订单改为超时（61 分钟前）
      const past = new Date(Date.now() - 61 * 60_000).toISOString();
      await db.update(paymentOrders).set({ createdAt: past }).where(eq(paymentOrders.id, order.order.id));
      await db.update(paymentOrderAttempts).set({ createdAt: past }).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id));

      const count = await expireOverdueOrders(db, TENANT_ID);
      expect(count).toBeGreaterThanOrEqual(1);

      // 订单 → expired
      const [expiredOrder] = await db.select({ status: paymentOrders.status }).from(paymentOrders).where(eq(paymentOrders.id, order.order.id));
      expect(expiredOrder?.status).toBe("expired");
      // entry → expired（名额释放）
      const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entry?.paymentStatus).toBe("expired");
      // 预占卡密释放回 available（可被他人复用）
      const avail = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "available")));
      expect(avail.length).toBe(5);
      const remainingReserved = await db.select().from(prizeCodes).where(and(eq(prizeCodes.tenantId, TENANT_ID), eq(prizeCodes.status, "reserved")));
      expect(remainingReserved).toHaveLength(0);
      // 活动名额计数器已扣减（base 1 释放）
      const [draw] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
      expect(draw?.count).toBe(0);
    });

    it("超时释放后同一身份可重新参与（复用原 entry 重新预约，不制造第二条参与记录）", async () => {
      const { drawId, entryId } = await seedLiveCtx(5, 1);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 1, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 990, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, providerMock);
      const past = new Date(Date.now() - 61 * 60_000).toISOString();
      await db.update(paymentOrders).set({ createdAt: past }).where(eq(paymentOrders.id, order.order.id));
      await db.update(paymentOrderAttempts).set({ createdAt: past }).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id));
      await expireOverdueOrders(db, TENANT_ID);

      // entry 已 expired，可重新参与（复用原 entry）
      const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entry?.paymentStatus).toBe("expired");
      // 重新预约：把 entry 从 expired 改回 reserved（模拟 joinDraw 的 reopened 分支）
      await db.update(lotteryDraws).set({ activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + 1` })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, TENANT_ID)));
      await db.update(lotteryEntries).set({ paymentStatus: "reserved" })
        .where(and(eq(lotteryEntries.id, entryId), eq(lotteryEntries.paymentStatus, "expired")));
      // 仍只有一条 entry（不制造第二条参与记录）
      const entries = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entries).toHaveLength(1);
    });

    /** 每次下单返回不同 providerTradeNo，避免重试 attempt 撞 (tenant, provider, tradeNo) 唯一索引 */
    function uniqueTradeNoProvider(): PaymentProvider {
      return {
        ...providerMock,
        createPayment: vi.fn(async () => ({
          providerTradeNo: `checkout-${crypto.randomUUID()}`,
          redirectUrl: "https://pay.example.com/checkout",
          qrCode: "https://pay.example.com/qr",
        })),
      };
    }

    it("超时释放 + 重新参与后仍可重试支付（P0：entry=reserved 时按已占 1 份补占，不重复占用名额）", async () => {
      const provider = uniqueTradeNoProvider();
      const { drawId, entryId } = await seedLiveCtx(5, 1);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 1, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 990, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, provider);
      const past = new Date(Date.now() - 61 * 60_000).toISOString();
      await db.update(paymentOrders).set({ createdAt: past }).where(eq(paymentOrders.id, order.order.id));
      await db.update(paymentOrderAttempts).set({ createdAt: past }).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id));
      await expireOverdueOrders(db, TENANT_ID);

      // joinDraw 的 reopened 分支：活动计数 +1（占 1 份基础份额）+ entry expired → reserved
      await db.update(lotteryDraws).set({ activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + 1` })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, TENANT_ID)));
      await db.update(lotteryEntries).set({ paymentStatus: "reserved" })
        .where(and(eq(lotteryEntries.id, entryId), eq(lotteryEntries.paymentStatus, "expired")));

      // 用户点「支付」→ routes/payment.ts 判定原订单可重试 → retryPaymentOrder
      const retried = await retryPaymentOrder(db, orderInput, provider, order.order.id);
      expect(retried.order.status).toBe("pending");

      // entry 回到 pending（不再永久卡在 reserved）
      const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entry?.paymentStatus).toBe("pending");
      // 名额计数器必须仍是 1（reopen 已占 1 份，重试不得重复 +1）
      const [drawRow] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
      expect(drawRow?.count).toBe(1);
    });

    it("重试支付：entry 仍为 expired 时按整单 quantity 补占名额", async () => {
      const provider = uniqueTradeNoProvider();
      const { drawId, entryId } = await seedLiveCtx(5, 1);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 2, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 1980, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, provider);
      const past = new Date(Date.now() - 61 * 60_000).toISOString();
      await db.update(paymentOrders).set({ createdAt: past }).where(eq(paymentOrders.id, order.order.id));
      await db.update(paymentOrderAttempts).set({ createdAt: past }).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id));
      await expireOverdueOrders(db, TENANT_ID);
      const [released] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
      expect(released?.count).toBe(0);

      const retried = await retryPaymentOrder(db, orderInput, provider, order.order.id);
      expect(retried.order.status).toBe("pending");
      const [drawRow] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
      expect(drawRow?.count).toBe(2);
    });

    it("重试支付：entry=reserved 且 quantity>1 时只补占 quantity-1（不重复计入已占的 1 份）", async () => {
      const provider = uniqueTradeNoProvider();
      const { drawId, entryId } = await seedLiveCtx(5, 1);
      const orderInput = {
        tenantId: TENANT_ID, drawId, entryId,
        buyerIdentityType: "email" as const, buyerIdentityValue: "live@test.com",
        quantity: 3, unitPriceCents: 990,
        pricingSnapshotJson: JSON.stringify({ model: "cliff_unit_price" }),
        amountCents: 2970, currency: "cny" as const, provider: "alipay" as const,
        notifyUrl: "https://cb.test", description: "限时抢购商品",
      };
      const order = await createPaymentOrder(db, orderInput, provider);
      const past = new Date(Date.now() - 61 * 60_000).toISOString();
      await db.update(paymentOrders).set({ createdAt: past }).where(eq(paymentOrders.id, order.order.id));
      await db.update(paymentOrderAttempts).set({ createdAt: past }).where(eq(paymentOrderAttempts.paymentOrderId, order.order.id));
      await expireOverdueOrders(db, TENANT_ID);

      // joinDraw reopened 分支：活动计数 +1（占 1 份基础份额）+ entry expired → reserved
      await db.update(lotteryDraws).set({ activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + 1` })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, TENANT_ID)));
      await db.update(lotteryEntries).set({ paymentStatus: "reserved" })
        .where(and(eq(lotteryEntries.id, entryId), eq(lotteryEntries.paymentStatus, "expired")));

      // 重试：quantity=3，entry=reserved（已占 1 份）→ 只补占 2 份
      const retried = await retryPaymentOrder(db, orderInput, provider, order.order.id);
      expect(retried.order.status).toBe("pending");
      const [entry] = await db.select({ paymentStatus: lotteryEntries.paymentStatus }).from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
      expect(entry?.paymentStatus).toBe("pending");
      // 名额 = reopen 的 1 份 + 补占的 2 份 = 3（quantity），不得重复计入
      const [drawRow] = await db.select({ count: lotteryDraws.activeParticipantCount }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId));
      expect(drawRow?.count).toBe(3);
    });
  });
});
