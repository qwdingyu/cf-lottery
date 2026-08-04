import { describe, expect, it } from 'vitest'
import {
  isMeVisibleInViralTop,
  isViralFeatureEnabled,
  isViralLeaderboardMeRow,
  parseViralLeaderboardResponse,
  shouldShowViralLeaderboard,
  viralMyRankFooterMode,
  viralRankBadge,
} from './viral-leaderboard-ui'

describe('viral-leaderboard-ui 门禁与展示', () => {
  it('isViralFeatureEnabled 仅 enabled===true', () => {
    expect(isViralFeatureEnabled(undefined)).toBe(false)
    expect(isViralFeatureEnabled({ enabled: false })).toBe(false)
    expect(isViralFeatureEnabled({ enabled: true })).toBe(true)
  })

  it('shouldShowViralLeaderboard：缺省开、显式 false 关', () => {
    expect(shouldShowViralLeaderboard({ enabled: true })).toBe(true)
    expect(shouldShowViralLeaderboard({ enabled: true, leaderboardEnabled: true })).toBe(true)
    expect(shouldShowViralLeaderboard({ enabled: true, leaderboardEnabled: false })).toBe(false)
    expect(shouldShowViralLeaderboard({ enabled: false, leaderboardEnabled: true })).toBe(false)
  })

  it('isViralLeaderboardMeRow 优先 entryId，并列不误伤', () => {
    const rowA = { rank: 1, displayName: 'A', invitedCount: 5, entryId: 'e-a' }
    const rowB = { rank: 1, displayName: 'B', invitedCount: 5, entryId: 'e-b' }
    expect(isViralLeaderboardMeRow(rowA, { entryId: 'e-a', myRank: { rank: 1, invitedCount: 5 } })).toBe(true)
    expect(isViralLeaderboardMeRow(rowB, { entryId: 'e-a', myRank: { rank: 1, invitedCount: 5 } })).toBe(false)
  })

  it('无 entryId 字段时 rank 对齐降级匹配', () => {
    const row = { rank: 3, displayName: 'x', invitedCount: 2 }
    expect(isViralLeaderboardMeRow(row, { entryId: 'me', myRank: { rank: 3, invitedCount: 2 } })).toBe(true)
    expect(isViralLeaderboardMeRow(row, { entryId: 'me', myRank: { rank: 2, invitedCount: 2 } })).toBe(false)
  })

  it('meVisibleInTop + footer 模式', () => {
    const top = [
      { rank: 1, displayName: 'a', invitedCount: 9, entryId: 'e1' },
      { rank: 2, displayName: 'b', invitedCount: 8, entryId: 'e2' },
    ]
    expect(isMeVisibleInViralTop(top, { entryId: 'e1', myRank: { rank: 1, invitedCount: 9 } })).toBe(true)
    expect(isMeVisibleInViralTop(top, { entryId: 'e99', myRank: { rank: 25, invitedCount: 1 } })).toBe(false)

    expect(viralMyRankFooterMode(null, { meVisibleInTop: false })).toBe('none')
    expect(viralMyRankFooterMode({ rank: 0, invitedCount: 0 }, { meVisibleInTop: false })).toBe('zero')
    expect(viralMyRankFooterMode({ rank: 25, invitedCount: 1 }, { meVisibleInTop: false })).toBe('footer')
    expect(viralMyRankFooterMode({ rank: 1, invitedCount: 9 }, { meVisibleInTop: true })).toBe('in_top')
    // rank≤20 但不在 top 可视（数据异常或分页）→ 仍 footer
    expect(viralMyRankFooterMode({ rank: 15, invitedCount: 2 }, { meVisibleInTop: false })).toBe('footer')
  })

  it('parseViralLeaderboardResponse：成功 / 业务 400 message / 空 body', () => {
    const ok = parseViralLeaderboardResponse(
      true,
      {
        ok: true,
        entries: [{ rank: 1, displayName: 'u***', invitedCount: 3, entryId: 'id1' }],
        myRank: { rank: 1, invitedCount: 3 },
      },
      '网络错误',
    )
    expect(ok.ok).toBe(true)
    expect(ok.entries[0]?.entryId).toBe('id1')
    expect(ok.myRank).toEqual({ rank: 1, invitedCount: 3 })
    expect(ok.error).toBe('')

    const biz = parseViralLeaderboardResponse(
      false,
      { ok: false, message: '该活动未开启裂变排行榜' },
      '网络错误',
    )
    expect(biz.ok).toBe(false)
    expect(biz.entries).toEqual([])
    expect(biz.error).toBe('该活动未开启裂变排行榜')

    const net = parseViralLeaderboardResponse(false, {}, '网络错误')
    expect(net.error).toBe('网络错误')

    // HTTP 200 但业务 ok:false（网关/代理误用状态码）仍读 message，禁止当成功列表
    const envelopeFail = parseViralLeaderboardResponse(
      true,
      { ok: false, message: '该活动未开启裂变排行榜', entries: [{ rank: 1, displayName: 'fake', invitedCount: 9 }] },
      '网络错误',
    )
    expect(envelopeFail.ok).toBe(false)
    expect(envelopeFail.entries).toEqual([])
    expect(envelopeFail.error).toBe('该活动未开启裂变排行榜')

    // 成功但 entries 非数组 → 空列表，不抛
    const badList = parseViralLeaderboardResponse(true, { ok: true, entries: null }, '网络错误')
    expect(badList.ok).toBe(true)
    expect(badList.entries).toEqual([])
  })

  it('无本机 entryId 时绝不「是我」；有 entryId 的行优先精确匹配', () => {
    const row = { rank: 1, displayName: 'x', invitedCount: 9, entryId: 'e1' }
    expect(isViralLeaderboardMeRow(row, { entryId: '', myRank: { rank: 1, invitedCount: 9 } })).toBe(false)
    expect(isViralLeaderboardMeRow(row, { entryId: null, myRank: { rank: 1, invitedCount: 9 } })).toBe(false)
    // 我的 id 在榜上但 rank 与行不一致时仍只认 entryId
    expect(
      isViralLeaderboardMeRow(
        { rank: 99, displayName: 'me', invitedCount: 1, entryId: 'mine' },
        { entryId: 'mine', myRank: { rank: 2, invitedCount: 1 } },
      ),
    ).toBe(true)
  })

  it('viralRankBadge', () => {
    expect(viralRankBadge(1)).toBe('🥇')
    expect(viralRankBadge(2)).toBe('🥈')
    expect(viralRankBadge(3)).toBe('🥉')
    expect(viralRankBadge(4)).toBe('4')
  })
})
