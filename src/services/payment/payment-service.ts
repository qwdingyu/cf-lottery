/**
 * 支付服务（秒杀卡密多租户直付，docs/131）
 *
 * 职责：
 * - 按租户加载/解密支付配置（tenant_configs.providers JSON，多租户隔离）
 * - 创建订单（payment_orders + payment_order_items，entryId 只做参与归属）
 * - 调用 cf-core Provider 创建支付（易支付/支付宝/Stripe）
 * - 支付回调验签 + 幂等 + 发卡密（prizeCodes available → issued 原子取卡）
 *
 * 复用 @usethink/cf-core/features/payment（Provider 抽象已在共享库）。
 */
import { createProviderRegistry, isAmbiguousEasyPayProviderError } from "@usethink/cf-core/features/payment";
import type { CallbackResult, PaymentProvider, CreatePaymentResult } from "@usethink/cf-core/features/payment";
import { eq, and, desc, sql, inArray, isNull, max, ne, notInArray } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import {
  tenantConfigs,
  paymentOrders,
  paymentOrderAttempts,
  paymentOrderItems,
  prizeCodes,
  lotteryPrizeTiers,
  prizes,
  lotteryEntries,
  lotteryDraws,
} from "../../db/schema";
import { PAYMENT_PROVIDER_CATALOG, isValidProviderName } from "./catalog";
import { decryptPaymentConfigValue, isEncryptedPaymentConfigValue } from "./secret-config";
import { parseFlashSaleConfig, resolveEffectiveStockLimit } from "../../lib/flash-sale-config";
import {
  isPaidPaymentAttemptStatus,
  isRetryablePaymentOrderStatus,
  PAYMENT_ATTEMPT_STATUS,
  PAYMENT_ENTRY_STATUS,
  PAYMENT_ORDER_ITEM_STATUS,
  PAYMENT_ORDER_STATUS,
} from "./payment-status";

// systemConfig 表（用于读取运行时配置订单超时/价格上限等）
import { systemConfig as systemConfigTable } from "../../db/schema";

export type PaymentProviderName = "easypay" | "stripe" | "alipay";

const PAYMENT_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function shouldCancelOrderAfterCreateFailure(error: unknown): boolean {
  // 易支付/ZPay 已在 cf-core 区分 deterministic / ambiguous。
  // ambiguous 表示网关可能已经创建订单：本地必须保留 pending，允许迟到回调或用户刷新后恢复支付入口。
  return !isAmbiguousEasyPayProviderError(error);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createPaymentAccessToken(): string {
  // 两个 UUID 提供足够的不可预测性；数据库只保存 SHA-256，令牌不会以明文落库。
  return `${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, "")}`;
}

function paymentAccessTokenExpiresAt(now = Date.now()): string {
  return new Date(now + PAYMENT_ACCESS_TOKEN_TTL_MS).toISOString();
}

/** 为公开订单签发访问令牌；调用方必须先完成 buyer+email 绑定校验。 */
export async function issuePaymentOrderAccessToken(
  db: DbType,
  tenantId: string,
  orderId: string,
  _entryId?: string,
): Promise<string> {
  const token = createPaymentAccessToken();
  const updated = await db
    .update(paymentOrders)
    .set({
      accessTokenHash: await sha256Hex(token),
      accessTokenExpiresAt: paymentAccessTokenExpiresAt(),
      updatedAt: sql`(datetime('now'))`,
    })
    .where(and(
      eq(paymentOrders.id, orderId),
      eq(paymentOrders.tenantId, tenantId),
    ))
    .returning({ id: paymentOrders.id });
  if (updated.length === 0) throw new Error("订单不存在");
  return token;
}

/** 用短期 Bearer 令牌查订单；任何无令牌/过期令牌都不返回订单细节。 */
export async function findPaymentOrderByAccessToken(
  db: DbType,
  tenantId: string,
  drawId: string,
  orderId: string,
  token: string,
): Promise<typeof paymentOrders.$inferSelect | null> {
  const normalized = String(token || "").trim();
  if (!normalized) return null;
  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.id, orderId),
      eq(paymentOrders.tenantId, tenantId),
      eq(paymentOrders.drawId, drawId),
      eq(paymentOrders.accessTokenHash, await sha256Hex(normalized)),
      sql`datetime(${paymentOrders.accessTokenExpiresAt}) > datetime('now')`,
    ))
    .limit(1);
  return order ?? null;
}

async function decrementActiveFlashSaleCount(
  db: DbType,
  tenantId: string,
  drawId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  await db
    .update(lotteryDraws)
    .set({
      activeParticipantCount: sql`MAX(0, ${lotteryDraws.activeParticipantCount} - ${amount})`,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
}

/** 懒清理：标记超时未支付的 pending 订单为 expired，并释放关联 entry 名额（docs/131 §8）。超时分钟数从 systemConfig 读取，未配则默认 30。 */
export async function expireOverdueOrders(db: DbType, tenantId: string): Promise<number> {
  // 读取运行时配置（systemConfig 表）→ 闭环节拍
  let timeoutMinutes = 30;
  try {
    const [row] = await db
      .select({ value: systemConfigTable.value })
      .from(systemConfigTable)
      .where(eq(systemConfigTable.key, "payment_order_timeout_minutes"))
      .limit(1);
    if (row) {
      const parsed = Number(row.value || "");
      if (Number.isFinite(parsed) && parsed >= 1) timeoutMinutes = Math.floor(parsed);
    }
  } catch { /* 表不存在或未迁移 → 默认 30 */ }
  const cutoff = sql`datetime('now', '-' || ${timeoutMinutes} || ' minutes')`;
  return withDbTransaction(db, async (tx) => {
    // 订单和 entry 必须在同一事务中软释放，否则回调或并发参与可能看到半完成状态。
    const overdue = await tx
      .select({
        id: paymentOrders.id,
        entryId: paymentOrders.entryId,
        currentAttemptId: paymentOrders.currentAttemptId,
        drawId: paymentOrders.drawId,
        quantity: paymentOrders.quantity,
      })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, tenantId),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
        sql`datetime(${paymentOrders.createdAt}) < ${cutoff}`,
      ));

    const staleReservations = await tx
      .select({ id: lotteryEntries.id, drawId: lotteryEntries.drawId })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.RESERVED),
        sql`datetime(${lotteryEntries.joinedAt}) < ${cutoff}`,
        sql`NOT EXISTS (
          SELECT 1 FROM payment_orders
          WHERE payment_orders.entry_id = ${lotteryEntries.id}
            AND payment_orders.tenant_id = ${tenantId}
        )`,
      ));
    if (overdue.length === 0 && staleReservations.length === 0) return 0;

    await tx
      .update(paymentOrders)
      .set({ status: PAYMENT_ORDER_STATUS.EXPIRED, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrders.tenantId, tenantId),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
        sql`datetime(${paymentOrders.createdAt}) < ${cutoff}`,
      ));

    if (overdue.length > 0) {
      await tx
        .update(paymentOrderAttempts)
        .set({ status: PAYMENT_ATTEMPT_STATUS.EXPIRED, updatedAt: sql`(datetime('now'))` })
        .where(and(
          eq(paymentOrderAttempts.tenantId, tenantId),
          inArray(paymentOrderAttempts.id, overdue.map((order) => order.currentAttemptId).filter(Boolean) as string[]),
          eq(paymentOrderAttempts.status, PAYMENT_ATTEMPT_STATUS.PENDING),
        ));
    }

    const entryIds = overdue.map((o) => o.entryId).filter(Boolean);
    const releaseByDraw = new Map<string, number>();
    if (entryIds.length > 0) {
      // 超时订单本身即将被置为 expired，不能算作 entry 的"其他有效订单"。
      const overdueOrderIds = overdue.map((o) => o.id).filter(Boolean);

      // 1) 有 PAID/FULFILLMENT_FAILED 订单的 entry：恢复为 paid（仍有有效履约，不能整体释放名额）
      //    例如用户已有 PAID 订单 A、正在创建订单 B（PENDING）超时，entry 应回到 PAID 而非 EXPIRED。
      const paidOrderRows = await tx
        .select({ entryId: paymentOrders.entryId })
        .from(paymentOrders)
        .where(and(
          eq(paymentOrders.tenantId, tenantId),
          inArray(paymentOrders.entryId, entryIds),
          inArray(paymentOrders.status, [PAYMENT_ORDER_STATUS.PAID, PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED]),
        ));
      const paidEntryIds = new Set(paidOrderRows.map((r) => r.entryId));
      if (paidEntryIds.size > 0) {
        await tx
          .update(lotteryEntries)
          .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PAID })
          .where(and(
            eq(lotteryEntries.tenantId, tenantId),
            inArray(lotteryEntries.id, [...paidEntryIds]),
            eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
          ));
      }

      // 2) 还有其它有效订单（非超时、非终态）的 entry：阻止释放（保持 pending 或已由 step 1 恢复为 paid）
      const otherActiveRows = await tx
        .select({ entryId: paymentOrders.entryId })
        .from(paymentOrders)
        .where(and(
          eq(paymentOrders.tenantId, tenantId),
          inArray(paymentOrders.entryId, entryIds),
          notInArray(paymentOrders.id, overdueOrderIds),
          notInArray(paymentOrders.status, [
            PAYMENT_ORDER_STATUS.CANCELLED,
            PAYMENT_ORDER_STATUS.EXPIRED,
            PAYMENT_ORDER_STATUS.REFUNDED,
          ]),
        ));
      const keepActiveEntryIds = new Set(otherActiveRows.map((r) => r.entryId));

      // 3) 其余 entry（无其他有效订单，也非 paid 恢复）释放为 expired
      const toRelease = entryIds.filter((id) => !paidEntryIds.has(id) && !keepActiveEntryIds.has(id));
      if (toRelease.length > 0) {
        await tx
          .update(lotteryEntries)
          .set({ paymentStatus: PAYMENT_ENTRY_STATUS.EXPIRED })
          .where(and(
            eq(lotteryEntries.tenantId, tenantId),
            inArray(lotteryEntries.id, toRelease),
            eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
          ));
      }

      // 4) 所有超时订单的容量都需释放（计数器独立于 entry 状态，decrement 用 MAX(0) 防下溢）
      for (const order of overdue) {
        const quantity = Math.max(1, Math.floor(Number(order.quantity || 1)));
        releaseByDraw.set(order.drawId, (releaseByDraw.get(order.drawId) || 0) + quantity);
      }
    }

    if (staleReservations.length > 0) {
      const releasedReserved = await tx
        .update(lotteryEntries)
        .set({ paymentStatus: PAYMENT_ENTRY_STATUS.EXPIRED })
        .where(and(
          eq(lotteryEntries.tenantId, tenantId),
          inArray(lotteryEntries.id, staleReservations.map((entry) => entry.id)),
          eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.RESERVED),
        ))
        .returning({ drawId: lotteryEntries.drawId });
      for (const entry of releasedReserved) {
        releaseByDraw.set(entry.drawId, (releaseByDraw.get(entry.drawId) || 0) + 1);
      }
    }

    // 释放名额的 entry 都属于直付秒杀；按活动分组扣减计数器，避免把多个活动混成一个 delta。
    for (const [drawId, amount] of releaseByDraw) {
      await decrementActiveFlashSaleCount(tx, tenantId, drawId, amount);
    }

    return overdue.length + staleReservations.length;
  });
}

async function cancelPaymentOrder(
  db: DbType,
  input: Pick<CreateOrderInput, "tenantId" | "drawId" | "entryId">,
  orderId: string,
  attemptId: string,
): Promise<void> {
  await withDbTransaction(db, async (tx) => {
    // 只有仍处于 pending 的订单才允许因网关创建失败而取消。
    // 如果回调已经把订单置为 paid，不能被迟到的下单异常覆盖。
    const cancelled = await tx
      .update(paymentOrders)
      .set({ status: PAYMENT_ORDER_STATUS.CANCELLED, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrders.id, orderId),
        eq(paymentOrders.tenantId, input.tenantId),
        eq(paymentOrders.drawId, input.drawId),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
      ))
      .returning({ id: paymentOrders.id, quantity: paymentOrders.quantity });
    if (cancelled.length === 0) return;

    await tx
      .update(paymentOrderAttempts)
      .set({ status: PAYMENT_ATTEMPT_STATUS.FAILED, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrderAttempts.id, attemptId),
        eq(paymentOrderAttempts.paymentOrderId, orderId),
        eq(paymentOrderAttempts.status, PAYMENT_ATTEMPT_STATUS.PENDING),
      ));

    // V2：取消订单时标记所有 pending 明细为 refunded（docs/158）。
    await tx
      .update(paymentOrderItems)
      .set({ status: PAYMENT_ORDER_ITEM_STATUS.REFUNDED, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrderItems.tenantId, input.tenantId),
        eq(paymentOrderItems.paymentOrderId, orderId),
        eq(paymentOrderItems.status, PAYMENT_ORDER_ITEM_STATUS.PENDING),
      ));

    // 释放该订单占用的名额
    const quantity = Math.max(1, Math.floor(Number(cancelled[0]?.quantity || 1)));
    await decrementActiveFlashSaleCount(tx, input.tenantId, input.drawId, quantity);

    // V2：释放 entry 时必须考虑该 entry 是否有其他有效订单（PAID / FULFILLMENT_FAILED / PENDING），
    // 而不仅是检查其他 pending 订单。否则用户已有 PAID 订单 A、正在创建订单 B 时 B 取消，
    // 会把 entry 误释放为 expired，掩盖 A 的已发卡履约并导致再次下单被"参与预约已失效"拦截。
    //
    // 采用与 expireOverdueOrders 一致的两步策略：优先检查 PAID/FULFILLMENT_FAILED，再检查 PENDING，
    // 避免 limit(1) 在同时存在 PAID 和 PENDING 订单时非确定性地选择 PENDING 掩盖履约。
    //
    // 1) 有 PAID/FULFILLMENT_FAILED 订单 → entry 恢复为 paid
    const [paidOrder] = await tx
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, input.tenantId),
        eq(paymentOrders.drawId, input.drawId),
        eq(paymentOrders.entryId, input.entryId),
        ne(paymentOrders.id, orderId),
        inArray(paymentOrders.status, [PAYMENT_ORDER_STATUS.PAID, PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED]),
      ))
      .limit(1);
    if (paidOrder) {
      await tx
        .update(lotteryEntries)
        .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PAID })
        .where(and(
          eq(lotteryEntries.id, input.entryId),
          eq(lotteryEntries.tenantId, input.tenantId),
          eq(lotteryEntries.drawId, input.drawId),
          eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
        ));
      return;
    }

    // 2) 有其他 PENDING 订单 → 保持 entry pending，不做改动
    const [otherPending] = await tx
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, input.tenantId),
        eq(paymentOrders.drawId, input.drawId),
        eq(paymentOrders.entryId, input.entryId),
        ne(paymentOrders.id, orderId),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
      ))
      .limit(1);
    if (otherPending) return;

    // 3) 无其他有效订单 → 释放为 expired
    await tx
      .update(lotteryEntries)
      .set({ paymentStatus: PAYMENT_ENTRY_STATUS.EXPIRED })
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
        eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
      ));
  });
}

async function armPaymentOrderForRetry(
  db: DbType,
  input: CreateOrderInput,
  orderId: string,
): Promise<{ attemptId: string; accessToken: string; amountCents: number; currency: string }> {
  const accessToken = createPaymentAccessToken();
  const accessTokenHash = await sha256Hex(accessToken);
  return withDbTransaction(db, async (tx) => {
    const [current] = await tx
      .select({
        id: paymentOrders.id,
        status: paymentOrders.status,
        entryId: paymentOrders.entryId,
        currentAttemptId: paymentOrders.currentAttemptId,
        amountCents: paymentOrders.amountCents,
        currency: paymentOrders.currency,
        quantity: paymentOrders.quantity,
      })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.id, orderId),
        eq(paymentOrders.tenantId, input.tenantId),
        eq(paymentOrders.drawId, input.drawId),
      ))
      .limit(1);
    if (!current || !isRetryablePaymentOrderStatus(current.status)) {
      throw new Error("订单不可重试");
    }

    const [draw] = await tx
      .select({
        id: lotteryDraws.id,
        tenantId: lotteryDraws.tenantId,
        status: lotteryDraws.status,
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
    if (draw.status !== "open") {
      throw new Error("活动当前不可重试支付");
    }

    const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
    const isFlashSale = flashParsed.config != null || draw.experienceType === "flash_sale";
    const capacity = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
    if (!isFlashSale || capacity == null || capacity <= 0) {
      throw new Error("秒杀活动未配置可重试名额");
    }

    // 过期 entry 已经被软释放，重试必须先通过活动计数器 CAS 重新预约名额。
    // 不能先把 entry 改回 pending 再检查，否则并发下会把已释放名额重复占用。
    const quantity = Math.max(1, Math.floor(Number(current.quantity || 1)));
    const reserved = await tx
      .update(lotteryDraws)
      .set({
        activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + ${quantity}`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(lotteryDraws.id, input.drawId),
        eq(lotteryDraws.tenantId, input.tenantId),
        sql`${lotteryDraws.activeParticipantCount} + ${quantity} <= ${capacity}`,
      ))
      .returning({ id: lotteryDraws.id });
    if (reserved.length === 0) {
      throw new Error("秒杀名额已被其他用户占用");
    }

    const rearmedEntry = await tx
      .update(lotteryEntries)
      .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PENDING })
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
        eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.EXPIRED),
      ))
      .returning({ id: lotteryEntries.id });
    if (rearmedEntry.length === 0) {
      throw new Error("秒杀名额已被其他用户占用");
    }

    const [attemptNumber] = await tx
      .select({ value: max(paymentOrderAttempts.attemptNo) })
      .from(paymentOrderAttempts)
      .where(eq(paymentOrderAttempts.paymentOrderId, orderId));
    const attemptId = crypto.randomUUID();
    const nextAttemptNo = Number(attemptNumber?.value || 0) + 1;

    if (current.currentAttemptId) {
      await tx
        .update(paymentOrderAttempts)
        .set({ status: PAYMENT_ATTEMPT_STATUS.SUPERSEDED, updatedAt: sql`(datetime('now'))` })
        .where(and(
          eq(paymentOrderAttempts.id, current.currentAttemptId),
          eq(paymentOrderAttempts.status, PAYMENT_ATTEMPT_STATUS.PENDING),
        ));
    }

    const orderAmountCents = currentAmountCents(current);
    const orderCurrency = currentCurrency(current);
    const [updatedRow] = await tx
      .update(paymentOrders)
      .set({
        tenantId: input.tenantId,
        drawId: input.drawId,
        amountCents: orderAmountCents,
        currency: orderCurrency,
        status: PAYMENT_ORDER_STATUS.PENDING,
        provider: input.provider,
        providerTradeNo: null,
        currentAttemptId: attemptId,
        accessTokenHash,
        accessTokenExpiresAt: paymentAccessTokenExpiresAt(),
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

    await tx.insert(paymentOrderAttempts).values({
      id: attemptId,
      paymentOrderId: orderId,
      tenantId: input.tenantId,
      drawId: input.drawId,
      attemptNo: nextAttemptNo,
      provider: input.provider,
      amountCents: orderAmountCents,
      currency: orderCurrency,
      status: PAYMENT_ATTEMPT_STATUS.PENDING,
    });
    return { attemptId, accessToken, amountCents: orderAmountCents, currency: orderCurrency };
  });
}

function currentAmountCents(current: { amountCents: number }): number {
  return Number(current.amountCents);
}

function currentCurrency(current: { currency: string }): string {
  return String(current.currency || "cny").trim().toLowerCase();
}

/** Provider 创建支付后若返回平台侧单号，立即落库到当前 attempt。 */
export async function persistProviderTradeNo(
  db: DbType,
  orderId: string,
  attemptId: string,
  payResult: CreatePaymentResult,
): Promise<void> {
  const providerTradeNo = String(payResult.providerTradeNo || "").trim();
  if (!providerTradeNo) return;
  await withDbTransaction(db, async (tx) => {
    // 两张表都以 provider_trade_no 表达同一笔外部交易。0039 迁移对该字段加了唯一约束；
    // 必须同一事务写入，才能保证脏网关返回重复流水时不会只更新 attempt 或只更新 order。
    await tx
      .update(paymentOrderAttempts)
      .set({ providerTradeNo, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrderAttempts.id, attemptId),
        eq(paymentOrderAttempts.paymentOrderId, orderId),
        eq(paymentOrderAttempts.status, PAYMENT_ATTEMPT_STATUS.PENDING),
      ));
    await tx
      .update(paymentOrders)
      .set({ providerTradeNo, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrders.id, orderId),
        eq(paymentOrders.currentAttemptId, attemptId),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
        isNull(paymentOrders.providerTradeNo),
      ));
  });
}

/** 从 DB 加载并解密租户支付配置；未配置或密钥缺失返回 null（照搬 cf-shop loadPaymentProviderConfigs） */
export async function loadTenantConfig(
  db: DbType,
  tenantId: string,
  encryptionKey?: string,
  options: {
    provider?: string;
    currency?: string;
    requireDirectFulfillment?: boolean;
    /**
     * 停用渠道只阻断新订单；在途订单仍必须能验签和接收回调。
     * 该选项只能由已按 order.provider 精确锁定的恢复/回调路径使用。
     */
    allowDisabled?: boolean;
  } = {},
): Promise<{ provider: PaymentProviderName; env: Record<string, string> } | null> {
  const [row] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);
  if (!row || (!row.enabled && !options.allowDisabled)) return null;

  let providers: Record<string, Record<string, unknown>> = {};
  try {
    providers = JSON.parse(row.providers || "{}");
  } catch {
    return null;
  }

  const decrypt = (v: string): Promise<string> => decryptPaymentConfigValue(v, encryptionKey);

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
    if (!cfg || (cfg.enabled !== true && !options.allowDisabled)) continue;

    const env: Record<string, string> = {};
    let complete = true;
    try {
      for (const field of item.fields) {
        const raw = cfg[field.key.toLowerCase()] ?? cfg[field.key];
        if (typeof raw !== "string" || !raw) {
          if (field.required) { complete = false; break; }
          continue;
        }
        if (field.sensitive && !isEncryptedPaymentConfigValue(raw)) {
          complete = false;
          break;
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
  /** V2 购买身份快照：下单时从 entry 拷贝，订单独立保存购买者身份（docs/158）。 */
  buyerIdentityType?: string;
  buyerIdentityValue?: string;
  buyerDisplayName?: string;
  quantity?: number;
  unitPriceCents?: number;
  pricingSnapshotJson?: string;
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
): Promise<{ order: typeof paymentOrders.$inferSelect; payResult: CreatePaymentResult; accessToken: string }> {
  // 懒清理本租户超时订单（避免定时任务，docs/131 §8）
  await expireOverdueOrders(db, input.tenantId);

  const id = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const accessToken = createPaymentAccessToken();
  const accessTokenHash = await sha256Hex(accessToken);
  let reservationFailedMessage = "";
  // 事务只含数据库写入；provider.createPayment 是网络调用，放事务外避免长时间占锁
  await withDbTransaction(db, async (tx) => {
    const [existingOrder] = await tx
      .select({
        id: paymentOrders.id,
        status: paymentOrders.status,
        createdAt: paymentOrders.createdAt,
      })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, input.tenantId),
        eq(paymentOrders.drawId, input.drawId),
        eq(paymentOrders.entryId, input.entryId),
      ))
      .orderBy(desc(paymentOrders.createdAt))
      .limit(1);
    if (
      existingOrder &&
      (existingOrder.status === PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED ||
        existingOrder.status === PAYMENT_ORDER_STATUS.LATE_NEEDS_REFUND)
    ) {
      throw new Error("订单仍在处理中，请联系客服处理");
    }
    if (existingOrder?.status === PAYMENT_ORDER_STATUS.PENDING) {
      throw new Error("订单已存在，请刷新后重试");
    }

    const quantity = Math.max(1, Math.floor(Number(input.quantity || 1)));
    // V2：查 entry 当前状态，决定是否已有前置订单（docs/158）。
    // - reserved（首次下单）：base=1 已在 joinDraw 时计入，需补 reserveQuantity = qty - 1
    // - paid/pending（再次购买）：base=1 已被之前订单消费，全额预约 reserveQuantity = qty
    const [entryRow] = await tx
      .select({ paymentStatus: lotteryEntries.paymentStatus })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.id, input.entryId), eq(lotteryEntries.tenantId, input.tenantId)))
      .limit(1);
    if (!entryRow) throw new Error("参与记录不存在");
    const hasPriorOrder = existingOrder != null;
    // 需预约件数：有前置订单时全额预约，否则只预约超出 base 1 的部分
    const reserveQuantity = hasPriorOrder ? quantity : (quantity - 1);

    if (reserveQuantity > 0) {
      const [draw] = await tx
        .select({
          maxParticipants: lotteryDraws.maxParticipants,
          experienceType: lotteryDraws.experienceType,
          promotionConfig: lotteryDraws.promotionConfig,
        })
        .from(lotteryDraws)
        .where(and(eq(lotteryDraws.id, input.drawId), eq(lotteryDraws.tenantId, input.tenantId)))
        .limit(1);
      if (!draw) throw new Error("活动不存在");
      const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
      const isFlashSale = flashParsed.config != null || draw.experienceType === "flash_sale";
      const capacity = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
      if (!isFlashSale || capacity == null || capacity <= 0) {
        throw new Error("秒杀活动未配置可用名额");
      }
      // 事务内 CAS 预约：不能只在路由层预检，否则两个批量订单并发时会同时看到相同剩余库存
      const reserved = await tx
        .update(lotteryDraws)
        .set({
          activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + ${reserveQuantity}`,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(and(
          eq(lotteryDraws.id, input.drawId),
          eq(lotteryDraws.tenantId, input.tenantId),
          sql`${lotteryDraws.activeParticipantCount} + ${reserveQuantity} <= ${capacity}`,
        ))
        .returning({ id: lotteryDraws.id });
      if (reserved.length === 0) {
        if (!hasPriorOrder) {
          // 首次下单且批量额外件数预约失败：释放 base 1
          const released = await tx
            .update(lotteryEntries)
            .set({ paymentStatus: PAYMENT_ENTRY_STATUS.EXPIRED })
            .where(and(
              eq(lotteryEntries.id, input.entryId),
              eq(lotteryEntries.tenantId, input.tenantId),
              eq(lotteryEntries.drawId, input.drawId),
              eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.RESERVED),
            ));
          if ((released.rowsAffected ?? 0) > 0) {
            await decrementActiveFlashSaleCount(tx, input.tenantId, input.drawId, 1);
          }
        }
        reservationFailedMessage = "秒杀名额已被其他用户占用";
        return;
      }
    }

    if (reservationFailedMessage) return;

    // V2：首次创建必须从 reserved 进入 pending；如果已有订单则按当前 entry 状态继续走。
    const allowedPriorStatuses = hasPriorOrder
      ? [PAYMENT_ENTRY_STATUS.PAID, PAYMENT_ENTRY_STATUS.PENDING]
      : [PAYMENT_ENTRY_STATUS.RESERVED];
    const armedEntry = await tx
      .update(lotteryEntries)
      .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PENDING })
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
        inArray(lotteryEntries.paymentStatus, allowedPriorStatuses),
      ))
      .returning({ id: lotteryEntries.id });
    if (armedEntry.length === 0) {
      throw new Error("参与预约已失效，请重新参与");
    }

    await tx.insert(paymentOrders).values({
      id,
      tenantId: input.tenantId,
      drawId: input.drawId,
      entryId: input.entryId,
      // V2：购买身份快照，下单时从 entry 拷贝到订单（docs/158）。
      buyerIdentityType: input.buyerIdentityType || "email",
      buyerIdentityValue: input.buyerIdentityValue || "",
      buyerDisplayName: input.buyerDisplayName || "",
      quantity,
      unitPriceCents: Math.max(0, Math.floor(Number(input.unitPriceCents || 0))),
      pricingSnapshotJson: input.pricingSnapshotJson || "{}",
      amountCents: input.amountCents,
      currency: input.currency,
      status: PAYMENT_ORDER_STATUS.PENDING,
      provider: input.provider,
      currentAttemptId: attemptId,
      accessTokenHash,
      accessTokenExpiresAt: paymentAccessTokenExpiresAt(),
    });
    // V2：创建 order_items（quantity 件，每件一条 pending 记录，docs/158）。
    const orderItemValues = Array.from({ length: quantity }, (_, i) => ({
      id: `${id}-item-${i + 1}`,
      tenantId: input.tenantId,
      drawId: input.drawId,
      paymentOrderId: id,
      lineNo: i + 1,
      itemType: "flash_sale",
      title: input.description || "",
      quantity: 1,
      prizeCodeId: null,
      amountCents: Math.max(0, Math.floor(Number(input.unitPriceCents || 0))),
      currency: input.currency,
      pricingSnapshotJson: input.pricingSnapshotJson || "{}",
      status: PAYMENT_ORDER_ITEM_STATUS.PENDING,
      unitPriceCents: Math.max(0, Math.floor(Number(input.unitPriceCents || 0))),
    }));
    await tx.insert(paymentOrderItems).values(orderItemValues);
    await tx.insert(paymentOrderAttempts).values({
      id: attemptId,
      paymentOrderId: id,
      tenantId: input.tenantId,
      drawId: input.drawId,
      attemptNo: 1,
      provider: input.provider,
      amountCents: input.amountCents,
      currency: input.currency,
      status: PAYMENT_ATTEMPT_STATUS.PENDING,
    });
  });
  if (reservationFailedMessage) {
    throw new Error(reservationFailedMessage);
  }

  let payResult: CreatePaymentResult;
  try {
    payResult = await provider.createPayment({
      orderNo: attemptId,
      amountCents: input.amountCents,
      currency: input.currency,
      notifyUrl: input.notifyUrl,
      returnUrl: input.returnUrl,
      description: input.description,
    });
  } catch (err) {
    // 确定性失败才取消并释放名额；不确定失败保留 pending，防止“网关已收单/已支付，本地已取消”。
    if (shouldCancelOrderAfterCreateFailure(err)) {
      await cancelPaymentOrder(db, input, id, attemptId);
    }
    throw err;
  }

  await persistProviderTradeNo(db, id, attemptId, payResult);
  // 纵深防御：同时限定 id + tenantId，防止初次创建后跨租户查询
  const [order] = await db.select().from(paymentOrders).where(and(eq(paymentOrders.id, id), eq(paymentOrders.tenantId, input.tenantId))).limit(1);
  return { order: order!, payResult, accessToken };
}

/**
 * 恢复同一 pending 订单的当前支付尝试。
 *
 * 创建支付是数据库写入后的外部 I/O，不能放进事务；因此这里必须复用与首次下单/
 * 重试相同的错误分类：确定性失败取消并释放名额，不确定失败保留 pending 等待回调或再次恢复。
 * 路由层不应自行调用 Provider，否则很容易漏掉这条状态机分支。
 */
export async function resumePendingPaymentOrder(
  db: DbType,
  input: CreateOrderInput,
  provider: PaymentProvider,
  orderId: string,
  attemptId: string,
): Promise<{ order: typeof paymentOrders.$inferSelect; payResult: CreatePaymentResult }> {
  let payResult: CreatePaymentResult;
  try {
    payResult = await provider.createPayment({
      orderNo: attemptId,
      amountCents: input.amountCents,
      currency: input.currency,
      notifyUrl: input.notifyUrl,
      returnUrl: input.returnUrl,
      description: input.description,
    });
  } catch (err) {
    if (shouldCancelOrderAfterCreateFailure(err)) {
      await cancelPaymentOrder(db, input, orderId, attemptId);
    }
    throw err;
  }

  await persistProviderTradeNo(db, orderId, attemptId, payResult);
  // 纵深防御：同时限定 id + tenantId，防止恢复订单时跨租户查询
  const [order] = await db.select().from(paymentOrders).where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.tenantId, input.tenantId))).limit(1);
  if (!order) throw new Error("订单不存在");
  return { order, payResult };
}

/** 重试已取消 / 已过期订单：复用同一逻辑订单，但为网关创建全新的 attempt/orderNo。 */
export async function retryPaymentOrder(
  db: DbType,
  input: CreateOrderInput,
  provider: PaymentProvider,
  orderId: string,
): Promise<{ order: typeof paymentOrders.$inferSelect; payResult: CreatePaymentResult; accessToken: string }> {
  const [existing] = await db
    .select()
    .from(paymentOrders)
    .where(and(
      eq(paymentOrders.id, orderId),
      eq(paymentOrders.tenantId, input.tenantId),
      eq(paymentOrders.drawId, input.drawId),
    ))
    .limit(1);
  if (!existing) {
    throw new Error("订单不存在");
  }
  if (!isRetryablePaymentOrderStatus(existing.status)) {
    throw new Error("订单不可重试");
  }

  const retryState = await armPaymentOrderForRetry(db, input, existing.id);

  let payResult: CreatePaymentResult;
  try {
    payResult = await provider.createPayment({
      orderNo: retryState.attemptId,
      amountCents: retryState.amountCents,
      currency: retryState.currency,
      notifyUrl: input.notifyUrl,
      returnUrl: input.returnUrl,
      description: input.description,
    });
  } catch (err) {
    if (shouldCancelOrderAfterCreateFailure(err)) {
      await cancelPaymentOrder(db, input, existing.id, retryState.attemptId);
    }
    throw err;
  }

  await persistProviderTradeNo(db, existing.id, retryState.attemptId, payResult);
  // 纵深防御：同时限定 id + tenantId，防止重试时跨租户查询
  const [order] = await db.select().from(paymentOrders).where(and(eq(paymentOrders.id, existing.id), eq(paymentOrders.tenantId, input.tenantId))).limit(1);
  return { order: order!, payResult, accessToken: retryState.accessToken };
}

/**
 * 支付回调处理：验签 → attempt 绑定 → 幂等 → 事务内取卡密/更新订单。
 *
 * 回调的 orderNo 永远是 payment_order_attempts.id，而不是逻辑订单 id。
 * 旧 attempt 迟到付款只记录为 paid_late_needs_refund，不会占用新 attempt 的名额。
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

  // 纵深防御：同时限定 attemptId + tenantId，回调未验租户前即排除跨租户 attempt
  const [preAttempt] = await db
    .select()
    .from(paymentOrderAttempts)
    .where(and(eq(paymentOrderAttempts.id, callback.orderNo), eq(paymentOrderAttempts.tenantId, tenantId)))
    .limit(1);
  if (!preAttempt) return { processed: false, error: "支付尝试不存在" };
  if (preAttempt.tenantId !== tenantId) return { processed: false, error: "租户不匹配" };
  if (preAttempt.provider !== provider.name) return { processed: false, error: "支付渠道不匹配" };
  const callbackCurrency = String(callback.currency || "").trim().toLowerCase();
  const attemptCurrency = String(preAttempt.currency || "").trim().toLowerCase();
  if (callback.amountCents !== preAttempt.amountCents || callbackCurrency !== attemptCurrency) {
    return { processed: false, error: "金额或币种不匹配" };
  }

  const result = await withDbTransaction(db, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(paymentOrderAttempts)
      .where(and(eq(paymentOrderAttempts.id, preAttempt.id), eq(paymentOrderAttempts.tenantId, tenantId)))
      .limit(1);
    const [current] = await tx
      .select()
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.id, preAttempt.paymentOrderId),
        eq(paymentOrders.tenantId, tenantId),
      ))
      .limit(1);
    if (!attempt || !current) return { order: null, handled: false };
    if (isPaidPaymentAttemptStatus(attempt.status)) {
      return { order: current, handled: true };
    }

    const isCurrentAttempt = current.currentAttemptId === attempt.id;
    const markAttemptLate = async () => {
      await tx
        .update(paymentOrderAttempts)
        .set({
          status: PAYMENT_ATTEMPT_STATUS.LATE_NEEDS_REFUND,
          providerTradeNo: callback.providerTradeNo,
          paidAt: callback.paidAt,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(and(
          eq(paymentOrderAttempts.id, attempt.id),
          eq(paymentOrderAttempts.status, attempt.status),
        ));
    };

    if (!isCurrentAttempt || current.status !== PAYMENT_ORDER_STATUS.PENDING) {
      await markAttemptLate();
      if (isCurrentAttempt) {
        await tx
          .update(paymentOrders)
          .set({
            status: PAYMENT_ORDER_STATUS.LATE_NEEDS_REFUND,
            providerTradeNo: callback.providerTradeNo,
            paidAt: callback.paidAt,
            updatedAt: sql`(datetime('now'))`,
          })
          .where(and(
            eq(paymentOrders.id, current.id),
            eq(paymentOrders.status, current.status),
          ));
      }
      const [updated] = await tx.select().from(paymentOrders).where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId))).limit(1);
      return { order: updated ?? current, handled: true };
    }

    const [entry] = await tx
      .select({ paymentStatus: lotteryEntries.paymentStatus })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.id, current.entryId),
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.drawId, current.drawId),
      ))
      .limit(1);
    if (!entry || entry.paymentStatus !== PAYMENT_ENTRY_STATUS.PENDING) {
      // 支付事实已发生但 entry 无法继续履约，必须进入人工退款，不得静默成功。
      await markAttemptLate();
      await tx
        .update(paymentOrders)
        .set({
          status: PAYMENT_ORDER_STATUS.LATE_NEEDS_REFUND,
          providerTradeNo: callback.providerTradeNo,
          paidAt: callback.paidAt,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING)));
      const [late] = await tx.select().from(paymentOrders).where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId))).limit(1);
      return { order: late ?? current, handled: true };
    }

    const quantity = Math.max(1, Math.floor(Number(current.quantity || 1)));
    const acquiredPrizeCodeIds = await acquirePrizeCodes(tx, tenantId, current.drawId, current.entryId, current.id, quantity);

    // 卡密不足：标记 paid_fulfillment_failed（运营后台可见，docs/131 §7），不静默 null
    const newStatus = acquiredPrizeCodeIds.length === quantity
      ? PAYMENT_ORDER_STATUS.PAID
      : PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED;
    const paidAttempt = await tx
      .update(paymentOrderAttempts)
      .set({
        status: PAYMENT_ATTEMPT_STATUS.PAID,
        providerTradeNo: callback.providerTradeNo,
        paidAt: callback.paidAt,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(paymentOrderAttempts.id, attempt.id),
        eq(paymentOrderAttempts.status, PAYMENT_ATTEMPT_STATUS.PENDING),
      ))
      .returning({ id: paymentOrderAttempts.id });
    if (paidAttempt.length === 0) {
      throw new Error("支付尝试状态已变化，请重试回调");
    }

    // V2：把已领取的卡密依次绑定到订单明细（order_items），每件一条 fulfilled（docs/158）。
    // 卡密不足时 acquirePrizeCodes 已原子回滚本次试领并返回 []，明细保持 pending。
    if (acquiredPrizeCodeIds.length > 0) {
      await fulfillOrderItems(tx, tenantId, current.id, acquiredPrizeCodeIds);
    }

    const paidOrder = await tx
      .update(paymentOrders)
      .set({
        status: newStatus,
        providerTradeNo: callback.providerTradeNo,
        paidAt: callback.paidAt,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(paymentOrders.id, current.id),
        eq(paymentOrders.currentAttemptId, attempt.id),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
      ))
      .returning({ id: paymentOrders.id });
    if (paidOrder.length === 0) {
      throw new Error("支付订单状态已变化，请重试回调");
    }

    // entry 的 paid 只代表“已支付并完成发卡”。
    // 卡密不足时订单进入 paid_fulfillment_failed，entry 保持 pending 继续占位，
    // 等运营补发成功后再由 retryPaymentFulfillment 原子切换为 paid。
    if (acquiredPrizeCodeIds.length === quantity) {
      const paidEntry = await tx
        .update(lotteryEntries)
        .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PAID })
        .where(and(
          eq(lotteryEntries.id, current.entryId),
          eq(lotteryEntries.tenantId, tenantId),
          eq(lotteryEntries.drawId, current.drawId),
          eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
        ))
        .returning({ id: lotteryEntries.id });
      if (paidEntry.length === 0) {
        throw new Error("参与记录状态已变化，支付履约未提交");
      }
    }

    const [updated] = await tx.select().from(paymentOrders).where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId))).limit(1);
    return { order: updated ?? current, handled: true };
  });

  if (!result.order) return { processed: false, error: "订单不存在" };
  return { processed: result.handled, order: result.order };
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
    if (current.status === PAYMENT_ORDER_STATUS.PAID) return { order: current };
    if (current.status !== PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED) {
      return { error: "订单状态不允许补发" };
    }

    const pendingItems = await tx
      .select({ id: paymentOrderItems.id })
      .from(paymentOrderItems)
      .where(and(
        eq(paymentOrderItems.tenantId, tenantId),
        eq(paymentOrderItems.paymentOrderId, current.id),
        eq(paymentOrderItems.status, PAYMENT_ORDER_ITEM_STATUS.PENDING),
      ))
      .orderBy(paymentOrderItems.lineNo);
    if (pendingItems.length === 0) {
      return { error: "订单没有可补发的待处理明细" };
    }
    const acquiredPrizeCodeIds = await acquirePrizeCodes(
      tx,
      tenantId,
      current.drawId,
      current.entryId,
      current.id,
      pendingItems.length,
    );
    if (acquiredPrizeCodeIds.length !== pendingItems.length) return { error: "没有足够可用卡密，请先补充码池" };
    // V2：补发只绑定尚未履约的订单项，不能按订单总 quantity 重复领取卡密。
    await fulfillOrderItems(tx, tenantId, current.id, acquiredPrizeCodeIds);

    // 如果 entry 已因其他订单 PAID（例如用户同时创建了多个订单，其中一个先补发成功），
    // 则跳过 entry 更新；只有 PENDING 状态才需要推进。避免"参与记录状态已变化"异常。
    const [entryCheck] = await tx
      .select({ paymentStatus: lotteryEntries.paymentStatus })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.id, current.entryId),
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.drawId, current.drawId),
      ))
      .limit(1);
    if (entryCheck?.paymentStatus === PAYMENT_ENTRY_STATUS.PAID) {
      // 已 paid → 只更新订单，跳过 entry 更新
    } else if (entryCheck?.paymentStatus === PAYMENT_ENTRY_STATUS.PENDING) {
      const paidEntry = await tx
        .update(lotteryEntries)
        .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PAID })
        .where(and(
          eq(lotteryEntries.id, current.entryId),
          eq(lotteryEntries.tenantId, tenantId),
          eq(lotteryEntries.drawId, current.drawId),
          eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
        ))
        .returning({ id: lotteryEntries.id });
      if (paidEntry.length === 0) {
        throw new Error("参与记录状态已变化，请刷新后重试");
      }
    } else {
      throw new Error("参与记录状态异常，无法补发");
    }

    const updatedOrder = await tx
      .update(paymentOrders)
      .set({
        status: PAYMENT_ORDER_STATUS.PAID,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(paymentOrders.id, current.id),
        eq(paymentOrders.status, PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED),
      ))
      .returning({ id: paymentOrders.id });
    if (updatedOrder.length === 0) {
      throw new Error("订单状态已变化，请刷新后重试");
    }

    const [updated] = await tx.select().from(paymentOrders).where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId))).limit(1);
    return { order: updated ?? current };
  });

  if ("error" in order) return { ok: false, error: order.error };
  return { ok: true, order: order.order };
}

/**
 * 原子领取活动绑定的卡密奖品。批量直付必须全量领取成功才提交：
 * - 成功：返回 quantity 个 code id，并用 payment_order_id 建立订单级关联。
 * - 失败：释放本次已经试领的卡密，返回 []，避免用户已付款后只拿到半单。
 */
async function acquirePrizeCodes(
  db: DbType,
  tenantId: string,
  drawId: string,
  entryId: string,
  orderId: string,
  quantityRaw: number,
): Promise<string[]> {
  const quantity = Math.max(1, Math.floor(Number(quantityRaw || 1)));
  // 查活动的卡密奖（prizeType=code）
  const tier = await findCodePrize(db, tenantId, drawId);
  if (!tier?.prizeId) return [];

  const ids: string[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const acquired = await db
      .update(prizeCodes)
      .set({
        status: "issued",
        issuedAt: sql`(datetime('now'))`,
        winnerId: entryId,
        paymentOrderId: orderId,
      })
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
    const id = acquired[0]?.id;
    if (!id) {
      if (ids.length > 0) {
        await db
          .update(prizeCodes)
          .set({ status: "available", winnerId: "", paymentOrderId: null, issuedAt: null })
          .where(and(
            eq(prizeCodes.tenantId, tenantId),
            inArray(prizeCodes.id, ids),
            eq(prizeCodes.paymentOrderId, orderId),
            eq(prizeCodes.winnerId, entryId),
            eq(prizeCodes.status, "issued"),
          ));
      }
      return [];
    }
    ids.push(id);
  }
  return ids;
}

/**
 * V2：把已领取的卡密依次绑定到订单的 pending 明细（payment_order_items）。
 * 必须在 acquirePrizeCodes 成功（返回非空数组）后调用，且在同一事务内。
 * 如果领取的卡密数量与订单 pending 明细数量不一致，只会绑定到 min(领取数, 明细数) 件，
 * 余下的明细保持 pending（由人工补发/退款流程处理）。
 */
async function fulfillOrderItems(
  db: DbType,
  tenantId: string,
  orderId: string,
  prizeCodeIds: string[],
): Promise<void> {
  const pendingItems = await db
    .select({ id: paymentOrderItems.id })
    .from(paymentOrderItems)
    .where(and(
      eq(paymentOrderItems.tenantId, tenantId),
      eq(paymentOrderItems.paymentOrderId, orderId),
      eq(paymentOrderItems.status, PAYMENT_ORDER_ITEM_STATUS.PENDING),
    ))
    .orderBy(paymentOrderItems.lineNo);
  const bindCount = Math.min(prizeCodeIds.length, pendingItems.length);
  for (let i = 0; i < bindCount; i++) {
    await db
      .update(paymentOrderItems)
      .set({
        prizeCodeId: prizeCodeIds[i],
        status: PAYMENT_ORDER_ITEM_STATUS.FULFILLED,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(paymentOrderItems.id, pendingItems[i].id),
        eq(paymentOrderItems.tenantId, tenantId),
        eq(paymentOrderItems.status, PAYMENT_ORDER_ITEM_STATUS.PENDING),
      ));
  }
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
