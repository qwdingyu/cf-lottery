/**
 * 模板文案解析契约（docs/162 P1-D / P2-B）：
 * - i18n 优先、API 中文兜底（后端新模板未配 i18n 时不空白）
 * - hints 数组经 tm() 解析；非法结构安全回退
 * - chips：结果模式复用 adminResult* 词表；抽奖=需奖品；直付=涉及收款
 */
import { describe, expect, it } from 'vitest'
import {
  templateChips,
  templateDisplayDesc,
  templateDisplayHints,
  templateDisplayName,
  type TemplateI18nSource,
} from './template-i18n'

/** 构造一个可控的 i18n mock：messages 为扁平 key → 值（字符串或数组） */
function mockI18n(messages: Record<string, unknown>): TemplateI18nSource {
  return {
    t: (key) => String(messages[key] ?? key),
    te: (key) => key in messages,
    tm: (key) => messages[key],
  }
}

const zhFallback = mockI18n({})

describe('templateDisplayName / templateDisplayDesc', () => {
  const tpl = { id: 'lottery-wheel', name: '大转盘抽奖', description: '后端中文描述' }

  it('有 i18n key 时用翻译（英文界面不再全中文）', () => {
    const en = mockI18n({
      'lottery.tpl.lottery-wheel.name': 'Lucky Wheel',
      'lottery.tpl.lottery-wheel.desc': 'Spin to enter the pool',
    })
    expect(templateDisplayName(tpl, en)).toBe('Lucky Wheel')
    expect(templateDisplayDesc(tpl, en)).toBe('Spin to enter the pool')
  })

  it('缺 key 时回退 API 字符串（后端新模板无需等前端发版）', () => {
    expect(templateDisplayName(tpl, zhFallback)).toBe('大转盘抽奖')
    expect(templateDisplayDesc(tpl, zhFallback)).toBe('后端中文描述')
  })

  it('id 为空时不构造 key，直接回退', () => {
    expect(templateDisplayName({ name: 'X' }, zhFallback)).toBe('X')
    expect(templateDisplayDesc({}, zhFallback)).toBe('')
  })
})

describe('templateDisplayHints', () => {
  const tpl = { id: 'flash-sale-rush', hints: ['API 提示一', 'API 提示二'] }

  it('i18n hints 为数组时优先使用', () => {
    const en = mockI18n({ 'lottery.tpl.flash-sale-rush.hints': ['Hint A', 'Hint B', 'Hint C'] })
    expect(templateDisplayHints(tpl, en)).toEqual(['Hint A', 'Hint B', 'Hint C'])
  })

  it('i18n hints 结构非法（非数组）时回退 API hints', () => {
    const broken = mockI18n({ 'lottery.tpl.flash-sale-rush.hints': 'not-an-array' })
    expect(templateDisplayHints(tpl, broken)).toEqual(['API 提示一', 'API 提示二'])
  })

  it('无 i18n 时回退 API hints；两端都没有则空数组', () => {
    expect(templateDisplayHints(tpl, zhFallback)).toEqual(['API 提示一', 'API 提示二'])
    expect(templateDisplayHints({ id: 'x' }, zhFallback)).toEqual([])
  })

  it('过滤空白项', () => {
    const messy = mockI18n({ 'lottery.tpl.flash-sale-rush.hints': ['  有效  ', '', '   '] })
    expect(templateDisplayHints(tpl, messy)).toEqual(['有效'])
  })
})

describe('templateChips', () => {
  it('延迟大转盘：手动开奖 + 需奖品', () => {
    expect(
      templateChips({ defaults: { activityKind: 'lottery', resultMode: 'manual' } }),
    ).toEqual(['lottery.adminResultManual', 'lottery.tplChipNeedsPrize'])
  })

  it('即时大转盘：即时结果 + 需奖品', () => {
    expect(
      templateChips({ defaults: { activityKind: 'lottery', resultMode: 'instant' } }),
    ).toEqual(['lottery.adminResultInstant', 'lottery.tplChipNeedsPrize'])
  })

  it('限时抢购直付：即时结果 + 涉及收款（claim 不需奖品 chip）', () => {
    expect(
      templateChips({
        defaults: { activityKind: 'claim', resultMode: 'instant', flashSalePaymentRequired: true },
      }),
    ).toEqual(['lottery.adminResultInstant', 'lottery.tplChipPayment'])
  })

  it('报名接龙：按顺序分配；预约：按容量确认', () => {
    expect(templateChips({ defaults: { activityKind: 'signup_chain', resultMode: 'ordered_assignment' } }))
      .toEqual(['lottery.adminResultOrdered'])
    expect(templateChips({ defaults: { activityKind: 'reservation', resultMode: 'capacity_assignment' } }))
      .toEqual(['lottery.adminResultCapacity'])
  })

  it('问卷：只记录提交；无结果模式/空 defaults 不出 chip', () => {
    expect(templateChips({ defaults: { activityKind: 'survey', resultMode: 'no_result' } }))
      .toEqual(['lottery.adminResultNoResult'])
    expect(templateChips({})).toEqual([])
    expect(templateChips({ defaults: { resultMode: 'unknown_mode' } })).toEqual([])
  })
})
