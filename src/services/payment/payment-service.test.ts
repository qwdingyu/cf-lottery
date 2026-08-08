import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../../test-setup";
import type { DbType } from "../../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryPrizeTiers,
  paymentOrders,
  paymentOrderAttempts,
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
        // 重试请求故意传入不同金额/币种，必须仍以原订单快照为准。
        amountCents: 1,
        currency: "usd",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
        returnUrl: "https://example.com/result",
        description: "秒杀卡密",
      },
      providerMock,
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
    expect(order?.prizeCodeId).toBeNull();
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
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
      },
      failingProvider,
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
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
      },
      providerMock,
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
    expect(result.order?.prizeCodeId).toBe(PRIZE_CODE_ID);
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(code?.status).toBe("issued");
    expect(code?.winnerId).toBe(ENTRY_ID);
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
    expect(fulfillment.order?.prizeCodeId).toBe(PRIZE_CODE_ID);
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
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/callback",
      },
      providerMock,
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
    expect(result.order?.prizeCodeId).toBeNull();
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
   * 两个并发 createPaymentOrder 操作同一个 reserved entry，
   * 只有第一个能成功创建 order（reserved→pending CAS），第二个应失败。
   *
   * 防护机制：payment-service.ts createPaymentOrder 中
   *   WHERE paymentStatus='reserved' AND NOT EXISTS (SELECT 1 FROM payment_orders WHERE entry_id=?)
   */
  it("两个并发 createPaymentOrder 同一 reserved entry → 仅一个订单", async () => {
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(tenants).values({ id: TENANT_ID, name: "tenant" });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT_ID, publicSlug: `concurrent-${drawId}`,
      title: "并发创建订单测试", status: "open",
      experienceType: "flash_sale",
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, paymentRequired: true, stockLimit: 1, priceCents: 9900, currency: "cny" } }),
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
      amountCents: 9900, currency: "cny",
      provider: "easypay", notifyUrl: "https://cb.example.com",
    } as const;

    // 两个并发调用——由于 SQLite 单写者序列化，先到的占用 reserved slot
    const results = await Promise.allSettled([
      createPaymentOrder(db, orderInput, providerMock),
      createPaymentOrder(db, orderInput, providerMock),
    ]);

    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const failCount = results.filter((r) => r.status === "rejected").length;
    expect(okCount).toBe(1);
    expect(failCount).toBe(1);

    // 验证只有一条 order 记录
    const orders = await db.select().from(paymentOrders)
      .where(eq(paymentOrders.entryId, entryId));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("pending");
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
    expect(order?.prizeCodeId).toBe(codeId);

    // entry 为 paid
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryId));
    expect(entry?.paymentStatus).toBe("paid");
  });
});
