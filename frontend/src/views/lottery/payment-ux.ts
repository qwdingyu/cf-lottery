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
  | 'late_paid'
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
  quantity?: number
  unitPriceCents?: number
  currency: string
  provider: string
  accessToken: string
  redirectUrl?: string
  qrCode?: string
}

export interface PaymentSessionSnapshot extends PaymentSessionState {
  savedAt: number
}

const PAYMENT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PAYMENT_SESSION_CLOCK_SKEW_MS = 60 * 1000

export function isDirectPaymentDraw(draw: Pick<LotteryDraw, 'flashSale'> | null | undefined): boolean {
  return draw?.flashSale?.paymentRequired === true
}

/**
 * 直付秒杀的「购买阶段」状态机（docs/257）。
 *
 * 为什么需要它：
 * 公开页原先用零散的布尔判断（是否已参与 / 是否有在途订单 / 限购是否用尽）分别控制
 * 件数选择器、总价预览、秒杀壳「抢」按钮和底部 CTA。四处判断口径不一致，导致
 * 「已锁定名额但未支付」时仍然展示件数加减 + 总价 + 可点的「抢」按钮——用户会以为
 * 还要再抢一次，实际后端只允许续付同一笔订单，属于误导性入口。
 *
 * 现在统一收敛为四个互斥阶段，模板只读阶段结论：
 * - browse        未锁名额：正常挑件数、看总价、点「抢」
 * - resume_payment 已锁名额且存在在途/需人工处理的订单：只允许支付相关操作
 * - add_more      已支付完成且累计限购还有余量：允许追加购买（批发场景）
 * - exhausted     已达累计限购：不再提供购买入口
 */
export type FlashSalePurchasePhase = 'browse' | 'resume_payment' | 'add_more' | 'exhausted'

export interface FlashSalePurchasePhaseInput {
  /** flashSale.paymentRequired === true */
  isDirectPayment: boolean
  /** 当前身份是否已参与（已锁定名额） */
  joined: boolean
  /**
   * 服务端最近一笔订单状态。
   * null/undefined 表示「未知」——包含"尚未拉到摘要"和"确实没有订单"两种情况，
   * 两者在已参与前提下都必须走 resume_payment：宁可少给一个购买入口，
   * 也不能在有在途订单时放出第二个下单入口造成重复支付。
   */
  latestOrderStatus?: string | null
  /** 服务端累计限购余量（maxPerUser - 已支付件数） */
  remainingQuantity?: number | null
  /** 活动配置的单用户累计限购 */
  maxPerUser?: number | null
}

export function resolveFlashSalePurchasePhase(input: FlashSalePurchasePhaseInput): FlashSalePurchasePhase {
  if (!input.isDirectPayment) return 'browse'
  if (!input.joined) return 'browse'

  const kind = paymentStatusKind(input.latestOrderStatus)
  // pending：等待用户付款；retryable(expired/cancelled)：需要重开同一份名额的支付单；
  // fulfillment_failed / late_paid：需要主办方人工处理。这些都不是"再买一件"的入口。
  if (
    kind === 'pending' ||
    kind === 'retryable' ||
    kind === 'fulfillment_failed' ||
    kind === 'late_paid' ||
    kind === 'unknown'
  ) {
    return 'resume_payment'
  }

  // paid / refunded：订单已终结，能否继续买完全由服务端累计限购余量决定。
  const maxPerUser = Math.max(1, Math.floor(Number(input.maxPerUser || 1)))
  const remaining = Math.max(0, Math.floor(Number(input.remainingQuantity ?? 0)))
  if (maxPerUser > 1 && remaining > 0) return 'add_more'
  return 'exhausted'
}

/** 阶段是否允许挑件数 / 预览总价（只有真正能下新单的阶段才展示） */
export function allowsFlashSaleQuantityPicker(phase: FlashSalePurchasePhase): boolean {
  return phase === 'browse' || phase === 'add_more'
}

/** 阶段是否应该隐藏秒杀壳的「抢」按钮（主 CTA 让位给底部支付按钮） */
export function hidesFlashSaleGrabCta(phase: FlashSalePurchasePhase): boolean {
  return phase === 'resume_payment' || phase === 'exhausted'
}

/**
 * 已锁名额状态条的主 CTA 文案 key。
 * pending 必须明确说「继续支付」，否则「继续支付或追加购买」会让用户以为还能加购。
 */
export function flashSalePurchaseCtaI18nKey(
  phase: FlashSalePurchasePhase,
  latestOrderStatus?: string | null,
): string {
  if (phase === 'add_more') return 'paymentBuyMore'
  if (phase === 'exhausted') return 'paymentViewOrder'
  const kind = paymentStatusKind(latestOrderStatus)
  if (kind === 'pending') return 'paymentContinuePaymentOnly'
  if (kind === 'retryable') return 'paymentReopenOrder'
  if (kind === 'fulfillment_failed' || kind === 'late_paid') return 'paymentViewOrder'
  return 'paymentContinuePaymentOnly'
}

export function paymentStatusKind(status: string | null | undefined): PaymentStatusKind {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'pending') return 'pending'
  if (normalized === 'paid') return 'paid'
  if (normalized === 'paid_fulfillment_failed') return 'fulfillment_failed'
  if (normalized === 'paid_late_needs_refund') return 'late_paid'
  if (normalized === 'cancelled' || normalized === 'expired') return 'retryable'
  if (normalized === 'refunded') return 'refunded'
  return 'unknown'
}

export function paymentStatusI18nKey(status: string | null | undefined): string {
  const kind = paymentStatusKind(status)
  if (kind === 'pending') return 'paymentStatusPending'
  if (kind === 'paid') return 'paymentStatusPaid'
  if (kind === 'fulfillment_failed') return 'paymentStatusFulfillmentFailed'
  if (kind === 'late_paid') return 'paymentStatusLatePaid'
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
  if (!state?.orderNo || !state.drawId || !state.entryId || !state.email || !state.accessToken) return null
  return {
    drawId: String(state.drawId),
    entryId: String(state.entryId),
    email: String(state.email).trim().toLowerCase(),
    orderNo: String(state.orderNo),
    status: String(state.status || 'pending'),
    amountCents: Number(state.amountCents || 0),
    quantity: Math.max(1, Math.floor(Number(state.quantity || 1))),
    unitPriceCents: Math.max(0, Math.floor(Number(state.unitPriceCents || 0))),
    currency: String(state.currency || 'cny'),
    provider: String(state.provider || ''),
    accessToken: String(state.accessToken),
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
    // 恢复会话时必须原样带回 quantity / unitPriceCents，否则批量订单从本地
    // 恢复后会把件数误显示为 1（金额以 amountCents 为准，功能不受影响，仅展示偏差）。
    const snapshot = buildPaymentSessionSnapshot({
      drawId: String(parsed.drawId || ''),
      entryId: String(parsed.entryId || ''),
      email: String(parsed.email || ''),
      orderNo: String(parsed.orderNo || ''),
      status: String(parsed.status || 'pending'),
      amountCents: Number(parsed.amountCents || 0),
      quantity: Math.max(1, Math.floor(Number(parsed.quantity || 1))),
      unitPriceCents: Math.max(0, Math.floor(Number(parsed.unitPriceCents || 0))),
      currency: String(parsed.currency || 'cny'),
      provider: String(parsed.provider || ''),
      accessToken: String(parsed.accessToken || ''),
      redirectUrl: parsed.redirectUrl ? String(parsed.redirectUrl) : undefined,
      qrCode: parsed.qrCode ? String(parsed.qrCode) : undefined,
    }, savedAt)
    if (!snapshot) return null
    return snapshot
  } catch {
    return null
  }
}
