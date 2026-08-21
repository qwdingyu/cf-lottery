import { describe, expect, it } from 'vitest'
import {
  allowsFlashSaleQuantityPicker,
  asHttpPaymentUrl,
  canRetryPaymentOrder,
  buildPaymentSessionSnapshot,
  composePaymentCode,
  flashSalePurchaseCtaI18nKey,
  formatPaymentAmount,
  hidesFlashSaleGrabCta,
  isDirectPaymentDraw,
  parsePaymentSessionSnapshot,
  paymentStatusI18nKey,
  paymentStatusKind,
  resolveFlashSalePurchasePhase,
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

  it('二维码内容为 URL 时提供安全备用支付入口', () => {
    expect(asHttpPaymentUrl('https://pay.example.com/checkout')).toBe('https://pay.example.com/checkout')
    expect(asHttpPaymentUrl('http://pay.example.com/checkout')).toBe('http://pay.example.com/checkout')
    expect(asHttpPaymentUrl('weixin://pay')).toBe('')
    expect(asHttpPaymentUrl('not a url')).toBe('')
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
      accessToken: 'token-1',
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
      accessToken: 'token-1',
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

  it('parsePaymentSessionSnapshot 恢复批量订单时保留 quantity 和 unitPriceCents', () => {
    const restored = parsePaymentSessionSnapshot(JSON.stringify({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      status: 'pending',
      amountCents: 19800,
      quantity: 3,
      unitPriceCents: 6600,
      currency: 'cny',
      provider: 'easypay',
      accessToken: 'token-1',
      savedAt: 1000,
    }), 2000)
    expect(restored?.quantity).toBe(3)
    expect(restored?.unitPriceCents).toBe(6600)
    expect(restored?.amountCents).toBe(19800)
  })

  it('buildPaymentSessionSnapshot 保留批量订单的 quantity 和 unitPriceCents', () => {
    const snapshot = buildPaymentSessionSnapshot({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      status: 'pending',
      amountCents: 26700,
      quantity: 3,
      unitPriceCents: 8900,
      currency: 'cny',
      provider: 'easypay',
      accessToken: 'token-1',
      redirectUrl: 'https://pay.example.com',
    } as any, 1000)

    expect(snapshot?.quantity).toBe(3)
    expect(snapshot?.unitPriceCents).toBe(8900)
    expect(snapshot?.amountCents).toBe(26700)
  })

  it('formatPaymentAmount 展示批量总价与单价逻辑一致', () => {
    // 3 件 * 8900 分 = 26700 分
    expect(formatPaymentAmount(26700, 'cny')).toBe('¥267.00')
    // 单价 8900 分 = 89.00 元
    expect(formatPaymentAmount(8900, 'cny')).toBe('¥89.00')
  })

  it('parsePaymentSessionSnapshot 向后兼容：旧数据（无 quantity）恢复为 1', () => {
    const restored = parsePaymentSessionSnapshot(JSON.stringify({
      drawId: 'draw-1',
      entryId: 'entry-1',
      email: 'buyer@example.com',
      orderNo: 'order-1',
      status: 'pending',
      amountCents: 9900,
      currency: 'cny',
      provider: 'easypay',
      accessToken: 'token-1',
      savedAt: 1000,
    }), 2000)
    expect(restored?.quantity).toBe(1)
    expect(restored?.unitPriceCents).toBe(0)
  })
})

/**
 * 直付购买阶段状态机（docs/257）。
 *
 * 回归的真实缺陷：已锁定名额但订单待支付时，公开页仍然渲染件数加减、总价预览和
 * 可点的「抢」按钮，用户以为要再抢一次；后端此时只允许续付同一笔订单。
 */
describe('resolveFlashSalePurchasePhase', () => {
  const base = { isDirectPayment: true, joined: true, maxPerUser: 5, remainingQuantity: 5 }

  it('非直付活动或未参与时保持 browse（正常挑件数、看总价、点抢）', () => {
    expect(resolveFlashSalePurchasePhase({ ...base, isDirectPayment: false })).toBe('browse')
    expect(resolveFlashSalePurchasePhase({ ...base, joined: false })).toBe('browse')
    expect(resolveFlashSalePurchasePhase({ ...base, joined: false, latestOrderStatus: 'pending' })).toBe('browse')
  })

  it('已锁名额且订单待支付 → resume_payment，只允许支付相关操作', () => {
    const phase = resolveFlashSalePurchasePhase({ ...base, latestOrderStatus: 'pending' })
    expect(phase).toBe('resume_payment')
    expect(allowsFlashSaleQuantityPicker(phase)).toBe(false)
    expect(hidesFlashSaleGrabCta(phase)).toBe(true)
    expect(flashSalePurchaseCtaI18nKey(phase, 'pending')).toBe('paymentContinuePaymentOnly')
  })

  it('订单摘要还没拉到（状态未知）时保守判为 resume_payment，绝不放出第二个下单入口', () => {
    expect(resolveFlashSalePurchasePhase({ ...base, latestOrderStatus: null })).toBe('resume_payment')
    expect(resolveFlashSalePurchasePhase({ ...base, latestOrderStatus: undefined })).toBe('resume_payment')
    expect(resolveFlashSalePurchasePhase({ ...base, latestOrderStatus: 'weird' })).toBe('resume_payment')
  })

  it('过期/取消订单走重新发起支付，而不是再选件数下新单', () => {
    for (const status of ['expired', 'cancelled']) {
      const phase = resolveFlashSalePurchasePhase({ ...base, latestOrderStatus: status })
      expect(phase).toBe('resume_payment')
      expect(flashSalePurchaseCtaI18nKey(phase, status)).toBe('paymentReopenOrder')
    }
  })

  it('发卡失败/迟到支付需要人工处理，只给查看订单入口', () => {
    for (const status of ['paid_fulfillment_failed', 'paid_late_needs_refund']) {
      const phase = resolveFlashSalePurchasePhase({ ...base, latestOrderStatus: status })
      expect(phase).toBe('resume_payment')
      expect(flashSalePurchaseCtaI18nKey(phase, status)).toBe('paymentViewOrder')
    }
  })

  it('已支付且批发限购仍有余量 → add_more，恢复件数选择与抢购按钮', () => {
    const phase = resolveFlashSalePurchasePhase({
      ...base,
      latestOrderStatus: 'paid',
      remainingQuantity: 3,
    })
    expect(phase).toBe('add_more')
    expect(allowsFlashSaleQuantityPicker(phase)).toBe(true)
    expect(hidesFlashSaleGrabCta(phase)).toBe(false)
    expect(flashSalePurchaseCtaI18nKey(phase, 'paid')).toBe('paymentBuyMore')
  })

  it('单件直付（maxPerUser=1）支付完成后即 exhausted，不再给购买入口', () => {
    const phase = resolveFlashSalePurchasePhase({
      isDirectPayment: true,
      joined: true,
      latestOrderStatus: 'paid',
      maxPerUser: 1,
      remainingQuantity: 0,
    })
    expect(phase).toBe('exhausted')
    expect(allowsFlashSaleQuantityPicker(phase)).toBe(false)
    expect(hidesFlashSaleGrabCta(phase)).toBe(true)
  })

  it('累计限购用尽 → exhausted', () => {
    expect(resolveFlashSalePurchasePhase({
      ...base,
      latestOrderStatus: 'paid',
      remainingQuantity: 0,
    })).toBe('exhausted')
  })
})
