import { describe, expect, it } from 'vitest'
import { buildTierProbabilities, normalizeTierWeight, sumTierWinnerCounts, buildTierWinnerCountSummary } from './tier-probability'

describe('tier-probability', () => {
  it('calculates relative hit tendency from configured weights', () => {
    expect(buildTierProbabilities([{ weight: 1 }, { weight: 3 }, { weight: 6 }])).toEqual([
      { weight: 1, percent: 10, label: '10%' },
      { weight: 3, percent: 30, label: '30%' },
      { weight: 6, percent: 60, label: '60%' },
    ])
  })

  it('normalizes invalid and fractional weights before calculating', () => {
    expect(buildTierProbabilities([{ weight: '2.9' }, { weight: -3 }, { weight: null }, { weight: 'bad' }])).toEqual([
      { weight: 2, percent: 100, label: '100%' },
      { weight: 0, percent: 0, label: '0%' },
      { weight: 0, percent: 0, label: '0%' },
      { weight: 0, percent: 0, label: '0%' },
    ])
  })

  it('returns zero probability labels when no positive weight exists', () => {
    expect(buildTierProbabilities([{ weight: 0 }, {}])).toEqual([
      { weight: 0, percent: 0, label: '0%' },
      { weight: 0, percent: 0, label: '0%' },
    ])
  })

  it('keeps display normalization aligned with publish/save constraints', () => {
    expect(normalizeTierWeight(100000.9)).toBe(100000)
    expect(normalizeTierWeight(Number.NaN)).toBe(0)
  })

  it('sums tier winner counts with negative/empty filtered to zero', () => {
    expect(sumTierWinnerCounts([{ winnerCount: 5 }, { winnerCount: 3 }, { winnerCount: '2' }])).toBe(10)
    expect(sumTierWinnerCounts([{ winnerCount: -1 }, { winnerCount: 0 }, { winnerCount: '' }])).toBe(0)
    expect(sumTierWinnerCounts(null)).toBe(0)
    expect(sumTierWinnerCounts([])).toBe(0)
    // 非整数向下取整（与保存逻辑一致）
    expect(sumTierWinnerCounts([{ winnerCount: 2.9 }])).toBe(2)
  })

  it('builds winner-count summary with draw comparison for lottery only', () => {
    // lottery：合计与活动设置不一致 → match=false
    expect(buildTierWinnerCountSummary([{ winnerCount: 5 }, { winnerCount: 3 }], 6, 'lottery')).toEqual({
      total: 8, drawWinnerCount: 6, match: false,
    })
    // lottery：一致 → match=true
    expect(buildTierWinnerCountSummary([{ winnerCount: 5 }, { winnerCount: 3 }], 8, 'lottery')).toEqual({
      total: 8, drawWinnerCount: 8, match: true,
    })
    // 未填份数 → null（不展示）
    expect(buildTierWinnerCountSummary([{ winnerCount: 0 }], 8, 'lottery')).toBeNull()
    // claim 直付秒杀：不做与 draw.winnerCount 的对比，仅返回合计
    expect(buildTierWinnerCountSummary([{ winnerCount: 5 }], 0, 'claim')).toEqual({
      total: 5, drawWinnerCount: null, match: true,
    })
  })
})
