/**
 * 公开页直付支付 UX 纯函数。
 *
 * 为什么独立：
 * - 支付状态是订单状态机，不应散落在 LotteryView 模板分支里。
 * - 未来抽到 cf-pay 微服务后，前端仍可沿用同一组展示决策。
 */
import type { LotteryDraw } from './types'

export type PaymentStatusKind =
  | 'pending'
  | 'paid'
  | 'fulfillment_failed'
  | 'retryable'
  | 'refunded'
  | 'unknown'

export function isDirectPaymentDraw(draw: Pick<LotteryDraw, 'flashSale'> | null | undefined): boolean {
  return draw?.flashSale?.paymentRequired === true
}

export function paymentStatusKind(status: string | null | undefined): PaymentStatusKind {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'pending') return 'pending'
  if (normalized === 'paid') return 'paid'
  if (normalized === 'paid_fulfillment_failed') return 'fulfillment_failed'
  if (normalized === 'cancelled' || normalized === 'expired') return 'retryable'
  if (normalized === 'refunded') return 'refunded'
  return 'unknown'
}

export function paymentStatusI18nKey(status: string | null | undefined): string {
  const kind = paymentStatusKind(status)
  if (kind === 'pending') return 'paymentStatusPending'
  if (kind === 'paid') return 'paymentStatusPaid'
  if (kind === 'fulfillment_failed') return 'paymentStatusFulfillmentFailed'
  if (kind === 'retryable') return 'paymentStatusRetryable'
  if (kind === 'refunded') return 'paymentStatusRefunded'
  return 'paymentStatusUnknown'
}

export function shouldPollPaymentStatus(status: string | null | undefined): boolean {
  return paymentStatusKind(status) === 'pending'
}

export function canRetryPaymentOrder(status: string | null | undefined): boolean {
  return paymentStatusKind(status) === 'retryable'
}

export function formatPaymentAmount(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  const n = Number(amountMinor)
  const normalized = String(currency || 'cny').trim().toUpperCase() || 'CNY'
  if (!Number.isFinite(n) || n < 0) return `-- ${normalized}`

  if (normalized === 'JPY') return `¥${Math.round(n)}`

  const value = n / 100
  if (normalized === 'CNY') return `¥${value.toFixed(2)}`
  if (normalized === 'USD') return `$${value.toFixed(2)}`
  if (normalized === 'EUR') return `€${value.toFixed(2)}`
  if (normalized === 'GBP') return `£${value.toFixed(2)}`
  return `${value.toFixed(2)} ${normalized}`
}

export function composePaymentCode(prizeCode: { code?: string | null; secret?: string | null } | null | undefined): string {
  const code = String(prizeCode?.code || '').trim()
  const secret = String(prizeCode?.secret || '').trim()
  if (!code) return ''
  return secret ? `${code}:${secret}` : code
}
