import { formatPaymentAmount } from './lottery/payment-ux'

export interface LandingHomeActivity {
  publicSlug: string
  title: string
  description?: string
  activityKind?: string
  experienceType?: string
  participationMode?: string
  startAt: string
  endAt: string
  claimed?: number
  product?: {
    title?: string
    imageUrl?: string
    priceText?: string
    url?: string
  }
  flashSale?: {
    enabled?: boolean
    paymentRequired?: boolean
    priceCents?: number | null
    currency?: string | null
    sessionLabel?: string
    remaining?: number | null
    effectiveStockLimit?: number | null
    progressPercent?: number
  } | null
}

export type LandingActivityKind = 'flash' | 'free'
export type LandingPaymentMode = 'direct' | 'external' | 'free'
export type LandingActivityPhase = 'upcoming' | 'running' | 'ended'
export type LandingEligibilityMode = 'open' | 'password' | 'invite' | 'roster' | 'registered' | 'restricted'

export interface LandingActivityCard {
  publicSlug: string
  title: string
  description: string
  imageUrl: string
  priceText: string
  badge: LandingActivityKind
  paymentMode: LandingPaymentMode
  phase: LandingActivityPhase
  eligibilityMode: LandingEligibilityMode
  sessionLabel: string
  remaining: number | null
  progressPercent: number
  href: string
}

export function classifyLandingActivity(activity: Pick<LandingHomeActivity, 'experienceType' | 'flashSale'>): LandingActivityKind {
  return activity.experienceType === 'flash_sale' || activity.flashSale?.enabled ? 'flash' : 'free'
}

export function resolveLandingPaymentMode(activity: Pick<LandingHomeActivity, 'flashSale' | 'product'>): LandingPaymentMode {
  if (activity.flashSale?.paymentRequired === true) return 'direct'
  if (String(activity.product?.url || '').trim()) return 'external'
  return 'free'
}

export function paymentModeI18nKey(mode: LandingPaymentMode): string {
  // 返回带命名空间前缀的完整 i18n key：页面 $t() 直接取用。
  // 注意：i18n 中这些文案在 landing 命名空间下（landing.marketPayment*），
  // 若返回裸 key 会导致 $t('marketPaymentFree') 找不到 → vue-i18n 回退显示 key 本身（写死文案）。
  if (mode === 'direct') return 'landing.marketPaymentDirect'
  if (mode === 'external') return 'landing.marketPaymentExternal'
  return 'landing.marketPaymentFree'
}

export function resolveLandingActivityPhase(
  activity: Pick<LandingHomeActivity, 'startAt' | 'endAt'>,
  nowMs = Date.now(),
): LandingActivityPhase {
  const startMs = Date.parse(activity.startAt)
  const endMs = Date.parse(activity.endAt)
  if (Number.isFinite(startMs) && nowMs < startMs) return 'upcoming'
  if (Number.isFinite(endMs) && nowMs >= endMs) return 'ended'
  return 'running'
}

export function activityPhaseI18nKey(phase: LandingActivityPhase): string {
  // 带 landing. 前缀（见 paymentModeI18nKey 注释）——避免 $t 找不到回退显示 key 本身
  if (phase === 'upcoming') return 'landing.marketPhaseUpcoming'
  if (phase === 'ended') return 'landing.marketPhaseEnded'
  return 'landing.marketPhaseRunning'
}

export function resolveLandingEligibilityMode(activity: Pick<LandingHomeActivity, 'participationMode'>): LandingEligibilityMode {
  const mode = String(activity.participationMode || 'open').trim()
  if (mode === 'open') return 'open'
  if (mode === 'password') return 'password'
  if (mode === 'invite_code') return 'invite'
  if (mode === 'roster') return 'roster'
  if (mode === 'registered') return 'registered'
  return 'restricted'
}

export function eligibilityModeI18nKey(mode: LandingEligibilityMode): string {
  // 带 landing. 前缀（见 paymentModeI18nKey 注释）
  if (mode === 'password') return 'landing.marketEligibilityPassword'
  if (mode === 'invite') return 'landing.marketEligibilityInvite'
  if (mode === 'roster') return 'landing.marketEligibilityRoster'
  if (mode === 'registered') return 'landing.marketEligibilityRegistered'
  if (mode === 'restricted') return 'landing.marketEligibilityRestricted'
  return 'landing.marketEligibilityOpen'
}

export function buildLandingActivityCard(activity: LandingHomeActivity, freeLabel: string, nowMs = Date.now()): LandingActivityCard {
  const badge = classifyLandingActivity(activity)
  const flashSale = activity.flashSale || null
  const paymentMode = resolveLandingPaymentMode(activity)
  const phase = resolveLandingActivityPhase(activity, nowMs)
  const eligibilityMode = resolveLandingEligibilityMode(activity)
  const title = String(flashSale?.sessionLabel ? activity.product?.title || flashSale.sessionLabel : activity.product?.title || activity.title).trim()
  const priceText = flashSale?.paymentRequired
    ? formatPaymentAmount(flashSale.priceCents, flashSale.currency || 'cny')
    : String(activity.product?.priceText || '').trim() || freeLabel

  return {
    publicSlug: activity.publicSlug,
    title: title || activity.title,
    description: String(activity.description || '').trim(),
    imageUrl: String(activity.product?.imageUrl || '').trim(),
    priceText,
    badge,
    paymentMode,
    phase,
    eligibilityMode,
    sessionLabel: String(flashSale?.sessionLabel || '').trim(),
    remaining:
      flashSale?.remaining === null || flashSale?.remaining === undefined
        ? null
        : Math.max(0, Math.floor(Number(flashSale.remaining) || 0)),
    progressPercent: Math.min(100, Math.max(0, Math.floor(Number(flashSale?.progressPercent) || 0))),
    href: `/lottery/${encodeURIComponent(activity.publicSlug)}`,
  }
}
