import { describe, expect, it } from 'vitest'
import {
  MAX_TIER_WEIGHT,
  buildTierProbabilities,
  normalizeTierWeight,
  sumTierWinnerCounts,
  buildTierWinnerCountSummary,
} from './tier-probability'

describe('tier-probability', () => {
  it('calculates relative hit tendency from configured weights', () => {
    expect(buildTierProbabilities([{ weight: 1 }, { weight: 3 }, { weight: 6 }])).toEqual([
      { weight: 1, percent: 10, label: '10%' },
      { weight: 3, percent: 30, label: '30%' },
      { weight: 6, percent: 60, label: '60%' },
    ])
  })

  it('keeps fractional weights in display calculation (backend floors on save)', () => {
    // 展示保留原始值，让用户看到的百分比与输入值一致
    const result = buildTierProbabilities([{ weight: '2.9' }, { weight: '5.1' }])
    expect(result).toHaveLength(2)
    expect(result[0]!.weight).toBe(2.9)
    expect(result[0]!.percent).toBeCloseTo(36.25, 2)
    expect(result[0]!.label).toBe('36.25%')
    expect(result[1]!.weight).toBe(5.1)
    expect(result[1]!.percent).toBeCloseTo(63.75, 2)
    expect(result[1]!.label).toBe('63.75%')
  })

  it('normalizes invalid display weights to zero', () => {
    expect(buildTierProbabilities([{ weight: -3 }, { weight: null }, { weight: 'bad' }])).toEqual([
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

  it('keeps save normalization aligned with publish/save constraints', () => {
    expect(normalizeTierWeight(MAX_TIER_WEIGHT + 0.9)).toBe(MAX_TIER_WEIGHT)
    expect(normalizeTierWeight(MAX_TIER_WEIGHT + 1)).toBe(MAX_TIER_WEIGHT)
    expect(normalizeTierWeight(Number.NaN)).toBe(0)
  })

  it('caps displayed probabilities at the same weight boundary used for saving', () => {
    expect(buildTierProbabilities([{ weight: MAX_TIER_WEIGHT * 2 }, { weight: MAX_TIER_WEIGHT }])).toEqual([
      { weight: MAX_TIER_WEIGHT, percent: 50, label: '50%' },
      { weight: MAX_TIER_WEIGHT, percent: 50, label: '50%' },
    ])
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
