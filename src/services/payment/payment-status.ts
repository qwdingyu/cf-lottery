/**
 * cf-lottery 直付秒杀状态机的唯一服务端定义。
 *
 * 这里故意把三个状态域分开：
 * - entry 状态：活动名额和参与履约的占位事实；
 * - order 状态：用户订单的支付与发卡结果；
 * - attempt 状态：一次具体网关交易尝试的结果。
 *
 * 不允许用 payment_orders.status 的字符串去判断 lottery_entries.payment_status，
 * 否则重试、迟到回调和发卡失败会把名额状态与支付审计状态混在一起。
 */

/**
 * lottery_entries.payment_status 的正常状态：
 * ""       普通非支付活动，无支付需求；
 * reserved 直付秒杀参与成功，活动名额 CAS 已占用，等待创建支付订单；
 * pending   支付订单已创建，等待付款，或已付款但仍在等待发卡完成；
 * paid      已支付并完成发卡；
 * expired   支付超时或创建支付失败，名额已释放。
 *
 * 注意：`paid_fulfillment_failed` 只属于 payment_orders.status / payment_order_attempts.status，
 * 不属于 entry 状态。entry 只负责名额与参与生命周期，不负责表达履约异常细节。
 */
export const PAYMENT_ENTRY_STATUS = {
  NONE: "",
  RESERVED: "reserved",
  PENDING: "pending",
  PAID: "paid",
  EXPIRED: "expired",
} as const;

export type PaymentEntryStatus = typeof PAYMENT_ENTRY_STATUS[keyof typeof PAYMENT_ENTRY_STATUS];

/** payment_orders.status：逻辑订单的支付和履约状态。 */
export const PAYMENT_ORDER_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  FULFILLMENT_FAILED: "paid_fulfillment_failed",
  LATE_NEEDS_REFUND: "paid_late_needs_refund",
  REFUNDED: "refunded",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
} as const;

export type PaymentOrderStatus = typeof PAYMENT_ORDER_STATUS[keyof typeof PAYMENT_ORDER_STATUS];

/** payment_order_attempts.status：单次网关交易尝试的状态。 */
export const PAYMENT_ATTEMPT_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  LATE_NEEDS_REFUND: "paid_late_needs_refund",
  REFUNDED: "refunded",
  EXPIRED: "expired",
  FAILED: "failed",
  SUPERSEDED: "superseded",
} as const;

export type PaymentAttemptStatus = typeof PAYMENT_ATTEMPT_STATUS[keyof typeof PAYMENT_ATTEMPT_STATUS];

/** 这些 entry 状态仍然占用秒杀名额，不能参与计数或软释放。 */
export const PAYMENT_ENTRY_CAPACITY_STATUSES = [
  PAYMENT_ENTRY_STATUS.RESERVED,
  PAYMENT_ENTRY_STATUS.PENDING,
  PAYMENT_ENTRY_STATUS.PAID,
] as const;

/** 只有这两种订单终态允许再次发起支付尝试。 */
export const RETRYABLE_PAYMENT_ORDER_STATUSES = [
  PAYMENT_ORDER_STATUS.CANCELLED,
  PAYMENT_ORDER_STATUS.EXPIRED,
] as const;

export function isRetryablePaymentOrderStatus(status: string): boolean {
  return (RETRYABLE_PAYMENT_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isPaidPaymentAttemptStatus(status: string): boolean {
  return status === PAYMENT_ATTEMPT_STATUS.PAID
    || status === PAYMENT_ATTEMPT_STATUS.LATE_NEEDS_REFUND
    || status === PAYMENT_ATTEMPT_STATUS.REFUNDED;
}
