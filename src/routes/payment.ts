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
import { eq, and, sql } from "drizzle-orm";
import type { CreatePaymentResult } from "@usethink/cf-core/features/payment";
import { getEnv } from "../lib/platform";
import { getDb, fail, ok } from "../lib/http";
import { lotteryDraws, lotteryEntries, paymentOrders } from "../db/schema";
import {
  loadTenantConfig,
  createTenantProvider,
  handlePaymentCallback,
  createPaymentOrder,
  retryPaymentOrder,
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

  // 查找参与者 entry（通过 entryId，docs/131 §10；支持 open/registered 所有身份类型）
  const body = await c.req.json<{ entryId?: string }>().catch(() => ({} as { entryId?: string }));
  const entryId = String(body.entryId || "").trim();
  if (!entryId) return fail(c, "缺少 entryId", 400);

  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.id, entryId),
    ))
    .limit(1);
  if (!entry) return fail(c, "参与记录不存在", 404);
  if (entry.tenantId !== draw.tenantId) return fail(c, "参与记录不属于此活动", 403);
  if (entry.identityType !== "email") {
    return fail(c, "直付卡密仅支持 email 身份参与", 400);
  }

  // 检查是否已有订单（一参与一订单）
  const [existing] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.entryId, entry.id))
    .limit(1);
  if (
    existing &&
    existing.status !== "cancelled" &&
    existing.status !== "expired" &&
    existing.status !== "pending"
  ) {
    return ok(c, {
      orderNo: existing.id,
      status: existing.status,
      entryId: existing.entryId,
      amountCents: existing.amountCents,
      currency: existing.currency,
      provider: existing.provider,
    });
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
      ? { provider: existing.provider, requireDirectFulfillment: true }
      : { currency, requireDirectFulfillment: true },
  );
  if (!config) return fail(c, "租户未配置可自动发卡的支付方式", 400);

  const provider = createTenantProvider(config.env, resumingPending ? existing.currency : currency);
  if (!provider) return fail(c, "支付服务暂不可用", 500);

  const retryable = existing?.status === "cancelled" || existing?.status === "expired";
  const notifyUrl = buildPaymentCallbackUrl(c.req.url, draw.tenantId, config.provider);
  const returnUrl = buildPaymentReturnUrl(c.req.url);

  if (resumingPending) {
    // 已有 pending 订单不新增 DB 行；只用同一 orderNo 重新生成支付入口，解决刷新后丢失支付链接/二维码。
    let payResult: CreatePaymentResult;
    try {
      payResult = await provider.createPayment({
        orderNo: existing.id,
        amountCents: existing.amountCents,
        currency: existing.currency,
        notifyUrl,
        returnUrl,
        description: flashSale.title || draw.title || "秒杀",
      });
    } catch {
      return fail(c, "支付入口生成失败，请稍后重试", 502);
    }
    if (payResult.providerTradeNo) {
      await db
        .update(paymentOrders)
        .set({ providerTradeNo: payResult.providerTradeNo, updatedAt: sql`(datetime('now'))` })
        .where(eq(paymentOrders.id, existing.id));
    }
    return ok(c, {
      orderNo: existing.id,
      status: existing.status,
      entryId: existing.entryId,
      amountCents: existing.amountCents,
      currency: existing.currency,
      provider: existing.provider,
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
  try {
    const created = retryable
      ? await retryPaymentOrder(db, orderInput, provider)
      : await createPaymentOrder(db, orderInput, provider);
    order = created.order;
    payResult = created.payResult;
  } catch {
    return fail(c, "支付下单失败，请稍后重试", 502);
  }

  return ok(c, {
    orderNo: order.id,
    status: order.status,
    amountCents: order.amountCents,
    currency: order.currency,
    provider: order.provider,
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
  const email = (c.req.query("email") || "").trim().toLowerCase();

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 用 orderId 查订单；验证 email 与订单关联的 entry 匹配（docs/131 §11 卡密防泄露）
  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, orderId))
    .limit(1);
  if (!order) return ok(c, { order: null });

  // 验证订单属于该活动，且 email 是订单关联的参与身份
  if (order.drawId !== draw.id) return fail(c, "订单不属于此活动", 404);
  if (!email) {
    return fail(c, "缺少 email", 400);
  }
  const [entry] = await db
    .select({ identityValue: lotteryEntries.identityValue })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, order.entryId),
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
    ))
    .limit(1);
  if (!entry || entry.identityValue !== email) {
    return fail(c, "无权查看该订单", 403);
  }

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

  // 根据回调参数中的 orderNo 查订单，获取租户 ID
  const orderNo = params.orderNo || params.out_trade_no || "";
  if (!orderNo) return c.text("missing orderNo", 400);

  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, orderNo))
    .limit(1);
  if (!order || order.provider !== providerName) return c.text("order not found", 404);
  // 路径 tenantId 必须与订单租户一致（防跨租户串单，docs/131 §11）
  if (order.tenantId !== pathTenantId) return c.text("tenant mismatch", 403);

  // 加载租户支付配置（用于验签）
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  const config = await loadTenantConfig(db, order.tenantId, encryptionKey, { provider: providerName });
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
