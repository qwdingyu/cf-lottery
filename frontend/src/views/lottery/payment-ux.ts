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

export interface PaymentSessionState {
  drawId: string
  entryId: string
  email: string
  orderNo: string
  status: string
  amountCents: number
  currency: string
  provider: string
  redirectUrl?: string
  qrCode?: string
}

export interface PaymentSessionSnapshot extends PaymentSessionState {
  savedAt: number
}

const PAYMENT_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000
const PAYMENT_SESSION_CLOCK_SKEW_MS = 60 * 1000

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
  const normalized = String(currency || 'cny').trim().toUpperCase() || 'CNY'
  if (amountMinor == null) return `-- ${normalized}`
  const n = Number(amountMinor)
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

export function asHttpPaymentUrl(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export function buildPaymentSessionSnapshot(
  state: PaymentSessionState | null | undefined,
  nowMs = Date.now(),
): PaymentSessionSnapshot | null {
  if (!state?.orderNo || !state.drawId || !state.entryId || !state.email) return null
  return {
    drawId: String(state.drawId),
    entryId: String(state.entryId),
    email: String(state.email).trim().toLowerCase(),
    orderNo: String(state.orderNo),
    status: String(state.status || 'pending'),
    amountCents: Number(state.amountCents || 0),
    currency: String(state.currency || 'cny'),
    provider: String(state.provider || ''),
    redirectUrl: state.redirectUrl ? String(state.redirectUrl) : undefined,
    qrCode: state.qrCode ? String(state.qrCode) : undefined,
    savedAt: nowMs,
  }
}

export function parsePaymentSessionSnapshot(
  raw: string | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = PAYMENT_SESSION_MAX_AGE_MS,
): PaymentSessionSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PaymentSessionSnapshot>
    const savedAt = Number(parsed.savedAt || 0)
    if (!Number.isFinite(savedAt) || savedAt <= 0 || nowMs - savedAt > maxAgeMs) return null
    if (savedAt - nowMs > PAYMENT_SESSION_CLOCK_SKEW_MS) return null
    const snapshot = buildPaymentSessionSnapshot({
      drawId: String(parsed.drawId || ''),
      entryId: String(parsed.entryId || ''),
      email: String(parsed.email || ''),
      orderNo: String(parsed.orderNo || ''),
      status: String(parsed.status || 'pending'),
      amountCents: Number(parsed.amountCents || 0),
      currency: String(parsed.currency || 'cny'),
      provider: String(parsed.provider || ''),
      redirectUrl: parsed.redirectUrl ? String(parsed.redirectUrl) : undefined,
      qrCode: parsed.qrCode ? String(parsed.qrCode) : undefined,
    }, savedAt)
    if (!snapshot) return null
    return snapshot
  } catch {
    return null
  }
}
