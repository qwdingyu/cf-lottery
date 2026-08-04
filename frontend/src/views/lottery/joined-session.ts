/**
 * 公开页「本机已参与」提示（sessionStorage，非密码学证明）。
 *
 * 为什么要有：
 * - open 邮箱 OTP 参与后往往只有 sessionEmail，无业务 JWT；刷新后 myJoinedById 清空，
 *   用户会再点参与 → 409，体验像失败（docs/097/098）。
 * - 本模块只服务 UI 回填（灰钮 / 查结果入口），**不能**代替 my-result OTP 读卡密。
 * - 退出登录 / 清会话时一并清掉，避免串号展示。
 */
import type { SessionStore } from '@/composables/cf-auth-session'

/** sessionStorage 键：slug → 已参与提示 */
export const LOTTERY_JOINED_HINTS_KEY = 'lottery_joined_hints'

export type JoinedHint = {
  drawId: string
  /** 可选：分享 / 裂变用；刷新后无 entryId 则分享降级为活动链接 */
  entryId?: string
  joinedAt?: string
  drawName?: string
  drawStatus?: string
  /** 玩法：回填「未中奖」标签时用，缺省不标未中奖（docs/104） */
  activityKind?: string
  won?: boolean
}

export type JoinedHintsMap = Record<string, JoinedHint>

/** 规范化 map 键（publicSlug 或 id） */
export function joinedHintKey(slugOrId: string): string {
  return String(slugOrId || '')
    .trim()
    .toLowerCase()
}

export function readJoinedHints(store: SessionStore): JoinedHintsMap {
  try {
    const raw = store.getItem(LOTTERY_JOINED_HINTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: JoinedHintsMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = joinedHintKey(k)
      if (!key || !v || typeof v !== 'object') continue
      const row = v as JoinedHint
      const drawId = String(row.drawId || key).trim()
      if (!drawId) continue
      out[key] = {
        drawId,
        entryId: row.entryId ? String(row.entryId) : undefined,
        joinedAt: row.joinedAt ? String(row.joinedAt) : undefined,
        drawName: row.drawName ? String(row.drawName) : undefined,
        drawStatus: row.drawStatus ? String(row.drawStatus) : undefined,
        activityKind: row.activityKind ? String(row.activityKind) : undefined,
        won: Boolean(row.won),
      }
    }
    return out
  } catch {
    return {}
  }
}

export function writeJoinedHints(store: SessionStore, map: JoinedHintsMap): void {
  try {
    store.setItem(LOTTERY_JOINED_HINTS_KEY, JSON.stringify(map))
  } catch {
    /* quota / 隐私模式：忽略，不影响主路径 */
  }
}

export function clearJoinedHints(store: SessionStore): void {
  try {
    store.removeItem(LOTTERY_JOINED_HINTS_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * 删除与某活动相关的本机提示（按 slug/id 多键）。
 * 用于 JWT my-result 明确「未参与」时清脏数据，避免假灰钮（docs/099）。
 */
export function removeJoinedHintsForKeys(store: SessionStore, keys: string[]): JoinedHintsMap {
  const map = readJoinedHints(store)
  let changed = false
  for (const k of keys) {
    const key = joinedHintKey(k)
    if (key && map[key]) {
      delete map[key]
      changed = true
    }
  }
  if (changed) writeJoinedHints(store, map)
  return map
}

/**
 * 写入或合并一条已参与提示（按 slug 与 drawId 双键，避免 id/slug 漂移丢状态）。
 */
export function upsertJoinedHint(
  store: SessionStore,
  keys: string[],
  hint: JoinedHint,
): JoinedHintsMap {
  const map = readJoinedHints(store)
  const row: JoinedHint = {
    drawId: String(hint.drawId || '').trim(),
    entryId: hint.entryId,
    joinedAt: hint.joinedAt || new Date().toISOString(),
    drawName: hint.drawName,
    drawStatus: hint.drawStatus,
    activityKind: hint.activityKind,
    won: hint.won,
  }
  if (!row.drawId) return map
  const uniq = new Set<string>()
  for (const k of [...keys, row.drawId]) {
    const key = joinedHintKey(k)
    if (key) uniq.add(key)
  }
  for (const key of uniq) {
    const prev = map[key]
    map[key] = {
      ...prev,
      ...row,
      entryId: row.entryId || prev?.entryId,
      activityKind: row.activityKind || prev?.activityKind,
      won: row.won || prev?.won,
    }
  }
  writeJoinedHints(store, map)
  return map
}

/** 响应是否表示「已参与」（409 或中英 message） */
export function isAlreadyJoinedResponse(
  data: { message?: string } | null | undefined,
  httpStatus?: number,
): boolean {
  if (httpStatus === 409) return true
  const msg = String(data?.message || '')
  return /已参与|already\s*join/i.test(msg)
}

/**
 * 公开 API 路径键：优先 publicSlug。
 * draws 为当前页活动列表（深链通常一条）。
 */
export function resolvePublicDrawPathKey(
  drawId: string,
  draws: Array<{ id?: string; publicSlug?: string }>,
): string {
  const id = String(drawId || '').trim()
  const draw = draws.find((d) => d.id === id || d.publicSlug === id)
  return String(draw?.publicSlug || draw?.id || id)
}

/**
 * 成功弹窗说明文案 key（lottery.*），按 result_mode 诚实分支。
 */
export function joinResultHintI18nKey(resultMode: string | null | undefined): string {
  const mode = String(resultMode || '')
    .trim()
    .toLowerCase()
  if (mode === 'instant') return 'joinResultHintInstant'
  if (mode === 'scheduled') return 'joinResultHintScheduled'
  if (mode === 'manual') return 'joinResultHintManual'
  if (mode === 'no_result') return 'joinResultHintNoResult'
  if (mode === 'vote_tally') return 'joinResultHintVoteTally'
  if (mode === 'ordered_assignment' || mode === 'capacity_assignment') {
    return 'joinResultHintOrdered'
  }
  // 审批：禁止落入「等开奖 / 是否中奖」（docs/105）
  if (mode === 'review_decision') return 'joinResultHintReview'
  return 'joinResultHintPending'
}

/**
 * 已参与且仍 open 时底部/横幅提示 key。
 */
export function joinedOpenStatusHintKey(resultMode: string | null | undefined): string {
  const mode = String(resultMode || '')
    .trim()
    .toLowerCase()
  if (mode === 'no_result') return 'statusHintJoinedNoResult'
  if (mode === 'vote_tally') return 'statusHintJoinedVote'
  if (mode === 'ordered_assignment' || mode === 'capacity_assignment') {
    return 'statusHintJoinedOrdered'
  }
  if (mode === 'instant') return 'statusHintJoinedInstant'
  if (mode === 'review_decision') return 'statusHintJoinedReview'
  return 'statusHintJoinedPending'
}

/**
 * fetchDraws 参数：模板 @click 会传入 Event，不可把 Event 当 { silent }。
 */
export function isSilentFetchOption(opts?: { silent?: boolean } | Event): boolean {
  return Boolean(
    opts != null &&
      typeof opts === 'object' &&
      'silent' in opts &&
      (opts as { silent?: boolean }).silent,
  )
}
