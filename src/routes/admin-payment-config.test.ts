import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { clearTestData, getTestDb } from "../test-setup";
import { signJwt } from "../middleware/auth";
import {
  auditLogs,
  lotteryDraws,
  lotteryEntries,
  lotteryPrizeTiers,
  paymentOrders,
  prizeCodes,
  prizes,
  tenantConfigs,
  tenantMembers,
  tenants,
  users,
} from "../db/schema";
import { adminPaymentConfigRoute } from "./admin-payment-config";
import { encryptPaymentConfigValue } from "../services/payment/secret-config";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-admin-payment-config-secret-0123456789";
const TENANT_ID = "tenant-admin-payment";
const OTHER_TENANT_ID = "tenant-admin-payment-other";
const OWNER_ID = "user-admin-payment-owner";
const VIEWER_ID = "user-admin-payment-viewer";
const DRAW_ID = "draw-admin-payment";
const ENTRY_ID = "entry-admin-payment";
const ORDER_ID = "order-admin-payment";
const PRIZE_ID = "prize-admin-payment";
const PRIZE_CODE_ID = "prize-code-admin-payment";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

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
  app.route("/api/admin", adminPaymentConfigRoute);
  return app;
}

async function authHeader(userId = OWNER_ID, tenantId = TENANT_ID) {
  const token = await signJwt({ sub: userId, tenantId }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

async function seedMembers() {
  await db.insert(tenants).values([
    { id: TENANT_ID, name: "Payment Tenant" },
    { id: OTHER_TENANT_ID, name: "Other Payment Tenant" },
  ]);
  await db.insert(users).values([
    {
      id: OWNER_ID,
      username: "payment_owner",
      email: "owner@example.com",
      emailVerified: 1,
      passwordHash: "hash",
    },
    {
      id: VIEWER_ID,
      username: "payment_viewer",
      email: "viewer@example.com",
      emailVerified: 1,
      passwordHash: "hash",
    },
  ]);
  await db.insert(tenantMembers).values([
    { tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" },
    { tenantId: TENANT_ID, userId: VIEWER_ID, role: "viewer" },
  ]);
}

async function seedOrder(status = "paid_fulfillment_failed") {
  const now = new Date().toISOString();
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "admin-payment",
    title: "支付订单测试",
    status: "open",
    startAt: now,
    endAt: now,
  });
  await db.insert(lotteryEntries).values({
    id: ENTRY_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    identityType: "email",
    identityValue: "buyer@example.com",
    displayName: "buyer",
    paymentStatus: "pending",
  });
  await db.insert(prizes).values({
    id: PRIZE_ID,
    tenantId: TENANT_ID,
    name: "卡密",
    prizeType: "code",
  });
  await db.insert(lotteryPrizeTiers).values({
    id: "tier-admin-payment",
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    prizeId: PRIZE_ID,
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
    paidAt: now,
  });
}

async function seedOtherTenantOrder() {
  const now = new Date().toISOString();
  await db.insert(lotteryDraws).values({
    id: "draw-admin-payment-other",
    tenantId: OTHER_TENANT_ID,
    publicSlug: "admin-payment-other",
    title: "其他租户支付订单",
    status: "open",
    startAt: now,
    endAt: now,
  });
  await db.insert(lotteryEntries).values({
    id: "entry-admin-payment-other",
    tenantId: OTHER_TENANT_ID,
    drawId: "draw-admin-payment-other",
    identityType: "email",
    identityValue: "other@example.com",
    displayName: "other",
    paymentStatus: "paid",
  });
  await db.insert(paymentOrders).values({
    id: "order-admin-payment-other",
    tenantId: OTHER_TENANT_ID,
    drawId: "draw-admin-payment-other",
    entryId: "entry-admin-payment-other",
    amountCents: 100,
    currency: "cny",
    status: "paid",
    provider: "alipay",
    paidAt: now,
  });
}

describe("admin payment management", () => {
  it("lists only the current tenant payment orders and never exposes code secrets", async () => {
    await seedMembers();
    await db.insert(tenantConfigs).values({
      tenantId: TENANT_ID,
      enabled: 1,
      providers: JSON.stringify({
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", ENCRYPTION_KEY),
          easypay_api_base: "https://zpayz.cn",
        },
      }),
    });
    await seedOrder("paid");
    await seedOtherTenantOrder();

    const app = createTestApp();
    const res = await app.request("/api/admin/payment-orders", {
      headers: await authHeader(),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      orders: Array<{ id: string; tenantId: string; identityValue: string; secret?: string }>;
      providers: Array<{ name: string; displayName: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.providers).toEqual([expect.objectContaining({ name: "easypay", displayName: "易支付" })]);
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      id: ORDER_ID,
      tenantId: TENANT_ID,
      identityValue: "buyer@example.com",
    });
    expect(body.orders[0].secret).toBeUndefined();
  });

  it("rejects viewer retry fulfillment because it issues scarce card codes", async () => {
    await seedMembers();
    await seedOrder();
    await db.insert(prizeCodes).values({
      id: PRIZE_CODE_ID,
      tenantId: TENANT_ID,
      prizeId: PRIZE_ID,
      code: "CODE-1",
      secret: "SECRET-1",
      status: "available",
    });

    const app = createTestApp();
    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/retry-fulfillment`, {
      method: "POST",
      headers: await authHeader(VIEWER_ID),
    }, TEST_ENV);

    expect(res.status).toBe(403);
  });

  it("retries paid fulfillment failure by atomically issuing one available card code", async () => {
    await seedMembers();
    await seedOrder();
    await db.insert(prizeCodes).values({
      id: PRIZE_CODE_ID,
      tenantId: TENANT_ID,
      prizeId: PRIZE_ID,
      code: "CODE-1",
      secret: "SECRET-1",
      status: "available",
    });

    const app = createTestApp();
    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/retry-fulfillment`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(order?.status).toBe("paid");
    expect(order?.prizeCodeId).toBe(PRIZE_CODE_ID);
    expect(entry?.paymentStatus).toBe("paid");
    expect(code?.status).toBe("issued");
    expect(code?.winnerId).toBe(ENTRY_ID);

    const audits = await db.select().from(auditLogs).where(and(
      eq(auditLogs.tenantId, TENANT_ID),
      eq(auditLogs.action, "tenant.payment_order.retry_fulfillment"),
    ));
    expect(audits).toHaveLength(1);
  });

  it("returns conflict when retry fulfillment has no available card code", async () => {
    await seedMembers();
    await seedOrder();

    const app = createTestApp();
    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/retry-fulfillment`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);

    expect(res.status).toBe(409);
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("paid_fulfillment_failed");
  });

  it("checks static payment config completeness without creating a real payment", async () => {
    await seedMembers();
    await db.insert(tenantConfigs).values({
      tenantId: TENANT_ID,
      enabled: 1,
      providers: JSON.stringify({
        alipay: {
          enabled: true,
          alipay_app_id: "app-id",
          alipay_private_key: await encryptPaymentConfigValue("private", ENCRYPTION_KEY),
          alipay_public_key: await encryptPaymentConfigValue("public", ENCRYPTION_KEY),
        },
      }),
    });

    const app = createTestApp();
    // 显式覆盖 CREDENTIALS_ENCRYPTION_KEY 为空，确保测试无密钥场景不被 process.env 污染
    const res = await app.request("/api/admin/payment-config/check", {
      headers: await authHeader(),
    }, Object.assign({}, TEST_ENV, { CREDENTIALS_ENCRYPTION_KEY: "" }));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      providers: Array<{ name: string; configured: boolean; issues: string[] }>;
      currencySupport: Array<{ currency: string; available: boolean; providers: string[] }>;
      credentialsEncryptionKey: { configured: boolean };
    };
    expect(body.credentialsEncryptionKey.configured).toBe(false);
    const alipay = body.providers.find((item) => item.name === "alipay");
    expect(alipay?.configured).toBe(false);
    expect(alipay?.issues.join(";")).toContain("CREDENTIALS_ENCRYPTION_KEY");
    expect(body.currencySupport.find((item) => item.currency === "cny")?.available).toBe(false);
  });

  it("preserves encrypted sensitive fields when saving masked payment config placeholders", async () => {
    await seedMembers();
    const app = createTestApp();
    const env = {
      ...TEST_ENV,
      CREDENTIALS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };

    const firstSave = await app.request("/api/admin/payment-config", {
      method: "PUT",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: [{
          name: "easypay",
          enabled: true,
          fields: {
            EASYPAY_PID: "pid-1",
            EASYPAY_KEY: "secret-1",
            EASYPAY_API_BASE: "https://zpayz.cn",
            EASYPAY_PAY_TYPE: "alipay",
          },
        }],
      }),
    }, env);
    expect(firstSave.status).toBe(200);

    const [afterFirstSave] = await db
      .select({ providers: tenantConfigs.providers })
      .from(tenantConfigs)
      .where(eq(tenantConfigs.tenantId, TENANT_ID))
      .limit(1);
    const firstProviders = JSON.parse(afterFirstSave.providers) as Record<string, Record<string, string>>;
    const encryptedKey = firstProviders.easypay.easypay_key;
    expect(encryptedKey).toMatch(/^enc:/);

    const getRes = await app.request("/api/admin/payment-config", {
      headers: await authHeader(),
    }, env);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as {
      providers: Array<{ name: string; saved?: { fields: Record<string, string> } }>;
    };
    expect(getBody.providers.find((item) => item.name === "easypay")?.saved?.fields.EASYPAY_KEY)
      .toBe("••••••••");

    const secondSave = await app.request("/api/admin/payment-config", {
      method: "PUT",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: [{
          name: "easypay",
          enabled: true,
          fields: {
            EASYPAY_PID: "pid-2",
            EASYPAY_KEY: "••••••••",
            EASYPAY_API_BASE: "https://zpayz.cn",
            EASYPAY_PAY_TYPE: "wxpay",
          },
        }],
      }),
    }, env);
    expect(secondSave.status).toBe(200);

    const [afterSecondSave] = await db
      .select({ providers: tenantConfigs.providers })
      .from(tenantConfigs)
      .where(eq(tenantConfigs.tenantId, TENANT_ID))
      .limit(1);
    const secondProviders = JSON.parse(afterSecondSave.providers) as Record<string, Record<string, string>>;
    expect(secondProviders.easypay.easypay_key).toBe(encryptedKey);
    expect(secondProviders.easypay.easypay_pid).toBe("pid-2");
    expect(secondProviders.easypay.easypay_pay_type).toBe("wxpay");
  });

  it("checks EasyPay as the CNY direct fulfillment provider and ignores legacy blockchain config", async () => {
    await seedMembers();
    await db.insert(tenantConfigs).values({
      tenantId: TENANT_ID,
      enabled: 1,
      providers: JSON.stringify({
        easypay: {
          enabled: true,
          easypay_pid: "pid",
          easypay_key: await encryptPaymentConfigValue("key", ENCRYPTION_KEY),
          easypay_api_base: "https://zpayz.cn",
        },
        usdt_trc20: {
          enabled: true,
          trc20_wallet_address: "TWallet",
          trongrid_api_key: "key",
        },
      }),
    });

    const app = createTestApp();
    const res = await app.request("/api/admin/payment-config/check", {
      headers: await authHeader(),
    }, {
      ...TEST_ENV,
      CREDENTIALS_ENCRYPTION_KEY: "test-key",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      providers: Array<{ name: string; configured: boolean; supportsDirectFulfillment: boolean; issues: string[] }>;
      currencySupport: Array<{ currency: string; available: boolean; providers: string[] }>;
    };
    const easypay = body.providers.find((item) => item.name === "easypay");
    expect(easypay?.supportsDirectFulfillment).toBe(true);
    expect(easypay?.configured).toBe(true);
    expect(body.currencySupport.find((item) => item.currency === "cny")).toMatchObject({
      available: true,
      providers: ["easypay"],
    });
    const usdt = body.providers.find((item) => item.name === "usdt_trc20");
    expect(usdt).toBeUndefined();
    expect(body.currencySupport.find((item) => item.currency === "usdt")).toBeUndefined();
  });
});
