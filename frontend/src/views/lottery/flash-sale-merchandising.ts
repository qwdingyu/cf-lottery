/**
 * 秒杀商品化展示纯函数。
 *
 * 为什么独立：
 * - cf-lottery 不复制 cf-shop 的商品表，只把活动的 productLink + flashSale
 *   合成为公开页可理解的「抢购商品卡」。
 * - 支付金额仍以 flashSale.priceCents 为准；导流模式价格仅是展示文案。
 */
import type { LotteryDraw } from './types'

export interface FlashSaleMerchCard {
  title: string
  imageUrl: string
  priceText: string
  sessionLabel: string
  isDirectPayment: boolean
  hasExternalCheckout: boolean
  remaining: number | null
  effectiveStockLimit: number | null
  progressPercent: number
}

export interface FlashSalePurchaseSummary {
  quantity: number
  unitPriceText: string
  totalPriceText: string
  tierLabel: string
}

export function buildFlashSaleMerchCard(
  draw: Pick<LotteryDraw, 'name' | 'title' | 'productTitle' | 'productLink' | 'flashSale' | 'prizes'> | null | undefined,
  formatAmount: (amountMinor: number | null | undefined, currency: string | null | undefined) => string,
): FlashSaleMerchCard | null {
  if (!draw) return null
  const flashSale = draw.flashSale
  if (!flashSale?.enabled) return null

  const productLink = draw.productLink
  const isDirectPayment = flashSale.paymentRequired === true
  const priceText = isDirectPayment
    ? formatAmount(flashSale.priceCents, flashSale.currency || 'cny')
    : String(productLink?.price || '').trim()
  const title = String(
    flashSale.title ||
    productLink?.title ||
    draw.productTitle ||
    draw.name ||
    draw.title ||
    '',
  ).trim()

  return {
    title,
    // 图片来源优先级（docs/245）：秒杀配置 imageUrl > 导流配置 productLink.imageUrl > 奖品图。
    // 旧秒杀活动 flashSale.imageUrl 为空 → 回退 productLink.imageUrl，行为不变。
    imageUrl: String(
      flashSale.imageUrl ||
      productLink?.imageUrl ||
      draw.prizes?.find((item) => item.imageUrl)?.imageUrl ||
      '',
    ).trim(),
    priceText,
    sessionLabel: String(flashSale.sessionLabel || '').trim(),
    isDirectPayment,
    hasExternalCheckout: Boolean(productLink?.url),
    remaining:
      flashSale.remaining === null || flashSale.remaining === undefined
        ? null
        : Math.max(0, Math.floor(Number(flashSale.remaining) || 0)),
    effectiveStockLimit:
      flashSale.effectiveStockLimit === null || flashSale.effectiveStockLimit === undefined
        ? null
        : Math.max(0, Math.floor(Number(flashSale.effectiveStockLimit) || 0)),
    progressPercent: Math.min(100, Math.max(0, Math.floor(Number(flashSale.progressPercent) || 0))),
  }
}

export function buildFlashSalePurchaseSummary(
  draw: Pick<LotteryDraw, 'flashSale'> | null | undefined,
  quantityRaw: number,
  formatAmount: (amountMinor: number | null | undefined, currency: string | null | undefined) => string,
): FlashSalePurchaseSummary | null {
  const flashSale = draw?.flashSale
  if (!flashSale?.enabled || flashSale.paymentRequired !== true) return null

  const maxPerUser = Math.max(1, Math.floor(Number(flashSale.maxPerUser || 1)))
  const quantity = Math.min(maxPerUser, Math.max(1, Math.floor(Number(quantityRaw || 1))))
  const baseUnitPrice = Math.max(0, Math.floor(Number(flashSale.priceCents || 0)))
  const tiers = Array.isArray(flashSale.pricingTiers)
    ? [...flashSale.pricingTiers]
        .filter((tier) => tier && typeof tier.minQuantity === 'number' && typeof tier.unitPriceCents === 'number')
        .sort((a, b) => Number(a.minQuantity || 0) - Number(b.minQuantity || 0))
    : []

  let matchedUnitPrice = baseUnitPrice
  let tierLabel = ''
  for (const tier of tiers) {
    const minQuantity = Math.max(1, Math.floor(Number(tier.minQuantity || 0)))
    if (minQuantity <= quantity) {
      matchedUnitPrice = Math.max(0, Math.floor(Number(tier.unitPriceCents || baseUnitPrice)))
      tierLabel = String(tier.label || '').trim()
    }
  }

  return {
    quantity,
    unitPriceText: formatAmount(matchedUnitPrice, flashSale.currency || 'cny'),
    totalPriceText: formatAmount(matchedUnitPrice * quantity, flashSale.currency || 'cny'),
    tierLabel,
  }
}
