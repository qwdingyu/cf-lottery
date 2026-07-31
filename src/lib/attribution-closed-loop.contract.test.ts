/**
 * 结构契约：店面下单路径「订单头 referral_code ↔ referral_events」闭环。
 * 放在 frontend 工作区以便 type-check（node:fs + import.meta.url）；
 * 读取后端/前端真实源文件，禁止只断言测试替身。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../../../', import.meta.url)
const paySource = readFileSync(new URL('./src/routes/pay.ts', repoRoot), 'utf8')
const orderServiceSource = readFileSync(new URL('./src/services/order-service.ts', repoRoot), 'utf8')
const referralSource = readFileSync(new URL('./src/services/referral-service.ts', repoRoot), 'utf8')
const payModalSource = readFileSync(new URL('./frontend/src/components/PayModal.vue', repoRoot), 'utf8')
const shopSource = readFileSync(new URL('./frontend/src/views/ShopView.vue', repoRoot), 'utf8')
const attributionSource = readFileSync(new URL('./frontend/src/lib/checkout-attribution.ts', repoRoot), 'utf8')

describe('storefront attribution closed-loop contract', () => {
  it('centralizes referral events in recordReferralEvent with per-order idempotency', () => {
    expect(referralSource).toContain('export async function recordReferralEvent')
    expect(referralSource).toContain('return "skipped"')
    expect(referralSource).toContain('return "exists"')
    expect(referralSource).toContain('return "inserted"')
    expect(referralSource).toContain('eq(referralEvents.orderId, orderId)')
    expect(referralSource).toContain('status: "created"')
  })

  it('pay createOrderRecord always invokes recorder after order insert', () => {
    expect(paySource).toContain('import { recordReferralEvent }')
    const createOrderRecordBlock = paySource.slice(
      paySource.indexOf('export async function createOrderRecord'),
      paySource.indexOf('export async function createOfflineOrder'),
    )
    expect(createOrderRecordBlock).toContain('referralCode: referralCode || ""')
    expect(createOrderRecordBlock).toContain('await recordReferralEvent(db,')
    expect(paySource.match(/await createOrderRecord\(/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('order-service createOrder records events inside all three insert transactions', () => {
    expect(orderServiceSource).toContain('import { recordReferralEvent }')
    const calls = orderServiceSource.match(/await recordReferralEvent\(tx,/g) || []
    expect(calls.length).toBe(3)
    expect(orderServiceSource).not.toMatch(/await recordReferralEvent\(db,/)
  })

  it('FE captures sticky attribution, clears on explicit empty and after successful pay', () => {
    expect(shopSource).toContain('captureAttributionFromQuery')
    expect(attributionSource).toContain('export function clearCheckoutAttribution')
    expect(attributionSource).toContain('export function captureAttributionFromQuery')
    expect(attributionSource).toContain('queryHasAttributionKey')
    expect(attributionSource).toContain('resolveAttributionForCheckout')
    expect(payModalSource).toContain('resolveAttributionForCheckout')
    expect(payModalSource).toContain('clearCheckoutAttribution')
    const clearCount = (payModalSource.match(/clearCheckoutAttribution\(\)/g) || []).length
    expect(clearCount).toBeGreaterThanOrEqual(2)
  })
})
