import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viewSource = readFileSync(new URL('./AdminReferralCodesView.vue', import.meta.url), 'utf8')
const routerSource = readFileSync(new URL('../../router/index.ts', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../AdminLayout.vue', import.meta.url), 'utf8')
const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')
const shopSource = readFileSync(new URL('../ShopView.vue', import.meta.url), 'utf8')
const attributionSource = readFileSync(new URL('../../lib/checkout-attribution.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../api/admin.ts', import.meta.url), 'utf8')

describe('admin referral codes management contract', () => {
  it('registers authenticated route and sidebar entry for referral codes', () => {
    expect(routerSource).toContain("path: 'referral-codes'")
    expect(routerSource).toContain("name: 'AdminReferralCodes'")
    expect(routerSource).toContain('AdminReferralCodesView')
    expect(layoutSource).toContain("to: '/admin/referral-codes'")
    expect(layoutSource).toContain("name: 'AdminReferralCodes'")
    expect(layoutSource).toContain("t('adminLayout.menuReferralCodes')")
  })

  it('wires list/create/update/delete to existing admin referral APIs', () => {
    expect(viewSource).toContain('fetchAdminReferralCodes')
    expect(viewSource).toContain('createAdminReferralCode')
    expect(viewSource).toContain('updateAdminReferralCode')
    expect(viewSource).toContain('deleteAdminReferralCode')
    expect(apiSource).toContain("'/api/admin/referral-codes'")
  })

  it('copies buy links with canonical short key ?ref= only', () => {
    expect(viewSource).toContain('buildAdminPromotionLink')
    expect(viewSource).toContain('buildAdminPromotionReviewLink')
    expect(viewSource).toContain('confirmCopyLink')
    expect(viewSource).toContain('confirmCopyReviewLink')
    expect(viewSource).toContain('copyLinkProduct')
    expect(viewSource).toContain('copyLinkCampaign')
    expect(viewSource).toContain("adminReferralCodes.copyReviewLinkBtn")
    expect(viewSource).toContain('appBasePath: import.meta.env.BASE_URL')
    // 禁止出站长别名
    expect(viewSource).not.toMatch(/\?referralCode=/)
    expect(viewSource).not.toMatch(/referralCode=\$\{/)
  })

  it('deep-links referral code to order search and hydrates local filter from route q', () => {
    expect(viewSource).toContain('searchOrdersByCode')
    expect(viewSource).toContain("path: '/admin/orders'")
    expect(viewSource).toContain('route.query.q')
    expect(viewSource).toContain('filterQ')
    // 无 q 时必须清空本地筛选，避免 URL 与表格过滤脱节（审查 Issue：initFromRoute）
    expect(viewSource).toContain("filterQ.value = ''")
    expect(viewSource).toMatch(/else\s*\{[\s\S]*?filterQ\.value = ''/)
  })

  it('deep-links paid conversions separately from all-order search (L0 settlement)', () => {
    expect(viewSource).toContain('searchPaidOrdersByCode')
    expect(viewSource).toContain("adminReferralCodes.actionSearchPaid")
    expect(viewSource).toContain('SETTLEMENT_ORDER_STATUS_QUERY')
    // 禁止把 useCount 当成交：成交入口必须带 status 查询
    expect(viewSource).toMatch(/searchPaidOrdersByCode[\s\S]*?status:\s*SETTLEMENT_ORDER_STATUS_QUERY/)
  })

  it('loads unregistered orphan stats for ops hygiene', () => {
    expect(viewSource).toContain('fetchAdminReferralUnregisteredStats')
    expect(apiSource).toContain('unregistered-stats')
  })

  it('documents open attribution: default-off optional reward, does not block trade', () => {
    expect(viewSource).toContain("$t('adminReferralCodes.colEvents')")
    expect(viewSource).toContain("$t('adminReferralCodes.helperIntro')")
    expect(viewSource).toContain("rewardType: 'none' as 'none' | 'fixed'")
    expect(viewSource).toContain("option value=\"fixed\"")
  })

  it('labels useCount as order-create events, not paid conversions', () => {
    // 列头与工具提示须区分事件数与成交，避免运营把 useCount 当 paid/issued
    expect(viewSource).toContain("$t('adminReferralCodes.colEvents')")
    expect(viewSource).toContain("$t('adminReferralCodes.colEventsTitle')")
    expect(viewSource).toContain('useCount')
    // 禁止仅写「使用次数」而无事件/建单语义（旧文案会误导对账）
    expect(viewSource).not.toMatch(/<th>使用次数<\/th>/)
  })

  it('shows commission column with fixed/percent/none formatting', () => {
    expect(viewSource).toContain("$t('adminReferralCodes.colCommission')")
    expect(viewSource).toContain('formatRewardRule')
    expect(viewSource).toContain("type === 'fixed'")
    expect(viewSource).toContain("type === 'percent'")
    expect(viewSource).toContain("t('adminReferralCodes.rewardAttributionOnly')")
    expect(viewSource).toContain('colspan="7"')
  })

  it('order detail shows read-only registry hint and deep-links without gating checkout', () => {
    expect(ordersSource).toContain('referralRegistryStatus')
    expect(ordersSource).toContain('referralRegistryHintLabel')
    expect(ordersSource).toContain('registryStatusUnregistered')
    expect(ordersSource).toContain('registryStatusActive')
    expect(ordersSource).toContain('searchOrdersByAttribution')
    expect(ordersSource).toContain('openReferralCodesForCode')
    expect(ordersSource).toContain("path: '/admin/referral-codes'")
  })

  it('storefront canonicalizes inbound long aliases to short keys', () => {
    expect(shopSource).toContain('canonicalizeAttributionRouteQuery')
    expect(shopSource).toContain('attributionRouteQueryHasLongAliases')
    expect(attributionSource).toContain('export function canonicalizeAttributionRouteQuery')
    expect(attributionSource).toContain('CAMPAIGN_QUERY_LONG_ALIASES')
    expect(attributionSource).toContain('REFERRAL_QUERY_LONG_ALIASES')
    expect(attributionSource).toContain("export const CAMPAIGN_QUERY_KEY = 'campaign'")
    expect(attributionSource).toContain("export const REFERRAL_QUERY_KEY = 'ref'")
  })
})
