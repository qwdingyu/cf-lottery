import { describe, expect, it } from 'vitest'
import { buildTierProbabilities, normalizeTierWeight } from './tier-probability'

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
})
