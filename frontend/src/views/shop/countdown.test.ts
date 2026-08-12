import { describe, expect, it } from 'vitest'
import { countdownParts, formatCountdown, formatEndTime } from './countdown'

describe('shop countdown', () => {
  it('countdownParts 拆分天时分秒', () => {
    expect(countdownParts(86400_000 + 3600_000 + 600_000 + 5000)).toEqual({
      days: 1,
      hours: 1,
      minutes: 10,
      seconds: 5,
    })
  })

  it('countdownParts 负数/非法输入归零', () => {
    expect(countdownParts(-1)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 })
    expect(countdownParts(Number.NaN)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 })
  })

  it('formatCountdown 一天内输出 HH:MM:SS', () => {
    expect(formatCountdown(3600_000 + 600_000 + 45_000)).toBe('01:10:45')
  })

  it('formatCountdown 超过一天输出 天 前缀', () => {
    expect(formatCountdown(2 * 86400_000 + 3600_000)).toBe('2天 01:00:00')
  })

  it('formatCountdown 已结束/非法输入输出空串', () => {
    expect(formatCountdown(0)).toBe('')
    expect(formatCountdown(-10)).toBe('')
    expect(formatCountdown(Number.NaN)).toBe('')
  })

  it('formatEndTime 输出 HH:mm', () => {
    // 本地时区测试：用本地时间构造，避免 CI 时区差异
    const d = new Date(2026, 7, 12, 21, 30)
    expect(formatEndTime(d.toISOString())).toBe('21:30')
  })

  it('formatEndTime 非法输入输出空串', () => {
    expect(formatEndTime('')).toBe('')
    expect(formatEndTime('not-a-date')).toBe('')
    expect(formatEndTime(null)).toBe('')
  })
})