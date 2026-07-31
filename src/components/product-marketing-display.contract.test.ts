import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const cardSource = readFileSync(new URL('./ProductCard.vue', import.meta.url), 'utf8')
const confirmSource = readFileSync(new URL('./ProductConfirmSheet.vue', import.meta.url), 'utf8')
const countdownSource = readFileSync(new URL('../lib/marketing-countdown.ts', import.meta.url), 'utf8')

describe('product marketing display contract', () => {
  it('renders limited-time marketing fields as display-only storefront urgency', () => {
    expect(cardSource).toContain('props.product.marketingBadge')
    expect(cardSource).toContain('props.product.marketingEndsAt')
    expect(cardSource).toContain('promoDisplay.visible')
    expect(cardSource).toContain("from '@/lib/marketing-countdown'")
    expect(confirmSource).toContain('p.marketingBadge')
    expect(confirmSource).toContain('p.marketingEndsAt')
    expect(confirmSource).toContain('confirm-marketing')
    expect(confirmSource).toContain('marketingDisplay.visible')
    expect(confirmSource).toContain("from '@/lib/marketing-countdown'")
    expect(countdownSource).toContain('productCard.marketingEndsMinutes')
  })

  it('hides the marketing display after the configured end time expires', () => {
    expect(cardSource).toContain("if (endsAt && !countdown) return { visible: false")
    expect(confirmSource).toContain("if (endsAt && !countdown) return { visible: false")
  })

  it('does not render an empty countdown tag when only a marketing badge is configured', () => {
    expect(cardSource).toContain('promoDisplay.label')
    expect(cardSource).toContain('cover-badges-right')
    expect(cardSource).not.toContain('product-tag-marketing')
    expect(confirmSource).toContain('confirm-marketing-badge')
    expect(confirmSource).toContain('marketingDisplay.label')
    expect(confirmSource).not.toContain('confirm-marketing-time')
  })
})
