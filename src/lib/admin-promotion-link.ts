import {
  CAMPAIGN_QUERY_KEY,
  REFERRAL_QUERY_KEY,
  normalizeAttributionCode,
} from '@/lib/checkout-attribution'
import { PRODUCT_DEEPLINK_QUERY } from '@/lib/storefront-product-link'
import { SETTLEMENT_ORDER_STATUS_QUERY } from '@shared/admin-order-export'

export type AdminPromotionLinkStorefront = {
  id?: string
  slug?: string
  homePath?: string
}

export type BuildAdminPromotionLinkInput = {
  origin: string
  storefront?: AdminPromotionLinkStorefront | null
  productKey?: string | null
  campaignCode?: string | null
  referralCode?: string | null
}

export type BuildAdminPromotionReviewLinkInput = {
  origin: string
  appBasePath?: string | null
  attributionCode?: string | null
}

export function normalizePromotionProductKey(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, 120)
}

export function resolveAdminPromotionHomePath(storefront?: AdminPromotionLinkStorefront | null): string {
  const home = String(storefront?.homePath || '').trim()
  if (home) return home.startsWith('/') ? home : `/${home}`
  const slug = String(storefront?.slug || '').trim()
  return slug ? `/s/${slug}` : '/shop'
}

function normalizeAppBasePath(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value || value === '/') return ''
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  return withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash
}

/**
 * Admin 投放链接生成器（纯函数）。
 *
 * 边界：
 * - 只拼现有用户侧入口：/shop 或 /s/:storefrontSlug。
 * - 商品仍走既有 ?product= 单商品深链。
 * - 归因只写短键 ?campaign= / ?ref=，不校验 registry，不挡交易。
 * - 不创建短链、不写 click log、不引入第二套引流系统。
 */
export function buildAdminPromotionLink(input: BuildAdminPromotionLinkInput): string {
  const origin = String(input.origin || '').trim()
  const path = resolveAdminPromotionHomePath(input.storefront)
  const params = new URLSearchParams()
  const productKey = normalizePromotionProductKey(input.productKey)
  if (productKey) params.set(PRODUCT_DEEPLINK_QUERY, productKey)
  const campaign = normalizeAttributionCode(input.campaignCode || undefined)
  if (campaign) params.set(CAMPAIGN_QUERY_KEY, campaign)
  const referral = normalizeAttributionCode(input.referralCode || undefined)
  if (referral) params.set(REFERRAL_QUERY_KEY, referral)
  const suffix = params.toString()
  const base = origin ? `${origin}${path}` : path
  return suffix ? `${base}?${suffix}` : base
}

/**
 * Admin 成交复盘链接生成器（纯函数）。
 *
 * 只复用订单页既有 q + paid/issued 筛选，不写点击日志、不做归因统计。
 * 运营复制投放链接时可同步保存此后台链接，后续直接核对实际成交。
 */
export function buildAdminPromotionReviewLink(input: BuildAdminPromotionReviewLinkInput): string {
  const origin = String(input.origin || '').trim()
  const appBasePath = normalizeAppBasePath(input.appBasePath)
  const code = normalizeAttributionCode(input.attributionCode || undefined)
  const params = new URLSearchParams()
  if (code) params.set('q', code)
  params.set('status', SETTLEMENT_ORDER_STATUS_QUERY)
  const base = `${origin}${appBasePath}/admin/orders`
  return `${base}?${params.toString()}`
}
