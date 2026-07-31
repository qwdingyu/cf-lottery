import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shopSource = readFileSync(new URL('../views/ShopView.vue', import.meta.url), 'utf8')
const paySource = readFileSync(new URL('../components/PayModal.vue', import.meta.url), 'utf8')
const shareSource = readFileSync(new URL('./member-share-referral.ts', import.meta.url), 'utf8')

describe('outbound share + post-pay refer contract', () => {
  it('ShopView copy uses own share code only', () => {
    expect(shopSource).toContain('resolveOutboundShareAttribution')
    expect(shopSource).toContain('copyBuyLinkFromConfirm')
    expect(shopSource).not.toContain('resolveAttributionForCheckout')
    // 仍捕获入站归因用于结账
    expect(shopSource).toContain('captureAttributionFromQuery')
  })

  it('Pay success offers link to member referral page', () => {
    expect(paySource).toContain("name: 'MemberReferral'")
    expect(paySource).toContain('查看我的推广码')
    expect(paySource).toContain("resultStatus === 'success'")
  })

  it('share module documents no inbound rebroadcast', () => {
    expect(shareSource).toContain('禁止')
    expect(shareSource).toContain('getMemberShareReferralCode')
    expect(shareSource).toContain('resolveOutboundShareAttribution')
  })
})
