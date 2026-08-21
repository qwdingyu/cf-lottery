/**
 * 支付工具函数（docs/257 死磕闭环）。
 *
 * 为什么独立成文件：
 * 路由层（payment.ts）不应内联订单快照复用的判断逻辑——「是否在重试一笔
 * 可重试订单」是核心语义，独立命名后路由层只调用一个函数，代码意图一目了然。
 */
import { isRetryablePaymentOrderStatus } from "./payment-status";

/**
 * 订单是否在「重试同一笔可重试订单」的语义下。
 *
 * 可重试订单 = 状态为 expired 或 cancelled 的订单（RETRYABLE_PAYMENT_ORDER_STATUSES）。
 * 此时路由层必须复用该订单的快照（数量/金额/价格），因为重试的是同一笔交易，
 * 不能悄悄改价改量。
 *
 * 反之：已有 paid 订单后的「追加购买」走 createPaymentOrder 新建订单，
 * 必须按本次前端件数重新计价，与 existing 无关。
 *
 * @param existing - 已有订单对象（或 null/undefined）
 * @returns 是否为重试可重试订单
 */
export function isRetryingPaymentOrder(
  existing: { status: string } | null | undefined,
): boolean {
  return existing != null && isRetryablePaymentOrderStatus(existing.status);
}