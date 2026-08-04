/**
 * 活动默认值与 drawTrigger 推断（docs/115 续审：drawAt 必须配对 scheduled）
 */
import { describe, expect, it } from 'vitest'
import {
  defaultResultModeForActivity,
  resolveDrawTrigger,
  resultModeForLotteryDrawTrigger,
} from './activity-defaults'

describe('resolveDrawTrigger（开奖触发对齐）', () => {
  it('显式 trigger 优先', () => {
    expect(resolveDrawTrigger({ drawTrigger: 'manual', drawAt: '2026-01-01T00:00:00Z' })).toBe('manual')
    expect(resolveDrawTrigger({ drawTrigger: 'scheduled', drawAt: null })).toBe('scheduled')
  })

  it('lottery + 有 drawAt → scheduled（修表单只写 drawAt 不写 trigger）', () => {
    expect(
      resolveDrawTrigger({
        activityKind: 'lottery',
        drawAt: '2026-08-10T12:00:00.000Z',
      }),
    ).toBe('scheduled')
  })

  it('lottery 无 drawAt → manual', () => {
    expect(resolveDrawTrigger({ activityKind: 'lottery', drawAt: '' })).toBe('manual')
    expect(resolveDrawTrigger({ activityKind: 'lottery' })).toBe('manual')
  })

  it('非 lottery 即使有 drawAt 也 manual（防 Cron 误开问卷）', () => {
    expect(
      resolveDrawTrigger({
        activityKind: 'survey',
        drawAt: '2026-08-10T12:00:00.000Z',
      }),
    ).toBe('manual')
  })
})

describe('resultModeForLotteryDrawTrigger', () => {
  it('与 trigger 对齐', () => {
    expect(resultModeForLotteryDrawTrigger('scheduled')).toBe('scheduled')
    expect(resultModeForLotteryDrawTrigger('manual')).toBe('manual')
  })
})

describe('defaultResultModeForActivity 基线', () => {
  it('lottery 默认 manual（有 drawAt 时由 resolve 覆盖）', () => {
    expect(defaultResultModeForActivity('lottery')).toBe('manual')
    expect(defaultResultModeForActivity('claim')).toBe('instant')
  })
})
