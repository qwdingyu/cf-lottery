import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routerSource = readFileSync(new URL('../../router/index.ts', import.meta.url), 'utf8')

describe('admin routing contract', () => {
  it('keeps the pending-tasks URL on an explicit authenticated page route', () => {
    expect(routerSource).toContain("path: 'pending-tasks'")
    expect(routerSource).toContain("name: 'AdminPendingTasks'")
    expect(routerSource.match(/component: AdminDashboardView/g)).toHaveLength(2)
  })

  it('exposes email-logs as an authenticated admin page', () => {
    expect(routerSource).toContain("path: 'email-logs'")
    expect(routerSource).toContain("name: 'AdminEmailLogs'")
  })

  it('exposes referral-codes as an authenticated admin page', () => {
    expect(routerSource).toContain("path: 'referral-codes'")
    expect(routerSource).toContain("name: 'AdminReferralCodes'")
  })

  it('exposes campaigns as an authenticated admin page', () => {
    expect(routerSource).toContain("path: 'campaigns'")
    expect(routerSource).toContain("name: 'AdminCampaigns'")
    expect(routerSource).toContain('AdminCampaignsView')
  })

  it('exposes lottery as an authenticated admin page', () => {
    expect(routerSource).toContain("path: 'lottery'")
    expect(routerSource).toContain("name: 'AdminLottery'")
    expect(routerSource).toContain('AdminLotteryView')
  })
})
