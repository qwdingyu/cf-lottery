import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../api/admin.ts', import.meta.url), 'utf8')
const adminRouteSource = readFileSync(new URL('../../../../src/routes/admin.ts', import.meta.url), 'utf8')
const orderStatusSource = readFileSync(new URL('../../../../shared/order-status.ts', import.meta.url), 'utf8')
const referralRewardSource = readFileSync(new URL('../../../../shared/referral-reward.ts', import.meta.url), 'utf8')
const referralServiceSource = readFileSync(
  new URL('../../../../src/services/referral-reward-service.ts', import.meta.url),
  'utf8',
)

describe('admin order L1 referral reward ops loop', () => {
  it('API client exposes mark-refunded / referral-reward get+retry', () => {
    expect(apiSource).toContain('fetchAdminOrderReferralReward')
    expect(apiSource).toContain('markAdminOrderRefunded')
    expect(apiSource).toContain('retryAdminOrderReferralReward')
    expect(apiSource).toContain('/mark-refunded')
    expect(apiSource).toContain('/referral-reward/retry')
    expect(apiSource).toContain('/referral-reward')
  })

  it('backend routes remain the single write path for refund reverse and retry', () => {
    expect(adminRouteSource).toContain('markOrderRefundedAndReverseReferral')
    expect(adminRouteSource).toContain('/orders/:id/mark-refunded')
    expect(adminRouteSource).toContain('/orders/:id/referral-reward/retry')
    expect(adminRouteSource).toContain('tryGrantReferralReward')
  })

  it('order detail loads reward ledger and offers mark-refunded + retry grant', () => {
    expect(ordersSource).toContain('loadReferralRewardForOrder')
    expect(ordersSource).toContain('fetchAdminOrderReferralReward')
    expect(ordersSource).toContain('markOrderRefunded')
    expect(ordersSource).toContain('markAdminOrderRefunded')
    expect(ordersSource).toContain('retryReferralReward')
    expect(ordersSource).toContain('retryAdminOrderReferralReward')
    expect(ordersSource).toContain('markOrderRefunded')
    expect(ordersSource).toContain("$t('adminOrders.detailRetryReward')")
    // 详情 3 Tab：佣金在履约面板；操作条常驻底栏
    expect(ordersSource).toContain('order-detail-panel-fulfillment')
    expect(ordersSource).toContain("detailSection === 'fulfillment'")
    expect(ordersSource).toContain('order-detail-actions')
    expect(ordersSource).toContain("$t('adminOrders.detailReferralNoData')")
  })

  it('order detail shows delivery_visibility snapshot and mark-refunded does not claim full refund', () => {
    expect(ordersSource).toContain('deliveryVisibilityText')
    expect(ordersSource).toContain('deliveryVisibility')
    expect(ordersSource).toContain("i18n.global.t('adminOrders.deliveryVisibilityEmailOnly')")
    // 确认文案走 i18n；语义（不退余额/不回收卡密）在 zh-CN.confirmRefundTitle 中固化，此处锁 key 绑定
    expect(ordersSource).toContain("t('adminOrders.confirmRefundTitle')")
    expect(ordersSource).toContain('markOrderRefunded')
  })

  it('UI gates refund/retry with isPaidLikeOrderStatus (shared PAID_LIKE)', () => {
    expect(ordersSource).toContain('isPaidLikeOrderStatus')
    expect(ordersSource).toContain('canMarkOrderRefunded')
    expect(ordersSource).toContain('canRetryReferralReward')
  })

  it('paid-like status is single-sourced in order-status; referral re-exports; reverse CAS uses PAID_LIKE', () => {
    expect(orderStatusSource).toContain('PAID_LIKE_ORDER_STATUSES')
    expect(orderStatusSource).toContain('export function isPaidLikeOrderStatus')
    // referral-reward 不得再内联 ["paid","issued"]
    expect(referralRewardSource).toContain('export { isPaidLikeOrderStatus }')
    expect(referralRewardSource).not.toMatch(/\[\s*["']paid["']\s*,\s*["']issued["']\s*\]/)
    expect(referralServiceSource).toContain('PAID_LIKE_ORDER_STATUSES')
    expect(referralServiceSource).toContain('inArray(orders.status, [...PAID_LIKE_ORDER_STATUSES])')
  })
})
