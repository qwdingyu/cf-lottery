import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')
const adminServiceSource = readFileSync(new URL('../../../../src/services/admin-service.ts', import.meta.url), 'utf8')

describe('admin orders email resend / event contract (V-012)', () => {
  it('single resend refreshes order detail on success and failure', () => {
    expect(ordersSource).toContain('async function resendEmail')
    expect(ordersSource).toContain('resendAdminOrderEmail')
    expect(ordersSource).toContain('fetchAdminOrder')
    // 成功与失败分支均应尝试刷新详情（email_resent / email_failed）
    expect(ordersSource).toMatch(/showToast\(res\.message[\s\S]*?fetchAdminOrder/)
    expect(ordersSource).toMatch(/showToast\(err\.message[\s\S]*?fetchAdminOrder/)
  })

  it('batch resend refreshes open detail when current order is in selection', () => {
    expect(ordersSource).toContain('async function batchResendEmail')
    expect(ordersSource).toMatch(/batchResendEmail[\s\S]*?currentOrder\.value\?\.id/)
    expect(ordersSource).toMatch(/batchResendEmail[\s\S]*?fetchAdminOrder/)
  })

  it('maps email_failed / email_resent event labels and classes', () => {
    expect(ordersSource).toContain("email_failed: i18n.global.t('adminOrders.eventEmailFailed')")
    expect(ordersSource).toContain("email_resent: i18n.global.t('adminOrders.eventEmailResent')")
    expect(ordersSource).toContain("'email_resent'")
    expect(ordersSource).toMatch(/eventTypeClass[\s\S]*?email_resent[\s\S]*?tag-success/)
  })

  it('backend resendOrderEmail writes email_failed / email_resent and binds orderId', () => {
    expect(adminServiceSource).toContain('resendOrderEmail')
    // 成败事件统一走 trackIssuedEmailResult，禁止内联第二套 writeOrderEvent type
    expect(adminServiceSource).toContain('trackIssuedEmailResult')
    expect(adminServiceSource).toContain('onSuccess: "email_resent"')
    expect(adminServiceSource).toContain('source: "admin_resend"')
    // sendEmail 须带 orderId，便于 email_logs 关联
    expect(adminServiceSource).toMatch(/sendEmail\([\s\S]*?orderId/)
  })
})
