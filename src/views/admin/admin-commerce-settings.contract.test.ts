import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paymentSource = readFileSync(new URL('./AdminPaymentView.vue', import.meta.url), 'utf8')
const productsSource = readFileSync(new URL('./AdminProductsView.vue', import.meta.url), 'utf8')
const storefrontsSource = readFileSync(new URL('./AdminStorefrontsView.vue', import.meta.url), 'utf8')
const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')
const lotterySource = readFileSync(new URL('./AdminLotteryView.vue', import.meta.url), 'utf8')
const couponsSource = readFileSync(new URL('./AdminCouponsView.vue', import.meta.url), 'utf8')
const cardsSource = readFileSync(new URL('./AdminCardsView.vue', import.meta.url), 'utf8')
const vouchersSource = readFileSync(new URL('./AdminVouchersView.vue', import.meta.url), 'utf8')
const productCardSource = readFileSync(new URL('../../components/ProductCard.vue', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
const configFieldSource = readFileSync(new URL('../../components/admin/ConfigField.vue', import.meta.url), 'utf8')
const i18nSource = readFileSync(new URL('../../i18n/index.ts', import.meta.url), 'utf8')
const enSource = readFileSync(new URL('../../i18n/en.ts', import.meta.url), 'utf8')
const systemConfigDefinitions = JSON.parse(readFileSync(new URL('../../../../src/lib/system-config-definitions.json', import.meta.url), 'utf8')) as Array<{ key: string }>

describe('admin commerce settings contract', () => {
  it('shows the enabled state returned by payment config saves instead of a stale fixed message', () => {
    expect(paymentSource).toContain('const result = await updateAdminPaymentConfig')
    expect(paymentSource).toContain("showToast(result.message, 'success')")
    expect(paymentSource).not.toContain('已保存，验证无误后请手动启用')
  })

  it('keeps product cover URL editing, preview, persistence, and storefront fallback connected', () => {
    expect(productsSource).toContain('v-model.trim="form.coverUrl"')
    expect(productsSource).toContain('coverUrl: form.coverUrl')
    expect(productsSource).toContain('@error="coverPreviewFailed = true"')
    expect(productCardSource).toContain("@error=\"imageFailed = true\"")
    expect(productsSource).toContain('await uploadAdminMediaImage(token.value, file)')
    expect(productsSource).toContain('form.coverUrl = result.url')
    expect(storefrontsSource).toContain('await uploadAdminMediaImage(token.value, file)')
    expect(storefrontsSource).toContain('form.logoUrl = result.url')
  })

  it('exposes product selection for every storefront and guards an empty default shop', () => {
    expect(storefrontsSource).toContain("$t('adminStorefronts.actionSelectProducts')")
    expect(storefrontsSource).toContain('currentStorefront.value.isDefault && visibleProducts.length === 0')
    expect(storefrontsSource).toContain("t('adminStorefronts.confirmEmptyDefault')")
  })

  it('shows the stable template key beside its operator-facing label', () => {
    expect(storefrontsSource).toContain("$t('adminStorefronts.templateCompact')")
    expect(storefrontsSource).toContain("$t('adminStorefronts.templateCatalog')")
  })

  it('defaults free-product purchase limit guidance to one claim per mailbox', () => {
    expect(productsSource).toContain("$t('adminProducts.purchaseLimitFreeHint')")
    expect(productsSource).toContain("if (parseMajorToMinor(form.priceMajor, form.currency) === 0) return 1")
    // 新建表单不得写死 purchaseLimit: '1'，否则改成付费价也会误带每人限 1
    expect(productsSource).toMatch(/purchaseLimit:\s*''/)
  })

  it('lets operators keep lottery prize products active but unpublished from storefronts', () => {
    expect(productsSource).toContain("v-model=\"internalOnlyProduct\"")
    expect(productsSource).toContain("$t('adminProducts.internalOnlyLabel')")
    expect(productsSource).toContain("form.storefrontIds = []")
    expect(productsSource).toContain("$t('adminProducts.freePublishedWarning')")
    expect(productsSource).toContain("await askConfirm(i18n.global.t('adminProducts.confirmFreePublished'")
    expect(productsSource).toContain("updateAdminProduct(token.value, editingId, { ...payload, storefrontIds: form.storefrontIds })")
    expect(productsSource).not.toContain('v-if="!editing" class="storefront-fieldset"')
  })

  it('localizes product editor option labels instead of rendering shared Chinese labels directly', () => {
    expect(productsSource).toContain('fulfillmentModeOptions')
    expect(productsSource).toContain('deliveryVisibilityOptions')
    expect(productsSource).toContain('fulfillmentInputOptions')
    expect(productsSource).toContain('stockDisplayModeOptions')
    expect(productsSource).toContain("adminProducts.fulfillmentModes")
    expect(productsSource).not.toContain('v-for="option in FULFILLMENT_MODE_OPTIONS"')
    expect(productsSource).not.toContain('v-for="option in DELIVERY_VISIBILITY_OPTIONS"')
    expect(productsSource).not.toContain('v-for="option in FULFILLMENT_INPUT_OPTIONS"')
    expect(productsSource).not.toContain('v-for="option in STOCK_DISPLAY_MODE_OPTIONS"')
    expect(productsSource).not.toContain('fulfillmentModeLabel')
    expect(productsSource).not.toContain('stockDisplayModeLabel')
  })

  it('localizes order fulfillment progress stages instead of rendering shared Chinese labels directly', () => {
    expect(ordersSource).toContain('fulfillmentProgressOptions = computed')
    expect(ordersSource).toContain('adminOrders.fulfillmentProgressStages')
    expect(ordersSource).not.toContain('const fulfillmentProgressOptions = FULFILLMENT_PROGRESS_OPTIONS')
  })

  it('localizes admin config definitions and date input language', () => {
    expect(configFieldSource).toContain('adminConfig.fields.${props.item.key}.label')
    expect(configFieldSource).toContain('adminConfig.fields.${props.item.key}.description')
    expect(configFieldSource).toContain('adminConfig.fields.${props.item.key}.effect')
    expect(configFieldSource).toContain("adminConfigField.yuanUnit")
    expect(i18nSource).toContain('document.documentElement.lang = lang')
    expect(enSource).toContain('shop_name:')
    expect(enSource).toContain('referral_member_reward_value_cents:')
    expect(enSource).toContain('keep_trade:')
    expect(enSource).toContain('keep_catalog:')
    expect(enSource).not.toContain('keepTrade:')
    expect(enSource).not.toContain('keepCatalog:')
    expect(enSource).not.toContain('ops: "Data & Maintenance",\\n    \\n    clearData')
    for (const item of systemConfigDefinitions) {
      expect(enSource).toContain(`${item.key}:`)
    }
  })

  it('binds admin datetime-local controls to the active locale', () => {
    for (const source of [lotterySource, couponsSource, cardsSource, vouchersSource]) {
      expect(source).not.toMatch(/type="datetime-local"(?![^>]*:lang)/)
    }
  })

  it('shows the product purchase-limit period directly in the admin product table', () => {
    expect(productsSource).toContain("$t('adminProducts.colPeriod')")
    expect(productsSource).toContain('purchaseLimitPeriodText(item)')
    expect(productsSource).toContain('purchaseLimitPeriodClass(item)')
    expect(productsSource).toContain('function purchaseLimitPeriodText(item: AdminProduct)')
    expect(productsSource).toContain("return item.purchaseLimitPeriod === 'daily' ? '每日' : '总限'")
    expect(productsSource).toContain('colspan="14"')
  })

  it('uses an on-row shelf switch instead of a sort jump in product ops', () => {
    expect(productsSource).toContain('toggleProductActive')
    expect(productsSource).toContain('status-switch')
    expect(productsSource).toContain("updateAdminProduct(token.value, item.id, { active: nextActive })")
    expect(productsSource).not.toContain('goStorefrontSort')
    expect(productsSource).not.toContain('>排序</button>')
    // 渠道排序仍保留在展示渠道列的行内编辑，不从操作列跳转
    expect(productsSource).toContain('saveCurrentStorefrontSort')
    expect(productsSource).toContain('adminProducts.sortOrderLabel')
  })

  it('copies user-facing buy links only for a visible channel mapping', () => {
    expect(productsSource).toContain('copyProductBuyLink')
    expect(productsSource).toContain('resolveAdminBuyLink')
    expect(productsSource).toContain('adminBuyLinkFailureMessage')
    // 可选活动/推荐码写入购买链 ?campaign= / ?ref=
    expect(productsSource).toContain('buyLinkCampaign')
    expect(productsSource).toContain('buyLinkReferral')
    expect(productsSource).toContain('attribution:')
    // 下架商品在商品列表直接禁用复制，避免无效点击
    expect(productsSource).toContain('item.active === false')
    expect(storefrontsSource).toContain('copyProductBuyLink')
    expect(storefrontsSource).toContain('resolveAdminBuyLink')
    expect(storefrontsSource).toContain('buyLinkCampaign')
    expect(storefrontsSource).toContain('attribution:')
    // 渠道映射：只允许已落库且未 dirty 的可见映射，禁止草稿死链
    expect(storefrontsSource).toContain('canCopyPersistedStorefrontBuyLink')
    expect(storefrontsSource).toContain('mappingBuyLinkGateMessage')
    expect(storefrontsSource).toContain('canCopyBuyLink')
    expect(storefrontsSource).toContain('persisted:')
    expect(storefrontsSource).toContain('mappingBuyLinkGateMessage(gate.reason)')
    // 禁止静默拼到无渠道 path
    expect(productsSource).not.toContain("'/product/'")
    expect(storefrontsSource).not.toContain("'/product/'")
  })

  it('recovers once when a deployed lazy chunk is missing from an already-open page', () => {
    expect(mainSource).toContain("window.addEventListener('vite:preloadError'")
    expect(mainSource).toContain('router.onError')
    expect(mainSource).toContain('window.location.replace(recoveryUrl)')
  })
})
