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
    expect(order?.status).toBe("cancelled");
    expect(entry?.paymentStatus).toBe("expired");
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
