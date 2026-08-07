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
  tenants,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";
import { paymentPublicRoute } from "./payment";

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
