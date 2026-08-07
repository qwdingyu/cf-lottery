import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  paymentOrders,
  prizeCodes,
  prizes,
  tenantConfigs,
  tenants,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";
import { buildPaymentCallbackUrl, buildPaymentReturnUrl, paymentCallbackRoute, paymentPublicRoute } from "./payment";

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
    amountCents: 9900,
    currency: "cny",
    status: "paid",
    provider: "alipay",
    providerTradeNo: "EP-123",
    prizeCodeId: PRIZE_CODE_ID,
    paidAt: new Date().toISOString(),
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
      paymentStatus: "",
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
      paymentStatus: "",
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
      paymentStatus: "",
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

  it("查询订单时必须提供 email，避免卡密直接暴露", async () => {
    await seedOrder();
    const app = createTestApp();

    const missing = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}`, {}, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(missing.status).toBe(400);

    const wrong = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}?email=other@example.com`, {}, {
      TURSO_URL: "",
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      JWT_SECRET: "test",
    });
    expect(wrong.status).toBe(403);

    const okRes = await app.request(`/api/public/draws/payment-route/payment-orders/${ORDER_ID}?email=${encodeURIComponent(EMAIL)}`, {}, {
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
});
