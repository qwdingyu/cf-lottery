import { describe, expect, it } from 'vitest'
import {
  canBatchHideDraw,
  canDeleteDraw,
  canSelectDrawForBulk,
  drawDisplayName,
  formatLotteryVisibilityLabel,
  hasActiveDrawListFilter,
  isLotteryUserVisible,
  isNonDefaultDrawStatusFilter,
  prizeCodePoolLeft,
} from './ops-utils'

describe('isLotteryUserVisible / visibility label', () => {
  it('defaults undefined/null to visible (DB DEFAULT 1)', () => {
    expect(isLotteryUserVisible(undefined)).toBe(true)
    expect(isLotteryUserVisible(null)).toBe(true)
    expect(isLotteryUserVisible(1)).toBe(true)
    expect(isLotteryUserVisible(0)).toBe(false)
  })

  it('formatLotteryVisibilityLabel does not treat missing visible as hidden', () => {
    const labels = { public: '用户可见', hidden: '已隐藏' }
    expect(formatLotteryVisibilityLabel(undefined, labels)).toBe('用户可见')
    expect(formatLotteryVisibilityLabel(null, labels)).toBe('用户可见')
    expect(formatLotteryVisibilityLabel(0, labels)).toBe('已隐藏')
    expect(formatLotteryVisibilityLabel(1, labels)).toBe('用户可见')
  })
})

describe('bulk select / hide helpers', () => {
  it('canBatchHideDraw only for drawn + still visible', () => {
    expect(canBatchHideDraw('drawn', 1)).toBe(true)
    expect(canBatchHideDraw('drawn', undefined)).toBe(true)
    expect(canBatchHideDraw('drawn', 0)).toBe(false)
    expect(canBatchHideDraw('open', 1)).toBe(false)
    expect(canBatchHideDraw('draft', 1)).toBe(false)
  })

  it('canSelectDrawForBulk unions delete + hide', () => {
    expect(canSelectDrawForBulk('open', 1)).toBe(false)
    expect(canSelectDrawForBulk('draft', 1)).toBe(true)
    expect(canSelectDrawForBulk('drawn', 1)).toBe(true)
    expect(canSelectDrawForBulk('drawn', 0)).toBe(true) // still deletable
    expect(canDeleteDraw('drawn')).toBe(true)
  })
})

describe('list filter empty-state heuristics', () => {
  it('default active is not a "has filter" for empty copy', () => {
    expect(isNonDefaultDrawStatusFilter('active')).toBe(false)
    expect(isNonDefaultDrawStatusFilter('')).toBe(false)
    expect(isNonDefaultDrawStatusFilter('drawn')).toBe(true)
    expect(
      hasActiveDrawListFilter({
        statusFilter: 'active',
        listQuery: '',
        activityKindFilter: '',
      }),
    ).toBe(false)
    expect(
      hasActiveDrawListFilter({
        statusFilter: 'active',
        listQuery: 'foo',
      }),
    ).toBe(true)
    expect(
      hasActiveDrawListFilter({
        statusFilter: 'drawn',
      }),
    ).toBe(true)
  })
})

describe('drawDisplayName / prizeCodePoolLeft', () => {
  it('prefers title then name', () => {
    expect(drawDisplayName({ title: 'A', name: 'B' })).toBe('A')
    expect(drawDisplayName({ name: 'B' })).toBe('B')
    expect(drawDisplayName({})).toBe('—')
  })

  it('computes pool left with floor 0', () => {
    expect(prizeCodePoolLeft({ totalCount: 10, usedCount: 3 })).toBe(7)
    expect(prizeCodePoolLeft({ totalCount: 2, usedCount: 5 })).toBe(0)
    expect(prizeCodePoolLeft({})).toBe(0)
  })
})
