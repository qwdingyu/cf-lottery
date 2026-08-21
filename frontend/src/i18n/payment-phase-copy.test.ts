/**
 * 直付购买阶段文案闭环（docs/257）。
 *
 * 为什么需要这个测试：
 * `flashSalePurchaseCtaI18nKey()` 返回的是 i18n key 字符串，模板用 `$t('lottery.' + key)`
 * 渲染。key 写错不会有类型错误，只会在页面上直接显示 `lottery.paymentXxx` 原文——
 * 这类缺陷只有真人打开页面才会发现。这里把"状态机产出的每个 key 在两种语言都存在"
 * 变成可回归的断言。
 */
import { describe, expect, it } from 'vitest'
import zh from './zh-CN'
import en from './en'
import {
  type FlashSalePurchasePhase,
  flashSalePurchaseCtaI18nKey,
} from '../views/lottery/payment-ux'

/** 覆盖所有阶段 × 所有订单状态的组合，穷举状态机可能产出的 key */
const PHASES: FlashSalePurchasePhase[] = ['browse', 'resume_payment', 'add_more', 'exhausted']
const ORDER_STATUSES = [
  null,
  '',
  'pending',
  'paid',
  'expired',
  'cancelled',
  'refunded',
  'paid_fulfillment_failed',
  'paid_late_needs_refund',
  'unexpected_future_status',
]

function lotString(lottery: Record<string, unknown>, key: string): string {
  const v = lottery[key]
  return typeof v === 'string' ? v : ''
}

describe('直付购买阶段 CTA 文案（docs/257）', () => {
  it('状态机产出的每个 CTA key 在 zh-CN 与 en 都有非空文案', () => {
    const produced = new Set<string>()
    for (const phase of PHASES) {
      for (const status of ORDER_STATUSES) {
        produced.add(flashSalePurchaseCtaI18nKey(phase, status))
      }
    }
    // 状态机至少要能产出四种语义不同的 CTA，否则说明分流退化成了单一文案
    expect(produced.size).toBeGreaterThanOrEqual(4)

    for (const key of produced) {
      expect(lotString(zh.lottery as Record<string, unknown>, key), `zh-CN 缺少 ${key}`).not.toBe('')
      expect(lotString(en.lottery as Record<string, unknown>, key), `en 缺少 ${key}`).not.toBe('')
    }
  })

  it('待支付提示条文案在两种语言都存在，且中文明确说明"支付后才算成功"', () => {
    const zhNotice = lotString(zh.lottery as Record<string, unknown>, 'paymentPendingOrderNotice')
    const enNotice = lotString(en.lottery as Record<string, unknown>, 'paymentPendingOrderNotice')
    expect(zhNotice).not.toBe('')
    expect(enNotice).not.toBe('')
    // 锁名额 ≠ 购买成功：这句话是本次修复的核心诚实性表达，不允许被改成含糊文案
    expect(zhNotice).toMatch(/支付/)
    expect(zhNotice).toMatch(/成功|完成/)
  })

  it('pending 阶段的 CTA 不能再暗示"追加购买"', () => {
    const key = flashSalePurchaseCtaI18nKey('resume_payment', 'pending')
    const zhText = lotString(zh.lottery as Record<string, unknown>, key)
    expect(zhText).toMatch(/继续支付/)
    expect(zhText).not.toMatch(/追加/)
  })
})
