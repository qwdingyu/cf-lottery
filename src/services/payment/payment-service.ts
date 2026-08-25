/**
 * 支付服务（秒杀卡密多租户直付，docs/131）
 *
 * 职责：
 * - 按租户加载/解密支付配置（tenant_configs.providers JSON，多租户隔离）
 * - 创建订单（payment_orders + payment_order_items，entryId 只做参与归属）
 * - 调用 cf-core Provider 创建支付（易支付/支付宝/Stripe）
 * - 支付回调验签 + 幂等 + 发卡密（prizeCodes available → issued 原子取卡）
 *
 * 复用 @usethink/cf-pay/catalog + /config-store（Provider 抽象经 cf-pay 上收，业务项目不直连 cf-core）。
 */
import { isAmbiguousEasyPayProviderError, PAYMENT_PROVIDER_CATALOG_SERVICE } from "@usethink/cf-pay/catalog";
import { logError } from "../../lib/logger";
import { isFlashSaleExperience } from "../../lib/activity-utils";
import type { CallbackResult, PaymentProvider, CreatePaymentResult } from "@usethink/cf-pay/catalog";
import { eq, and, desc, sql, inArray, isNull, max, ne, notInArray } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { DRAW_STATUS } from "../lottery/types";
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
  auditLogs,
} from "../../db/schema";
import { PAYMENT_PROVIDER_CATALOG, isValidProviderName } from "@usethink/cf-pay/catalog";
import { decryptPaymentConfigValue, isEncryptedPaymentConfigValue } from "@usethink/cf-pay/config-store";
import { parseFlashSaleConfig, resolveEffectiveStockLimit } from "../../lib/flash-sale-config";
import { settleRewardByPercent, cancelRewardPending } from "../lottery/reward";
import { dispatchWebhookDelivery } from "../lottery/integration";
import {
  isPaidPaymentAttemptStatus,
  isRetryablePaymentOrderStatus,
  PAYMENT_ATTEMPT_STATUS,
  PAYMENT_ENTRY_STATUS,
  PAYMENT_ORDER_ITEM_STATUS,
  PAYMENT_ORDER_STATUS,
} from "./payment-status";
import {
  type FulfillmentProvider,
  type FulfillmentResult,
  type FulfillmentRetryResult,
  isFulfillmentSuccessful,
  isFulfillmentAnyFailed,
} from "@usethink/cf-pay/fulfillment";

// systemConfig 表（用于读取运行时配置订单超时/价格上限等）
import { systemConfig as systemConfigTable } from "../../db/schema";

export type PaymentProviderName = "easypay" | "stripe" | "alipay";

/**
 * 外部履约 provider 所需的业务上下文。
 * 可由业务项目注入自定义 FulfillmentProvider，替换内置的卡密发卡逻辑。
 */
export interface LotteryContext {
  db: DbType;
  tenantId: string;
  drawId: string;
  entryId: string;
  orderId: string;
  quantity: number;
}

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
    //
    // 过期条件（docs/271 优化）：
    //   a) 超时：createdAt + timeoutMinutes < now（现有逻辑）
    //   b) 活动已结束：endAt < now（新增——活动结束后不应再接受付款）
    // 两者任一满足即过期，确保"活动结束"不会留下可付款的窗口期。
    const activityEndedClause = sql`EXISTS (
      SELECT 1 FROM lottery_draws
      WHERE lottery_draws.id = ${paymentOrders.drawId}
        AND lottery_draws.tenant_id = ${tenantId}
        AND datetime(lottery_draws.end_at) < datetime('now')
    )`;
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
        sql`(
          datetime(${paymentOrders.createdAt}) < ${cutoff}
          OR ${activityEndedClause}
        )`,
      ));

    const staleReservations = await tx
      .select({ id: lotteryEntries.id, drawId: lotteryEntries.drawId })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.RESERVED),
        sql`(
          datetime(${lotteryEntries.joinedAt}) < ${cutoff}
          OR EXISTS (
            SELECT 1 FROM lottery_draws
            WHERE lottery_draws.id = ${lotteryEntries.drawId}
              AND lottery_draws.tenant_id = ${tenantId}
              AND datetime(lottery_draws.end_at) < datetime('now')
          )
        )`,
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
        sql`(
          datetime(${paymentOrders.createdAt}) < ${cutoff}
          OR ${activityEndedClause}
        )`,
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

      // 4) 超时订单的容量释放：entry 已释放（toRelease）时释放完整 quantity；
      //    entry 未释放（keepActive，有其他有效订单）时只释放 quantity-1（额外件数），
      //    保留 entry 自身占用的 base 1，避免 activeParticipantCount 偏低（docs/199 §4）。
      const toReleaseSet = new Set(toRelease);
      for (const order of overdue) {
        const qty = Math.max(1, Math.floor(Number(order.quantity || 1)));
        // 若 entry 未释放（keepActive），只释放额外件数，保留 base 1
        const quantity = toReleaseSet.has(order.entryId) ? qty : Math.max(0, qty - 1);
        if (quantity > 0) {
          releaseByDraw.set(order.drawId, (releaseByDraw.get(order.drawId) || 0) + quantity);
        }
        // 释放该订单预占的卡密（P2 优化，docs/205）：reserved → available，供其他用户复用
        await releaseReservedPrizeCodes(tx, order.id, tenantId);
      }

      // 4b) 取消对应 reward_pending 事件（docs/271）：已释放的 entry 不再有付款确认机会，
      //     因此 sharer 的 pending 奖励应标记为 cancelled。仅对 toRelease 的 entry 执行。
      //     用 overdue 订单的 drawId 而非空字符串——cancelRewardPending 需要 drawId
      //     查询 attributed_join 事件以获取 sharerEntryId，空 drawId 会导致查询永远不匹配。
      const entryDrawMap = new Map(overdue.map((o) => [o.entryId, o.drawId]));
      for (const expiredEntryId of toRelease) {
        const drawId = entryDrawMap.get(expiredEntryId) || "";
        await cancelRewardPending(tx, tenantId, drawId, expiredEntryId, "payment_expired").catch((err) => {
          logError("payment-service", `cancelRewardPending entry=${expiredEntryId} draw=${drawId}`, err);
        });
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
        .returning({ drawId: lotteryEntries.drawId, id: lotteryEntries.id });
      for (const entry of releasedReserved) {
        releaseByDraw.set(entry.drawId, (releaseByDraw.get(entry.drawId) || 0) + 1);
        // 取消对应 reward_pending 事件（docs/271）：残留预占 entry 不再有付款机会，
        // 因此 sharer 的 pending 奖励应标记为 cancelled。
        await cancelRewardPending(tx, tenantId, entry.drawId, entry.id, "payment_expired").catch((err) => {
          logError("payment-service", `cancelRewardPending stale entry=${entry.id}`, err);
        });
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
    // 释放该订单预占的卡密（P2 优化，docs/205）：reserved → available
    await releaseReservedPrizeCodes(tx, orderId, input.tenantId);

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

    // 取消对应的 reward_pending 事件（docs/271）
    await cancelRewardPending(tx, input.tenantId, input.drawId, input.entryId, "payment_cancelled").catch((err) => {
      logError("payment-service", `cancelRewardPending entry=${input.entryId}`, err);
    });
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
    if (draw.status !== DRAW_STATUS.OPEN) {
      throw new Error("活动当前不可重试支付");
    }

    const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
    const isFlashSale = flashParsed.config != null || isFlashSaleExperience(draw.experienceType);
    const capacity = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
    if (!isFlashSale || capacity == null || capacity <= 0) {
      throw new Error("秒杀活动未配置可重试名额");
    }

    // ── 重试时的名额补占计算（docs/255 §3.5 P0-1）──
    // entry 的当前状态决定它此刻占用了几份名额（与 createPaymentOrder 的 base 1 语义一致）：
    //   · EXPIRED  ：订单超时/取消时已软释放，占 0 份 → 本次需补占 quantity 份。
    //   · RESERVED ：用户在超时后又调用 joinDraw 重新参与（reopened 分支已 +1），占 1 份
    //                → 本次只需补占 quantity - 1 份，否则会把同一份名额重复计入（超发）。
    // 其余状态（pending/paid）说明该 entry 另有生效中的订单，不允许在此重新预约。
    const [entryState] = await tx
      .select({ paymentStatus: lotteryEntries.paymentStatus })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
      ))
      .limit(1);
    if (!entryState) throw new Error("参与记录不存在");
    const priorEntryStatus = entryState.paymentStatus;
    if (
      priorEntryStatus !== PAYMENT_ENTRY_STATUS.EXPIRED
      && priorEntryStatus !== PAYMENT_ENTRY_STATUS.RESERVED
    ) {
      throw new Error("参与预约已失效，请重新参与");
    }

    // 名额必须先通过活动计数器 CAS 预约，再改 entry 状态。
    // 不能先把 entry 改回 pending 再检查，否则并发下会把已释放名额重复占用。
    const quantity = Math.max(1, Math.floor(Number(current.quantity || 1)));
    const reserveQuantity = priorEntryStatus === PAYMENT_ENTRY_STATUS.RESERVED
      ? quantity - 1
      : quantity;
    if (reserveQuantity > 0) {
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
        throw new Error("秒杀名额已被其他用户占用");
      }
    }

    // CAS 锁定读到的 entry 状态：若并发改变（如同时被 joinDraw / expireOverdueOrders 改写），
    // 这里返回 0 行 → 抛错回滚，上面的名额补占一并撤销。
    const rearmedEntry = await tx
      .update(lotteryEntries)
      .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PENDING })
      .where(and(
        eq(lotteryEntries.id, input.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
        eq(lotteryEntries.paymentStatus, priorEntryStatus),
      ))
      .returning({ id: lotteryEntries.id });
    if (rearmedEntry.length === 0) {
      throw new Error("秒杀名额已被其他用户占用");
    }

    // ── 重试时的卡密库存补占（docs/255 §十五 R-1）──
    // 订单超时/取消时 expireOverdueOrders / cancelPaymentOrder 已把预占卡密释放回 available，
    // 期间卡密可能被别人买走。若重试只补名额而不重新预占，用户付款后回调只能落到
    // acquirePrizeCodes 兜底，拿不到卡密就必然 FULFILLMENT_FAILED，只能靠退款兜底。
    // 与 createPaymentOrder 的源头扼杀语义对齐：拿不到足量卡密就拒绝重试
    // （抛错回滚整个事务，上面的名额补占与 entry 状态改写一并撤销）。
    const codePrize = await resolveCodePrizeForDraw(tx, input.tenantId, input.drawId);
    if (codePrize.kind === "ambiguous") {
      throw new Error(`活动配置了多个卡密奖品（${codePrize.count} 个），无法确定发卡目标，请联系运营调整奖品配置`);
    }
    if (codePrize.kind === "inactive") {
      throw new Error("活动的卡密奖品已停用，暂不可支付");
    }
    if (codePrize.kind === "unique") {
      // 幂等：正常路径下重试前预占已释放；若本订单仍持有 reserved 卡密
      //（并发释放竞态 / 人工补录的历史订单），只补差额，避免重复预占放大占用。
      const [heldRow] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(prizeCodes)
        .where(and(
          eq(prizeCodes.tenantId, input.tenantId),
          eq(prizeCodes.paymentOrderId, orderId),
          eq(prizeCodes.status, "reserved"),
        ));
      const needQuantity = quantity - Number(heldRow?.count ?? 0);
      if (needQuantity > 0) {
        const [stockRow] = await tx
          .select({ count: sql<number>`COUNT(*)` })
          .from(prizeCodes)
          .where(and(
            eq(prizeCodes.tenantId, input.tenantId),
            eq(prizeCodes.prizeId, codePrize.prizeId),
            eq(prizeCodes.status, "available"),
          ));
        const availableStock = Number(stockRow?.count ?? 0);
        if (availableStock < needQuantity) {
          throw new Error(`库存不足（可用 ${availableStock} 件，需要 ${needQuantity} 件）`);
        }
        const reservedCodeIds = await reservePrizeCodes(
          tx,
          input.tenantId,
          input.drawId,
          input.entryId,
          orderId,
          needQuantity,
        );
        // 并发下 COUNT 与预占之间仍可能被抢走，这里是最终判定。
        if ((reservedCodeIds?.length ?? 0) < needQuantity) {
          throw new Error("卡密库存不足");
        }
      }
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
  const registry = PAYMENT_PROVIDER_CATALOG_SERVICE.createRegistry(env);
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

/**
 * 统一的订单前置校验（docs/203 源头扼杀原则）
 *
 * 在创建订单的事务内执行所有前置检查，确保：
 * 1. 用户身份有效（源头扼杀——不让未验证身份的用户进入支付流程）
 * 2. 活动有效、时间未过期（源头扼杀——不让用户为已结束的活动下单）
 * 3. 库存充足（源头扼杀——不让用户为空库存下单，而不是付款后才说库存不足）
 * 4. 限购不超（源头扼杀——不让用户超限下单，而不是付款后检查）
 * 5. 订单未过期（源头扼杀——不让用户为过期订单支付）
 *
 * 所有校验在事务内原子执行，任一失败则事务回滚，用户不会进入付款阶段。
 * 新增校验只需在此函数加检查项，无需在多个入口打补丁。
 */
async function validateOrderPreconditions(
  tx: DbType,
  input: Pick<CreateOrderInput, "tenantId" | "drawId" | "entryId" | "quantity" | "unitPriceCents" | "amountCents">,
  entryRow: { id: string; tenantId: string; identityType: string | null; identityValue: string | null; paymentStatus: string | null },
  existingOrder: { id: string; status: string; createdAt: string } | null,
): Promise<{ ok: true; draw: { id: string; status: string; experienceType: string; promotionConfig: string; maxParticipants: number | null; endAt: string } } | { ok: false; error: string }> {
  const { tenantId, drawId, entryId } = input;
  const quantity = Math.max(1, Math.floor(Number(input.quantity || 1)));

  // 1. 用户身份有效性（docs/203 §3.1）
  // 源头扼杀：在订单创建时就验证身份，不让未验证身份的用户进入支付流程。
  if (!entryRow.identityType || !entryRow.identityValue) {
    return { ok: false, error: "参与身份未验证，请先完成身份验证" };
  }

  // 1a. entry 状态有效性（docs/203 复核）
  // 源头扼杀：entry 必须处于可下单状态（reserved 首次 / paid 追加），
  // 已过期（expired）或已取消（cancelled）的 entry 不允许创建订单。
  // expireOverdueOrders 会清理超时 reserved entry，但清理后 entry 仍存在于表中，
  // 如果不检查状态，用户可绕过名额限制重新下单。
  if (entryRow.paymentStatus !== "reserved" && entryRow.paymentStatus !== "paid") {
    return { ok: false, error: "参与预约已失效" };
  }

  // 1b. 金额一致性校验（docs/203 复核）
  // 源头扼杀：路由层 calculateFlashSalePrice 保证 amountCents = unitPriceCents * quantity，
  // 但后端应独立校验，防止路由层传入不一致的值导致订单金额错误（防御纵深）。
  // 注意：pricingSnapshotJson 和 unitPriceCents 可能为空（非秒杀场景），此时跳过。
  if (input.unitPriceCents && input.unitPriceCents > 0) {
    const expectedAmount = input.unitPriceCents * quantity;
    if (input.amountCents !== expectedAmount) {
      return { ok: false, error: `订单金额不一致（预期 ${expectedAmount}，收到 ${input.amountCents}）` };
    }
  }

  // 2. 活动有效性 + 时间检查（docs/203 §2.1）
  const [draw] = await tx
    .select({
      id: lotteryDraws.id,
      status: lotteryDraws.status,
      experienceType: lotteryDraws.experienceType,
      promotionConfig: lotteryDraws.promotionConfig,
      maxParticipants: lotteryDraws.maxParticipants,
      endAt: lotteryDraws.endAt,
    })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return { ok: false, error: "活动不存在" };
  if (draw.status !== "open") return { ok: false, error: "活动已结束，无法下单" };
  if (draw.endAt && new Date(draw.endAt).getTime() < Date.now()) {
    return { ok: false, error: "活动已结束" };
  }

  // 3. 库存充足性预检（docs/203 §2.2）
  const flashSaleParsed = parseFlashSaleConfig(draw.promotionConfig);
  // 源头扼杀：在用户下单时就检查卡密库存，不让用户为空库存创建订单并付款。
  // 必须与发卡侧（reservePrizeCodes / acquirePrizeCodes → findCodePrize）用同一个解析器，
  // 否则预检与发卡对"哪个奖品是卡密奖"的判断会分叉（docs/255 §八 P2-9）：
  //   - 旧实现取 lotteryPrizeTiers 任意一行（LIMIT 1 无 orderBy）再判类型，
  //     多奖档活动（实物奖 + 卡密奖）下预检整体失效；
  //   - 旧实现没有 active 过滤，会把已停用奖品的码池算成有库存；
  //   - 多卡密奖品 / 卡密奖品停用时发卡侧 fail-closed，而 reservePrizeCodes 把 null
  //     当作"非卡密活动无需预占"，订单照样创建并收款，回调时必然 FULFILLMENT_FAILED。
  // 因此这三种"发卡不可能成功"的配置必须在付款前拒绝。
  const codePrize = await resolveCodePrizeForDraw(tx, tenantId, drawId);
  if (codePrize.kind === "ambiguous") {
    return { ok: false, error: `活动配置了多个卡密奖品（${codePrize.count} 个），无法确定发卡目标，请联系运营调整奖品配置` };
  }
  if (codePrize.kind === "inactive") {
    return { ok: false, error: "活动的卡密奖品已停用，暂不可下单" };
  }
  if (codePrize.kind === "unique") {
    const [stockRow] = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(prizeCodes)
      .where(and(
        eq(prizeCodes.prizeId, codePrize.prizeId),
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.status, "available"),
      ));
    const availableStock = Number(stockRow?.count ?? 0);
    if (availableStock < quantity) {
      return { ok: false, error: `库存不足（可用 ${availableStock} 件，需要 ${quantity} 件）` };
    }
  }

  // 4. 限购检查（docs/203 §2.4）
  // 源头扼杀：累计检查历史已支付订单，不让用户超限下单。
  // 无论是否首次下单，均执行累计检查：
  // - 首次下单：alreadyBought = 0，0 + quantity > maxPerUser 即 quantity > maxPerUser
  // - 追加下单：统计已有 PAID / FULFILLMENT_FAILED 订单总量，加上当前数量不得超限
  // 防御纵深：即使路由层未限制 quantity，后端也能独立拦截超量下单。
  const maxPerUser = flashSaleParsed?.config?.maxPerUser ?? 1;
  if (maxPerUser > 0) {
    const [sumRow] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${paymentOrders.quantity}), 0)` })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, tenantId),
        eq(paymentOrders.drawId, drawId),
        eq(paymentOrders.entryId, entryId),
        inArray(paymentOrders.status, [PAYMENT_ORDER_STATUS.PAID, PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED]),
      ));
    const alreadyBought = Number(sumRow?.total ?? 0);
    if (alreadyBought + quantity > maxPerUser) {
      return { ok: false, error: `每人限购 ${maxPerUser} 件，已购买 ${alreadyBought} 件` };
    }
  }

  // 5. 订单未过期（docs/203 §2.3）
  // 源头扼杀：在用户提交支付请求时直接检查订单有效期，不让用户为已过期的订单支付。
  // 与 expireOverdueOrders 共用 payment_order_timeout_minutes 配置，基于 createdAt 计算过期时间，
  // 而不是依赖懒清理标记 status——避免懒清理尚未执行或配置变更时差导致的缺口。
  if (existingOrder?.status === PAYMENT_ORDER_STATUS.PENDING) {
    let timeoutMinutes = 30;
    try {
      const [row] = await tx
        .select({ value: systemConfigTable.value })
        .from(systemConfigTable)
        .where(eq(systemConfigTable.key, "payment_order_timeout_minutes"))
        .limit(1);
      if (row) {
        const parsed = Number(row.value || "");
        if (Number.isFinite(parsed) && parsed >= 1) timeoutMinutes = Math.floor(parsed);
      }
    } catch { /* 表不存在或未迁移 → 默认 30 */ }
    const createdAt = new Date(existingOrder.createdAt).getTime();
    if (Date.now() - createdAt > timeoutMinutes * 60 * 1000) {
      return { ok: false, error: "订单已过期，请重新参与" };
    }
  }

  return { ok: true, draw };
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
      // 防御纵深：检查订单是否已过期（docs/203 §2.3）
      // 不使用 expireOverdueOrders 的懒清理标记 status，而是直接基于 createdAt 计算过期时间。
      let timeoutMinutes = 30;
      try {
        const [row] = await tx
          .select({ value: systemConfigTable.value })
          .from(systemConfigTable)
          .where(eq(systemConfigTable.key, "payment_order_timeout_minutes"))
          .limit(1);
        if (row) {
          const parsed = Number(row.value || "");
          if (Number.isFinite(parsed) && parsed >= 1) timeoutMinutes = Math.floor(parsed);
        }
      } catch { /* 默认 30 */ }
      const createdAt = new Date(existingOrder.createdAt).getTime();
      if (Number.isFinite(createdAt) && Date.now() - createdAt > timeoutMinutes * 60 * 1000) {
        throw new Error("订单已过期，请重新参与");
      }
      throw new Error("订单已存在，请刷新后重试");
    }

    const quantity = Math.max(1, Math.floor(Number(input.quantity || 1)));
    // V2：查 entry 当前状态，决定是否已有前置订单（docs/158）。
    // - reserved（首次下单）：base=1 已在 joinDraw 时计入，需补 reserveQuantity = qty - 1
    // - paid/pending（再次购买）：base=1 已被之前订单消费，全额预约 reserveQuantity = qty
    const [entryRow] = await tx
      .select({
        paymentStatus: lotteryEntries.paymentStatus,
        identityType: lotteryEntries.identityType,
        identityValue: lotteryEntries.identityValue,
      })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.id, input.entryId), eq(lotteryEntries.tenantId, input.tenantId)))
      .limit(1);
    if (!entryRow) throw new Error("参与记录不存在");
    // ── existingOrder 语义（该 entry 在该 draw 下是否已有订单）──
    // existingOrder = 本函数开头按 (tenantId, drawId, entryId) 查到的最近一笔订单。
    // 它的两个用途：
    //   ① 订单去重：状态为 FULFILLMENT_FAILED / LATE_NEEDS_REFUND 时拒绝（等人工/补发），
    //      PENDING 时拒绝（已有未支付订单，防重复下单）。
    //   ② 名额预约计算：见下方 reserveQuantity。
    // hasPriorOrder = 是否已有任意状态的前置订单。
    const hasPriorOrder = existingOrder != null;
    // ── reserveQuantity 语义（本次需从活动名额中预约的件数）──
    // joinDraw 时已为每个参与 entry 计入 base 1 名额（activeParticipantCount + 1）。
    //   · 首次下单（hasPriorOrder=false）：base 1 已在 join 时计入，本次只需补足
    //     reserveQuantity = quantity - 1（qty=1 时不补，qty>1 时补额外件数）。
    //   · 追加下单（hasPriorOrder=true）：base 1 已被之前订单消费，本次全额预约
    //     reserveQuantity = quantity。
    const reserveQuantity = hasPriorOrder ? quantity : (quantity - 1);

    // 统一前置校验（docs/203 源头扼杀）：身份/活动有效期/库存/限购/金额一致性，任一失败即事务回滚
    const validation = await validateOrderPreconditions(tx, {
      ...input,
      quantity, unitPriceCents: input.unitPriceCents, amountCents: input.amountCents,
    }, {
      ...entryRow,
      id: input.entryId,
      tenantId: input.tenantId,
    }, existingOrder);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

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
      const isFlashSale = flashParsed.config != null || isFlashSaleExperience(draw.experienceType);
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
    // 下单时预占卡密库存（P2 优化，docs/205）：事务内与名额预约原子完成。
    // reservePrizeCodes 返回：
    //   null = 无卡密奖品（非秒杀直付），跳过预占
    //   []   = 有卡密但库存不足，throw 回滚事务（用户不进入支付流程）
    //   id[] = 预占成功
    const reservedCodeIds = await reservePrizeCodes(tx, input.tenantId, input.drawId, input.entryId, id, quantity);
    if (reservedCodeIds !== null && reservedCodeIds.length < quantity) {
      throw new Error("卡密库存不足");
    }
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
  fulfillmentProvider?: FulfillmentProvider<LotteryContext>,
): Promise<{ processed: boolean; order?: typeof paymentOrders.$inferSelect; error?: string }> {
  // ── 支付回调校验链（6 重防护，docs/203 复核）──
  // ① 验签：provider.verifyCallback 返回 null/false 直接拒绝
  // ② attempt 存在性 + 租户归属：SELECT by attemptId + tenantId，跨租户 attempt 被排除
  // ③ 支付渠道一致性：attempt.provider === provider.name
  // ④ 金额一致性：callback.amountCents === attempt.amountCents（防御路由层/网关篡改）
  // ⑤ 币种一致性：callback.currency === attempt.currency（防御多币种混淆）
  // ⑥ 幂等性：attempt.status 已 paid 时跳过，不重复发卡
  // ⑦ 订单当前 attempt 校验：current.currentAttemptId === attempt.id（旧 attempt 迟到付款走 LATE_NEEDS_REFUND）
  // ⑧ entry 状态校验：必须是 PENDING，否则标记 LATE_NEEDS_REFUND 等待人工退款
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
      // 用 attempt.status 快照做 WHERE：旧 attempt 可能处于 expired/failed 而非 pending，
      // 显式 PENDING 会造成 UPDATE 命中 0 行（迟到标记失效）。SQLite 串行化隔离下
      // 事务内快照始终最新，无需担心并发覆盖（docs/202 §5.2 复核结论）。
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

    // ── 履约分发：可注入外部 FulfillmentProvider，否则走内置卡密发卡 ──
    // 外部 provider 的 fulfill() 返回 FulfillmentResult，据此决定订单/entry 状态：
    //   fulfilled/not_applicable → PAID + entry PAID
    //   failed/partial_failed     → FULFILLMENT_FAILED，entry 保持 PENDING 等待补发
    let newStatus: string;
    let fulfillmentOk: boolean;
    let acquiredPrizeCodeIds: string[] = [];
    // percent 模式奖励结算：webhook deliveryIds 在事务外 dispatch（避免 fetch 阻塞事务）
    let settleDeliveryIds: string[] = [];

    if (fulfillmentProvider) {
      const fulfillmentResult: FulfillmentResult = await fulfillmentProvider.fulfill({
        db: tx,
        tenantId,
        drawId: current.drawId,
        entryId: current.entryId,
        orderId: current.id,
        quantity,
      });
      fulfillmentOk = isFulfillmentSuccessful(fulfillmentResult);
      newStatus = isFulfillmentAnyFailed(fulfillmentResult)
        ? PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED
        : PAYMENT_ORDER_STATUS.PAID;
    } else {
      // 确认下单时预占的卡密（reserved → issued，P2 优化，docs/205）。
      // 先确认预占：正常流程（createPaymentOrder 预占）下能命中 reserved 卡密。
      acquiredPrizeCodeIds = await confirmPrizeCodes(tx, current.id, quantity);
      // 兼容兜底：若订单无预占卡密（seed/旧订单/人工补录），回退到从 available 领取。
      // 避免这些历史订单回调时因无预占卡密而错误进入 FULFILLMENT_FAILED。
      if (acquiredPrizeCodeIds.length < quantity) {
        acquiredPrizeCodeIds = await acquirePrizeCodes(tx, tenantId, current.drawId, current.entryId, current.id, quantity);
      }
      // 卡密不足：标记 paid_fulfillment_failed（运营后台可见，docs/131 §7），不静默 null
      newStatus = acquiredPrizeCodeIds.length === quantity
        ? PAYMENT_ORDER_STATUS.PAID
        : PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED;
      fulfillmentOk = acquiredPrizeCodeIds.length === quantity;
      // V2：把已领取的卡密依次绑定到订单明细（order_items），每件一条 fulfilled（docs/158）。
      // 卡密不足时 acquirePrizeCodes 已原子回滚本次试领并返回 []，明细保持 pending。
      if (acquiredPrizeCodeIds.length > 0) {
        await fulfillOrderItems(tx, tenantId, current.id, acquiredPrizeCodeIds);
      }
    }

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
    if (fulfillmentOk) {
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

      // percent 模式奖励结算（docs/271）：付款确认后，计算邀请人应得佣金并通知中转站。
      // 幂等性：settleRewardByPercent 内部通过查找 reward_pending 事件隐式幂等——
      // 同一 entry 的 attributed_join 事件唯一，reward_earned 事件写入后不会重复触发。
      // 执行失败时（如活动未配置 percent 奖励）静默跳过，不影响支付主流程。
      if (fulfillmentOk && current.amountCents > 0) {
        const settleResult = await settleRewardByPercent(tx, tenantId, current.drawId, current.entryId, current.amountCents, current.currency).catch((err) => {
          logError("payment-service", `settleRewardByPercent draw=${current.drawId} entry=${current.entryId}`, err);
          return { settled: false, deliveryIds: [] as string[] };
        });
        settleDeliveryIds = settleResult.deliveryIds || [];
      }
    }

    const [updated] = await tx.select().from(paymentOrders).where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId))).limit(1);
    return { order: updated ?? current, handled: true, settleDeliveryIds };
  });

  if (!result.order) return { processed: false, error: "订单不存在" };

  // 事务外异步 dispatch webhook（与 maybeTriggerReward 一致：fire-and-forget，失败不影响主流程）
  if (result.settleDeliveryIds && result.settleDeliveryIds.length > 0) {
    for (const deliveryId of result.settleDeliveryIds) {
      void dispatchWebhookDelivery(db, tenantId, deliveryId).catch((err) => {
        logError("payment-service", `settleRewardByPercent webhook dispatch delivery=${deliveryId}`, err);
      });
    }
  }

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
  fulfillmentProvider?: FulfillmentProvider<LotteryContext>,
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

    // 分支判据：`fulfillmentProvider?.retry` —— retry 是接口可选方法。
    // 有外部补发能力时优先交给 provider.retry()；未实现 retry 的 provider
    // （`?.` 取到 undefined）或未注入 provider 时，走下方内置兜底（释放残留预留码→重领卡密→绑定明细），
    // 保证管理端补发入口对"是否注入 provider"完全幂等。
    if (fulfillmentProvider?.retry) {
      const retryResult: FulfillmentRetryResult = await fulfillmentProvider.retry({
        db: tx,
        tenantId,
        drawId: current.drawId,
        entryId: current.entryId,
        orderId: current.id,
        quantity: Math.max(1, Math.floor(Number(current.quantity || 1))),
      });
      if (!retryResult.ok) {
        return { error: retryResult.error || "补发失败" };
      }
    } else {
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
      // FULFILLMENT_FAILED 残留预留码释放（P1 修复）：
      // 回调流程先 confirmPrizeCodes（reserved→issued）再兜底 acquirePrizeCodes，卡密不足时 acquire 会原子回滚，
      // 但任何未确认的预占码都会永久卡在 reserved。补发前先统一释放本订单残留的 reserved 码回 available，
      // 避免码池永久泄漏（与 expireOverdueOrders / cancelPaymentOrder 的释放语义一致）。
      await releaseReservedPrizeCodes(tx, current.id, tenantId);
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
    }

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

    // percent 模式奖励结算：补发成功后，计算邀请人应得佣金（幂等，与 handlePaymentCallback 一致）
    let settleDeliveryIds: string[] = [];
    if (current.amountCents > 0) {
      const settleResult = await settleRewardByPercent(tx, tenantId, current.drawId, current.entryId, current.amountCents, current.currency).catch((err) => {
        logError("payment-service", `retryPaymentFulfillment: settleRewardByPercent draw=${current.drawId} entry=${current.entryId}`, err);
        return { settled: false, deliveryIds: [] as string[] };
      });
      settleDeliveryIds = settleResult.deliveryIds || [];
    }

    const [updated] = await tx.select().from(paymentOrders).where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId))).limit(1);
    return { order: updated ?? current, settleDeliveryIds };
  });

  if ("error" in order) return { ok: false, error: order.error };

  // 事务外异步 dispatch webhook（与 handlePaymentCallback 一致）
  if (order.settleDeliveryIds && order.settleDeliveryIds.length > 0) {
    for (const deliveryId of order.settleDeliveryIds) {
      void dispatchWebhookDelivery(db, tenantId, deliveryId).catch((err) => {
        logError("payment-service", `retryPaymentFulfillment webhook delivery=${deliveryId}`, err);
      });
    }
  }

  return { ok: true, order: order.order };
}

/**
 * 管理端退款执行（docs/131 §8 退款闭环修复）。
 *
 * 背景：paid_late_needs_refund / paid_fulfillment_failed 此前只有状态标记，没有任何退款执行路径；
 * cf-core 的 PaymentProvider.refund 是可选接口，当前所有 provider 都未实现（easypay 明确不实现）。
 * 因此这里不能盲目调用 provider.refund()：
 *   1. 按 order.provider 精确加载租户配置取 provider（allowDisabled:true，退款是存量订单收尾，不要求渠道当前启用）；
 *   2. 仅当 provider.refund 存在才发起自动退款，否则只做本地状态收尾（人工线下退款后由运营点击确认标记）。
 *
 * 流程：
 * 1. 前置校验：订单存在且状态 ∈ {paid, paid_fulfillment_failed, paid_late_needs_refund}；
 *    有已核销（redeemed）卡密的订单拒绝退款——用户已实际消费卡密，退款会造成"钱退人、卡被用"双重损失，只能人工线下处理。
 * 2. 自动退款（provider.refund 存在时）：调用 refund({ providerTradeNo, refundCents, reason })；
 *    调用抛错或 success=false 都抛错、绝不推进本地状态，防止"网关没退、本地已退"的资金黑洞。
 * 3. 事务内收尾：
 *    - order.status → refunded；currentAttempt.status → refunded；
 *    - order_items（pending/fulfilled）→ refunded（明细级履约收尾，docs/158）；
 *    - 该订单已发卡密（issued 且 paymentOrderId=order）→ revoked（保留 winnerId/paymentOrderId 审计，不物理删除）；
 *    - 残留 reserved 码释放回 available（防码池泄漏）；
 *    - entry 释放逻辑与 cancelPaymentOrder 一致：查该 entry 是否还有其他有效订单
 *      （PAID / FULFILLMENT_FAILED / PENDING，排除本订单）→ 有则 entry 保持（PAID/FF 存在时恢复为 paid）；
 *      无则 entry.paymentStatus → EXPIRED 并 decrementActiveFlashSaleCount(quantity) 释放名额；
 *    - 写租户审计（auditLogs，action: "payment.order.refund"）——退款是资金敏感操作，必须与状态迁移同事务留痕。
 *
 * @param options.provider 可注入的 Provider（测试用）；不传时按 order.provider 从租户配置加载。
 */
export async function refundPaymentOrder(
  db: DbType,
  tenantId: string,
  orderId: string,
  actorUserId: string,
  options: { encryptionKey?: string; reason?: string; provider?: PaymentProvider } = {},
): Promise<{ ok: true; order: typeof paymentOrders.$inferSelect }> {
  // 纵深防御：同时限定 id + tenantId，防止跨租户退款
  const [current] = await db
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.tenantId, tenantId)))
    .limit(1);
  if (!current) throw new Error("订单不存在");

  const refundableStatuses: string[] = [
    PAYMENT_ORDER_STATUS.PAID,
    PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED,
    PAYMENT_ORDER_STATUS.LATE_NEEDS_REFUND,
  ];
  if (!refundableStatuses.includes(current.status)) {
    // 幂等保护：已 refunded / pending / expired / cancelled 一律拒绝，防止重复退款或对未支付订单退款
    throw new Error(`订单状态 ${current.status} 不允许退款`);
  }

  // 已核销卡密拒绝退款：卡已被用户消费，退款会直接造成资损，只能人工线下处理
  const [redeemed] = await db
    .select({ id: prizeCodes.id })
    .from(prizeCodes)
    .where(and(
      eq(prizeCodes.paymentOrderId, orderId),
      eq(prizeCodes.tenantId, tenantId),
      eq(prizeCodes.status, "redeemed"),
    ))
    .limit(1);
  if (redeemed) {
    throw new Error("订单包含已核销卡密，无法自动退款，请人工线下处理");
  }

  // 自动退款：仅当 provider 实现了 refund 才调用（当前全部 provider 未实现 → 走人工退款标记）
  let provider = options.provider;
  if (!provider) {
    const loaded = await loadTenantConfig(db, tenantId, options.encryptionKey, {
      provider: current.provider,
      allowDisabled: true, // 退款是存量订单收尾，不要求渠道当前处于启用状态
    });
    if (loaded) provider = createTenantProvider(loaded.env, current.currency) ?? undefined;
  }
  if (provider?.refund) {
    if (!current.providerTradeNo) {
      // 缺少平台交易号无法发起网关退款；本地标记退款会掩盖"钱还在用户账户"的事实，必须 fail closed
      throw new Error("订单缺少支付平台交易号，无法自动退款，请人工线下处理");
    }
    let refundResult;
    try {
      refundResult = await provider.refund({
        providerTradeNo: current.providerTradeNo,
        refundCents: Number(current.amountCents),
        reason: options.reason || "运营退款",
      });
    } catch (err) {
      // 网关调用失败不推进本地状态，避免"网关没退、本地已退"的资金黑洞
      throw new Error(`支付平台退款调用失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!refundResult.success) {
      throw new Error(`支付平台退款被拒绝（${refundResult.status || "unknown"}），请人工线下处理`);
    }
  }

  const order = await withDbTransaction(db, async (tx) => {
    // 用 status 快照做乐观锁：并发两次退款只有一次能命中，天然幂等
    const updated = await tx
      .update(paymentOrders)
      .set({ status: PAYMENT_ORDER_STATUS.REFUNDED, updatedAt: sql`(datetime('now'))` })
      .where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.status, current.status)))
      .returning({ id: paymentOrders.id });
    if (updated.length === 0) {
      throw new Error("订单状态已变化，请刷新后重试");
    }

    // 当前支付尝试 → refunded（只更新已支付/待退款状态的尝试，避免覆盖其它终态）
    if (current.currentAttemptId) {
      await tx
        .update(paymentOrderAttempts)
        .set({ status: PAYMENT_ATTEMPT_STATUS.REFUNDED, updatedAt: sql`(datetime('now'))` })
        .where(and(
          eq(paymentOrderAttempts.id, current.currentAttemptId),
          eq(paymentOrderAttempts.paymentOrderId, current.id),
          inArray(paymentOrderAttempts.status, [
            PAYMENT_ATTEMPT_STATUS.PAID,
            PAYMENT_ATTEMPT_STATUS.LATE_NEEDS_REFUND,
          ]),
        ));
    }

    // 订单明细（pending/fulfilled）→ refunded：明细级履约收尾，与 payment_orders.status 解耦
    await tx
      .update(paymentOrderItems)
      .set({ status: PAYMENT_ORDER_ITEM_STATUS.REFUNDED, updatedAt: sql`(datetime('now'))` })
      .where(and(
        eq(paymentOrderItems.tenantId, tenantId),
        eq(paymentOrderItems.paymentOrderId, current.id),
        inArray(paymentOrderItems.status, [
          PAYMENT_ORDER_ITEM_STATUS.PENDING,
          PAYMENT_ORDER_ITEM_STATUS.FULFILLED,
        ]),
      ));

    // 已发卡密 → revoked：保留 winnerId/paymentOrderId 审计，不物理删除，防止退款后再现卡密
    await tx
      .update(prizeCodes)
      .set({ status: "revoked", issuedAt: sql`(datetime('now'))` })
      .where(and(
        eq(prizeCodes.paymentOrderId, current.id),
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.status, "issued"),
      ));
    // 残留 reserved 码释放回 available（防泄漏，与 expireOverdueOrders/cancelPaymentOrder 一致）
    await releaseReservedPrizeCodes(tx, current.id, tenantId);

    // entry 释放：仿照 cancelPaymentOrder 的两步策略（docs/158 V2 语义）
    if (current.entryId) {
      // 1) 有 PAID/FULFILLMENT_FAILED 的其他订单 → entry 恢复为 paid（仍有有效履约，不能释放名额）
      const [paidOrder] = await tx
        .select({ id: paymentOrders.id })
        .from(paymentOrders)
        .where(and(
          eq(paymentOrders.tenantId, tenantId),
          eq(paymentOrders.entryId, current.entryId),
          ne(paymentOrders.id, current.id),
          inArray(paymentOrders.status, [
            PAYMENT_ORDER_STATUS.PAID,
            PAYMENT_ORDER_STATUS.FULFILLMENT_FAILED,
          ]),
        ))
        .limit(1);
      if (paidOrder) {
        await tx
          .update(lotteryEntries)
          .set({ paymentStatus: PAYMENT_ENTRY_STATUS.PAID })
          .where(and(
            eq(lotteryEntries.id, current.entryId),
            eq(lotteryEntries.tenantId, tenantId),
            eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PENDING),
          ));
      } else {
        // 2) 有其他 PENDING 订单 → 保持 entry 现状（仍有在途支付占位）
        const [otherPending] = await tx
          .select({ id: paymentOrders.id })
          .from(paymentOrders)
          .where(and(
            eq(paymentOrders.tenantId, tenantId),
            eq(paymentOrders.entryId, current.entryId),
            ne(paymentOrders.id, current.id),
            eq(paymentOrders.status, PAYMENT_ORDER_STATUS.PENDING),
          ))
          .limit(1);
        if (!otherPending) {
          // 3) 无其他有效订单 → 释放 entry 为 expired 并扣减该订单 quantity 名额
          await tx
            .update(lotteryEntries)
            .set({ paymentStatus: PAYMENT_ENTRY_STATUS.EXPIRED })
            .where(and(
              eq(lotteryEntries.id, current.entryId),
              eq(lotteryEntries.tenantId, tenantId),
              inArray(lotteryEntries.paymentStatus, [
                PAYMENT_ENTRY_STATUS.PENDING,
                PAYMENT_ENTRY_STATUS.PAID,
              ]),
            ));
          const quantity = Math.max(1, Math.floor(Number(current.quantity || 1)));
          await decrementActiveFlashSaleCount(tx, tenantId, current.drawId, quantity);

          // percent 模式奖励清理：退款且无其他有效订单时，取消对应的 reward_pending 事件。
          // 容错：失败不影响退款主流程（审计事件已落库）。
          await cancelRewardPending(tx, tenantId, current.drawId, current.entryId, "payment_refunded").catch((err) => {
            logError("payment-service", `refundPaymentOrder cancelRewardPending order=${current.id} draw=${current.drawId}`, err);
          });
        }
      }
    }

    // 审计：退款是资金敏感操作，与状态迁移同事务写入，失败即整体回滚
    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId,
      action: "payment.order.refund",
      targetType: "payment_order",
      targetId: current.id,
      metadataJson: JSON.stringify({
        reason: options.reason || "",
        providerRefund: Boolean(provider?.refund),
        previousStatus: current.status,
        providerTradeNo: current.providerTradeNo || "",
      }),
    });

    const [finalOrder] = await tx
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.id, current.id), eq(paymentOrders.tenantId, tenantId)))
      .limit(1);
    return finalOrder!;
  });

  return { ok: true, order };
}

/**
 * 原子领取活动绑定的卡密奖品。批量直付必须全量领取成功才提交：
 * - 成功：返回 quantity 个 code id，并用 payment_order_id 建立订单级关联。
 * - 失败：释放本次已经试领的卡密，返回 []，避免用户已付款后只拿到半单。
 */
export async function acquirePrizeCodes(
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
 * 下单时预占卡密库存（P2 优化，docs/205）。
 *
 * 与 acquirePrizeCodes 逻辑相同，但目标状态为 reserved（而非 issued），
 * 在 createPaymentOrder 事务内执行，与名额预约原子完成。
 * 回调时由 confirmPrizeCodes 把 reserved → issued。
 *
 * 不足时回滚已预占的卡密，返回 []。
 * 预占的卡密在订单超时/取消时由 expireOverdueOrders / cancelPaymentOrder 释放回 available。
 */
export async function reservePrizeCodes(
  db: DbType,
  tenantId: string,
  drawId: string,
  entryId: string,
  orderId: string,
  quantityRaw: number,
): Promise<string[] | null> {
  const quantity = Math.max(1, Math.floor(Number(quantityRaw || 1)));
  // docs/255 R-4：用 resolveCodePrizeForDraw 替代 findCodePrize，消除 null 二义性。
  // findCodePrize 在 inactive/ambiguous 时也返回 null，调用方无法区分"无卡密奖"与"解析失败"。
  // resolveCodePrizeForDraw 返回四态：
  //   none       → 返回 null（无卡密奖品，非秒杀直付，跳过预占）
  //   unique     → 预占卡密
  //   inactive   → 返回 []（卡密奖品已停用，预占失败）
  //   ambiguous  → 返回 []（多个卡密奖品，无法确定发卡目标，预占失败）
  const resolved = await resolveCodePrizeForDraw(db, tenantId, drawId);
  if (resolved.kind === "none") return null;
  if (resolved.kind !== "unique") return []; // inactive / ambiguous → 预占失败

  const ids: string[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const acquired = await db
      .update(prizeCodes)
      .set({
        status: "reserved",
        winnerId: entryId,
        paymentOrderId: orderId,
      })
      .where(and(
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.status, "available"),
        eq(prizeCodes.prizeId, resolved.prizeId),
        eq(prizeCodes.id, sql<string>`(
          SELECT id FROM prize_codes
          WHERE tenant_id = ${tenantId}
            AND prize_id = ${resolved.prizeId}
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
          .set({ status: "available", winnerId: "", paymentOrderId: null })
          .where(and(
            eq(prizeCodes.tenantId, tenantId),
            inArray(prizeCodes.id, ids),
            eq(prizeCodes.status, "reserved"),
          ));
      }
      return [];
    }
    ids.push(id);
  }
  return ids;
}

/**
 * 支付回调时确认预占的卡密（reserved → issued，P2 优化，docs/205）。
 *
 * 在 handlePaymentCallback 事务内调用，把该订单（orderId）预占的 reserved 卡密转为 issued。
 * 不足时回滚已确认的卡密并返回 []（极少发生，仅在并发下单时预占卡密被其他订单共用）。
 */
export async function confirmPrizeCodes(
  tx: DbType,
  orderId: string,
  quantityRaw: number,
): Promise<string[]> {
  const quantity = Math.max(1, Math.floor(Number(quantityRaw || 1)));
  const ids: string[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const updated = await tx
      .update(prizeCodes)
      .set({
        status: "issued",
        issuedAt: sql`(datetime('now'))`,
      })
      .where(and(
        eq(prizeCodes.paymentOrderId, orderId),
        eq(prizeCodes.status, "reserved"),
        eq(prizeCodes.id, sql<string>`(
          SELECT id FROM prize_codes
          WHERE payment_order_id = ${orderId}
            AND status = 'reserved'
          ORDER BY id
          LIMIT 1
        )`),
      ))
      .returning({ id: prizeCodes.id });
    const id = updated[0]?.id;
    if (!id) {
      if (ids.length > 0) {
        await tx
          .update(prizeCodes)
          .set({ status: "reserved" })
          .where(and(
            eq(prizeCodes.paymentOrderId, orderId),
            inArray(prizeCodes.id, ids),
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
 * 释放订单预占的卡密（reserved → available，P2 优化，docs/205）。
 *
 * 在订单超时（expireOverdueOrders）或取消（cancelPaymentOrder）时调用，
 * 把该订单预占的 reserved 卡密释放回 available，供其他用户使用。
 */
export async function releaseReservedPrizeCodes(
  tx: DbType,
  orderId: string,
  tenantId: string,
): Promise<void> {
  await tx
    .update(prizeCodes)
    .set({ status: "available", winnerId: "", paymentOrderId: null })
    .where(and(
      eq(prizeCodes.paymentOrderId, orderId),
      eq(prizeCodes.tenantId, tenantId),
      eq(prizeCodes.status, "reserved"),
    ));
}

/**
 * V2：把已领取的卡密依次绑定到订单的 pending 明细（payment_order_items）。
 * 必须在 acquirePrizeCodes 成功（返回非空数组）后调用，且在同一事务内。
 * 如果领取的卡密数量与订单 pending 明细数量不一致，只会绑定到 min(领取数, 明细数) 件，
 * 余下的明细保持 pending（由人工补发/退款流程处理）。
 */
export async function fulfillOrderItems(
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
 * 活动卡密奖品解析结果（docs/255 §八 P2-9）。
 *
 * 下单预检与发卡必须共用这一份判断，避免"预检说有库存、发卡说没奖品"的分叉：
 * - none      ：活动没有任何卡密奖档（虚拟/链接/邀请等玩法），不占用 prizeCodes 库存
 * - unique    ：唯一可用卡密奖品，可发卡
 * - inactive  ：有卡密奖档但奖品全部被停用（active=0），发卡必然失败
 * - ambiguous ：多个 active 卡密奖品，无法确定发卡目标，必须 fail-closed
 */
type CodePrizeResolution =
  | { kind: "none" }
  | { kind: "unique"; prizeId: string }
  | { kind: "inactive" }
  | { kind: "ambiguous"; count: number };

async function resolveCodePrizeForDraw(
  db: DbType,
  tenantId: string,
  drawId: string,
): Promise<CodePrizeResolution> {
  const rows = await db
    .select({ prizeId: lotteryPrizeTiers.prizeId, active: prizes.active })
    .from(lotteryPrizeTiers)
    .innerJoin(prizes, and(
      eq(prizes.id, lotteryPrizeTiers.prizeId),
      eq(prizes.tenantId, tenantId),
      eq(prizes.prizeType, "code"),
    ))
    .where(and(eq(lotteryPrizeTiers.tenantId, tenantId), eq(lotteryPrizeTiers.drawId, drawId)));
  if (rows.length === 0) return { kind: "none" };
  // 按 prizeId 去重：多个奖档指向同一个卡密奖品是合法配置（一等奖/二等奖共用同一码池），
  // 不去重会被误判成 ambiguous，导致整个活动发不出卡。
  const activePrizeIds = [...new Set(rows.filter((r) => r.active === 1).map((r) => r.prizeId))];
  if (activePrizeIds.length === 0) return { kind: "inactive" };
  if (activePrizeIds.length > 1) return { kind: "ambiguous", count: activePrizeIds.length };
  return { kind: "unique", prizeId: activePrizeIds[0]! };
}

/**
 * 查询活动唯一的卡密奖品（prizeType=code）的 prizeId，用于发卡。
 *
 * 发布预检会阻断多卡密奖品，但运行时仍必须 fail closed；否则脏配置下
 * `LIMIT 1` 会随机选中一个奖品，造成支付成功后发错卡。
 */
async function findCodePrize(db: DbType, tenantId: string, drawId: string) {
  const resolved = await resolveCodePrizeForDraw(db, tenantId, drawId);
  if (resolved.kind === "ambiguous") {
    // 多个卡密奖品命中：fail-closed 返回 null 且必须留日志，否则运营看不到发卡失败的真因（docs/202 §5.3-22）。
    logError("payment-service", `活动 ${drawId} 存在 ${resolved.count} 个卡密奖品，无法确定发卡目标（fail-closed）`);
  }
  return resolved.kind === "unique" ? { prizeId: resolved.prizeId } : null;
}


/**
 * 卡密过期维护（cron 调用，docs/111 §7.3 + docs/114 §4）。
 *
 * 把 status IN ('available','issued') 且 expiresAt 非空且 expiresAt < now 的码标记为 'expired'。
 * - available 过期：未发放的限时卡密到点即作废，防止过期码被后续领取/发放；
 * - issued 过期：已发放但用户未核销的限时卡密到点作废（不再允许核销）。
 * - redeemed 不进处理范围：已核销消费的事实必须保留，不能把核销记录改写成过期。
 *
 * 分批处理（bound limit，默认 500）避免长事务；返回实际处理行数供 maintenance 汇总。
 */
export async function expireExpiredPrizeCodes(db: DbType, limit = 500): Promise<number> {
  const now = new Date().toISOString();
  // 先按条件取 id 列表再按 id 更新：libSQL 不支持 UPDATE ... ORDER BY ... LIMIT（与 acquirePrizeCodes 同约束）
  const rows = await db
    .select({ id: prizeCodes.id })
    .from(prizeCodes)
    .where(and(
      inArray(prizeCodes.status, ["available", "issued"]),
      sql`${prizeCodes.expiresAt} IS NOT NULL AND ${prizeCodes.expiresAt} <> '' AND ${prizeCodes.expiresAt} < ${now}`,
    ))
    .limit(Math.max(1, Math.min(limit, 5000)));
  if (rows.length === 0) return 0;

  const result = await db
    .update(prizeCodes)
    .set({ status: "expired" })
    .where(and(
      inArray(prizeCodes.id, rows.map((row) => row.id)),
      // 双保险：只更新仍处于 available/issued 的码，避免把并发中被核销/作废的码覆盖
      inArray(prizeCodes.status, ["available", "issued"]),
    ));
  return result.rowsAffected ?? 0;
}
