import { describe, expect, it } from 'vitest'
import {
  buildSelectedDrawsCsvRows,
  canBatchHideDraw,
  canDeleteDraw,
  canDeletePrizeCode,
  canDisableRedemptionCode,
  canOperatePlatformMember,
  canPauseDraw,
  canRemoveMember,
  canResumeDraw,
  canRetryWebhookDelivery,
  canSelectDrawForBulk,
  drawDisplayName,
  formatLotteryVisibilityLabel,
  hasActiveDrawListFilter,
  isLotteryUserVisible,
  isNonDefaultDrawStatusFilter,
  isPrizeActive,
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

  it('canSelectDrawForBulk unions delete + hide + pause + resume', () => {
    // open 不可删但可暂停 → 可选
    expect(canSelectDrawForBulk('open', 1)).toBe(true)
    expect(canPauseDraw('open')).toBe(true)
    expect(canResumeDraw('paused')).toBe(true)
    expect(canPauseDraw('paused')).toBe(false)
    expect(canResumeDraw('open')).toBe(false)
    expect(canSelectDrawForBulk('draft', 1)).toBe(true)
    expect(canSelectDrawForBulk('drawn', 1)).toBe(true)
    expect(canSelectDrawForBulk('drawn', 0)).toBe(true) // still deletable
    expect(canDeleteDraw('drawn')).toBe(true)
  })

  it('buildSelectedDrawsCsvRows includes header and safe metadata only', () => {
    const rows = buildSelectedDrawsCsvRows([
      { id: 'd1', publicSlug: 'abc', title: 'T1', status: 'open', activityKind: 'lottery', visible: 1, createdAt: '2026-01-01' },
    ])
    expect(rows[0]).toEqual(['id', 'publicSlug', 'title', 'status', 'activityKind', 'visible', 'createdAt'])
    expect(rows[1]).toEqual(['d1', 'abc', 'T1', 'open', 'lottery', '1', '2026-01-01'])
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

  it('only available codes are deletable; prize active defaults true', () => {
    expect(canDeletePrizeCode('available')).toBe(true)
    expect(canDeletePrizeCode('issued')).toBe(false)
    expect(isPrizeActive(undefined)).toBe(true)
    expect(isPrizeActive(0)).toBe(false)
    expect(isPrizeActive(1)).toBe(true)
  })

  it('owner cannot be bulk-removed; only active redemption codes disable', () => {
    expect(canRemoveMember('owner')).toBe(false)
    expect(canRemoveMember('admin')).toBe(true)
    expect(canRemoveMember('viewer')).toBe(true)
    expect(canDisableRedemptionCode('active')).toBe(true)
    expect(canDisableRedemptionCode('used')).toBe(false)
    expect(canDisableRedemptionCode('disabled')).toBe(false)
    expect(canDisableRedemptionCode('expired')).toBe(false)
  })

  it('platform member self is not operable; only failed/pending deliveries retry', () => {
    expect(canOperatePlatformMember('u1', 'u1')).toBe(false)
    expect(canOperatePlatformMember('u2', 'u1')).toBe(true)
    expect(canOperatePlatformMember('u2', '')).toBe(true)
    expect(canRetryWebhookDelivery('failed')).toBe(true)
    expect(canRetryWebhookDelivery('pending')).toBe(true)
    expect(canRetryWebhookDelivery('sent')).toBe(false)
  })
})
