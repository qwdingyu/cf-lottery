import { formatPaymentAmount } from './lottery/payment-ux'

export interface LandingHomeActivity {
  publicSlug: string
  title: string
  description?: string
  activityKind?: string
  experienceType?: string
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

export interface LandingActivityCard {
  publicSlug: string
  title: string
  description: string
  imageUrl: string
  priceText: string
  badge: LandingActivityKind
  sessionLabel: string
  remaining: number | null
  progressPercent: number
  href: string
}

export function classifyLandingActivity(activity: Pick<LandingHomeActivity, 'experienceType' | 'flashSale'>): LandingActivityKind {
  return activity.experienceType === 'flash_sale' || activity.flashSale?.enabled ? 'flash' : 'free'
}

export function buildLandingActivityCard(activity: LandingHomeActivity, freeLabel: string): LandingActivityCard {
  const badge = classifyLandingActivity(activity)
  const flashSale = activity.flashSale || null
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
    sessionLabel: String(flashSale?.sessionLabel || '').trim(),
    remaining:
      flashSale?.remaining === null || flashSale?.remaining === undefined
        ? null
        : Math.max(0, Math.floor(Number(flashSale.remaining) || 0)),
    progressPercent: Math.min(100, Math.max(0, Math.floor(Number(flashSale?.progressPercent) || 0))),
    href: `/lottery/${encodeURIComponent(activity.publicSlug)}`,
  }
}
