import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dashboardSource = readFileSync(new URL('./AdminDashboardView.vue', import.meta.url), 'utf8')

describe('admin dashboard marketing summary contract', () => {
  it('keeps marketing summary read-only and protects quick period switching from stale responses', () => {
    expect(dashboardSource).toContain('fetchAdminMarketingSummary')
    expect(dashboardSource).toContain('let marketingRequestSequence = 0')
    expect(dashboardSource).toContain('const requestSequence = ++marketingRequestSequence')
    expect(dashboardSource).toContain('if (requestSequence !== marketingRequestSequence) return')
    expect(dashboardSource).toContain('fetchAdminMarketingSummary(token.value, { days: requestedDays, limit: 10 })')
  })

  it('deep-links marketing summary rows to converted storefront orders', () => {
    expect(dashboardSource).toContain('goToMarketingOrders(group.key, row)')
    expect(dashboardSource).toContain("status: 'paid,issued'")
    expect(dashboardSource).toContain("orderSource: 'storefront'")
    expect(dashboardSource).toContain("query.storefrontId = row.storefrontId")
    expect(dashboardSource).toContain("query.q = row.code")
    expect(dashboardSource).toContain("path: '/admin/orders'")
  })
})
