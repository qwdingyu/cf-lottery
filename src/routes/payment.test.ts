import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  emailAccessCodes,
  paymentOrders,
  paymentOrderAttempts,
  paymentOrderItems,
  prizeCodes,
  prizes,
  tenantConfigs,
  tenants,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";
import {
  buildPaymentCallbackUrl,
  buildPaymentRequestUrl,
  buildPaymentReturnUrl,
  paymentCallbackRoute,
  paymentPublicRoute,
} from "./payment";
import { issuePaymentOrderAccessToken, createPaymentOrder } from "../services/payment/payment-service";
import { encryptPaymentConfigValue } from "@usethink/cf-pay/config-store";
import { hashCode } from "./public-lottery-helpers";

/**
 * 追加购买（add_more）回归测试的依赖隔离（docs/257 死磕闭环）：
 * - 只 mock 掉「支付网络调用」边界（provider 创建与订单创建），让路由层真实跑通
 *   loadTenantConfig → 计价 → 下单，从而验证「已有 paid 订单后追加购买的件数/金额
 *   是否按本次前端件数计算」。
 * - createTenantProvider 同时被 resumingPending 分支使用，本 mock 返回 fake provider
 *   不会影响其它早退（400/409）测试。
 */
vi.mock("../services/payment/payment-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/payment/payment-service")>();
  const fakeProvider = {
    name: "easypay",
    createPayment: async () => ({
      redirectUrl: "https://pay.example.test/mock",
      qrCode: "qr-mock",
    }),
  } as never;
  return {
    ...actual,
    createTenantProvider: vi.fn(() => fakeProvider),
    createPaymentOrder: vi.fn(async (_db: unknown, input: { quantity?: number; amountCents?: number; tenantId: string; drawId: string; entryId: string; unitPriceCents?: number; currency: string; provider: string }) => ({
      order: {
        id: "order-added-mock",
        tenantId: input.tenantId,
        drawId: input.drawId,
        entryId: input.entryId,
        quantity: input.quantity ?? 1,
        unitPriceCents: input.unitPriceCents ?? 0,
        amountCents: input.amountCents ?? 0,
        currency: input.currency,
        provider: input.provider,
        status: "pending",
      },
      payResult: { redirectUrl: "https://pay.example.test/mock", qrCode: "qr-mock" },
      accessToken: "access-token-mock",
    })),
  };
});

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const TENANT_ID = "tenant-payment-route";
const DRAW_ID = "draw-payment-route";
const ENTRY_ID = "entry-payment-route";
const PRIZE_ID = "prize-payment-route";
const PRIZE_CODE_ID = "prize-code-payment-route";
const ORDER_ID = "order-payment-route";
const EMAIL = "buyer@example.com";

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/public", paymentPublicRoute);
  app.route("/api/payments", paymentCallbackRoute);
  return app;
}

async function seedOrder() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "payment-route" });
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "payment-route",
    title: "支付路由测试",
    status: "open",
    activityKind: "claim",
    participationMode: "open",
    experienceType: "card",
    resultMode: "instant",
    promotionConfig: JSON.stringify({
      flashSale: {
        enabled: true,
        paymentRequired: true,
        stockLimit: 10,
        priceCents: 9900,
        currency: "cny",
      },
    }),
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await db.insert(prizes).values({
    id: PRIZE_ID,
    tenantId: TENANT_ID,
    name: "卡密奖品",
    prizeType: "code",
  });
  await db.insert(prizeCodes).values({
    id: PRIZE_CODE_ID,
    tenantId: TENANT_ID,
    prizeId: PRIZE_ID,
    code: "CODE-123",
    secret: "SECRET-123",
    status: "issued",
  });
  await db.insert(lotteryEntries).values({
    id: ENTRY_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    identityType: "email",
    identityValue: EMAIL,
    displayName: "buyer",
    paymentStatus: "paid",
  });
  await db.insert(paymentOrders).values({
    id: ORDER_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    entryId: ENTRY_ID,
    // V2（docs/158 §2.1）：buyer 快照 — 下单时拷贝参与者的身份，后续独立于 entry 存在。
    buyerIdentityType: "email",
    buyerIdentityValue: EMAIL,
    buyerDisplayName: "buyer",
    quantity: 1,
    unitPriceCents: 9900,
    pricingSnapshotJson: "{}",
    amountCents: 9900,
    currency: "cny",
    status: "paid",
    provider: "alipay",
    currentAttemptId: ORDER_ID,
    providerTradeNo: "EP-123",
    /* V2 removed */ // prizeCodeId: PRIZE_CODE_ID,
    paidAt: new Date().toISOString(),
  });
  await db.insert(paymentOrderAttempts).values({
    id: ORDER_ID,
    paymentOrderId: ORDER_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    attemptNo: 1,
    provider: "alipay",
    amountCents: 9900,
    currency: "cny",
    status: "paid",
    providerTradeNo: "EP-123",
    paidAt: new Date().toISOString(),
  });
  // V2：订单项承载已发卡密（docs/158）
  await db.insert(paymentOrderItems).values({
    id: `${ORDER_ID}-item-1`,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    paymentOrderId: ORDER_ID,
    lineNo: 1,
    itemType: "flash_sale",
    title: "卡密奖品",
    quantity: 1,
    prizeCodeId: PRIZE_CODE_ID,
    amountCents: 9900,
    currency: "cny",
    status: "fulfilled",
    unitPriceCents: 9900,
  });
}

describe("payment route", () => {
  it("生成的支付回调和跳转 URL 与实际路由挂载一致", () => {
    const requestUrl = "https://lottery.example.com/api/public/draws/payment-route/payment-orders";
    expect(buildPaymentCallbackUrl(requestUrl, TENANT_ID, "alipay"))
      .toBe("https://lottery.example.com/api/payments/tenant-payment-route/alipay/callback");
    expect(buildPaymentReturnUrl(requestUrl))
      .toBe("https://lottery.example.com/api/public/draws/payment-route");
  });

  it("支付回调和回跳地址优先使用服务端 APP_ORIGIN，不信任伪造 Host", () => {
    const requestUrl = "https://attacker.example/api/public/draws/payment-route/payment-orders";
    expect(buildPaymentRequestUrl(requestUrl, "https://lottery.example.com/", "payment-route"))
      .toBe("https://lottery.example.com/api/public/draws/payment-route/payment-orders");
    expect(() => buildPaymentRequestUrl(requestUrl, "javascript:alert(1)", "payment-route"))
      .toThrow("APP_ORIGIN");
  });

  it("Stripe webhook 使用原始 JSON body 提取 order_no，而不是按表单解析", async () => {
    const app = createTestApp();
    const res = await app.request("/api/payments/tenant-payment-route/stripe/callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=123,v1=abc",
      },
      body: JSON.stringify({
        type: "checkout.session.completed",
        data: {
          object: {
            metadata: { order_no: ORDER_ID },
          },
        },
      }),
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("order not found");
  });

  it("创建直付订单时拒绝非 email 身份，避免支付后无法授权查卡", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "payment-route" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "payment-route",
      title: "支付路由测试",
      status: "open",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await db.insert(lotteryEntries).values({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "phone",
      identityValue: "13800138000",
      displayName: "buyer",
      paymentStatus: "reserved",
    });

    const app = createTestApp();
    const res = await app.request("/api/public/draws/payment-route/payment-orders", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: EMAIL }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("email");
  });

  it("创建直付订单时必须把请求邮箱绑定到参与记录，不能只凭 entryId 下单", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "payment-route" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "payment-route",
      title: "支付身份绑定测试",
      status: "open",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 1,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await db.insert(lotteryEntries).values({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: EMAIL,
      displayName: "buyer",
      paymentStatus: "reserved",
    });

    const app = createTestApp();
    const res = await app.request("/api/public/draws/payment-route/payment-orders", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: "attacker@example.com" }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("参与身份");
    expect(await db.select().from(paymentOrders)).toHaveLength(0);
  });

  it("直付批发摘要按已支付订单累计限购，但不返回订单号或卡密", async () => {
    await seedOrder();
    await db.update(lotteryDraws).set({
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 5,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    }).where(eq(lotteryDraws.id, DRAW_ID));
    await db.update(paymentOrders).set({ quantity: 2 }).where(eq(paymentOrders.id, ORDER_ID));

    const app = createTestApp();
    const forbidden = await app.request("/api/public/draws/payment-route/payment-orders/summary", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: "attacker@example.com" }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(forbidden.status).toBe(403);

    const res = await app.request("/api/public/draws/payment-route/payment-orders/summary", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: EMAIL }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      latestOrderStatus: "paid",
      purchasedQuantity: 2,
      remainingQuantity: 3,
      maxPerUser: 5,
    });
    expect(body).not.toHaveProperty("orderNo");
    expect(body).not.toHaveProperty("prizeCode");
  });

  it("创建批量直付订单时拒绝超过单笔购买上限的数量", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "payment-route" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "payment-route",
      title: "批量数量上限测试",
      status: "open",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 2,
          priceCents: 9900,
          currency: "cny",
          pricingTiers: [{ minQuantity: 2, unitPriceCents: 8900, label: "批发价" }],
        },
      }),
    });
    await db.insert(lotteryEntries).values({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: EMAIL,
      displayName: "buyer",
      paymentStatus: "reserved",
    });

    const app = createTestApp();
    const res = await app.request("/api/public/draws/payment-route/payment-orders", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: EMAIL, quantity: 3 }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "单笔最多可购买 2 件" });
    expect(await db.select().from(paymentOrders)).toHaveLength(0);
  });

  it("已有 paid 订单后追加购买按本次件数重新计价，不复用旧订单数量", async () => {
    await seedOrder();
    // 已支付订单是 1 件 ¥99.00（seedOrder 固定）；活动支持批发阶梯（2 件起 ¥89/件）
    await db.update(lotteryDraws).set({
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          maxPerUser: 5,
          priceCents: 9900,
          currency: "cny",
          pricingTiers: [{ minQuantity: 2, unitPriceCents: 8900, label: "批发价" }],
        },
      }),
    }).where(eq(lotteryDraws.id, DRAW_ID));
    await db.insert(tenantConfigs).values({
      tenantId: TENANT_ID,
      enabled: 1,
      providers: JSON.stringify({
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
          easypay_api_base: "https://zpayz.cn",
        },
      }),
    });

    const app = createTestApp();
    const res = await app.request("/api/public/draws/payment-route/payment-orders", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: EMAIL, quantity: 3 }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
      CREDENTIALS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    // 追加 3 件 → 命中批发阶梯：单价 ¥89.00 × 3 = ¥267.00，而不是复用旧订单的 1 件 ¥99.00
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      quantity: number;
      amountCents: number;
      unitPriceCents: number;
    };
    expect(body.ok).toBe(true);
    expect(body.quantity).toBe(3);
    expect(body.unitPriceCents).toBe(8900);
    expect(body.amountCents).toBe(26700);

    // 路由层必须把「本次追加件数」传给 createPaymentOrder，而不是 existing.quantity（旧 1 件）
    const createMock = createPaymentOrder as unknown as ReturnType<typeof vi.fn>;
    const routedInput = createMock.mock.calls[createMock.mock.calls.length - 1]?.[1] as
      { quantity?: number; amountCents?: number };
    expect(routedInput.quantity).toBe(3);
    expect(routedInput.amountCents).toBe(26700);
  });

  it("活动已开奖时不能恢复 pending 支付，避免结束后继续收款", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "payment-route" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "payment-route",
      title: "已结束支付测试",
      status: "drawn",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() - 1_000).toISOString(),
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 1,
          priceCents: 9900,
          currency: "cny",
        },
      }),
    });
    await db.insert(lotteryEntries).values({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: EMAIL,
      displayName: "buyer",
      paymentStatus: "pending",
    });
    await db.insert(paymentOrders).values({
      id: ORDER_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: ENTRY_ID,
      amountCents: 9900,
      currency: "cny",
      status: "pending",
      provider: "easypay",
      currentAttemptId: ORDER_ID,
    });
    await db.insert(paymentOrderItems).values({
      id: `${ORDER_ID}-item-1`,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      paymentOrderId: ORDER_ID,
      lineNo: 1,
      itemType: "flash_sale",
      title: "已结束支付测试",
      quantity: 1,
      amountCents: 9900,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "pending",
      unitPriceCents: 9900,
    });
    await db.insert(paymentOrderAttempts).values({
      id: ORDER_ID,
      paymentOrderId: ORDER_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      attemptNo: 1,
      provider: "easypay",
      amountCents: 9900,
      currency: "cny",
      status: "pending",
    });

    const app = createTestApp();
    const res = await app.request("/api/public/draws/payment-route/payment-orders", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: EMAIL }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });

    expect(res.status).toBe(409);
    // expireOverdueOrders 在路由入口处调用（优化后：活动已结束则立即过期订单），
    // 订单被标记为 expired → 用户无法重试 → 返回 '活动已关闭，不能重新创建支付订单'
    expect(await res.json()).toMatchObject({ message: "活动已关闭，不能重新创建支付订单" });
  });

  it("区块链支付暂不进入当前目录，USDT 直付发卡订单被拒绝创建", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "payment-route" });
    await db.insert(tenantConfigs).values({
      tenantId: TENANT_ID,
      enabled: 1,
      providers: JSON.stringify({
        usdt_trc20: {
          enabled: true,
          trc20_wallet_address: "TWallet",
          trongrid_api_key: "key",
        },
      }),
    });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "payment-route",
      title: "支付路由测试",
      status: "open",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
      promotionConfig: JSON.stringify({
        flashSale: {
          enabled: true,
          paymentRequired: true,
          stockLimit: 10,
          priceCents: 9900,
          currency: "usdt",
        },
      }),
    });
    await db.insert(lotteryEntries).values({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      identityType: "email",
      identityValue: EMAIL,
      displayName: "buyer",
      paymentStatus: "reserved",
    });

    const app = createTestApp();
    const res = await app.request("/api/public/draws/payment-route/payment-orders", {
      method: "POST",
      body: JSON.stringify({ entryId: ENTRY_ID, email: EMAIL }),
      headers: { "Content-Type": "application/json" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("自动发卡");
    const orders = await db.select().from(paymentOrders).where(eq(paymentOrders.tenantId, TENANT_ID));
    expect(orders).toHaveLength(0);
  });

  it("查询订单必须使用短期访问令牌，避免卡密直接暴露", async () => {
    await seedOrder();
    const app = createTestApp();

    const missing = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}`, {}, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(missing.status).toBe(404);

    const wrong = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}`, {
      headers: { Authorization: "Bearer invalid-token" },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(wrong.status).toBe(404);

    const accessToken = await issuePaymentOrderAccessToken(db, TENANT_ID, ORDER_ID);

    const okRes = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(okRes.status).toBe(200);
    const body = await okRes.json() as {
      ok: boolean;
      order: {
        orderNo: string;
        status: string;
        prizeCode: { code: string; secret: string } | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.order.orderNo).toBe(ORDER_ID);
    expect(body.order.prizeCode).toEqual({ code: "CODE-123", secret: "SECRET-123" });
  });

  it("批量直付订单查单返回订单关联的多张卡密，并保留 prizeCode 兼容字段", async () => {
    await seedOrder();
    await db.update(paymentOrders)
      .set({ quantity: 2, unitPriceCents: 8900, amountCents: 17800 })
      .where(eq(paymentOrders.id, ORDER_ID));
    await db.update(paymentOrderItems)
      .set({ prizeCodeId: PRIZE_CODE_ID, status: "fulfilled", lineNo: 10 })
      .where(eq(paymentOrderItems.paymentOrderId, ORDER_ID));
    await db.insert(prizeCodes).values({
      id: `${PRIZE_CODE_ID}-2`,
      tenantId: TENANT_ID,
      prizeId: PRIZE_ID,
      code: "CODE-456",
      secret: "SECRET-456",
      status: "issued",
      winnerId: ENTRY_ID,
      paymentOrderId: ORDER_ID,
    });
    await db.insert(paymentOrderItems).values({
      id: `${ORDER_ID}-item-2`,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      paymentOrderId: ORDER_ID,
      lineNo: 2,
      itemType: "flash_sale",
      title: "卡密奖品",
      quantity: 1,
      prizeCodeId: `${PRIZE_CODE_ID}-2`,
      amountCents: 8900,
      currency: "cny",
      pricingSnapshotJson: "{}",
      status: "fulfilled",
      unitPriceCents: 8900,
    });
    const accessToken = await issuePaymentOrderAccessToken(db, TENANT_ID, ORDER_ID);
    const app = createTestApp();

    const okRes = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });

    expect(okRes.status).toBe(200);
    const body = await okRes.json() as {
      ok: boolean;
      order: {
        quantity: number;
        amountCents: number;
        prizeCode: { code: string; secret: string } | null;
        prizeCodes: Array<{ code: string; secret: string }>;
      };
    };
    expect(body.order.quantity).toBe(2);
    expect(body.order.amountCents).toBe(17800);
    expect(body.order.prizeCode).toEqual({ code: "CODE-456", secret: "SECRET-456" });
    expect(body.order.prizeCodes).toEqual([
      { code: "CODE-456", secret: "SECRET-456" },
      { code: "CODE-123", secret: "SECRET-123" },
    ]);

    await db.insert(emailAccessCodes).values({
      id: "payment-bulk-recovery-code",
      email: EMAIL,
      drawId: DRAW_ID,
      codeHash: await hashCode("654321"),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      used: 0,
    });
    const recovered = await app.request("/api/public/draws/payment-route/payment-orders/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, code: "654321" }),
    }, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    const recoveredBody = await recovered.json() as {
      ok: boolean;
      orders: Array<{ quantity: number; prizeCodes: Array<{ code: string; secret: string }> }>;
    };
    expect(recovered.status).toBe(200);
    expect(recoveredBody.orders[0].quantity).toBe(2);
    expect(recoveredBody.orders[0].prizeCodes).toEqual([
      { code: "CODE-456", secret: "SECRET-456" },
      { code: "CODE-123", secret: "SECRET-123" },
    ]);
  });

  it("不再公开裸邮箱订单列表；OTP 找回可恢复已支付订单和卡密", async () => {
    await seedOrder();
    const app = createTestApp();
    const env = {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    };

    const insecureList = await app.request(
      `/api/public/draws/payment-route/payment-orders?email=${encodeURIComponent(EMAIL)}`,
      {},
      env,
    );
    expect(insecureList.status).toBe(404);

    await db.insert(emailAccessCodes).values({
      id: "payment-recovery-code",
      email: EMAIL,
      drawId: DRAW_ID,
      codeHash: await hashCode("123456"),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      used: 0,
    });

    const missingCode = await app.request("/api/public/draws/payment-route/payment-orders/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, code: "000000" }),
    }, env);
    expect(missingCode.status).toBe(400);

    const recovered = await app.request("/api/public/draws/payment-route/payment-orders/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, code: "123456" }),
    }, env);
    expect(recovered.status).toBe(200);
    const body = await recovered.json() as {
      ok: boolean;
      orders: Array<{
        orderNo: string;
        entryId: string;
        status: string;
        prizeCode: { code: string; secret: string } | null;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      orderNo: ORDER_ID,
      entryId: ENTRY_ID,
      status: "paid",
      prizeCode: { code: "CODE-123", secret: "SECRET-123" },
    });
  });
});
