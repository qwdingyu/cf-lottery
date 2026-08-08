/**
 * 支付路由（秒杀卡密多租户直付，docs/131）
 *
 * 路由组织：
 * - /api/public/draws/:slug/payment-orders — 创建/恢复订单（公开，需参与）
 * - /api/public/draws/:slug/payment-orders/recover — OTP 保护的订单找回
 * - /api/public/draws/:slug/payment-orders/:id — Bearer 保护的订单状态/卡密查询
 * - /api/payments/:tenantId/:provider/callback — 支付回调（支付平台调用，无鉴权）
 *
 * 回调处理模式：GET query / POST form → provider.verifyCallback → 发卡。
 */
import { Hono } from "hono";
import { eq, and, desc, inArray } from "drizzle-orm";
import type { CreatePaymentResult } from "@usethink/cf-core/features/payment";
import { getClientIp, getEnv } from "../lib/platform";
import { getDb, fail, ok, isValidEmail } from "../lib/http";
import { lotteryDraws, lotteryEntries, paymentOrders, paymentOrderAttempts, prizeCodes, prizes, systemConfig } from "../db/schema";
import { checkPublicIdentityRateLimit, checkPublicRateLimit, verifyEmailAccessCode } from "./public-lottery-helpers";
import {
  loadTenantConfig,
  createTenantProvider,
  handlePaymentCallback,
  createPaymentOrder,
  expireOverdueOrders,
  retryPaymentOrder,
  issuePaymentOrderAccessToken,
  findPaymentOrderByAccessToken,
  resumePendingPaymentOrder,
} from "../services/payment/payment-service";
import {
  isRetryablePaymentOrderStatus,
  PAYMENT_ENTRY_STATUS,
  PAYMENT_ORDER_STATUS,
} from "../services/payment/payment-status";
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

function safeHttpOrigin(value: unknown): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/**
 * 支付网关回调和用户回跳地址必须来自服务端配置的 APP_ORIGIN。
 * 只有未配置时才回退到当前请求 origin，避免 Host 头被伪造后把网关通知
 * 指向攻击者域名。活动页仍保留 slug 路径，支付完成后能回到原活动。
 */
export function buildPaymentRequestUrl(requestUrl: string, appOrigin: string | undefined, slug: string): string {
  const configuredOrigin = String(appOrigin || "").trim();
  const origin = configuredOrigin
    ? safeHttpOrigin(configuredOrigin)
    : new URL(requestUrl).origin;
  if (!origin) throw new Error("APP_ORIGIN 必须是 http/https 地址");
  return `${origin}/api/public/draws/${encodeURIComponent(slug)}/payment-orders`;
}

function safePaymentRedirectUrl(value: unknown): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
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
    !isRetryablePaymentOrderStatus(existing.status) &&
    existing.status !== PAYMENT_ORDER_STATUS.PENDING
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

  // 活动关闭后不允许凭旧 entry 新建或重试订单；暂停期间仍允许恢复已经
  // 发起的 pending 支付，避免用户已经付款途中因运营暂停活动而失去合法支付入口。
  if (!existing && draw.status !== "open") {
    return fail(c, "活动当前不可创建支付订单", 409);
  }
  if (
    existing?.status === PAYMENT_ORDER_STATUS.PENDING &&
    draw.status !== "open" &&
    draw.status !== "paused"
  ) {
    return fail(c, "活动已关闭，不能继续支付", 409);
  }
  if (existing && isRetryablePaymentOrderStatus(existing.status) && draw.status !== "open") {
    return fail(c, "活动已关闭，不能重新创建支付订单", 409);
  }
  if (existing?.status === PAYMENT_ORDER_STATUS.PENDING && entry.paymentStatus !== PAYMENT_ENTRY_STATUS.PENDING) {
    return fail(c, "订单与参与记录状态不一致，请联系客服处理", 409);
  }
  if (!existing && entry.paymentStatus !== PAYMENT_ENTRY_STATUS.RESERVED) {
    return fail(c, "参与预约已失效，请重新参与", 409);
  }

  // 加载租户支付配置
  const encryptionKey = getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "";
  // 订单金额是用户当次购买事实，重试不能因为运营修改活动配置而悄悄改变价格。
  // 活动发布后当前路由禁止编辑配置；这里仍以订单快照兜底，防止历史数据或后台修复
  // 造成金额漂移。
  const currency = existing?.currency || flashSale.currency || "cny";
  const amountCents = existing?.amountCents ?? flashSale.priceCents;
  const resumingPending = existing?.status === PAYMENT_ORDER_STATUS.PENDING;
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

  const retryable = existing != null && isRetryablePaymentOrderStatus(existing.status);
  const paymentRequestUrl = buildPaymentRequestUrl(c.req.url, getEnv(c, "APP_ORIGIN"), slug);
  const notifyUrl = buildPaymentCallbackUrl(paymentRequestUrl, draw.tenantId, config.provider);
  const returnUrl = buildPaymentReturnUrl(paymentRequestUrl);

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
      const resumed = await resumePendingPaymentOrder(
        db,
        {
          tenantId: draw.tenantId,
          drawId: draw.id,
          entryId: existing.entryId,
          amountCents: existing.amountCents,
          currency: existing.currency,
          provider: existing.provider as "easypay" | "stripe" | "alipay",
          notifyUrl,
          returnUrl,
          description: flashSale.title || draw.title || "秒杀",
        },
        provider,
        existing.id,
        attempt.id,
      );
      payResult = resumed.payResult;
    } catch {
      return fail(c, "支付入口生成失败，请稍后重试", 502);
    }
    return ok(c, {
      orderNo: existing.id,
      status: existing.status,
      entryId: existing.entryId,
      amountCents: existing.amountCents,
      currency: existing.currency,
      provider: existing.provider,
      accessToken,
      redirectUrl: safePaymentRedirectUrl(payResult.redirectUrl),
      qrCode: payResult.qrCode,
    });
  }

  const orderInput = {
    tenantId: draw.tenantId,
    drawId: draw.id,
    entryId: entry.id,
    amountCents,
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
    redirectUrl: safePaymentRedirectUrl(payResult.redirectUrl),
    qrCode: payResult.qrCode,
  });
});

/**
 * 公开：OTP 保护的支付订单找回。
 *
 * 旧的 `GET .../payment-orders?email=` 只凭裸邮箱返回订单列表，既没有证明邮箱
 * 控制权，也无法直接完成卡密查询。找回必须复用 my-result 的邮箱 OTP 身份证明；
 * 本接口只返回已验证邮箱在当前活动中的订单摘要和已发卡密，不接受跨活动/跨租户查询。
 */
paymentPublicRoute.post("/draws/:slug/payment-orders/recover", async (c) => {
  const db = getDb(c);
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `payment-recover:${ip}`, 10, 60000))) {
    return fail(c, "支付订单找回过于频繁，请稍后再试", 429);
  }

  const slug = c.req.param("slug");
  const body = await c.req.json<{ email?: string; code?: string }>().catch(
    () => ({} as { email?: string; code?: string }),
  );
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();
  if (!isValidEmail(email)) return fail(c, "请输入有效的邮箱地址", 400);
  if (!/^\d{6}$/.test(code)) return fail(c, "请输入 6 位验证码", 400);

  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      promotionConfig: lotteryDraws.promotionConfig,
    })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const { parseFlashSaleConfig } = await import("../lib/flash-sale-config");
  const flashSale = parseFlashSaleConfig(draw.promotionConfig).config;
  if (!flashSale?.paymentRequired) {
    return fail(c, "该活动未启用直付支付", 400);
  }
  if (!(await checkPublicIdentityRateLimit(db, "payment-recover", draw.id, email, 10, 60000))) {
    return fail(c, "支付订单找回过于频繁，请稍后再试", 429);
  }

  // 查询 OTP 只证明邮箱控制权，不核销验证码；与 my-result 保持同一查询语义。
  // 已支付订单在本接口内直接返回卡密，待支付订单仍必须走订单 Bearer 查询链路。
  const validCode = await verifyEmailAccessCode(db, email, draw.id, code);
  if (!validCode) return fail(c, "验证码无效或已过期", 400);

  const entries = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityType, "email"),
      eq(lotteryEntries.identityValue, email),
    ));
  if (entries.length === 0) return ok(c, { orders: [] });

  const rows = await db
    .select({
      orderNo: paymentOrders.id,
      entryId: paymentOrders.entryId,
      status: paymentOrders.status,
      amountCents: paymentOrders.amountCents,
      currency: paymentOrders.currency,
      provider: paymentOrders.provider,
      paidAt: paymentOrders.paidAt,
      prizeCodeId: paymentOrders.prizeCodeId,
    })
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.tenantId, draw.tenantId),
      eq(paymentOrders.drawId, draw.id),
      inArray(paymentOrders.entryId, entries.map((entry) => entry.id)),
    ))
    .orderBy(desc(paymentOrders.createdAt))
    .limit(10);

  const codeIds = rows.map((row) => row.prizeCodeId).filter(Boolean) as string[];
  const codeRows = codeIds.length > 0
    ? await db
      .select({
        id: prizeCodes.id,
        code: prizeCodes.code,
        secret: prizeCodes.secret,
      })
      .from(prizeCodes)
      .where(and(
        eq(prizeCodes.tenantId, draw.tenantId),
        inArray(prizeCodes.id, codeIds),
      ))
    : [];
  const codeById = new Map(codeRows.map((row) => [row.id, { code: row.code, secret: row.secret }]));

  return ok(c, {
    orders: rows.map((row) => ({
      orderNo: row.orderNo,
      entryId: row.entryId,
      status: row.status,
      amountCents: row.amountCents,
      currency: row.currency,
      provider: row.provider,
      paidAt: row.paidAt,
      prizeCode: row.prizeCodeId ? codeById.get(row.prizeCodeId) || null : null,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════
// 公开：查询单个订单状态 docs/131 §10(get by orderId)
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
  // 回调渠道属于具体 attempt，而不是逻辑订单当前选中的 provider。
  // 重试允许切换主渠道；若仍检查 payment_orders.provider，旧渠道迟到回调会在进入
  // 状态机前被 404，无法落库为 paid_late_needs_refund。
  if (!order || attempt.provider !== providerName) return c.text("order not found", 404);
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

  // 支付成功后异步发送中奖邮件（不阻塞回调响应）——受 L3 系统配置 notify_winner_email_enabled 控制。
  const notifyWinnerEnabled = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, "notify_winner_email_enabled"))
    .limit(1)
    .then((r) => r[0]?.value !== "false")
    .catch(() => true); // 默认开启
  if (
    result.order?.prizeCodeId &&
    result.order.status === PAYMENT_ORDER_STATUS.PAID &&
    notifyWinnerEnabled
  ) {
    void (async () => {
      const [winner] = await db
        .select({
          email: lotteryEntries.identityValue,
          identityType: lotteryEntries.identityType,
        })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, order.entryId))
        .limit(1);
      if (!winner || winner.identityType !== "email") return;

      // 查活动标题（用于邮件中 drawName，避免展示 UUID）
      const [drawInfo] = await db
        .select({ title: lotteryDraws.title })
        .from(lotteryDraws)
        .where(eq(lotteryDraws.id, order.drawId))
        .limit(1);

      // 查卡密信息（同时取 code 和 secret，分别用于展示账号和交付密钥）
      const [codeInfo] = order.prizeCodeId
        ? await db
          .select({ code: prizeCodes.code, secret: prizeCodes.secret, prizeId: prizeCodes.prizeId })
          .from(prizeCodes)
          .where(eq(prizeCodes.id, order.prizeCodeId))
          .limit(1)
        : [];

      // 查奖品名称（productName 应为奖品名，而非卡密值）
      const productName = codeInfo?.prizeId
        ? await db
          .select({ name: prizes.name })
          .from(prizes)
          .where(eq(prizes.id, codeInfo.prizeId))
          .limit(1)
          .then((rows) => rows[0]?.name || "奖品")
        : "奖品";

      const { sendEmail, buildLotteryWinnerTemplateData } = await import("../services/email-service");
      await sendEmail({
        cfAuthIssuer: getEnv(c, "CF_AUTH_ISSUER") || "",
        cfAuthClientId: getEnv(c, "CF_AUTH_CLIENT_ID") || "",
        cfAuthClientSecret: getEnv(c, "CF_AUTH_CLIENT_SECRET") || "",
      }, {
        to: winner.email,
        template: "lottery_winner",
        templateData: buildLotteryWinnerTemplateData({
          drawName: drawInfo?.title || "活动",
          productName,
          orderNo: order.id,
          accountLabel: codeInfo?.code || "",
          deliverySecret: codeInfo?.secret || "",
          deliveryNote: "支付已完成，卡密已发放。如有疑问请联系主办方。",
        }),
      });
    })().catch((err) => {
      console.error(`[payment] 中奖邮件发送失败 for order ${order.id}:`, err);
    });
  }

  // 支付平台期望的响应格式：支付宝返回 success，Stripe 返回 200
  return c.text("success");
});
