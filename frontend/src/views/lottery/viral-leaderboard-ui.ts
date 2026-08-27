/**
 * 公开页邀请排行榜 UI 决策纯函数（docs/109 / 114）。
 *
 * 从 ViralLeaderboard.vue 抽出可单测逻辑，避免「只改模板、契约漂移」且不挂载 SFC。
 * 不发起网络请求；只描述：是否画榜、是否高亮我、是否展示我的底栏名次、如何解析榜错误。
 */
import type { ReferralRewardDef } from './types'

export type ViralUiConfig = {
  enabled?: boolean
  extraEntriesPerInvite?: number
  maxExtraEntries?: number
  leaderboardEnabled?: boolean
  referralRewardDefs?: ReferralRewardDef[]
} | null | undefined

export type LeaderboardRow = {
  rank: number
  displayName: string
  invitedCount: number
  entryId?: string
  /** 排行榜奖励是否已发放（leaderboardRewardedAt 非空即已发） */
  rewarded?: boolean
}

export type MyRankInfo = {
  rank: number
  invitedCount: number
} | null

/** 裂变总开关：必须显式 enabled === true 才挂载整块 */
export function isViralFeatureEnabled(viral: ViralUiConfig): boolean {
  return viral?.enabled === true
}

/**
 * 是否应挂载裂变面板（ViralLeaderboard / GameResultModal 共享判定，docs/103/259 D2）：
 * - viral.enabled === true 始终展示；
 * - viral 关闭但配置了 referralRewardDefs 时，仍展示里程碑进度面。
 *
 * 调用方可按自身场景追加 entry/status 门禁（如 GameResultModal 的 entryId+终态）。
 */
export function shouldShowViralPanel(viral: ViralUiConfig): boolean {
  if (viral?.enabled === true) return true
  const defs = viral?.referralRewardDefs
  return Array.isArray(defs) && defs.length > 0
}

/**
 * 是否展示排行榜卡片并请求 /viral-leaderboard。
 * 与后端 isViralLeaderboardEnabled、管理端默认一致：仅显式 false 关闭。
 */
export function shouldShowViralLeaderboard(viral: ViralUiConfig): boolean {
  if (!isViralFeatureEnabled(viral)) return false
  return viral?.leaderboardEnabled !== false
}

/**
 * 榜行是否「是我」：
 * - 行上带 entryId 时**只**比 entryId（并列同 rank 绝不能靠 rank 误高亮他人）
 * - 仅当行无 entryId（旧响应）时，才用 myRank.rank 降级对齐
 */
export function isViralLeaderboardMeRow(
  item: LeaderboardRow,
  opts: { entryId?: string | null; myRank?: MyRankInfo },
): boolean {
  const myId = String(opts.entryId || '').trim()
  if (!myId) return false
  // 现代 API 必带 entryId：有则只认精确匹配，禁止再走 rank 降级
  if (item.entryId) {
    return item.entryId === myId
  }
  if (opts.myRank && opts.myRank.rank > 0 && item.rank === opts.myRank.rank) {
    return true
  }
  return false
}

/**
 * 我是否已出现在当前 Top 列表中（用于决定是否再画底栏「我的名次」条）。
 * Top 内已高亮则不重复底栏（rank≤20 且在 list 中）。
 */
export function isMeVisibleInViralTop(
  leaderboard: LeaderboardRow[],
  opts: { entryId?: string | null; myRank?: MyRankInfo },
): boolean {
  if (!opts.entryId || !opts.myRank || opts.myRank.rank <= 0) return false
  return leaderboard.some(
    (row) =>
      row.entryId === opts.entryId ||
      (row.rank === opts.myRank!.rank && isViralLeaderboardMeRow(row, opts)),
  )
}

/**
 * 底栏「我的排名」展示模式：
 * - none：无 myRank（路人未带 entryId）
 * - zero：已参与 0 邀请，诚实「尚未上榜」
 * - footer：有名次且未在 Top 可视区（或 rank>20）
 * - in_top：已在列表高亮，不画底栏
 */
export function viralMyRankFooterMode(
  myRank: MyRankInfo,
  opts: { meVisibleInTop: boolean },
): 'none' | 'zero' | 'footer' | 'in_top' {
  if (!myRank) return 'none'
  if (myRank.rank === 0) return 'zero'
  if (myRank.rank > 0 && (myRank.rank > 20 || !opts.meVisibleInTop)) return 'footer'
  return 'in_top'
}

/**
 * 解析榜 API 响应为 UI 状态（成功列表 / 业务错误文案）。
 * 非 2xx 也读 message，禁止一律「网络错误」掩盖「未开启排行榜」。
 */
export function parseViralLeaderboardResponse(
  httpOk: boolean,
  body: unknown,
  fallbackNetworkError: string,
): {
  ok: boolean
  entries: LeaderboardRow[]
  myRank: MyRankInfo
  error: string
} {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const message = typeof raw.message === 'string' && raw.message.trim() ? raw.message.trim() : ''
  const apiOk = raw.ok !== false

  if (httpOk && apiOk) {
    const list = Array.isArray(raw.entries) ? raw.entries : []
    const entries: LeaderboardRow[] = list.map((e: any) => ({
      rank: Number(e?.rank) || 0,
      displayName: String(e?.displayName || '***'),
      invitedCount: Math.max(0, Math.floor(Number(e?.invitedCount) || 0)),
      entryId: e?.entryId ? String(e.entryId) : undefined,
      rewarded: e?.rewarded === true,
    }))
    let myRank: MyRankInfo = null
    if (raw.myRank && typeof raw.myRank === 'object') {
      const mr = raw.myRank as Record<string, unknown>
      myRank = {
        rank: Math.floor(Number(mr.rank) || 0),
        invitedCount: Math.max(0, Math.floor(Number(mr.invitedCount) || 0)),
      }
    }
    return { ok: true, entries, myRank, error: '' }
  }

  return {
    ok: false,
    entries: [],
    myRank: null,
    error: message || fallbackNetworkError,
  }
}

/** 名次徽章：1–3 奖牌，其余数字（纯展示，单测锁文案稳定性） */
export function viralRankBadge(rank: number): string {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return String(rank)
}
