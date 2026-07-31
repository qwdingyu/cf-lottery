import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')
const emailLogsSource = readFileSync(new URL('./AdminEmailLogsView.vue', import.meta.url), 'utf8')
const balanceSource = readFileSync(new URL('./AdminBalanceView.vue', import.meta.url), 'utf8')
const packageJson = readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')

describe('admin ops deeplink contract', () => {
  it('hydrates order list q from the route and caps length at 120', () => {
    expect(ordersSource).toContain('filter.q = String(query.q).slice(0, 120)')
    expect(ordersSource).toContain('maxlength="120"')
    expect(ordersSource).toContain("if (filter.q) query.q = filter.q")
  })

  it('shows paymentRef in the order list and selected/server export paths', () => {
    expect(ordersSource).toContain("$t('adminOrders.colPaymentRef')")
    expect(ordersSource).toContain('item.paymentRef || \'-\'')
    // 客户端选中导出须与 shared/admin-order-export + 服务端 /orders/export 同源表头
    expect(ordersSource).toContain('ADMIN_ORDER_EXPORT_CSV_HEADERS')
    expect(ordersSource).toContain('orderExportCell')
    expect(ordersSource).toContain('exportSelectedCsv')
    // 复制 TSV 仍须含流水/归因/paidAt（人工结算粘贴）
    expect(ordersSource).toContain('order.paymentRef || \'\'')
    expect(ordersSource).toContain('order.campaignCode || \'\'')
    expect(ordersSource).toContain('order.referralCode || \'\'')
    expect(ordersSource).toContain('order.paidAt || \'\'')
  })

  it('exposes settlement status filter and copy includes attribution for L0 ops', () => {
    // 人工结算：状态下拉绑定 SETTLEMENT_ORDER_STATUS_QUERY；复制 TSV 含活动/推荐/paidAt
    // 文案走 i18n（adminOrders.statusSettled），禁止再硬编码「已成交（结算）」
    expect(ordersSource).toContain('SETTLEMENT_ORDER_STATUS_QUERY')
    expect(ordersSource).toContain("$t('adminOrders.statusSettled')")
    expect(ordersSource).toContain('isSettlementOrderStatusFilter')
    expect(ordersSource).toContain('order.campaignCode || \'\'')
    expect(ordersSource).toContain('order.referralCode || \'\'')
    expect(ordersSource).toContain('order.paidAt || \'\'')
  })

  it('order detail shows plain client IP, not ip_hash fingerprint', () => {
    // 运营需要可识别 IP；哈希不可逆，不得再作为主展示
    expect(ordersSource).toContain("$t('adminOrders.detailClientIp')")
    expect(ordersSource).not.toContain('IP 标识（哈希）')
    expect(ordersSource).toContain('orderClientIpText')
    expect(ordersSource).toContain('order.clientIp')
    expect(ordersSource).toContain('clientIpHashOnly')
    // TG 单 IP 语义：Webhook 侧，禁止暗示为买家设备 IP
    expect(ordersSource).toContain("orderSource === 'telegram'")
    expect(ordersSource).toContain('clientIpTelegram')
  })

  it('order search and detail expose referral/campaign for ops attribution', () => {
    // 搜索框 placeholder 走 i18n（含活动码/推荐码语义），详情归因字段亦走 i18n
    expect(ordersSource).toContain("$t('adminOrders.search')")
    expect(ordersSource).toContain("$t('adminOrders.detailReferralCode')")
    expect(ordersSource).toContain("$t('adminOrders.detailCampaignCode')")
    expect(ordersSource).toContain('attributionText')
    // 列表：列头标明归因层；标签展示活动/推荐，不改写 orderSource 主文案
    expect(ordersSource).toContain("$t('adminOrders.colSourceAttribution')")
    expect(ordersSource).toContain('order-attribution-line')
    expect(ordersSource).toContain('order-attr-tag')
    expect(ordersSource).toContain("$t('adminOrders.campaignTag')")
    expect(ordersSource).toContain("$t('adminOrders.referralTag')")
    expect(ordersSource).toContain('orderSourceText')
  })

  it('keeps lottery order source and payment method visible in admin orders', () => {
    expect(ordersSource).toContain("$t('adminOrders.sourceLottery')")
    expect(ordersSource).toContain("$t('adminOrders.paymentLottery')")
    expect(ordersSource).toContain("order.orderSource === 'lottery'")
    expect(ordersSource).toContain('paymentMethodText(item)')
    expect(ordersSource).toContain('paymentMethodText(currentOrder)')
    expect(ordersSource).toContain("case 'paymentMethod':")
    expect(ordersSource).toContain('return paymentMethodText(order)')
  })

  it('order detail registry hint is read-only and never implies checkout gating', () => {
    expect(ordersSource).toContain('referralRegistryHintLabel')
    expect(ordersSource).toContain('referralRegistryStatus')
    // 只读标签文案，非拦截逻辑
    expect(ordersSource).toContain('registryStatusUnregistered')
  })

  it('links order detail to email logs and balance ledger via query-driven routes', () => {
    expect(ordersSource).toContain("path: '/admin/email-logs'")
    expect(ordersSource).toContain('query: { search }')
    expect(ordersSource).toContain("path: '/admin/balance'")
    expect(ordersSource).toContain("referenceType: 'order'")
    expect(ordersSource).toContain('openEmailLogsForOrder')
    expect(ordersSource).toContain('openBalanceLedgerForOrder')
  })

  it('hydrates email-logs search from route query and deep-links order ids', () => {
    expect(emailLogsSource).toContain('initFilterFromRoute')
    expect(emailLogsSource).toContain("route.query.search")
    expect(emailLogsSource).toContain('.slice(0, 200)')
    expect(emailLogsSource).toContain("path: '/admin/orders'")
    expect(emailLogsSource).toContain("query: { q: String(item.orderId).slice(0, 120) }")
    expect(emailLogsSource).toContain("void router.replace({ path: route.path, query })")
  })

  it('hydrates balance ledger filters from route query and deep-links order spend refs', () => {
    expect(balanceSource).toContain('initFilterFromRoute')
    expect(balanceSource).toContain("query.referenceType")
    expect(balanceSource).toContain("query.referenceId")
    expect(balanceSource).toContain("path: '/admin/orders'")
    expect(balanceSource).toContain("item.referenceType === 'order'")
  })

  it('exposes local frontend type-check gate aligned with CI vue-tsc', () => {
    expect(packageJson).toContain('"type-check:frontend"')
    expect(packageJson).toContain('npm --workspace frontend run type-check')
    expect(packageJson).toContain('"type-check:all"')
    const frontendPackage = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    expect(frontendPackage).toContain('"type-check"')
    expect(frontendPackage).toContain('vue-tsc -b')
  })
})
