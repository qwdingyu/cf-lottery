import { describe, expect, it } from 'vitest'
import {
  canRetryPaymentOrder,
  composePaymentCode,
  formatPaymentAmount,
  isDirectPaymentDraw,
  paymentStatusI18nKey,
  paymentStatusKind,
  shouldPollPaymentStatus,
} from './payment-ux'

describe('payment-ux', () => {
  it('只把 flashSale.paymentRequired=true 识别为直付活动', () => {
    expect(isDirectPaymentDraw({ flashSale: { paymentRequired: true } } as any)).toBe(true)
    expect(isDirectPaymentDraw({ flashSale: { paymentRequired: false } } as any)).toBe(false)
    expect(isDirectPaymentDraw(null)).toBe(false)
  })

  it('支付状态分类和轮询决策稳定', () => {
    expect(paymentStatusKind('pending')).toBe('pending')
    expect(paymentStatusKind('paid')).toBe('paid')
    expect(paymentStatusKind('paid_fulfillment_failed')).toBe('fulfillment_failed')
    expect(paymentStatusKind('expired')).toBe('retryable')
    expect(paymentStatusKind('cancelled')).toBe('retryable')
    expect(paymentStatusKind('refunded')).toBe('refunded')
    expect(paymentStatusKind('other')).toBe('unknown')

    expect(shouldPollPaymentStatus('pending')).toBe(true)
    expect(shouldPollPaymentStatus('paid')).toBe(false)
    expect(canRetryPaymentOrder('expired')).toBe(true)
    expect(canRetryPaymentOrder('pending')).toBe(false)
  })

  it('支付状态映射到 i18n key', () => {
    expect(paymentStatusI18nKey('pending')).toBe('paymentStatusPending')
    expect(paymentStatusI18nKey('paid')).toBe('paymentStatusPaid')
    expect(paymentStatusI18nKey('paid_fulfillment_failed')).toBe('paymentStatusFulfillmentFailed')
    expect(paymentStatusI18nKey('cancelled')).toBe('paymentStatusRetryable')
    expect(paymentStatusI18nKey('refunded')).toBe('paymentStatusRefunded')
    expect(paymentStatusI18nKey('')).toBe('paymentStatusUnknown')
  })

  it('金额和卡密展示不依赖模板拼字符串', () => {
    expect(formatPaymentAmount(9900, 'cny')).toBe('¥99.00')
    expect(formatPaymentAmount(1299, 'usd')).toBe('$12.99')
    expect(formatPaymentAmount(1200, 'jpy')).toBe('¥1200')
    expect(formatPaymentAmount(120000, 'usdt')).toBe('1200.00 USDT')
    expect(formatPaymentAmount(null, 'eur')).toBe('-- EUR')
    expect(composePaymentCode({ code: 'CARD-1', secret: 'SECRET' })).toBe('CARD-1:SECRET')
    expect(composePaymentCode({ code: 'CARD-1' })).toBe('CARD-1')
    expect(composePaymentCode(null)).toBe('')
  })
})
