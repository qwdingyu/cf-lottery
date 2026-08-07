/**
 * 支付路由（秒杀卡密多租户直付，docs/131）
 *
 * 路由组织：
 * - /api/public/draws/:slug/payment/order — 创建/查询订单（公开，需参与）
 * - /api/payment/callback/:provider — 支付回调（支付平台调用，无鉴权）
 *
 * 照搬 cf-shop pay.ts 的回调处理模式（GET query / POST form → provider.verifyCallback → 发卡）。
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { getEnv } from "../lib/platform";
import { getDb, fail, ok } from "../lib/http";
import { lotteryDraws, lotteryEntries, paymentOrders } from "../db/schema";
import { loadTenantConfig, createTenantProvider, handlePaymentCallback, createPaymentOrder } from "../services/payment/payment-service";
import type { AppEnv } from "../bindings";

export const paymentPublicRoute = new Hono<AppEnv>();
export const paymentCallbackRoute = new Hono<AppEnv>();

// ═══════════════════════════════════════════════════════════════
// 公开：创建订单（参与成功后调用）
// ═══════════════════════════════════════════════════════════════
paymentPublicRoute.post("/draws/:slug/payment/order", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 解析 flashSale 配置（含 priceCents）
  const { parseFlashSaleConfig } = await import("../lib/flash-sale-config");
  const { config: flashSale } = parseFlashSaleConfig(draw.promotionConfig);
  if (!flashSale || !flashSale.priceCents || flashSale.priceCents <= 0) {
    return fail(c, "秒杀活动未配置价格", 400);
  }

  // 查找参与者 entry（通过 email 或 user_id）
  const body = await c.req.json<{ email?: string; entryId?: string }>().catch(() => ({})) as { email?: string; entryId?: string };
  const identityValue = body.email || "";
  if (!identityValue) return fail(c, "缺少参与者身份", 400);

  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityValue, identityValue),
    ))
    .limit(1);
  if (!entry) return fail(c, "未参与此活动", 400);

  // 检查是否已有订单（一参与一订单）
  const [existing] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.entryId, entry.id))
    .limit(1);
  if (existing) {
    return ok(c, { orderNo: existing.id, status: existing.status, entryId: existing.entryId });
  }

  // 加载租户支付配置
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  const config = await loadTenantConfig(db, entry.tenantId, encryptionKey);
  if (!config) return fail(c, "租户未配置支付方式", 400);

  const provider = createTenantProvider(config.env);
  if (!provider) return fail(c, "支付服务暂不可用", 500);

  const notifyUrl = `${c.req.url.replace(/\/draws\/.*/, "")}/payment/callback/${config.provider}`;
  const returnUrl = `${c.req.url.replace(/\/payment\/order.*/, "")}`;

  const { order, payResult } = await createPaymentOrder(db, {
    tenantId: draw.tenantId,
    drawId: draw.id,
    entryId: entry.id,
    amountCents: flashSale.priceCents,
    currency: flashSale.currency || "cny",
    provider: config.provider,
    notifyUrl,
    returnUrl,
    description: flashSale.title || draw.title || "秒杀",
  }, provider);

  return ok(c, {
    orderNo: order.id,
    status: order.status,
    amountCents: order.amountCents,
    currency: order.currency,
    redirectUrl: payResult.redirectUrl,
    qrCode: payResult.qrCode,
  });
});

// ═══════════════════════════════════════════════════════════════
// 公开：查询订单状态
// ═══════════════════════════════════════════════════════════════
paymentPublicRoute.get("/draws/:slug/payment/order", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const email = c.req.query("email") || "";

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, draw.id), eq(lotteryEntries.identityValue, email)))
    .limit(1);
  if (!entry) return ok(c, { order: null });

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.entryId, entry.id))
    .limit(1);
  if (!order) return ok(c, { order: null });

  // 查卡密信息（支付后才有）
  let codeInfo: { code?: string; secret?: string } | null = null;
  if (order.prizeCodeId) {
    const { prizeCodes } = await import("../db/schema");
    const [pc] = await db
      .select({ code: prizeCodes.code, secret: prizeCodes.secret })
      .from(prizeCodes)
      .where(eq(prizeCodes.id, order.prizeCodeId))
      .limit(1);
    if (pc) codeInfo = { code: pc.code, secret: pc.secret };
  }

  return ok(c, {
    order: {
      orderNo: order.id,
      status: order.status,
      amountCents: order.amountCents,
      currency: order.currency,
      provider: order.provider,
      paidAt: order.paidAt,
      prizeCode: codeInfo,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// 支付回调（照搬 cf-shop pay.ts 回调模式）
// ═══════════════════════════════════════════════════════════════
paymentCallbackRoute.all("/callback/:provider", async (c) => {
  const providerName = c.req.param("provider") || "";
  const db = getDb(c);

  // 解析回调参数（GET query / POST form → Record<string, string>）
  let params: Record<string, string>;
  try {
    if (c.req.method === "GET") {
      params = Object.fromEntries(
        Object.entries(c.req.queries()).map(([k, v]) => [k, v[0] || ""]),
      );
    } else {
      const bodyText = await c.req.text();
      params = Object.fromEntries(new URLSearchParams(bodyText).entries());
    }
  } catch {
    return c.text("invalid request", 400);
  }

  // 根据回调参数中的 orderNo 查订单，获取租户 ID
  const orderNo = params.orderNo || params.out_trade_no || "";
  if (!orderNo) return c.text("missing orderNo", 400);

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, orderNo))
    .limit(1);
  if (!order || order.provider !== providerName) return c.text("order not found", 404);

  // 加载租户支付配置（用于验签）
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  const config = await loadTenantConfig(db, order.tenantId, encryptionKey);
  if (!config) return c.text("tenant config not found", 500);

  const provider = createTenantProvider(config.env);
  if (!provider) return c.text("provider not available", 500);

  const result = await handlePaymentCallback(db, order.tenantId, provider, params);
  if (!result.processed) {
    return c.text(result.error || "fail", 400);
  }

  // 支付平台期望的响应格式：支付宝返回 success，Stripe 返回 200
  return c.text("success");
});