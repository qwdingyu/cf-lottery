/**
 * 支付路由（秒杀卡密多租户直付，docs/131）
 *
 * 路由组织：
 * - /api/public/draws/:slug/payment-orders — 创建/查询订单（公开，需参与）
 * - /api/payments/:tenantId/:provider/callback — 支付回调（支付平台调用，无鉴权）
 *
 * 回调处理模式：GET query / POST form → provider.verifyCallback → 发卡。
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { CreatePaymentResult } from "@usethink/cf-core/features/payment";
import { getClientIp, getEnv } from "../lib/platform";
import { getDb, fail, ok, isValidEmail } from "../lib/http";
import { lotteryDraws, lotteryEntries, paymentOrders, paymentOrderAttempts } from "../db/schema";
import { checkPublicRateLimit } from "./public-lottery-helpers";
import {
  loadTenantConfig,
  createTenantProvider,
  handlePaymentCallback,
  createPaymentOrder,
  expireOverdueOrders,
  retryPaymentOrder,
  issuePaymentOrderAccessToken,
  findPaymentOrderByAccessToken,
  persistProviderTradeNo,
} from "../services/payment/payment-service";
import type { AppEnv } from "../bindings";

export const paymentPublicRoute = new Hono<AppEnv>();
export const paymentCallbackRoute = new Hono<AppEnv>();

export function buildPaymentCallbackUrl(requestUrl: string, tenantId: string, provider: string): string {
  const url = new URL(requestUrl);
  url.pathname = `/api/payments/${tenantId}/${provider}/callback`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildPaymentReturnUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.pathname = url.pathname.replace(/\/payment-orders$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

// ═══════════════════════════════════════════════════════════════
// 公开：创建订单（参与成功后调用）docs/131 §10
// ═══════════════════════════════════════════════════════════════
paymentPublicRoute.post("/draws/:slug/payment-orders", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `payment-create:${ip}`, 20, 60000))) {
    return fail(c, "支付请求过于频繁，请稍后再试", 429);
  }

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 解析 flashSale 配置（含 priceCents）
  const { parseFlashSaleConfig } = await import("../lib/flash-sale-config");
  const { config: flashSale } = parseFlashSaleConfig(draw.promotionConfig);
  if (!flashSale?.paymentRequired) {
    return fail(c, "秒杀活动未启用直付支付", 400);
  }
  if (!flashSale || !flashSale.priceCents || flashSale.priceCents <= 0) {
    return fail(c, "秒杀活动未配置价格", 400);
  }

  // 先懒清理本租户超时订单，避免 stale pending 被重新生成支付入口。
  await expireOverdueOrders(db, draw.tenantId);

  // 查找参与者 entry（通过 entryId，docs/131 §10；邮箱必须与 entry 身份一致）
  const body = await c.req.json<{ entryId?: string; email?: string }>().catch(() => ({} as { entryId?: string; email?: string }));
  const entryId = String(body.entryId || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  if (!entryId) return fail(c, "缺少 entryId", 400);
  if (!isValidEmail(email)) return fail(c, "缺少或无效的 email", 400);

  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.id, entryId),
    ))
    .limit(1);
  if (!entry) return fail(c, "参与记录不存在", 404);
  if (entry.identityType !== "email") {
    return fail(c, "直付卡密仅支持 email 身份参与", 400);
  }
  if (entry.identityValue.trim().toLowerCase() !== email) {
    return fail(c, "支付请求与参与身份不匹配", 403);
  }

  // 检查是否已有订单（一参与一订单）
  const [existing] = await db
    .select()
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.tenantId, draw.tenantId),
      eq(paymentOrders.drawId, draw.id),
      eq(paymentOrders.entryId, entry.id),
    ))
    .limit(1);
  if (
    existing &&
    existing.status !== "cancelled" &&
    existing.status !== "expired" &&
    existing.status !== "pending"
  ) {
    const accessToken = await issuePaymentOrderAccessToken(db, draw.tenantId, existing.id, existing.entryId);
    return ok(c, {
      orderNo: existing.id,
      status: existing.status,
      entryId: existing.entryId,
      amountCents: existing.amountCents,
      currency: existing.currency,
      provider: existing.provider,
      accessToken,
    });
  }

  // 活动关闭后不允许凭旧 entry 新建或重试订单；已有 pending 订单仍允许恢复支付，
  // 避免用户已经付款途中因运营暂停活动而失去合法支付入口。
  if (!existing && draw.status !== "open") {
    return fail(c, "活动当前不可创建支付订单", 409);
  }
  if ((existing?.status === "cancelled" || existing?.status === "expired") && draw.status !== "open") {
    return fail(c, "活动已关闭，不能重新创建支付订单", 409);
  }
  if (existing?.status === "pending" && entry.paymentStatus !== "pending") {
    return fail(c, "订单与参与记录状态不一致，请联系客服处理", 409);
  }

  // 加载租户支付配置
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  const currency = flashSale.currency || "cny";
  const resumingPending = existing?.status === "pending";
  const config = await loadTenantConfig(
    db,
    entry.tenantId,
    encryptionKey,
    resumingPending
      ? { provider: existing.provider, requireDirectFulfillment: true, allowDisabled: true }
      : { currency, requireDirectFulfillment: true },
  );
  if (!config) return fail(c, "租户未配置可自动发卡的支付方式", 400);

  const provider = createTenantProvider(config.env, resumingPending ? existing.currency : currency);
  if (!provider) return fail(c, "支付服务暂不可用", 500);

  const retryable = existing?.status === "cancelled" || existing?.status === "expired";
  const notifyUrl = buildPaymentCallbackUrl(c.req.url, draw.tenantId, config.provider);
  const returnUrl = buildPaymentReturnUrl(c.req.url);

  if (resumingPending) {
    // 已有 pending 订单不新增逻辑订单；只用当前 attempt 重新生成支付入口。
    const [attempt] = await db
      .select()
      .from(paymentOrderAttempts)
      .where(and(
        eq(paymentOrderAttempts.id, existing.currentAttemptId || ""),
        eq(paymentOrderAttempts.paymentOrderId, existing.id),
        eq(paymentOrderAttempts.status, "pending"),
      ))
      .limit(1);
    if (!attempt) return fail(c, "订单支付尝试已失效，请联系客服处理", 409);
    const accessToken = await issuePaymentOrderAccessToken(db, draw.tenantId, existing.id, existing.entryId);
    let payResult: CreatePaymentResult;
    try {
      payResult = await provider.createPayment({
        orderNo: attempt.id,
        amountCents: existing.amountCents,
        currency: existing.currency,
        notifyUrl,
        returnUrl,
        description: flashSale.title || draw.title || "秒杀",
      });
    } catch {
      return fail(c, "支付入口生成失败，请稍后重试", 502);
    }
    await persistProviderTradeNo(db, existing.id, attempt.id, payResult);
    return ok(c, {
      orderNo: existing.id,
      status: existing.status,
      entryId: existing.entryId,
      amountCents: existing.amountCents,
      currency: existing.currency,
      provider: existing.provider,
      accessToken,
      redirectUrl: payResult.redirectUrl,
      qrCode: payResult.qrCode,
    });
  }

  const orderInput = {
    tenantId: draw.tenantId,
    drawId: draw.id,
    entryId: entry.id,
    amountCents: flashSale.priceCents,
    currency,
    provider: config.provider,
    notifyUrl,
    returnUrl,
    description: flashSale.title || draw.title || "秒杀",
  };

  let order: typeof paymentOrders.$inferSelect;
  let payResult: CreatePaymentResult;
  let accessToken = "";
  try {
    const created = retryable
      ? await retryPaymentOrder(db, orderInput, provider)
      : await createPaymentOrder(db, orderInput, provider);
    order = created.order;
    payResult = created.payResult;
    accessToken = created.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("名额")) {
      return fail(c, message, 409);
    }
    return fail(c, "支付下单失败，请稍后重试", 502);
  }

  return ok(c, {
    orderNo: order.id,
    status: order.status,
    amountCents: order.amountCents,
    currency: order.currency,
    provider: order.provider,
    accessToken,
    redirectUrl: payResult.redirectUrl,
    qrCode: payResult.qrCode,
  });
});

// ═══════════════════════════════════════════════════════════════
// 公开：查询订单状态 docs/131 §10
// ═══════════════════════════════════════════════════════════════
paymentPublicRoute.get("/draws/:slug/payment-orders/:orderId", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const orderId = c.req.param("orderId");
  const authorization = c.req.header("Authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `payment-query:${ip}`, 30, 60000))) {
    return fail(c, "支付查询过于频繁，请稍后再试", 429);
  }

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 卡密查询只接受创建订单时签发的短期 Bearer 令牌，避免 orderId+email 组合泄露密钥。
  const order = await findPaymentOrderByAccessToken(db, draw.tenantId, draw.id, orderId, accessToken);
  if (!order) return fail(c, "订单不存在或访问已失效", 404);

  // 查卡密信息（支付后才有）
  let codeInfo: { code?: string; secret?: string } | null = null;
  if (order.prizeCodeId) {
    const { prizeCodes } = await import("../db/schema");
    const [pc] = await db
      .select({ code: prizeCodes.code, secret: prizeCodes.secret })
      .from(prizeCodes)
      .where(and(
        eq(prizeCodes.id, order.prizeCodeId),
        eq(prizeCodes.tenantId, draw.tenantId),
      ))
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
// 支付回调（docs/131 §10：/api/payments/:tenantId/:provider/callback）
// ═══════════════════════════════════════════════════════════════
paymentCallbackRoute.all("/:tenantId/:provider/callback", async (c) => {
  const providerName = c.req.param("provider") || "";
  const pathTenantId = c.req.param("tenantId") || "";
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
      if (providerName === "stripe") {
        let orderNo = "";
        try {
          const event = JSON.parse(bodyText) as {
            data?: { object?: { metadata?: Record<string, string> } };
          };
          orderNo = event.data?.object?.metadata?.order_no || event.data?.object?.metadata?.orderNo || "";
        } catch {
          orderNo = "";
        }
        params = {
          _raw_body: bodyText,
          _stripe_signature: c.req.header("stripe-signature") || "",
          orderNo,
        };
      } else {
        params = Object.fromEntries(new URLSearchParams(bodyText).entries());
      }
    }
  } catch {
    return c.text("invalid request", 400);
  }

  // 根据回调参数中的 orderNo 查支付尝试，再获取逻辑订单和租户。
  const orderNo = params.orderNo || params.out_trade_no || "";
  if (!orderNo) return c.text("missing orderNo", 400);

  const [attempt] = await db
    .select()
    .from(paymentOrderAttempts)
    .where(eq(paymentOrderAttempts.id, orderNo))
    .limit(1);
  if (!attempt) return c.text("order not found", 404);
  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.id, attempt.paymentOrderId),
      eq(paymentOrders.tenantId, pathTenantId),
    ))
    .limit(1);
  if (!order || order.provider !== providerName) return c.text("order not found", 404);
  // 路径 tenantId 必须与订单租户一致（防跨租户串单，docs/131 §11）
  if (order.tenantId !== pathTenantId) return c.text("tenant mismatch", 403);

  // 加载租户支付配置（用于验签）
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  const config = await loadTenantConfig(db, order.tenantId, encryptionKey, {
    provider: providerName,
    allowDisabled: true,
  });
  if (!config) return c.text("tenant config not found", 500);

  const provider = createTenantProvider(config.env, order.currency);
  if (!provider) return c.text("provider not available", 500);

  const result = await handlePaymentCallback(db, order.tenantId, provider, params);
  if (!result.processed) {
    return c.text(result.error || "fail", 400);
  }

  // 支付平台期望的响应格式：支付宝返回 success，Stripe 返回 200
  return c.text("success");
});
