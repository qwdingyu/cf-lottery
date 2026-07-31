import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viewSource = readFileSync(new URL('./MemberReferralView.vue', import.meta.url), 'utf8')
const routerSource = readFileSync(new URL('../router/index.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../api/index.ts', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('../components/HeaderBar.vue', import.meta.url), 'utf8')

describe('member referral (全员推广) contract', () => {
  it('registers /refer and redirects /partner', () => {
    expect(routerSource).toContain("path: '/refer'")
    expect(routerSource).toContain('MemberReferralView')
    expect(routerSource).toContain("path: '/partner'")
    expect(routerSource).toContain("redirect: '/refer'")
  })

  it('exposes member APIs without create-code', () => {
    expect(apiSource).toContain('/api/member/access-code')
    expect(apiSource).toContain('/api/member/session')
    expect(apiSource).toContain('/api/member/me')
    expect(apiSource).toContain('/api/member/rewards')
    expect(apiSource).not.toContain('/api/partner/')
    expect(apiSource).not.toContain('createPartnerReferralCode')
    expect(apiSource).not.toContain('createMemberReferralCode')
  })

  it('nav includes 推广 entry', () => {
    expect(headerSource).toContain('to="/refer"')
    expect(headerSource).toContain("$t('nav.refer')")
  })

  it('view is view-only for code (no create form)', () => {
    expect(viewSource).toContain('fetchMemberMe')
    expect(viewSource).toContain('copyPromoLink')
    expect(viewSource).toContain('setMemberShareReferralCode')
    expect(viewSource).not.toContain('createPartner')
    expect(viewSource).not.toContain("$t('member.create')")
  })

  it('renders percent rewards as percent instead of fixed money', () => {
    expect(viewSource).toContain("referralCode.rewardType === 'fixed'")
    expect(viewSource).toContain("$t('member.rewardFixed'")
    expect(viewSource).toContain("referralCode.rewardType === 'percent'")
    expect(viewSource).toContain("$t('member.rewardPercent'")
  })

  it('uses global dark form-card tokens (no light card fallback)', () => {
    // 禁止 scoped 用未定义 token + 白底 fallback 盖掉 desktop.css 暗色 .form-card
    expect(viewSource).not.toMatch(/var\(--card-bg/)
    expect(viewSource).not.toMatch(/background:\s*(?:var\([^)]+,\s*)?#fff\b/i)
    expect(viewSource).not.toMatch(/border-bottom:\s*1px solid #eee/)
    expect(viewSource).not.toMatch(/#c0392b/)
    expect(viewSource).toContain('class="form-card"')
    expect(viewSource).toContain('var(--tg-hint)')
    expect(viewSource).toContain('var(--border)')
    expect(viewSource).toContain('var(--tg-destructive')
  })
})
