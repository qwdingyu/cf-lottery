/**
 * 创建 payload 调度字段：drawAt ↔ drawTrigger ↔ resultMode（docs/115）
 */
import { describe, expect, it } from 'vitest'
import { resolveLotteryScheduleFields } from './ops-utils'

describe('resolveLotteryScheduleFields', () => {
  it('lottery + drawAt → scheduled + resultMode scheduled', () => {
    expect(
      resolveLotteryScheduleFields({
        activityKind: 'lottery',
        drawAt: '2026-08-10T12:00:00.000Z',
        resultMode: 'manual', // 表单默认不得覆盖
      }),
    ).toEqual({ drawTrigger: 'scheduled', resultMode: 'scheduled' })
  })

  it('lottery 无 drawAt → manual', () => {
    expect(
      resolveLotteryScheduleFields({
        activityKind: 'lottery',
        drawAt: undefined,
      }),
    ).toEqual({ drawTrigger: 'manual', resultMode: 'manual' })
  })

  it('survey 有 drawAt 仍 manual，保留 resultMode', () => {
    expect(
      resolveLotteryScheduleFields({
        activityKind: 'survey',
        drawAt: '2026-08-10T12:00:00.000Z',
        resultMode: 'no_result',
      }),
    ).toEqual({ drawTrigger: 'manual', resultMode: 'no_result' })
  })

  it('显式 manual 即使有 drawAt 也尊重（运营刻意只记时间）', () => {
    expect(
      resolveLotteryScheduleFields({
        activityKind: 'lottery',
        drawAt: '2026-08-10T12:00:00.000Z',
        drawTrigger: 'manual',
      }),
    ).toEqual({ drawTrigger: 'manual', resultMode: 'manual' })
  })

  it('lottery + instant 保留 instant，有 drawAt 也不变 scheduled（docs/116）', () => {
    expect(
      resolveLotteryScheduleFields({
        activityKind: 'lottery',
        drawAt: '2026-08-10T12:00:00.000Z',
        resultMode: 'instant',
      }),
    ).toEqual({ drawTrigger: 'manual', resultMode: 'instant' })
  })

  it('instant 忽略显式 scheduled trigger，仍 manual+instant', () => {
    expect(
      resolveLotteryScheduleFields({
        activityKind: 'lottery',
        drawAt: '2026-08-10T12:00:00.000Z',
        drawTrigger: 'scheduled',
        resultMode: 'instant',
      }),
    ).toEqual({ drawTrigger: 'manual', resultMode: 'instant' })
  })
})
