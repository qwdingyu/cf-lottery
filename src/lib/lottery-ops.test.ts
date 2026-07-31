import { describe, expect, it } from 'vitest'
import {
  buildLotteryDrawConfirmMessage,
  buildLotteryDuplicateDraft,
  buildLotteryPublicPath,
  buildLotteryPublicShareUrl,
  buildLotteryWinnersCsv,
  countLotteryEmailFailures,
  filterAndSortAdminLotteryDraws,
  formatLotteryEntryProgress,
  formatLotteryVisibilityLabel,
  plannedWinnerCount,
  sortLotteryMyEntries,
} from './lottery-ops'

describe('lottery-ops pure helpers', () => {
  it('buildLotteryPublicPath keeps safe ids and rejects unsafe ids', () => {
    expect(buildLotteryPublicPath('draw-1')).toBe('/lottery/draw-1')
    expect(buildLotteryPublicPath('ab:cd_1.2')).toBe('/lottery/ab:cd_1.2')
    expect(buildLotteryPublicPath('../evil')).toBe('/lottery')
    expect(buildLotteryPublicPath('')).toBe('/lottery')
    expect(buildLotteryPublicPath('a/b')).toBe('/lottery')
    expect(buildLotteryPublicPath('x y')).toBe('/lottery')
  })

  it('buildLotteryPublicShareUrl joins origin without double slash', () => {
    expect(buildLotteryPublicShareUrl('https://shop.example.com', 'd1')).toBe(
      'https://shop.example.com/lottery/d1',
    )
    expect(buildLotteryPublicShareUrl('https://shop.example.com/', 'd1')).toBe(
      'https://shop.example.com/lottery/d1',
    )
    expect(buildLotteryPublicShareUrl('', 'd1')).toBe('/lottery/d1')
    expect(buildLotteryPublicShareUrl(null, 'd1')).toBe('/lottery/d1')
  })

  it('plannedWinnerCount is min(pool, quota) and never negative', () => {
    expect(plannedWinnerCount(10, 3)).toBe(3)
    expect(plannedWinnerCount(2, 5)).toBe(2)
    expect(plannedWinnerCount(0, 5)).toBe(0)
    expect(plannedWinnerCount(null, 5)).toBe(0)
    expect(plannedWinnerCount(3, 0)).toBe(0)
    expect(plannedWinnerCount(-1, 2)).toBe(0)
  })

  it('buildLotteryDrawConfirmMessage includes pool/quota/product and empty-pool warn', () => {
    const labels = {
      title: 'TITLE',
      name: 'NAME:',
      pool: 'POOL:',
      quota: 'QUOTA:',
      willDraw: 'WILL:',
      product: 'PRODUCT:',
      emptyPoolWarn: 'EMPTY',
      confirm: 'CONFIRM',
    }
    const msg = buildLotteryDrawConfirmMessage(
      { id: '1', name: '春日抽奖', entryCount: 12, maxWinners: 3, productTitle: '月卡' },
      labels,
    )
    expect(msg).toContain('TITLE')
    expect(msg).toContain('NAME:春日抽奖')
    expect(msg).toContain('POOL:12')
    expect(msg).toContain('QUOTA:3')
    expect(msg).toContain('WILL:3')
    expect(msg).toContain('PRODUCT:月卡')
    expect(msg).toContain('CONFIRM')
    expect(msg).not.toContain('EMPTY')

    const empty = buildLotteryDrawConfirmMessage(
      { id: '1', name: '空', entryCount: 0, maxWinners: 3, productId: 'p1' },
      labels,
    )
    expect(empty).toContain('EMPTY')
    expect(empty).toContain('WILL:0')
    expect(empty).toContain('PRODUCT:p1')
  })

  it('buildLotteryDuplicateDraft prefills fields and clears times', () => {
    const draft = buildLotteryDuplicateDraft({
      id: 'old',
      name: '原活动',
      description: '说明',
      productId: 'prod-1',
      maxWinners: 5,
      maxParticipants: 100,
      expectedParticipants: 80,
    })
    expect(draft.name).toBe('原活动 (copy)')
    expect(draft.description).toBe('说明')
    expect(draft.productId).toBe('prod-1')
    expect(draft.maxWinners).toBe(5)
    expect(draft.maxParticipants).toBe(100)
    expect(draft.expectedParticipants).toBe(80)
    expect(draft.startTime).toBe('')
    expect(draft.endTime).toBe('')
    expect(draft.drawTime).toBe('')

    const custom = buildLotteryDuplicateDraft(
      { id: 'x', name: 'A', maxWinners: 1, productId: 'p' },
      { nameSuffix: ' #2' },
    )
    expect(custom.name).toBe('A #2')
    expect(custom.maxParticipants).toBeNull()
  })

  it('countLotteryEmailFailures only counts unsuccessful with error', () => {
    expect(
      countLotteryEmailFailures([
        { emailSent: 1, emailError: '' },
        { emailSent: 0, emailError: 'timeout' },
        { emailSent: 0, emailError: '' },
        { emailSent: 0, emailError: '  boom  ' },
        { emailSent: 1, emailError: 'stale' },
      ]),
    ).toBe(2)
    expect(countLotteryEmailFailures([])).toBe(0)
  })

  it('formatLotteryEntryProgress shows optional cap', () => {
    expect(formatLotteryEntryProgress(3, null)).toBe('3')
    expect(formatLotteryEntryProgress(3, undefined)).toBe('3')
    expect(formatLotteryEntryProgress(3, 0)).toBe('3')
    expect(formatLotteryEntryProgress(3, 10)).toBe('3 / 10')
  })
})

describe('lottery-ops list filter/sort + winners csv', () => {
  const sample = [
    { id: 'd-open', name: '春日抽奖', status: 'open', productTitle: '月卡', productId: 'p1', drawTime: '2026-03-02T00:00:00Z', entryCount: 5, maxWinners: 1 },
    { id: 'd-draw', name: '夏日抽奖', status: 'drawing', productTitle: '季卡', productId: 'p2', drawTime: '2026-03-01T00:00:00Z', entryCount: 2, maxWinners: 1 },
    { id: 'd-draft', name: '草稿活动', status: 'draft', productTitle: null, productId: 'p3', drawTime: '2026-04-01T00:00:00Z', entryCount: 0, maxWinners: 1 },
    { id: 'd-done', name: '已开奖活动', status: 'drawn', productTitle: '年卡', productId: 'p4', drawTime: '2026-01-01T00:00:00Z', entryCount: 9, maxWinners: 2 },
  ]

  it('filterAndSortAdminLotteryDraws prioritizes drawing/open and filters by query', () => {
    const all = filterAndSortAdminLotteryDraws(sample, { status: '', query: '' })
    expect(all.map((d) => d.id)).toEqual(['d-draw', 'd-open', 'd-draft', 'd-done'])

    const openOnly = filterAndSortAdminLotteryDraws(sample, { status: 'open', query: '' })
    expect(openOnly.map((d) => d.id)).toEqual(['d-open'])

    const byName = filterAndSortAdminLotteryDraws(sample, { status: '', query: '春日' })
    expect(byName.map((d) => d.id)).toEqual(['d-open'])

    const byProduct = filterAndSortAdminLotteryDraws(sample, { status: '', query: '季卡' })
    expect(byProduct.map((d) => d.id)).toEqual(['d-draw'])

    const byId = filterAndSortAdminLotteryDraws(sample, { status: '', query: 'd-done' })
    expect(byId.map((d) => d.id)).toEqual(['d-done'])
  })

  it('buildLotteryWinnersCsv escapes commas/quotes and marks email state', () => {
    const csv = buildLotteryWinnersCsv(
      [
        {
          email: 'a@x.com',
          orderNo: 'ORD-1',
          cardAccountLabel: 'acc,1',
          cardDeliverySecret: 'sec"ret',
          emailSent: 1,
          emailError: '',
        },
        {
          email: 'b@x.com',
          orderNo: null,
          cardAccountLabel: null,
          cardDeliverySecret: null,
          emailSent: 0,
          emailError: 'timeout, boom',
        },
      ],
      {
        email: '邮箱',
        orderNo: '订单号',
        card: '卡密',
        emailStatus: '邮件',
        sent: '已发送',
        pending: '待发送',
        failed: '发送失败',
      },
    )
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('邮箱,订单号,卡密,邮件')
    expect(lines[1]).toContain('a@x.com')
    expect(lines[1]).toContain('已发送')
    expect(lines[1]).toContain('"acc,1')
    expect(lines[1]).toContain('""') // escaped quote in secret
    expect(lines[2]).toContain('发送失败')
    expect(lines[2]).toContain('timeout, boom')
  })

  it('buildLotteryWinnersCsv returns header-only for empty list', () => {
    const csv = buildLotteryWinnersCsv([], {
      email: 'E',
      orderNo: 'O',
      card: 'C',
      emailStatus: 'S',
      sent: 'ok',
      pending: 'pend',
      failed: 'fail',
    })
    expect(csv.trim()).toBe('E,O,C,S')
  })
})


describe('lottery-ops visibility + my-entry sort', () => {
  it('formatLotteryVisibilityLabel distinguishes hidden vs public', () => {
    expect(formatLotteryVisibilityLabel(1, { public: '公开', hidden: '隐藏' })).toBe('公开')
    expect(formatLotteryVisibilityLabel(0, { public: '公开', hidden: '隐藏' })).toBe('隐藏')
    expect(formatLotteryVisibilityLabel(null, { public: '公开', hidden: '隐藏' })).toBe('公开')
    expect(formatLotteryVisibilityLabel(undefined, { public: '公开', hidden: '隐藏' })).toBe('公开')
  })

  it('sortLotteryMyEntries puts winners first then by joinedAt desc', () => {
    const entries = [
      { drawId: 'a', joinedAt: '2026-01-01T10:00:00Z', drawStatus: 'open' },
      { drawId: 'b', joinedAt: '2026-01-03T10:00:00Z', drawStatus: 'drawn' },
      { drawId: 'c', joinedAt: '2026-01-02T10:00:00Z', drawStatus: 'drawn' },
      { drawId: 'd', joinedAt: '2026-01-04T10:00:00Z', drawStatus: 'open' },
    ]
    const won = new Set(['c', 'b'])
    const sorted = sortLotteryMyEntries(entries, won)
    expect(sorted.map((e) => e.drawId)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('sortLotteryMyEntries is stable for missing joinedAt', () => {
    const entries = [
      { drawId: 'x', drawStatus: 'open' },
      { drawId: 'y', joinedAt: '2026-01-01T00:00:00Z', drawStatus: 'open' },
    ]
    expect(sortLotteryMyEntries(entries, new Set()).map((e) => e.drawId)).toEqual(['y', 'x'])
  })
})
