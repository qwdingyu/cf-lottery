import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./RechargeModal.vue', import.meta.url), 'utf8')

describe('recharge modal interaction contract', () => {
  it('submits verification and recharge from the form, including Enter', () => {
    expect(source).toContain('<form v-if="step === \'form\'" class="recharge-body" @submit.prevent="submit">')
    expect(source).toContain('type="submit"')
    expect(source).toContain("$t('recharge.submit'")
    expect(source).toContain('autocomplete="one-time-code"')
  })

  it('explains why recharge is unavailable when no payment method is enabled', () => {
    expect(source).toContain('paymentAvailabilityError')
    expect(source).toContain("t('recharge.noPaymentMethods')")
    expect(source).toContain('methods.length === 0')
  })

  it('validates email, verification code, amount, and payment availability before creating an order', () => {
    expect(source).toContain("t('recharge.validEmail')")
    expect(source).toContain("t('recharge.validCode')")
    expect(source).toContain("t('recharge.amountRange'")
    expect(source).toContain('if (methods.value.length === 0) return')
  })

  it('expires stale recovery state and resets the modal after closing', () => {
    expect(source).toContain('PENDING_RECHARGE_TTL_MS')
    expect(source).toContain('createdAt')
    expect(source).toContain('resetFormState()')
    expect(source).toContain('loadShopConfig(true).catch(() => undefined)')
    expect(source).toContain(':disabled="submitting" @click="close"')
    expect(source).toContain('function close() { if (submitting.value) return; stopPolling(); closeRecharge(); resetFormState() }')
    expect(source).toContain('const restored = restore()')
    expect(source).toContain('if (!restored && !email.value.trim())')
    expect(source.indexOf('const restored = restore()')).toBeGreaterThan(-1)
    expect(source.indexOf('const restored = restore()')).toBeLessThan(source.indexOf('loadShopConfig(true).catch'))
  })
})
