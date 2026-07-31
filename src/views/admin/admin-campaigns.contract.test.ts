import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viewSource = readFileSync(new URL('./AdminCampaignsView.vue', import.meta.url), 'utf8')
const routerSource = readFileSync(new URL('../../router/index.ts', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../AdminLayout.vue', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../api/admin.ts', import.meta.url), 'utf8')

describe('admin campaigns management contract', () => {
  it('registers authenticated route and sidebar entry for campaigns', () => {
    expect(routerSource).toContain("path: 'campaigns'")
    expect(routerSource).toContain("name: 'AdminCampaigns'")
    expect(routerSource).toContain('AdminCampaignsView')
    expect(layoutSource).toContain("to: '/admin/campaigns'")
    expect(layoutSource).toContain("name: 'AdminCampaigns'")
    expect(layoutSource).toContain("t('adminLayout.menuCampaigns')")
  })

  it('wires list/create/update/delete to existing admin campaign APIs', () => {
    expect(viewSource).toContain('fetchAdminCampaigns')
    expect(viewSource).toContain('createAdminCampaign')
    expect(viewSource).toContain('updateAdminCampaign')
    expect(viewSource).toContain('deleteAdminCampaign')
    expect(apiSource).toContain("'/api/admin/campaigns'")
  })

  it('copies buy links with canonical short key ?campaign= only', () => {
    expect(viewSource).toContain('buildAdminPromotionLink')
    expect(viewSource).toContain('buildAdminPromotionReviewLink')
    expect(viewSource).toContain('confirmCopyLink')
    expect(viewSource).toContain('confirmCopyReviewLink')
    expect(viewSource).toContain("$t('adminCampaigns.copyLinkBtn')")
    expect(viewSource).toContain("$t('adminCampaigns.copyReviewLinkBtn')")
    expect(viewSource).toContain('appBasePath: import.meta.env.BASE_URL')
    expect(viewSource).toContain('copyLinkProduct')
    // 禁止出站长别名
    expect(viewSource).not.toMatch(/\?campaignCode=/)
    expect(viewSource).not.toMatch(/campaignCode=\$\{/)
  })

  it('deep-links campaign code to order search', () => {
    expect(viewSource).toContain('searchOrdersByCode')
    expect(viewSource).toContain("path: '/admin/orders'")
  })

  it('deep-links paid conversions for channel review (L0)', () => {
    expect(viewSource).toContain('searchPaidOrdersByCode')
    expect(viewSource).toContain("$t('adminCampaigns.actionSearchPaid')")
    expect(viewSource).toContain('SETTLEMENT_ORDER_STATUS_QUERY')
    expect(viewSource).toMatch(/searchPaidOrdersByCode[\s\S]*?status:\s*SETTLEMENT_ORDER_STATUS_QUERY/)
  })

  it('clears local filter when route query q is absent', () => {
    // 与推荐码页同构：防止筛选清空后 filterQ 残留
    expect(viewSource).toContain("filterQ.value = ''")
    expect(viewSource).toMatch(/else\s*\{[\s\S]*?filterQ\.value = ''/)
  })

  it('documents open attribution and does not block trade', () => {
    expect(viewSource).toContain("$t('adminCampaigns.toolbarHint')")
  })

  it('states active/dates are ledger-only and do not block checkout or campaign_code writes', () => {
    expect(viewSource).toContain("$t('adminCampaigns.formDatesHint')")
    expect(viewSource).toMatch(/enable|disable/)
    expect(viewSource).toMatch(/formDatesHint/)
  })
})
