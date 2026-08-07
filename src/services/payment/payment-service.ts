/**
 * 支付服务（秒杀卡密多租户直付，docs/131）
 *
 * 职责：
 * - 按租户加载/解密支付配置（tenant_configs.providers JSON，多租户隔离）
 * - 创建订单（payment_orders，entryId UNIQUE 一参与一订单）
 * - 调用 cf-core Provider 创建支付（易支付/支付宝/Stripe）
 * - 支付回调验签 + 幂等 + 发卡密（prizeCodes available → issued 原子取卡）
 *
 * 复用 @usethink/cf-core/features/payment（Provider 抽象已在共享库）。
 */
import { createProviderRegistry } from "@usethink/cf-core/features/payment";
import type { CallbackResult, PaymentProvider, CreatePaymentResult } from "@usethink/cf-core/features/payment";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import {
  tenantConfigs,
  paymentOrders,
  prizeCodes,
  lotteryPrizeTiers,
  prizes,
  lotteryEntries,
  lotteryDraws,
} from "../../db/schema";
import { PAYMENT_PROVIDER_CATALOG, isValidProviderName } from "./catalog";
import { parseFlashSaleConfig, resolveEffectiveStockLimit } from "../../lib/flash-sale-config";

export type PaymentProviderName = "easypay" | "stripe" | "alipay";
const RETRYABLE_PAYMENT_ORDER_STATUSES = new Set(["cancelled", "expired"]);

/** 订单超时时间(分钟)：超过此时间未支付的 pending 订单标记 expired（docs/131 §8） */
const ORDER_EXPIRE_MINUTES = 30;

/** 懒清理：标记超过 30 分钟未支付的 pending 订单为 expired，并释放关联 entry 名额（docs/131 §8）。 */
export async function expireOverdueOrders(db: DbType, tenantId: string): Promise<number> {
  const cutoff = sql`datetime('now', '-' || ${ORDER_EXPIRE_MINUTES} || ' minutes')`;
  return withDbTransaction(db, async (tx) => {
    // 订单和 entry 必须在同一事务中软释放，否则回调或并发参与可能看到半完成状态。
    const overdue = await tx
      .select({ id: paymentOrders.id, entryId: paymentOrders.entryId })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, tenantId),
        eq(paymentOrders.status, "pending"),
        sql`${paymentOrders.createdAt} < ${cutoff}`,
      ));
    if (overdue.length === 0) return 0;

    await tx
      .update(paymentOrders)
      .set({ status: "expired", updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrders.tenantId, tenantId),
        eq(paymentOrders.status, "pending"),
        sql`${paymentOrders.createdAt} < ${cutoff}`,
      ));

    const entryIds = overdue.map((o) => o.entryId).filter(Boolean);
    if (entryIds.length > 0) {
      await tx
        .update(lotteryEntries)
        .set({ paymentStatus: "expired" })
        .where(and(
          eq(lotteryEntries.tenantId, tenantId),
          inArray(lotteryEntries.id, entryIds),
          eq(lotteryEntries.paymentStatus, "pending"),
        ));
    }

    return overdue.length;
  });
}

async function cancelPaymentOrder(db: DbType, orderId: string, entryId: string): Promise<void> {
  await withDbTransaction(db, async (tx) => {
    // 只有仍处于 pending 的订单才允许因网关创建失败而取消。
    // 如果回调已经把订单置为 paid，不能被迟到的下单异常覆盖。
    const cancelled = await tx
      .update(paymentOrders)
      .set({ status: "cancelled", updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrders.id, orderId),
        eq(paymentOrders.status, "pending"),
      ))
      .returning({ id: paymentOrders.id });
    if (cancelled.length === 0) return;

    await tx
      .update(lotteryEntries)
      .set({ paymentStatus: "expired" })
      .where(and(
        eq(lotteryEntries.id, entryId),
        eq(lotteryEntries.paymentStatus, "pending"),
      ));
  });
}

async function armPaymentOrderForRetry(
  db: DbType,
  input: CreateOrderInput,
  orderId: string,
): Promise<void> {
  await withDbTransaction(db, async (tx) => {
    const [current] = await tx
      .select({
        id: paymentOrders.id,
        status: paymentOrders.status,
        entryId: paymentOrders.entryId,
      })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.id, orderId),
        eq(paymentOrders.tenantId, input.tenantId),
        eq(paymentOrders.drawId, input.drawId),
        eq(paymentOrders.entryId, input.entryId),
      ))
      .limit(1);
    if (!current || !RETRYABLE_PAYMENT_ORDER_STATUSES.has(current.status)) {
      throw new Error("订单不可重试");
    }

    const [draw] = await tx
      .select({
        id: lotteryDraws.id,
        tenantId: lotteryDraws.tenantId,
        maxParticipants: lotteryDraws.maxParticipants,
        experienceType: lotteryDraws.experienceType,
        promotionConfig: lotteryDraws.promotionConfig,
      })
      .from(lotteryDraws)
      .where(and(
        eq(lotteryDraws.id, input.drawId),
        eq(lotteryDraws.tenantId, input.tenantId),
      ))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
    const isFlashSale = flashParsed.config != null || draw.experienceType === "flash_sale";
    const capacity = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
    if (!isFlashSale || capacity == null || capacity <= 0) {
      throw new Error("秒杀活动未配置可重试名额");
    }

    // 过期 entry 已经被软释放，重试必须重新原子预约名额。
    // 不能先把 entry 改回 pending 再 COUNT，否则并发下会把已释放名额重复占用。
    const rearmedEntry = await tx
      .update(lotteryEntries)
      .set({ paymentStatus: "pending" })
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
        eq(lotteryEntries.paymentStatus, "expired"),
        sql`(
          SELECT COUNT(*) FROM lottery_entries
          WHERE tenant_id = ${input.tenantId}
            AND draw_id = ${input.drawId}
            AND payment_status <> 'expired'
        ) < ${capacity}`,
      ))
      .returning({ id: lotteryEntries.id });
    if (rearmedEntry.length === 0) {
      throw new Error("秒杀名额已被其他用户占用");
    }

    const [updatedRow] = await tx
      .update(paymentOrders)
      .set({
        tenantId: input.tenantId,
        drawId: input.drawId,
        amountCents: input.amountCents,
        currency: input.currency,
        status: "pending",
        provider: input.provider,
        providerTradeNo: null,
        prizeCodeId: null,
        paidAt: null,
        createdAt: sql`(datetime('now'))`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(paymentOrders.id, orderId),
        eq(paymentOrders.status, current.status),
      ))
      .returning({ id: paymentOrders.id });
    if (!updatedRow) {
      throw new Error("订单状态已变化，请刷新后重试");
    }
  });
}

/** Provider 创建支付后若返回平台侧单号，立即落库，便于后续查询、排障和未来 cf-pay 迁移。 */
async function persistProviderTradeNo(
  db: DbType,
  orderId: string,
  payResult: CreatePaymentResult,
): Promise<void> {
  const providerTradeNo = String(payResult.providerTradeNo || "").trim();
  if (!providerTradeNo) return;
  await db
    .update(paymentOrders)
    .set({ providerTradeNo, updatedAt: sql`(datetime('now'))` })
    .where(eq(paymentOrders.id, orderId));
}

/** 从 DB 加载并解密租户支付配置；未配置或密钥缺失返回 null（照搬 cf-shop loadPaymentProviderConfigs） */
export async function loadTenantConfig(
  db: DbType,
  tenantId: string,
  encryptionKey?: string,
  options: { provider?: string; currency?: string; requireDirectFulfillment?: boolean } = {},
): Promise<{ provider: PaymentProviderName; env: Record<string, string> } | null> {
  const [row] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);
  if (!row || !row.enabled) return null;

  let providers: Record<string, Record<string, unknown>> = {};
  try {
    providers = JSON.parse(row.providers || "{}");
  } catch {
    return null;
  }

  const decrypt = async (v: string): Promise<string> => {
    if (!v.startsWith("enc:")) return v;
    if (!encryptionKey) throw new Error("CREDENTIALS_ENCRYPTION_KEY 未配置");
    const { decrypt: aesDecrypt } = await import("@usethink/cf-core");
    const decrypted = await aesDecrypt(v.slice(4), encryptionKey);
    return String(decrypted);
  };

  // 按 catalog 顺序遍历，返回第一个已启用且凭据完整的渠道。
  // 直付路由只拿到一个 Provider，未来迁移 cf-pay 时保持这里作为统一选路边界。
  const requestedProvider = String(options.provider || "").trim();
  const requestedCurrency = String(options.currency || "").trim().toLowerCase();
  for (const item of PAYMENT_PROVIDER_CATALOG) {
    if (!isValidProviderName(item.name)) continue;
    if (options.requireDirectFulfillment && !item.supportsDirectFulfillment) continue;
    if (requestedProvider && item.name !== requestedProvider) continue;
    if (
      requestedCurrency &&
      !item.supportedCurrencies.some((currency) => currency.toLowerCase() === requestedCurrency)
    ) {
      continue;
    }
    const cfg = providers[item.name] as Record<string, unknown> | undefined;
    if (!cfg || cfg.enabled !== true) continue;

    const env: Record<string, string> = {};
    let complete = true;
    try {
      for (const field of item.fields) {
        const raw = cfg[field.key.toLowerCase()] ?? cfg[field.key];
        if (typeof raw !== "string" || !raw) {
          if (field.required) { complete = false; break; }
          continue;
        }
        env[field.key] = await decrypt(raw);
      }
    } catch {
      continue; // 解密失败 → 该渠道禁用，fail closed
    }
    if (!complete) continue;
    return { provider: item.name as PaymentProviderName, env };
  }
  return null;
}

/** 用租户配置创建 Provider 注册表并返回首选 Provider */
export function createTenantProvider(env: Record<string, string>, currency?: string): PaymentProvider | null {
  const registry = createProviderRegistry(env, PAYMENT_PROVIDER_CATALOG.map((i) => i.factory));
  return registry.selectOnline(currency) ?? null;
}

export interface CreateOrderInput {
  tenantId: string;
  drawId: string;
  entryId: string;
  amountCents: number;
  currency: string;
  provider: PaymentProviderName;
  notifyUrl: string;
  returnUrl?: string;
  description?: string;
}

/** 创建订单并请求支付，返回订单 + 支付入口（事务内写入订单 + 更新 entry 状态，docs/131 §7） */
export async function createPaymentOrder(
  db: DbType,
  input: CreateOrderInput,
  provider: PaymentProvider,
): Promise<{ order: typeof paymentOrders.$inferSelect; payResult: CreatePaymentResult }> {
  // 懒清理本租户超时订单（避免定时任务，docs/131 §8）
  await expireOverdueOrders(db, input.tenantId);

  const id = crypto.randomUUID();
  // 事务只含数据库写入；provider.createPayment 是网络调用，放事务外避免长时间占锁
  await withDbTransaction(db, async (tx) => {
    const armedEntry = await tx
      .update(lotteryEntries)
      .set({ paymentStatus: "pending" })
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
        eq(lotteryEntries.paymentStatus, ""),
      ))
      .returning({ id: lotteryEntries.id });
    if (armedEntry.length === 0) {
      throw new Error("参与记录状态不允许创建支付订单");
    }

    await tx.insert(paymentOrders).values({
      id,
      tenantId: input.tenantId,
      drawId: input.drawId,
      entryId: input.entryId,
      amountCents: input.amountCents,
      currency: input.currency,
      status: "pending",
      provider: input.provider,
    });
  });

  let payResult: CreatePaymentResult;
  try {
    payResult = await provider.createPayment({
      orderNo: id,
      amountCents: input.amountCents,
      currency: input.currency,
      notifyUrl: input.notifyUrl,
      returnUrl: input.returnUrl,
      description: input.description,
    });
  } catch (err) {
    // 支付下单失败 → 回滚订单为 cancelled（释放 entry 名额，避免占位）
    await cancelPaymentOrder(db, id, input.entryId);
    throw err;
  }

  await persistProviderTradeNo(db, id, payResult);
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).limit(1);
  return { order: order!, payResult };
}

/** 重试已取消 / 已过期订单：复用同一 entryId 与 orderNo，避免把一参与一订单拆成多条记录。 */
export async function retryPaymentOrder(
  db: DbType,
  input: CreateOrderInput,
  provider: PaymentProvider,
): Promise<{ order: typeof paymentOrders.$inferSelect; payResult: CreatePaymentResult }> {
  const [existing] = await db
    .select()
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.tenantId, input.tenantId),
      eq(paymentOrders.drawId, input.drawId),
      eq(paymentOrders.entryId, input.entryId),
    ))
    .limit(1);
  if (!existing) {
    throw new Error("订单不存在");
  }
  if (!RETRYABLE_PAYMENT_ORDER_STATUSES.has(existing.status)) {
    throw new Error("订单不可重试");
  }

  await armPaymentOrderForRetry(db, input, existing.id);

  let payResult: CreatePaymentResult;
  try {
    payResult = await provider.createPayment({
      orderNo: existing.id,
      amountCents: input.amountCents,
      currency: input.currency,
      notifyUrl: input.notifyUrl,
      returnUrl: input.returnUrl,
      description: input.description,
    });
  } catch (err) {
    await cancelPaymentOrder(db, existing.id, input.entryId);
    throw err;
  }

  await persistProviderTradeNo(db, existing.id, payResult);
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, existing.id)).limit(1);
  return { order: order!, payResult };
}

/**
 * 支付回调处理：验签 → 幂等 → 事务内（取卡密 + 标记 paid）→ 返回订单。
 * 卡密不足时订单标记 paid_fulfillment_failed（不静默 paid+null，docs/131 §7）。
 * params 为支付平台回调的 searchParams（Record<string,string>，由 Provider verifyCallback 解析）。
 * 重复回调返回 { processed: false, order } 不重复发卡。
 */
export async function handlePaymentCallback(
  db: DbType,
  tenantId: string,
  provider: PaymentProvider,
  params: Record<string, string>,
): Promise<{ processed: boolean; order?: typeof paymentOrders.$inferSelect; error?: string }> {
  let callback: CallbackResult;
  try {
    callback = await provider.verifyCallback(params);
  } catch {
    return { processed: false, error: "验签失败" };
  }
  if (!callback) return { processed: false, error: "验签失败" };

  const [pre] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, callback.orderNo))
    .limit(1);
  if (!pre) return { processed: false, error: "订单不存在" };
  if (pre.tenantId !== tenantId) return { processed: false, error: "租户不匹配" };
  if (pre.provider !== provider.name) return { processed: false, error: "支付渠道不匹配" };
  const callbackCurrency = String(callback.currency || "").trim().toLowerCase();
  const orderCurrency = String(pre.currency || "").trim().toLowerCase();
  if (callback.amountCents !== pre.amountCents || callbackCurrency !== orderCurrency) {
    return { processed: false, error: "金额或币种不匹配" };
  }

  // 事务内完成发卡与状态更新（docs/131 §7：读取→取卡密→更新订单，一次提交）
  const order = await withDbTransaction(db, async (tx) => {
    // 幂等：事务内重新读取，已 paid 的订单直接返回
    const [current] = await tx
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, pre.id))
      .limit(1);
    if (!current) return null;
    if (
      current.status === "paid" ||
      current.status === "paid_fulfillment_failed" ||
      current.status === "expired" ||
      current.status === "cancelled" ||
      current.status === "refunded"
    ) {
      // 终态回调只确认已处理，不重新发卡。尤其 expired 不能因迟到回调重新占用已释放名额。
      return current;
    }
    if (current.status !== "pending") return current;

    const [entry] = await tx
      .select({ paymentStatus: lotteryEntries.paymentStatus })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.id, current.entryId),
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.drawId, current.drawId),
      ))
      .limit(1);
    if (!entry || entry.paymentStatus === "expired") {
      // 防御性兜底：即使订单状态尚未同步，已释放的 entry 也不能被迟到回调发卡。
      return current;
    }

    const prizeCodeId = await acquirePrizeCode(tx, tenantId, pre.drawId, pre.entryId);

    // 卡密不足：标记 paid_fulfillment_failed（运营后台可见，docs/131 §7），不静默 null
    const newStatus = prizeCodeId ? "paid" : "paid_fulfillment_failed";
    await tx
      .update(paymentOrders)
      .set({
        status: newStatus,
        providerTradeNo: callback.providerTradeNo,
        prizeCodeId: prizeCodeId ?? null,
        paidAt: callback.paidAt,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(paymentOrders.id, pre.id));

    // 支付成功 → entry 标记 paid（软释放状态机，docs/131 §8）
    if (newStatus === "paid") {
      await tx
        .update(lotteryEntries)
        .set({ paymentStatus: "paid" })
        .where(eq(lotteryEntries.id, pre.entryId));
    }

    const [updated] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, pre.id)).limit(1);
    return updated ?? null;
  });

  if (!order) return { processed: false, error: "订单不存在" };
  // 对已终态订单（包括 expired/cancelled/refunded）也返回已处理，避免支付平台
  // 因迟到回调反复重试；状态保持不变，绝不因回调重新发卡。
  return { processed: order.status !== "pending", order };
}

/**
 * 管理端人工补发：仅处理「已付款但发卡失败」订单。
 * 运营补充码池后点击重试，事务内重新领取一张卡密并把订单恢复为 paid。
 */
export async function retryPaymentFulfillment(
  db: DbType,
  tenantId: string,
  orderId: string,
): Promise<{ ok: boolean; order?: typeof paymentOrders.$inferSelect; error?: string }> {
  const order = await withDbTransaction(db, async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.tenantId, tenantId)))
      .limit(1);
    if (!current) return { error: "订单不存在" };
    if (current.status === "paid" && current.prizeCodeId) return { order: current };
    if (current.status !== "paid_fulfillment_failed") {
      return { error: "订单状态不允许补发" };
    }

    const prizeCodeId = await acquirePrizeCode(tx, tenantId, current.drawId, current.entryId);
    if (!prizeCodeId) return { error: "没有可用卡密，请先补充码池" };

    const updatedOrder = await tx
      .update(paymentOrders)
      .set({
        status: "paid",
        prizeCodeId,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(paymentOrders.id, current.id),
        eq(paymentOrders.status, "paid_fulfillment_failed"),
      ))
      .returning({ id: paymentOrders.id });
    if (updatedOrder.length === 0) {
      throw new Error("订单状态已变化，请刷新后重试");
    }

    await tx
      .update(lotteryEntries)
      .set({ paymentStatus: "paid" })
      .where(eq(lotteryEntries.id, current.entryId));

    const [updated] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, current.id)).limit(1);
    return { order: updated ?? current };
  });

  if ("error" in order) return { ok: false, error: order.error };
  return { ok: true, order: order.order };
}

/** 原子领取活动绑定的卡密奖品。返回 null 表示未绑卡密奖或码池不足。 */
async function acquirePrizeCode(
  db: DbType,
  tenantId: string,
  drawId: string,
  entryId: string,
): Promise<string | null> {
  // 查活动的卡密奖（prizeType=code）
  const tier = await findCodePrize(db, tenantId, drawId);
  if (!tier?.prizeId) return null;

  const acquired = await db
    .update(prizeCodes)
    .set({ status: "issued", issuedAt: sql`(datetime('now'))`, winnerId: entryId })
    .where(and(
      eq(prizeCodes.tenantId, tenantId),
      eq(prizeCodes.status, "available"),
      // SQLite/libSQL 不支持 Drizzle 生成的 UPDATE ... RETURNING ... ORDER BY ... LIMIT。
      // 用子查询在同一条 UPDATE 内选中最小 id 的可用卡密，保留原子领取语义。
      eq(prizeCodes.id, sql<string>`(
        SELECT id FROM prize_codes
        WHERE tenant_id = ${tenantId}
          AND prize_id = ${tier.prizeId}
          AND status = 'available'
        ORDER BY id
        LIMIT 1
      )`),
    ))
    .returning({ id: prizeCodes.id });
  return acquired[0]?.id ?? null;
}

/**
 * 查询活动唯一的卡密奖品（prizeType=code）的 prizeId，用于发卡。
 *
 * 发布预检会阻断多卡密奖品，但运行时仍必须 fail closed；否则脏配置下
 * `LIMIT 1` 会随机选中一个奖品，造成支付成功后发错卡。
 */
async function findCodePrize(db: DbType, tenantId: string, drawId: string) {
  const rows = await db
    .select({ prizeId: lotteryPrizeTiers.prizeId })
    .from(lotteryPrizeTiers)
    .innerJoin(prizes, and(
      eq(prizes.id, lotteryPrizeTiers.prizeId),
      eq(prizes.tenantId, tenantId),
      eq(prizes.prizeType, "code"),
      eq(prizes.active, 1),
    ))
    .where(and(eq(lotteryPrizeTiers.tenantId, tenantId), eq(lotteryPrizeTiers.drawId, drawId)));
  return rows.length === 1 ? rows[0] : null;
}
