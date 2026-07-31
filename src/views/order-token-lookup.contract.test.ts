import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const orderViewSource = readFileSync(new URL('./OrderView.vue', import.meta.url), 'utf8')

describe('order token lookup contract', () => {
  it('supports token-only secure order links from lottery winner emails', () => {
    expect(orderViewSource).toContain("import { getPayStatus, lookupOrders } from '@/api'")
    expect(orderViewSource).toContain('if (!orderId)')
    expect(orderViewSource).toContain('const rows = await lookupOrders(token)')
    expect(orderViewSource).toContain('buildLookupOrderState(first)')
    expect(orderViewSource).toContain("readOrderLinkParam('token')")
    expect(orderViewSource).toContain("route.hash.includes('?')")
    expect(orderViewSource).not.toContain('if (!orderId || !token)')
  })
})
