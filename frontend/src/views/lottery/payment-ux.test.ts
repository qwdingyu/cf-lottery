import { describe, expect, it } from 'vitest'
import {
  canRetryPaymentOrder,
  buildPaymentSessionSnapshot,
  composePaymentCode,
  formatPaymentAmount,
  isDirectPaymentDraw,
  parsePaymentSessionSnapshot,
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

  it('支付会话快照只保留恢复轮询所需字段，不持久化卡密明文', () => {
    const snapshot = buildPaymentSessionSnapshot({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'Buyer@Example.com',
      orderNo: 'order-1',
      status: 'pending',
      amountCents: 9900,
      currency: 'cny',
      provider: 'easypay',
      redirectUrl: 'https://pay.example.com',
      qrCode: 'qr-content',
      prizeCode: { code: 'CARD-1', secret: 'SECRET' },
    } as any, 1000)

    expect(snapshot).toMatchObject({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      savedAt: 1000,
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
  })

  it('拒绝不完整或过期的支付会话快照', () => {
    expect(buildPaymentSessionSnapshot({ drawId: 'draw-1', entryId: 'entry-1', email: '', orderNo: '' } as any)).toBeNull()
    expect(parsePaymentSessionSnapshot('{bad json', 2000)).toBeNull()
    expect(parsePaymentSessionSnapshot(JSON.stringify({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      status: 'pending',
      amountCents: 9900,
      currency: 'cny',
      provider: 'easypay',
      savedAt: 1000,
    }), 2000)).toMatchObject({ orderNo: 'order-1' })
    expect(parsePaymentSessionSnapshot(JSON.stringify({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      savedAt: 1000,
    }), 10_000, 100)).toBeNull()
    expect(parsePaymentSessionSnapshot(JSON.stringify({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      savedAt: 70_000,
    }), 1000)).toBeNull()
  })
})
