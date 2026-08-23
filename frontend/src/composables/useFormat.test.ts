/**
 * useFormat 时区解析单测（docs/263）。
 *
 * 核心验证点：toCSTDate 按来源格式显式补时区，使 formatDateCST 在任何浏览器
 * 时区下都统一展示东八区时间。断言使用 toISOString()（恒为 UTC 格式），
 * 与运行环境的 TZ/ICU 无关，保证测试稳定。
 */
import { describe, expect, it } from 'vitest'
import { toCSTDate, formatDateCST } from './useFormat'

describe('toCSTDate：按来源格式补时区', () => {
  it('SQLite UTC 格式（"YYYY-MM-DD HH:MM:SS"，无 T）→ 按 UTC 解释', () => {
    // 后端 datetime('now') 生成，UTC 01:00 必须解析为 01:00Z，而非浏览器本地时间
    expect(toCSTDate('2026-08-23 01:00:00').toISOString()).toBe('2026-08-23T01:00:00.000Z')
  })

  it('datetime-local 输入（"YYYY-MM-DDTHH:mm"，无 Z）→ 按东八时间解释', () => {
    // 管理端运营者以东八时间录入 09:00 → UTC 01:00
    expect(toCSTDate('2026-08-23T09:00').toISOString()).toBe('2026-08-23T01:00:00.000Z')
    expect(toCSTDate('2026-08-23T09:00:00').toISOString()).toBe('2026-08-23T01:00:00.000Z')
  })

  it('ISO 8601 带 Z → 原样解析，不补时区', () => {
    expect(toCSTDate('2026-08-23T01:00:00.000Z').toISOString()).toBe('2026-08-23T01:00:00.000Z')
  })

  it('ISO 8601 带数字偏移（±HH:mm）→ 原样解析，不补时区', () => {
    expect(toCSTDate('2026-08-23T09:00:00+09:00').toISOString()).toBe('2026-08-23T00:00:00.000Z')
    expect(toCSTDate('2026-08-23T09:00:00+0800').toISOString()).toBe('2026-08-23T01:00:00.000Z')
  })

  it('非法格式回退 new Date 原行为（不抛错）', () => {
    expect(Number.isNaN(toCSTDate('not-a-date').getTime())).toBe(true)
  })
})

describe('formatDateCST：统一东八区展示', () => {
  it('SQLite UTC 时间在东八区展示为 UTC+8（偏移修复核心）', () => {
    // UTC 01:00 → 上海 09:00（修复前东八浏览器会错误显示 01:00）
    const out = formatDateCST('2026-08-23 01:00:00')
    expect(out).toContain('09:00')
    expect(out).toContain('2026')
  })

  it('datetime-local 东八输入按东八展示（不重复偏移）', () => {
    const out = formatDateCST('2026-08-23T09:00')
    expect(out).toContain('09:00')
  })

  it('带 Z 的 ISO 按东八展示', () => {
    expect(formatDateCST('2026-08-23T01:00:00.000Z')).toContain('09:00')
  })

  it('无效输入原样返回，空值返回占位符', () => {
    expect(formatDateCST('not-a-date')).toBe('not-a-date')
    expect(formatDateCST(null)).toBe('-')
    expect(formatDateCST(undefined)).toBe('-')
    expect(formatDateCST('')).toBe('-')
  })
})
