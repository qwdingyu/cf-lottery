import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routerSource = readFileSync(new URL('../../router/index.ts', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../AdminLayout.vue', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../api/admin.ts', import.meta.url), 'utf8')
const viewSource = readFileSync(new URL('./AdminPromotionsView.vue', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../../../../src/routes/admin-promotions.ts', import.meta.url), 'utf8')

describe('admin promotions contract', () => {
  it('registers authenticated route and sidebar entry', () => {
    expect(routerSource).toContain("path: 'promotions'")
    expect(routerSource).toContain("name: 'AdminPromotions'")
    expect(routerSource).toContain('AdminPromotionsView')
    expect(layoutSource).toContain("to: '/admin/promotions'")
    expect(layoutSource).toContain('menuPromotions')
  })

  it('exposes only group-buy creation and status management APIs', () => {
    expect(apiSource).toContain("'/api/admin/promotions'")
    expect(apiSource).toContain("'/api/admin/promotions/group-buy'")
    expect(apiSource).toContain('updateAdminPromotionStatus')
    expect(routeSource).toContain('createGroupBuyPromotion')
    expect(routeSource).not.toContain('flash_sale')
  })

  it('warns operators that pricing promotions are not connected to checkout', () => {
    expect(viewSource).toContain('adminPromotions.toolbarHint')
    expect(viewSource).toContain('adminPromotions.formHint')
  })

  it('renders instance statuses through the shared promotion status labels', () => {
    expect(viewSource).toContain('statusText(item.status)')
  })

  it('renders promotion visible status and constrains lifecycle actions in the UI', () => {
    expect(viewSource).toContain('item.visibleStatus || item.status')
    expect(viewSource).toContain('canToggleActive(item)')
    expect(viewSource).toContain("item.status !== 'active' && item.status !== 'paused'")
  })

  it('confirms irreversible promotion lifecycle actions before sending them', () => {
    expect(viewSource).toContain('ConfirmDialog')
    expect(viewSource).toContain("adminPromotions.confirmEnd")
    expect(viewSource).toContain("adminPromotions.confirmArchive")
    expect(viewSource).toContain("item.status !== 'ended'")
    expect(viewSource).toContain("setStatus(item, 'archived')")
  })

  it('shows read-only promotion instance observability without adding write actions', () => {
    expect(viewSource).toContain('instanceOriginOrder')
    expect(viewSource).toContain('instanceUsageBreakdown')
    expect(viewSource).toContain('instanceLatestUsage')
    expect(viewSource).toContain('item.originOrderNo || item.originOrderId')
    expect(viewSource).toContain('item.latestUsageAt')
  })
})
