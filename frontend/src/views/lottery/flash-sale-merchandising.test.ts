import { describe, expect, it } from 'vitest'
import { formatPaymentAmount } from './payment-ux'
import { buildFlashSaleMerchCard } from './flash-sale-merchandising'

describe('flash-sale-merchandising', () => {
  it('直付秒杀用支付金额作为商品价格，避免公开页没有价格', () => {
    const card = buildFlashSaleMerchCard({
      title: 'Token 闪购',
      productLink: { url: '', title: '', imageUrl: '', price: '' },
      flashSale: {
        enabled: true,
        paymentRequired: true,
        title: 'Token 日卡',
        priceCents: 990,
        currency: 'cny',
        remaining: 8,
        effectiveStockLimit: 20,
        progressPercent: 60,
      },
    } as any, formatPaymentAmount)

    expect(card).toMatchObject({
      title: 'Token 日卡',
      priceText: '¥9.90',
      isDirectPayment: true,
      remaining: 8,
      effectiveStockLimit: 20,
      progressPercent: 60,
    })
  })

  it('导流秒杀用 productLink 展示商品与价格，不把展示价当支付金额', () => {
    const card = buildFlashSaleMerchCard({
      title: '限时抢购',
      productLink: {
        url: 'https://shop.example.com/p/1',
        title: '外部商城商品',
        imageUrl: 'https://img.example.com/p.png',
        price: '¥4.89',
      },
      flashSale: {
        enabled: true,
        paymentRequired: false,
        sessionLabel: '12:00场',
        remaining: null,
        effectiveStockLimit: null,
        progressPercent: 0,
      },
    } as any, formatPaymentAmount)

    expect(card).toMatchObject({
      title: '外部商城商品',
      imageUrl: 'https://img.example.com/p.png',
      priceText: '¥4.89',
      sessionLabel: '12:00场',
      isDirectPayment: false,
      hasExternalCheckout: true,
    })
  })

  it('未启用秒杀壳时不渲染商品化抢购卡', () => {
    expect(buildFlashSaleMerchCard({ title: '普通活动' } as any, formatPaymentAmount)).toBeNull()
  })
})
