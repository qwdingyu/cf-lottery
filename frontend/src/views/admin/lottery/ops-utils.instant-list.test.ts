/**
 * 管理端列表：instant 标签与「立即开奖」互斥（docs/116/118/119）
 */
import { describe, expect, it } from 'vitest'
import {
  adminOpenLotterySecondaryAction,
  shouldShowAdminDrawNowButton,
  shouldShowAdminInstantResultTag,
} from './ops-utils'

describe('admin list instant 决策', () => {
  it('resultMode=instant 显示即时标签', () => {
    expect(shouldShowAdminInstantResultTag('instant')).toBe(true)
    expect(shouldShowAdminInstantResultTag('manual')).toBe(false)
    expect(shouldShowAdminInstantResultTag('scheduled')).toBe(false)
    expect(shouldShowAdminInstantResultTag('')).toBe(false)
    expect(shouldShowAdminInstantResultTag(null)).toBe(false)
  })

  it('open lottery delayed → 立即开奖；instant → 暂停且无 draw_now', () => {
    expect(
      adminOpenLotterySecondaryAction({
        status: 'open',
        activityKind: 'lottery',
        resultMode: 'manual',
      }),
    ).toBe('draw_now')
    expect(
      adminOpenLotterySecondaryAction({
        status: 'open',
        activityKind: 'lottery',
        resultMode: 'scheduled',
      }),
    ).toBe('draw_now')
    expect(
      adminOpenLotterySecondaryAction({
        status: 'open',
        activityKind: 'lottery',
        resultMode: 'instant',
      }),
    ).toBe('pause')
    expect(
      shouldShowAdminDrawNowButton({
        status: 'open',
        activityKind: 'lottery',
        resultMode: 'instant',
      }),
    ).toBe(false)
    expect(
      shouldShowAdminDrawNowButton({
        status: 'open',
        activityKind: 'lottery',
        resultMode: 'manual',
      }),
    ).toBe(true)
  })

  it('非 open / 非 lottery → none', () => {
    expect(
      adminOpenLotterySecondaryAction({
        status: 'draft',
        activityKind: 'lottery',
        resultMode: 'manual',
      }),
    ).toBe('none')
    expect(
      adminOpenLotterySecondaryAction({
        status: 'open',
        activityKind: 'survey',
        resultMode: 'instant',
      }),
    ).toBe('none')
  })
})
