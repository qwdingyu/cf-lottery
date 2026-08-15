/**
 * 退款执行闭环测试（docs/131 §8，任务 1c）。
 *
 * 覆盖 refundPaymentOrder + POST /admin/payment-orders/:id/refund：
 * - 正常退款：paid 订单 → refunded，卡密 revoked，entry 释放、名额扣减
 * - 有其他有效订单时不释放 entry
 * - 有 redeemed 卡密时拒绝
 * - 非退款状态订单拒绝
 * - 幂等：已 refunded 订单再次退款拒绝
 * - 跨租户隔离：其它租户订单在本租户下退款 → 404
 * - provider 退款路径（注入 mock provider）：成功推进、调用抛错/失败不推进本地状态
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { clearTestData, getTestDb } from "../test-setup";
import { signJwt } from "../middleware/auth";
import {
  auditLogs,
  lotteryDraws,
  lotteryEntries,
  paymentOrders,
  paymentOrderAttempts,
  paymentOrderItems,
  prizeCodes,
  prizes,
  tenantMembers,
  tenants,
  users,
} from "../db/schema";
import { adminPaymentConfigRoute } from "./admin-payment-config";
import { refundPaymentOrder } from "../services/payment/payment-service";
import type { PaymentProvider } from "@usethink/cf-pay/catalog";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-admin-payment-refund-secret-0123456789";
const TENANT_ID = "tenant-admin-refund";
const OTHER_TENANT_ID = "tenant-admin-refund-other";
const OWNER_ID = "user-admin-refund-owner";
const VIEWER_ID = "user-admin-refund-viewer";
const DRAW_ID = "draw-admin-refund";
const ENTRY_ID = "entry-admin-refund";
const ORDER_ID = "order-admin-refund";
const PRIZE_ID = "prize-admin-refund";
const PRIZE_CODE_ID = "prize-code-admin-refund";

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
    { id: TENANT_ID, name: "Refund Tenant" },
    { id: OTHER_TENANT_ID, name: "Other Refund Tenant" },
  ]);
  await db.insert(users).values([
    { id: OWNER_ID, username: "refund_owner", email: "ro@example.com", emailVerified: 1, passwordHash: "hash" },
    { id: VIEWER_ID, username: "refund_viewer", email: "rv@example.com", emailVerified: 1, passwordHash: "hash" },
  ]);
  await db.insert(tenantMembers).values([
    { tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" },
    { tenantId: TENANT_ID, userId: VIEWER_ID, role: "viewer" },
  ]);
}

/** 构造一个已支付订单（含已发卡密 + 订单项 + attempt），entry 状态可自定义 */
async function seedPaidOrder(options: {
  entryPaymentStatus?: string;
  codeStatus?: string;
  codePaymentOrderId?: string | null;
  activeParticipantCount?: number;
  orderStatus?: string;
  quantity?: number;
} = {}) {
  const now = new Date().toISOString();
  const {
    entryPaymentStatus = "paid",
    codeStatus = "issued",
    codePaymentOrderId = ORDER_ID,
    activeParticipantCount = 1,
    orderStatus = "paid",
    quantity = 1,
  } = options;
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "admin-refund",
    title: "退款测试活动",
    status: "open",
    activeParticipantCount,
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
    paymentStatus: entryPaymentStatus,
  });
  await db.insert(prizes).values({
    id: PRIZE_ID,
    tenantId: TENANT_ID,
    name: "卡密",
    prizeType: "code",
  });
  await db.insert(paymentOrders).values({
    id: ORDER_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    entryId: ENTRY_ID,
    buyerIdentityType: "email",
    buyerIdentityValue: "buyer@example.com",
    buyerDisplayName: "buyer",
    quantity,
    unitPriceCents: 9900,
    pricingSnapshotJson: "{}",
    amountCents: 9900 * quantity,
    currency: "cny",
    status: orderStatus,
    provider: "alipay",
    providerTradeNo: "EP-REFUND-1",
    currentAttemptId: `${ORDER_ID}-attempt-1`,
    paidAt: now,
  });
  await db.insert(paymentOrderAttempts).values({
    id: `${ORDER_ID}-attempt-1`,
    paymentOrderId: ORDER_ID,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    attemptNo: 1,
    provider: "alipay",
    amountCents: 9900 * quantity,
    currency: "cny",
    status: "paid",
    providerTradeNo: "EP-REFUND-1",
    paidAt: now,
  });
  await db.insert(paymentOrderItems).values({
    id: `${ORDER_ID}-item-1`,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    paymentOrderId: ORDER_ID,
    lineNo: 1,
    itemType: "flash_sale",
    title: "卡密",
    quantity: 1,
    prizeCodeId: PRIZE_CODE_ID,
    amountCents: 9900,
    currency: "cny",
    pricingSnapshotJson: "{}",
    status: "fulfilled",
    unitPriceCents: 9900,
  });
  await db.insert(prizeCodes).values({
    id: PRIZE_CODE_ID,
    tenantId: TENANT_ID,
    prizeId: PRIZE_ID,
    code: "REFUND-CODE-1",
    secret: "SECRET-1",
    status: codeStatus,
    winnerId: ENTRY_ID,
    paymentOrderId: codePaymentOrderId,
    issuedAt: now,
  });
}

async function seedOtherTenantPaidOrder() {
  const now = new Date().toISOString();
  await db.insert(lotteryDraws).values({
    id: "draw-admin-refund-other",
    tenantId: OTHER_TENANT_ID,
    publicSlug: "admin-refund-other",
    title: "其它租户退款测试",
    status: "open",
    startAt: now,
    endAt: now,
  });
  await db.insert(lotteryEntries).values({
    id: "entry-admin-refund-other",
    tenantId: OTHER_TENANT_ID,
    drawId: "draw-admin-refund-other",
    identityType: "email",
    identityValue: "other@example.com",
    displayName: "other",
    paymentStatus: "paid",
  });
  await db.insert(paymentOrders).values({
    id: "order-admin-refund-other",
    tenantId: OTHER_TENANT_ID,
    drawId: "draw-admin-refund-other",
    entryId: "entry-admin-refund-other",
    buyerIdentityType: "email",
    buyerIdentityValue: "other@example.com",
    buyerDisplayName: "other",
    quantity: 1,
    unitPriceCents: 100,
    pricingSnapshotJson: "{}",
    amountCents: 100,
    currency: "cny",
    status: "paid",
    provider: "alipay",
    providerTradeNo: "EP-OTHER-1",
    paidAt: now,
  });
}

describe("POST /admin/payment-orders/:id/refund", () => {
  it("viewer 无退款权限（退款是资金敏感操作）", async () => {
    await seedMembers();
    await seedPaidOrder();
    const app = createTestApp();
    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(VIEWER_ID),
    }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("正常退款：订单→refunded，卡密→revoked（保留审计），明细→refunded，entry 释放、名额扣减", async () => {
    await seedMembers();
    await seedPaidOrder();
    const app = createTestApp();

    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("refunded");

    const [attempt] = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.id, `${ORDER_ID}-attempt-1`));
    expect(attempt?.status).toBe("refunded");

    const [item] = await db.select().from(paymentOrderItems).where(eq(paymentOrderItems.paymentOrderId, ORDER_ID));
    expect(item?.status).toBe("refunded");

    // 卡密 revoked：保留 winnerId/paymentOrderId 审计，不物理删除
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(code?.status).toBe("revoked");
    expect(code?.winnerId).toBe(ENTRY_ID);
    expect(code?.paymentOrderId).toBe(ORDER_ID);

    // entry 释放为 expired + 名额扣减（activeParticipantCount 1 → 0）
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(entry?.paymentStatus).toBe("expired");
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(draw?.activeParticipantCount).toBe(0);

    // 审计留痕
    const audits = await db.select().from(auditLogs).where(and(
      eq(auditLogs.tenantId, TENANT_ID),
      eq(auditLogs.action, "payment.order.refund"),
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(ORDER_ID);
  });

  it("有其他有效订单（PAID）时不释放 entry", async () => {
    await seedMembers();
    await seedPaidOrder();
    // 追加第二笔已支付订单：退款本订单后 entry 仍应有有效履约
    const now = new Date().toISOString();
    await db.insert(paymentOrders).values({
      id: `${ORDER_ID}-b`,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: ENTRY_ID,
      buyerIdentityType: "email",
      buyerIdentityValue: "buyer@example.com",
      buyerDisplayName: "buyer",
      quantity: 1,
      unitPriceCents: 9900,
      pricingSnapshotJson: "{}",
      amountCents: 9900,
      currency: "cny",
      status: "paid",
      provider: "alipay",
      providerTradeNo: "EP-REFUND-B",
      paidAt: now,
    });
    const app = createTestApp();

    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(entry?.paymentStatus).toBe("paid");

    // 名额不释放（activeParticipantCount 保持 1）
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(draw?.activeParticipantCount).toBe(1);
  });

  it("有其他有效订单（PENDING）时保持 entry 占位", async () => {
    await seedMembers();
    await seedPaidOrder();
    const now = new Date().toISOString();
    await db.insert(paymentOrders).values({
      id: `${ORDER_ID}-pending`,
      tenantId: TENANT_ID,
      drawId: DRAW_ID,
      entryId: ENTRY_ID,
      buyerIdentityType: "email",
      buyerIdentityValue: "buyer@example.com",
      buyerDisplayName: "buyer",
      quantity: 1,
      unitPriceCents: 9900,
      pricingSnapshotJson: "{}",
      amountCents: 9900,
      currency: "cny",
      status: "pending",
      provider: "alipay",
      createdAt: now,
    });
    const app = createTestApp();

    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    // entry 保持（不释放名额，仍有在途支付占位）
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, ENTRY_ID));
    expect(entry?.paymentStatus).toBe("paid");
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, DRAW_ID));
    expect(draw?.activeParticipantCount).toBe(1);
  });

  it("有 redeemed（已核销）卡密时拒绝退款并提示人工线下处理", async () => {
    await seedMembers();
    await seedPaidOrder({ codeStatus: "redeemed" });
    const app = createTestApp();

    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(res.status).toBe(409);
    const body = await res.json() as { message?: string };
    expect(body.message).toContain("已核销");
    expect(body.message).toContain("人工线下");

    // 状态未推进
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("paid");
  });

  it("非退款状态订单（expired）拒绝退款", async () => {
    await seedMembers();
    await seedPaidOrder({ orderStatus: "expired", codePaymentOrderId: null });
    const app = createTestApp();

    const res = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = await res.json() as { message?: string };
    expect(body.message).toContain("不允许退款");
  });

  it("幂等：已 refunded 订单再次退款拒绝，且不重复扣名额/写审计", async () => {
    await seedMembers();
    await seedPaidOrder();
    const app = createTestApp();

    const first = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(first.status).toBe(200);

    const second = await app.request(`/api/admin/payment-orders/${ORDER_ID}/refund`, {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(second.status).toBe(400);
    const body = await second.json() as { message?: string };
    expect(body.message).toContain("不允许退款");

    // 审计只写一次
    const audits = await db.select().from(auditLogs).where(and(
      eq(auditLogs.tenantId, TENANT_ID),
      eq(auditLogs.action, "payment.order.refund"),
    ));
    expect(audits).toHaveLength(1);
  });

  it("跨租户隔离：其它租户订单在本租户下退款返回 404", async () => {
    await seedMembers();
    await seedOtherTenantPaidOrder();
    const app = createTestApp();

    const res = await app.request("/api/admin/payment-orders/order-admin-refund-other/refund", {
      method: "POST",
      headers: await authHeader(),
    }, TEST_ENV);
    expect(res.status).toBe(404);
  });
});

describe("refundPaymentOrder provider 退款路径（注入 mock provider）", () => {
  it("provider.refund 成功时推进本地状态", async () => {
    await seedMembers();
    await seedPaidOrder();
    const refundSpy = vi.fn(async () => ({ success: true, status: "refunded", providerRefundNo: "R-1" }));
    const provider = {
      name: "mock",
      displayName: "mock",
      supportedCurrencies: ["cny"],
      createPayment: vi.fn(),
      verifyCallback: vi.fn(),
      refund: refundSpy,
    } as unknown as PaymentProvider;

    const result = await refundPaymentOrder(db, TENANT_ID, ORDER_ID, OWNER_ID, { provider });
    expect(result.ok).toBe(true);
    expect(refundSpy).toHaveBeenCalledWith({
      providerTradeNo: "EP-REFUND-1",
      refundCents: 9900,
      reason: "运营退款",
    });
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("refunded");
  });

  it("provider.refund 调用抛错时不推进本地状态", async () => {
    await seedMembers();
    await seedPaidOrder();
    const provider = {
      name: "mock",
      displayName: "mock",
      supportedCurrencies: ["cny"],
      createPayment: vi.fn(),
      verifyCallback: vi.fn(),
      refund: vi.fn(async () => { throw new Error("网关超时"); }),
    } as unknown as PaymentProvider;

    await expect(refundPaymentOrder(db, TENANT_ID, ORDER_ID, OWNER_ID, { provider })).rejects.toThrow("退款调用失败");
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("paid");
    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, PRIZE_CODE_ID));
    expect(code?.status).toBe("issued");
  });

  it("provider.refund 返回 success=false 时不推进本地状态", async () => {
    await seedMembers();
    await seedPaidOrder();
    const provider = {
      name: "mock",
      displayName: "mock",
      supportedCurrencies: ["cny"],
      createPayment: vi.fn(),
      verifyCallback: vi.fn(),
      refund: vi.fn(async () => ({ success: false, status: "rejected" })),
    } as unknown as PaymentProvider;

    await expect(refundPaymentOrder(db, TENANT_ID, ORDER_ID, OWNER_ID, { provider })).rejects.toThrow("退款被拒绝");
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, ORDER_ID));
    expect(order?.status).toBe("paid");
  });
});
