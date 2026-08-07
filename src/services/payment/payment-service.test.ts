import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../../test-setup";
import type { DbType } from "../../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  paymentOrders,
  tenantConfigs,
  tenants,
} from "../../db/schema";
import type { PaymentProvider } from "@usethink/cf-core/features/payment";
import { createTenantProvider, loadTenantConfig, retryPaymentOrder } from "./payment-service";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const TENANT_ID = "tenant-payment-service";
const DRAW_ID = "draw-payment-service";
const ENTRY_ID = "entry-payment-service";
const ORDER_ID = "order-payment-service";

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
    paymentStatus: "",
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
        amountCents: 9900,
        currency: "cny",
        provider: "alipay",
        notifyUrl: "https://example.com/payments/callback",
        returnUrl: "https://example.com/result",
        description: "秒杀卡密",
      },
      providerMock,
    );

    expect(providerMock.createPayment).toHaveBeenCalledTimes(1);
    expect(providerMock.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      orderNo: ORDER_ID,
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
    expect(order?.prizeCodeId).toBeNull();
    expect(entry?.paymentStatus).toBe("pending");
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
    expect(entry?.paymentStatus).toBe("");
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
          alipay_private_key: "private",
          alipay_public_key: "public",
        },
        usdt_trc20: {
          enabled: true,
          trc20_wallet_address: "TWallet",
          trongrid_api_key: "key",
        },
      }),
    });

    await expect(loadTenantConfig(db, TENANT_ID, "", { currency: "cny" }))
      .resolves.toMatchObject({ provider: "alipay" });
    await expect(loadTenantConfig(db, TENANT_ID, "", { currency: "usdt" }))
      .resolves.toMatchObject({ provider: "usdt_trc20" });
    await expect(loadTenantConfig(db, TENANT_ID, "", { provider: "alipay" }))
      .resolves.toMatchObject({ provider: "alipay" });
    await expect(loadTenantConfig(db, TENANT_ID, "", { provider: "stripe" }))
      .resolves.toBeNull();
  });

  it("createTenantProvider honours currency filtering from cf-core registry", () => {
    const env = {
      TRC20_WALLET_ADDRESS: "TWallet",
      TRONGRID_API_KEY: "key",
    };
    expect(createTenantProvider(env, "usdt")?.name).toBe("usdt_trc20");
    expect(createTenantProvider(env, "cny")).toBeNull();
  });
});
