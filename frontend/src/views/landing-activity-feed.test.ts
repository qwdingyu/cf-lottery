import { describe, expect, it } from 'vitest'
import { buildLandingActivityCard, classifyLandingActivity } from './landing-activity-feed'

describe('landing-activity-feed', () => {
  it('直付秒杀卡片价格来自 flashSale.priceCents', () => {
    const card = buildLandingActivityCard({
      publicSlug: 'token-day',
      title: 'Token 秒杀',
      startAt: '2026-08-07T04:00:00.000Z',
      endAt: '2026-08-07T05:00:00.000Z',
      product: { title: 'Token 日卡', priceText: '外部价不采用' },
      flashSale: {
        enabled: true,
        paymentRequired: true,
        priceCents: 990,
        currency: 'cny',
        sessionLabel: '12:00场',
        remaining: 8,
        progressPercent: 20,
      },
    }, '免费')

    expect(card).toMatchObject({
      badge: 'flash',
      title: 'Token 日卡',
      priceText: '¥9.90',
      sessionLabel: '12:00场',
      remaining: 8,
      progressPercent: 20,
      href: '/lottery/token-day',
    })
  })

  it('免费活动没有价格时使用免费标签', () => {
    const card = buildLandingActivityCard({
      publicSlug: 'free-wheel',
      title: '免费抽奖',
      experienceType: 'wheel',
      startAt: '2026-08-07T04:00:00.000Z',
      endAt: '2026-08-07T05:00:00.000Z',
    }, '免费')

    expect(classifyLandingActivity({
      experienceType: 'wheel',
      flashSale: null,
    })).toBe('free')
    expect(card.priceText).toBe('免费')
    expect(card.badge).toBe('free')
  })
})
