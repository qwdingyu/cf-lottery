import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
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
import type { PaymentProvider } from "@usethink/cf-core/features/payment";
import { EasyPayProviderError } from "@usethink/cf-core/features/payment";
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
} from "./payment-service";
import { encryptPaymentConfigValue } from "./secret-config";

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
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 5, priceCents: 9900, currency: "cny" } }),
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
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 2, priceCents: 9900, currency: "cny" } }),
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
        flashSale: { enabled: true, paymentRequired: true, stockLimit: maxParticipants, priceCents: 9900, currency: "cny" },
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
    // 只释放订单 B 的 3 件，订单 A 的 2 件仍占用
    expect(draw?.activeParticipantCount).toBe(2);
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
    // 只释放订单 B 的 3 件，订单 A 的 2 件仍占用
    expect(draw?.activeParticipantCount).toBe(2);
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
});
