/**
 * cf-lottery 卡密履约实现（FulfillmentProvider 参考实现，docs/131）。
 *
 * 包装支付服务中的卡密领取/绑定逻辑，适配 @usethink/cf-pay/fulfillment 契约。
 * 在支付回调事务内由 cf-pay 编排层调用，替代原有的内联发卡代码。
 *
 * ── 生命周期映射 ──
 * reserve()  → reservePrizeCodes（下单预占 reserved）
 * fulfill()  → confirmPrizeCodes + acquirePrizeCodes + fulfillOrderItems
 * retry()    → retryPaymentFulfillment 核心逻辑（释放残留 → 重新领取 → 绑定）
 * release()  → releaseReservedPrizeCodes（释放 reserved 回 available）
 *
 * ── 迁移目标 ──
 * 1. handlePaymentCallback 中的卡密逻辑抽出，由 provider.fulfill() 替代
 * 2. retryPaymentFulfillment 中的卡密逻辑抽出，由 provider.retry() 替代
 * 3. cf-pay 编排层统一管理 attempt/order/entry 状态机，provider 只关心卡密
 */
import type { FulfillmentProvider, FulfillmentResult, FulfillmentRetryResult } from "@usethink/cf-pay/fulfillment";
import type { DbType } from "../../db/client";
import {
  confirmPrizeCodes,
  acquirePrizeCodes,
  fulfillOrderItems,
  reservePrizeCodes,
  releaseReservedPrizeCodes,
} from "./payment-service";
/**
 * cf-lottery 履约上下文：支付回调事务内所需的所有参数。
 */
export interface LotteryContext {
  /** 数据库连接（在事务内） */
  db: DbType;
  /** 租户 ID */
  tenantId: string;
  /** 活动 ID */
  drawId: string;
  /** 参与记录 ID */
  entryId: string;
  /** 订单 ID */
  orderId: string;
  /** 需要领取的卡密数量 */
  quantity: number;
}

/**
 * cf-lottery 卡密履约 Provider。
 *
 * 所有方法假设在 {db} 的活跃事务内调用（由 cf-pay 编排层传入）。
 * 仅在 fulfill() 内处理卡密不足等预期内的履约失败；确定性错误（如事务冲突）直接抛错，
 * 由编排层回滚事务。
 */
export const lotteryFulfillmentProvider: FulfillmentProvider<LotteryContext> = {
  name: "lottery-prize-code",

  /**
   * 下单时预占卡密（reserved）。
   * 与 createPaymentOrder 事务内原子执行，由编排层在创建订单后调用。
   */
  async reserve(ctx: LotteryContext): Promise<void> {
    const ids = await reservePrizeCodes(ctx.db, ctx.tenantId, ctx.drawId, ctx.entryId, ctx.orderId, ctx.quantity);
    // reservePrizeCodes 返回 null（无卡密奖）或 []（余量不足）时静默通过，
    // 回调时由 acquirePrizeCodes 兜底；reserve 只做"尽力预占"。
    if (ids === null) return; // 无卡密奖品，无需预占
    if (ids.length === 0) {
      // 预占不足：记录日志但不下发异常，回调时由兜底逻辑处理
      console.warn(`[Fulfillment] 预占卡密不足: order=${ctx.orderId}, quantity=${ctx.quantity}, acquired=0`);
    }
  },

  /**
   * 支付确认后执行卡密领取与绑定。
   *
   * 1. 先确认预占卡密（reserved → issued）
   * 2. 不足时从 available 兜底领取
   * 3. 绑定到订单明细（order_items）
   *
   * 返回值直接决定订单终态：
   * - fulfilled       → 全部领取成功，订单进入 PAID
   * - partial_failed  → 部分领取成功，订单进入 FULFILLMENT_FAILED
   * - failed          → 完全无卡密，订单进入 FULFILLMENT_FAILED
   */
  async fulfill(ctx: LotteryContext): Promise<FulfillmentResult> {
    const quantity = Math.max(1, Math.floor(Number(ctx.quantity || 1)));

    // ① 确认预占卡密（reserved → issued）
    let acquiredPrizeCodeIds = await confirmPrizeCodes(ctx.db, ctx.orderId, quantity);

    // ② 兼容兜底：若订单无预占卡密，回退到从 available 领取
    if (acquiredPrizeCodeIds.length < quantity) {
      acquiredPrizeCodeIds = await acquirePrizeCodes(
        ctx.db, ctx.tenantId, ctx.drawId, ctx.entryId, ctx.orderId, quantity,
      );
    }

    // ③ 绑定到订单明细
    if (acquiredPrizeCodeIds.length > 0) {
      await fulfillOrderItems(ctx.db, ctx.tenantId, ctx.orderId, acquiredPrizeCodeIds);
    }

    // ④ 结果判定
    if (acquiredPrizeCodeIds.length === quantity) {
      return { status: "fulfilled" };
    }
    if (acquiredPrizeCodeIds.length > 0) {
      return {
        status: "partial_failed",
        fulfilledCount: acquiredPrizeCodeIds.length,
        totalCount: quantity,
        error: `卡密不足：需 ${quantity} 张，实领 ${acquiredPrizeCodeIds.length} 张`,
      };
    }
    return { status: "failed", error: "无可用的卡密，请先补充码池" };
  },

  /**
   * 履约失败后重试（运营补发场景）。
   *
   * 先释放残留预留码 → 重新领取 available 卡密 → 绑定到 pending 明细。
   * 与 retryPaymentFulfillment 核心逻辑一致，但返回 FulfillmentRetryResult。
   */
  async retry(ctx: LotteryContext): Promise<FulfillmentRetryResult> {
    const quantity = Math.max(1, Math.floor(Number(ctx.quantity || 1)));

    // ① 释放残留预留码（FULFILLMENT_FAILED 时可能残留 reserved 卡密）
    await releaseReservedPrizeCodes(ctx.db, ctx.orderId, ctx.tenantId);

    // ② 重新领取 available 卡密
    const acquiredPrizeCodeIds = await acquirePrizeCodes(
      ctx.db, ctx.tenantId, ctx.drawId, ctx.entryId, ctx.orderId, quantity,
    );

    if (acquiredPrizeCodeIds.length !== quantity) {
      // acquirePrizeCodes 不足时会原子回滚本次领取的卡密，无需额外清理
      return { ok: false, error: "没有足够可用卡密，请先补充码池" };
    }

    // ③ 绑定到 pending 明细
    await fulfillOrderItems(ctx.db, ctx.tenantId, ctx.orderId, acquiredPrizeCodeIds);

    return { ok: true };
  },

  /**
   * 释放预占卡密（reserved → available）。
   * 订单取消/超时/退款时调用，尽力释放，不抛错。
   */
  async release(ctx: LotteryContext): Promise<void> {
    await releaseReservedPrizeCodes(ctx.db, ctx.orderId, ctx.tenantId);
  },
};