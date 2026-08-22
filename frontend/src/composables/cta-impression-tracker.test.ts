import { describe, it, expect } from 'vitest'
import { createCtaImpressionTracker } from './cta-impression-tracker'

describe('cta-impression-tracker 去重', () => {
  it('首次 track 返回 true', () => {
    const tracker = createCtaImpressionTracker()
    expect(tracker.track('draw-1:after_win')).toBe(true)
    expect(tracker.size).toBe(1)
  })

  it('相同 key 重复 track 返回 false', () => {
    const tracker = createCtaImpressionTracker()
    tracker.track('draw-1:after_win')
    expect(tracker.track('draw-1:after_win')).toBe(false)
    expect(tracker.size).toBe(1)
  })

  it('不同 key 独立去重', () => {
    const tracker = createCtaImpressionTracker()
    expect(tracker.track('draw-1:after_win')).toBe(true)
    expect(tracker.track('draw-1:after_loss')).toBe(true)
    expect(tracker.track('draw-2:after_win')).toBe(true)
    expect(tracker.size).toBe(3)
  })

  it('reset 后重新曝光', () => {
    const tracker = createCtaImpressionTracker()
    tracker.track('draw-1:after_win')
    tracker.reset()
    expect(tracker.size).toBe(0)
    expect(tracker.track('draw-1:after_win')).toBe(true)
  })

  it('模拟 watch 多次触发但只记录一次', () => {
    const tracker = createCtaImpressionTracker()
    const impressions: string[] = []

    // 模拟 watch 回调被触发 5 次（响应式依赖变化）
    for (let i = 0; i < 5; i++) {
      const key = 'draw-42:after_win'
      if (tracker.track(key)) {
        impressions.push(key)
      }
    }

    expect(impressions).toEqual(['draw-42:after_win'])
    expect(tracker.size).toBe(1)
  })
})
