import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 抽奖管理页主题与组件契约：
 * - 必须 import admin.css，禁止自造 chip / btn-warning
 * - 必须显式 import AdminProductSelect（无自动注册）
 * - 商品下拉仅 card 履约；状态用共享 .tag*
 * - 订单跳转走 RouterLink query.q（与订单列表 deep-link 对齐）
 */
const viewSource = readFileSync(new URL('./AdminLotteryView.vue', import.meta.url), 'utf8')
const productSelectSource = readFileSync(
  new URL('../../components/AdminProductSelect.vue', import.meta.url),
  'utf8',
)
const lotteryServiceSource = readFileSync(
  new URL('../../../../src/services/lottery-service.ts', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(new URL('../../api/admin.ts', import.meta.url), 'utf8')

describe('admin lottery theme + product select contract', () => {
  it('imports admin.css and does not invent chip/btn-warning primitives', () => {
    expect(viewSource).toContain("@/assets/admin.css")
    // 禁止 class 用法与 CSS 定义；注释里可以写「禁止 btn-warning」作约束说明
    expect(viewSource).not.toMatch(/class="[^"]*chip/)
    expect(viewSource).not.toMatch(/class='[^']*chip/)
    expect(viewSource).not.toMatch(/class="[^"]*btn-warning/)
    expect(viewSource).not.toMatch(/class='[^']*btn-warning/)
    expect(viewSource).not.toMatch(/\.chip(?:-[\w]+)?\s*\{/)
    expect(viewSource).not.toMatch(/\.btn-warning\s*\{/)
    expect(viewSource).not.toMatch(/<style\s+scoped/)
  })

  it('explicitly imports AdminProductSelect and locks card-only fulfillment', () => {
    expect(viewSource).toContain("import AdminProductSelect from '@/components/AdminProductSelect.vue'")
    expect(viewSource).toContain('fulfillment-mode="card"')
    expect(viewSource).toContain('AdminModal')
    expect(viewSource).toContain('modal-form')
    expect(productSelectSource).toContain('fulfillmentMode?: string')
    expect(productSelectSource).toContain("defineModel<string>")
    expect(productSelectSource).toContain('productStorefrontLabel')
    expect(productSelectSource).toContain("t('adminProductSelect.internalOnly')")
    expect(productSelectSource).toContain("t('adminProductSelect.publishedDefault')")
  })

  it('uses shared tag/table-actions/notice-card patterns', () => {
    expect(viewSource).toContain('class="tag"')
    expect(viewSource).toContain('tag-success')
    expect(viewSource).toContain('tag-muted')
    expect(viewSource).toContain('table-actions')
    expect(viewSource).toContain('notice-card')
    expect(viewSource).toContain('relation-cell')
    expect(viewSource).toContain('empty-text')
    expect(viewSource).toContain('table-error')
    expect(viewSource).toContain('field-hint')
  })

  it('create form uses product-style sections, time presets, and order validation', () => {
    expect(viewSource).toContain('form-section')
    expect(viewSource).toContain('form-grid two-cols')
    expect(viewSource).toContain('lottery-editor-form')
    expect(viewSource).toContain('time-preset-row')
    expect(viewSource).toContain('applyTimePreset')
    expect(viewSource).toContain('timeOrderError')
    expect(viewSource).toContain("type=\"datetime-local\"")
    expect(viewSource).toContain('toDateTimeLocalValue')
    // 表格收拢列数，操作区允许换行（避免 nowrap 撑爆）
    expect(viewSource).toContain('colspan="9"')
    expect(viewSource).toContain('col-actions')
  })

  it('truncates failureReason in table and clamps name column', () => {
    expect(viewSource).toContain('shortFailure')
    expect(viewSource).toContain('failure-snippet')
    expect(viewSource).toContain('col-name')
    // 禁止把整段 failureReason 无截断直接塞进单元格（历史上会把表撑成只剩名称列）
    expect(viewSource).not.toMatch(/\{\{\s*draw\.failureReason\s*\}\}/)
  })

  it('orders deep-link via RouterLink query.q capped at 120', () => {
    expect(viewSource).toContain('RouterLink')
    expect(viewSource).toContain("path: '/admin/orders'")
    expect(viewSource).toContain('query: { q: String(w.orderNo).slice(0, 120) }')
    // 禁止回到裸 hash 链接
    expect(viewSource).not.toContain("'/#/admin/orders?q='")
  })

  it('listAdminDraws exposes productTitle + entryCount; winners expose email status', () => {
    expect(lotteryServiceSource).toContain('productTitle: products.title')
    expect(lotteryServiceSource).toContain('entryCount: sql<number>`(select count(*) from ${lotteryEntries} where ${lotteryEntries.drawId} = ${lotteryDraws.id})`')
    expect(lotteryServiceSource).toContain('winnerCount: sql<number>`(select count(*) from ${lotteryWinners} where ${lotteryWinners.drawId} = ${lotteryDraws.id})`')
    expect(lotteryServiceSource).not.toContain('entryCount: count(lotteryEntries.id)')
    expect(lotteryServiceSource).not.toContain('winnerCount: count(lotteryWinners.id)')
    expect(lotteryServiceSource).not.toContain('count(distinct')
    expect(lotteryServiceSource).toContain('emailSent: lotteryWinners.emailSent')
    expect(lotteryServiceSource).toContain('emailError: lotteryWinners.emailError')
    expect(apiSource).toContain('productTitle?: string | null')
    expect(apiSource).toContain('emailSent?: number')
  })

  it('hardcodes limitPerEmail=1 on create and never offers editable >1', () => {
    expect(viewSource).toContain('limitPerEmail: 1')
    expect(viewSource).toContain(':value="1"')
    expect(viewSource).toContain('disabled')
    expect(viewSource).toContain("$t('lottery.adminLimitHint')")
  })

  it('all lottery admin API calls go through adminRequest helpers', () => {
    expect(viewSource).toContain('fetchAdminLotteryDraws')
    expect(viewSource).toContain('createAdminLotteryDraw')
    expect(viewSource).toContain('openAdminLotteryDraw')
    expect(viewSource).toContain('performAdminLotteryDraw')
    expect(viewSource).toContain('cancelAdminLotteryDraw')
    expect(viewSource).toContain('retryAdminLotteryEmail')
    expect(viewSource).not.toMatch(/fetch\s*\(\s*['"`]\/api\/admin\/lottery/)
  })

  it('ops UX: share link, duplicate draft, draw confirm summary, email failure banner', () => {
    expect(viewSource).toContain("from '@/lib/lottery-ops'")
    expect(viewSource).toContain('buildLotteryPublicShareUrl')
    expect(viewSource).toContain('buildLotteryDuplicateDraft')
    expect(viewSource).toContain('buildLotteryDrawConfirmMessage')
    expect(viewSource).toContain('countLotteryEmailFailures')
    expect(viewSource).toContain('formatLotteryEntryProgress')
    expect(viewSource).toContain('handleCopyShareLink')
    expect(viewSource).toContain('handleDuplicate')
    expect(viewSource).toContain('winnersEmailFailureCount')
    expect(viewSource).toContain('adminEmailFailureSummary')
    // 开奖确认必须带池子摘要，禁止只弹一句无上下文的确认
    expect(viewSource).toContain('handleDraw(draw)')
    expect(viewSource).toContain('adminConfirmDrawPool')
    // 复制活动不直接 POST，只预填表单；创建仍走 handleCreate 校验时间
    expect(viewSource).toContain('adminDuplicateReady')
    expect(viewSource).toContain('isEditing.value = false')
  })

  it('ops UX p1: search/sort, open copies link, draw opens winners, export csv, public page', () => {
    expect(viewSource).toContain('filterAndSortAdminLotteryDraws')
    expect(viewSource).toContain('listQuery')
    expect(viewSource).toContain('adminSearchPlaceholder')
    expect(viewSource).toContain('buildLotteryWinnersCsvRows')
    expect(viewSource).toContain('handleExportWinners')
    expect(viewSource).toContain('downloadCsv')
    expect(viewSource).toContain('adminOpenedWithLink')
    expect(viewSource).toContain('handleOpenPublic')
    // 开奖成功后必须自动打开中奖名单
    expect(viewSource).toMatch(/performAdminLotteryDraw[\s\S]*?viewWinners\(/)
  })

  it('ops UX p2: visibility label, create copies link, draw then winners without operatingId race', () => {
    expect(viewSource).toContain('formatLotteryVisibilityLabel')
    expect(viewSource).toContain('visibilityLabel')
    expect(viewSource).toContain('adminVisibilityPublic')
    expect(viewSource).toContain('adminCreatedWithLink')
    expect(viewSource).toContain('publicShareUrl(created.id)')
    expect(viewSource).toContain('drawOk')
    expect(viewSource).toMatch(/operatingId\.value = ''[\s\S]*if \(drawOk\)[\s\S]*viewWinners/)
  })

  it('keeps winner email status fresh after draw', () => {
    expect(viewSource).toContain('winnersEmailPendingCount')
    expect(viewSource).toContain('startWinnersStatusPolling')
    expect(viewSource).toContain('refreshWinnersStatus')
    expect(viewSource).toContain('MAX_WINNERS_STATUS_REFRESHES')
    expect(viewSource).toContain('onBeforeUnmount')
  })

  it('ops UX p3: filter count, empty match, edit draft-only, visibility confirm', () => {
    expect(viewSource).toContain('hasListFilter')
    expect(viewSource).toContain('adminListCount')
    expect(viewSource).toContain('adminNoMatch')
    expect(viewSource).toContain('adminEditNonDraft')
    expect(viewSource).toContain("draw.status !== 'draft'")
    expect(viewSource).toContain('adminConfirmToggleVisibility')
    // 编辑按钮不得对 paused 开放（后端 PATCH 仅 draft）
    expect(viewSource).not.toMatch(/v-if="draw\.status === 'draft' \|\| draw\.status === 'paused'"[\s\S]{0,120}handleEdit/)
  })

  it('declares filteredDraws before selection setup to avoid setup-time TDZ crashes', () => {
    const filteredIndex = viewSource.indexOf('const filteredDraws = computed')
    const visibleIndex = viewSource.indexOf('const visibleItems = computed(() => filteredDraws.value)')
    const selectionIndex = viewSource.indexOf('useTableSelection(visibleItems')

    expect(filteredIndex).toBeGreaterThan(-1)
    expect(visibleIndex).toBeGreaterThan(filteredIndex)
    expect(selectionIndex).toBeGreaterThan(visibleIndex)
  })

  it('uses one delete predicate for row checkbox, batch selection, and delete button', () => {
    expect(viewSource).toContain('function canDeleteDraw(draw: AdminLotteryDraw): boolean')
    expect(viewSource).toContain("draw.status === 'draft' || draw.status === 'paused' || draw.status === 'drawn' || draw.status === 'cancelled'")
    expect(viewSource).toContain(':disabled="loading || batchOperating || !canDeleteDraw(draw)"')
    expect(viewSource).toContain('isSelectable: canDeleteDraw')
    expect(viewSource).toContain('v-if="canDeleteDraw(draw)"')
    expect(viewSource).toContain('drawnCount')
    expect(viewSource).toContain('statusLabel(draw.status)')
  })
})
