/**
 * 抽奖运营端纯函数（无 DOM / 无网络）。
 * 分享链接、开奖确认摘要、复制活动预填、邮件失败统计 —— 便于单测，禁止把逻辑只写在 Vue 里。
 */

export type LotteryOpsDrawLike = {
  id: string
  name: string
  status?: string
  productId?: string
  productTitle?: string | null
  entryCount?: number | null
  winnerCount?: number | null
  maxWinners: number
  maxParticipants?: number | null
  expectedParticipants?: number | null
  description?: string | null
  visible?: number | null
}

export type LotteryOpsWinnerLike = {
  emailSent?: number | null
  emailError?: string | null
}

/** 用户端公开分享路径（history 模式，不含 origin） */
export function buildLotteryPublicPath(drawId: string): string {
  const id = String(drawId || '').trim()
  if (!id) return '/lottery'
  // 防止 path 注入：只允许常见 id 字符；校验通过后原样拼接，避免 encode 后与路由 :id 对不上
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    return '/lottery'
  }
  return `/lottery/${id}`
}

/** 完整可分享 URL；origin 缺省时仍返回 path（调用方再补） */
export function buildLotteryPublicShareUrl(origin: string | null | undefined, drawId: string): string {
  const path = buildLotteryPublicPath(drawId)
  const base = String(origin || '').replace(/\/+$/, '')
  if (!base) return path
  return `${base}${path}`
}

/** 实际将抽出的人数：min(候选池, 名额)；池空为 0 */
export function plannedWinnerCount(entryCount: number | null | undefined, maxWinners: number): number {
  const pool = Math.max(0, Number(entryCount) || 0)
  const cap = Math.max(0, Math.floor(Number(maxWinners) || 0))
  return Math.min(pool, cap)
}

/**
 * 开奖前确认文案（多行）。
 * 供 ConfirmDialog 展示，降低误开奖；不含卡密等敏感信息。
 */
export function buildLotteryDrawConfirmMessage(
  draw: LotteryOpsDrawLike,
  labels: {
    title: string
    name: string
    pool: string
    quota: string
    willDraw: string
    product: string
    emptyPoolWarn: string
    confirm: string
  },
): string {
  const pool = Math.max(0, Number(draw.entryCount) || 0)
  const quota = Math.max(0, Math.floor(Number(draw.maxWinners) || 0))
  const will = plannedWinnerCount(pool, quota)
  const product = (draw.productTitle || draw.productId || '-').trim() || '-'
  const lines = [
    labels.title,
    '',
    `${labels.name}${draw.name || '-'}`,
    `${labels.pool}${pool}`,
    `${labels.quota}${quota}`,
    `${labels.willDraw}${will}`,
    `${labels.product}${product}`,
  ]
  if (pool <= 0) {
    lines.push('', labels.emptyPoolWarn)
  }
  lines.push('', labels.confirm)
  return lines.join('\n')
}

/** 复制活动：预填可编辑字段；时间故意留空，避免把过期窗口原样带入 */
export function buildLotteryDuplicateDraft(
  source: LotteryOpsDrawLike,
  options?: { nameSuffix?: string; defaultName?: string },
): {
  name: string
  description: string
  productId: string
  maxWinners: number
  maxParticipants: number | null
  expectedParticipants: number
  startTime: string
  endTime: string
  drawTime: string
} {
  const suffix = options?.nameSuffix ?? ' (copy)'
  const baseName = String(source.name || '').trim() || options?.defaultName || 'Lottery'
  return {
    name: `${baseName}${suffix}`.slice(0, 120),
    description: String(source.description || ''),
    productId: String(source.productId || ''),
    maxWinners: Math.max(1, Math.floor(Number(source.maxWinners) || 1)),
    maxParticipants:
      source.maxParticipants == null || source.maxParticipants === undefined
        ? null
        : Math.max(1, Math.floor(Number(source.maxParticipants) || 1)),
    expectedParticipants: Math.max(0, Math.floor(Number(source.expectedParticipants) || 0)),
    startTime: '',
    endTime: '',
    drawTime: '',
  }
}

/** 中奖名单中的邮件失败数（已发送成功的不算） */
export function countLotteryEmailFailures(winners: LotteryOpsWinnerLike[]): number {
  let n = 0
  for (const w of winners) {
    if (Number(w.emailSent) === 1) continue
    const err = String(w.emailError || '').trim()
    if (err) n += 1
  }
  return n
}

/** 参与进度文案：有上限显示 a/b，无上限只显示 a */
export function formatLotteryEntryProgress(
  entryCount: number | null | undefined,
  maxParticipants: number | null | undefined,
): string {
  const a = Math.max(0, Number(entryCount) || 0)
  if (maxParticipants == null || maxParticipants === undefined || !(Number(maxParticipants) > 0)) {
    return String(a)
  }
  return `${a} / ${Math.floor(Number(maxParticipants))}`
}

/** 列表排序优先级：卡死 drawing 最先，其次 open / paused，再 draft，drawn/cancelled 靠后 */
const ADMIN_LOTTERY_STATUS_RANK: Record<string, number> = {
  drawing: 0,
  open: 1,
  paused: 2,
  draft: 3,
  drawn: 4,
  cancelled: 5,
}

export type LotteryOpsListDraw = LotteryOpsDrawLike & {
  drawTime?: string | null
  productId?: string
  productTitle?: string | null
}

/**
 * 运营列表：状态筛选 + 名称/奖品/id 模糊搜索，并按运营紧急度排序。
 * 不改服务端数据，只做前端视图层。
 */
export function filterAndSortAdminLotteryDraws<T extends LotteryOpsListDraw>(
  draws: T[],
  options: { status?: string; query?: string },
): T[] {
  const status = String(options.status || '').trim()
  const q = String(options.query || '').trim().toLowerCase()

  const filtered = draws.filter((d) => {
    if (status && d.status !== status) return false
    if (!q) return true
    const hay = [
      d.id,
      d.name,
      d.productTitle,
      d.productId,
      d.description,
    ]
      .map((x) => String(x || '').toLowerCase())
      .join(' ')
    return hay.includes(q)
  })

  return [...filtered].sort((a, b) => {
    const ra = ADMIN_LOTTERY_STATUS_RANK[String(a.status || '')] ?? 50
    const rb = ADMIN_LOTTERY_STATUS_RANK[String(b.status || '')] ?? 50
    if (ra !== rb) return ra - rb
    const ta = Date.parse(String(a.drawTime || '')) || 0
    const tb = Date.parse(String(b.drawTime || '')) || 0
    // 同优先级：开奖时间更近的在前（升序）
    if (ta !== tb) return ta - tb
    return String(a.id).localeCompare(String(b.id))
  })
}

function csvEscape(value: string): string {
  const s = String(value ?? '')
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export type LotteryOpsCsvWinner = LotteryOpsWinnerLike & {
  email?: string | null
  orderNo?: string | null
  cardAccountLabel?: string | null
  cardDeliverySecret?: string | null
}

export type LotteryWinnersCsvLabels = {
  email: string
  orderNo: string
  card: string
  emailStatus: string
  sent: string
  pending: string
  failed: string
}

/** 中奖名单二维表（含表头），供 downloadCsv / 文本 CSV 共用 */
export function buildLotteryWinnersCsvRows(
  winners: LotteryOpsCsvWinner[],
  labels: LotteryWinnersCsvLabels,
): string[][] {
  const header = [labels.email, labels.orderNo, labels.card, labels.emailStatus]
  const body = winners.map((w) => {
    const cardParts = [w.cardAccountLabel, w.cardDeliverySecret]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    let status = labels.pending
    if (Number(w.emailSent) === 1) status = labels.sent
    else if (String(w.emailError || '').trim()) {
      status = `${labels.failed}: ${String(w.emailError).trim()}`
    }
    return [
      String(w.email || ''),
      String(w.orderNo || ''),
      cardParts.join(' / '),
      status,
    ]
  })
  return [header, ...body]
}

/**
 * 中奖名单 CSV（含表头）。卡密仅供运营导出，勿对用户暴露此接口。
 */
export function buildLotteryWinnersCsv(
  winners: LotteryOpsCsvWinner[],
  labels: LotteryWinnersCsvLabels,
): string {
  return (
    buildLotteryWinnersCsvRows(winners, labels)
      .map((row) => row.map(csvEscape).join(','))
      .join('\n') + '\n'
  )
}

/** 列表可见性文案：visible 缺省/非 0 视为公开（与后端默认 visible=1 对齐） */
export function formatLotteryVisibilityLabel(
  visible: number | null | undefined,
  labels: { public: string; hidden: string },
): string {
  // 仅显式 0 为隐藏。注意 Number(null)===0，故不能用 Number() 判断缺省。
  if (visible === 0) return labels.hidden
  return labels.public
}

export type LotteryOpsMyEntryLike = {
  drawId: string
  joinedAt?: string | null
  drawStatus?: string | null
  drawName?: string | null
  drawTime?: string | null
}

/**
 * 「我的记录」排序：中奖优先，其次按参与时间新→旧。
 * wonDrawIds 为中奖 drawId 集合；不修改入参数组。
 */
export function sortLotteryMyEntries<T extends LotteryOpsMyEntryLike>(
  entries: T[],
  wonDrawIds: Set<string> | ReadonlySet<string>,
): T[] {
  return [...entries].sort((a, b) => {
    const aw = wonDrawIds.has(a.drawId) ? 1 : 0
    const bw = wonDrawIds.has(b.drawId) ? 1 : 0
    if (aw !== bw) return bw - aw
    const ta = Date.parse(String(a.joinedAt || '')) || 0
    const tb = Date.parse(String(b.joinedAt || '')) || 0
    if (ta !== tb) return tb - ta
    return String(a.drawId).localeCompare(String(b.drawId))
  })
}
