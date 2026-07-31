import { describe, expect, it } from 'vitest'
import {
  buildAdminPromotionReviewLink,
  buildAdminPromotionLink,
  normalizePromotionProductKey,
  resolveAdminPromotionHomePath,
} from './admin-promotion-link'

describe('admin-promotion-link', () => {
  it('builds a default /shop attribution link with canonical short keys', () => {
    expect(buildAdminPromotionLink({
      origin: 'https://shop.example',
      campaignCode: 'YLB-QQ',
      referralCode: 'Partner-A',
    })).toBe('https://shop.example/shop?campaign=ylb-qq&ref=partner-a')
  })

  it('adds optional product deep link before attribution params', () => {
    expect(buildAdminPromotionLink({
      origin: 'https://shop.example',
      storefront: { homePath: '/s/software' },
      productKey: ' useai ',
      campaignCode: 'camp1',
    })).toBe('https://shop.example/s/software?product=useai&campaign=camp1')
  })

  it('keeps public promotion buy links outside the Vite /_app frontend base', () => {
    expect(buildAdminPromotionLink({
      origin: 'https://shop.example',
      storefront: { homePath: '/shop' },
      productKey: 'useai',
      campaignCode: 'ylb',
    })).toBe('https://shop.example/shop?product=useai&campaign=ylb')
  })

  it('falls back from missing homePath to slug and then /shop', () => {
    expect(resolveAdminPromotionHomePath({ slug: 'vip' })).toBe('/s/vip')
    expect(resolveAdminPromotionHomePath(null)).toBe('/shop')
  })

  it('trims product key without lowercasing slugs or ids', () => {
    expect(normalizePromotionProductKey(' Product-ID_01 ')).toBe('Product-ID_01')
    expect(normalizePromotionProductKey(null)).toBe('')
  })

  it('does not emit empty query params', () => {
    expect(buildAdminPromotionLink({
      origin: '',
      storefront: { homePath: 's/private' },
      productKey: '',
      campaignCode: '',
      referralCode: '',
    })).toBe('/s/private')
  })

  it('builds an admin paid-conversion review link without touching storefront attribution', () => {
    expect(buildAdminPromotionReviewLink({
      origin: 'https://shop.example',
      attributionCode: ' Partner-A ',
    })).toBe('https://shop.example/admin/orders?q=partner-a&status=paid%2Cissued')
  })

  it('keeps admin review links under the deployed frontend base path', () => {
    expect(buildAdminPromotionReviewLink({
      origin: 'https://shop.example',
      appBasePath: '/_app/',
      attributionCode: 'YLB-QQ',
    })).toBe('https://shop.example/_app/admin/orders?q=ylb-qq&status=paid%2Cissued')
  })
})
