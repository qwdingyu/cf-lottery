/**
 * 管理端抽奖页纯工具：CSV、复制草稿、展示辅助。
 *
 * 为什么独立：这些函数不依赖 Vue 组件实例，只吃数据 + 文案参数，
 * 便于单测与从 3k+ 行 SFC 中减负，同时不拆成十几个 50 行碎片文件。
 */
import { toDateTimeLocalValue } from '@/composables/useFormat'
import {
  defaultExperienceForParticipation,
  defaultResultModeForActivity,
} from '@/lib/activity-defaults'
import { normalizeActivityConfig, type ActivityConfigTranslate } from './activity-config'
import type { ExternalConversion, LotteryWinner, PublishCheckItem } from './types'

/** 下载 CSV（含公式注入防护，须与后端 csvEscape 语义对齐） */
export function downloadCsv(filename: string, rows: string[][]) {
  // 公式注入防护：Excel/Sheets 会把 = + - @ 开头的单元格当公式执行，
  // 加 ' 前缀阻止；结构上统一引号包裹 + 引号加倍。
  // 注意：后端 admin-lottery.ts 的 csvEscape 有相同逻辑（服务端导出），
  // 修改此处时必须同步修改后端版本，保持一致（跨运行环境不强行共享）。
  const escapeCell = (c: unknown): string => {
    const raw = String(c ?? '')
    const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
    return `"${safe.replace(/"/g, '""')}"`
  }
  const csv = rows.map((r) => r.map(escapeCell).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 后端 winners 以 notificationStatus 为准；emailSent/emailError 为历史兼容字段，不可单独依赖 */
export function isWinnerEmailSent(w: Pick<LotteryWinner, 'notificationStatus' | 'emailSent'>): boolean {
  if (w.notificationStatus === 'sent') return true
  if (w.notificationStatus === 'failed' || w.notificationStatus === 'pending') return false
  // 无 notificationStatus 时的兜底（旧 mock / 残缺数据）
  return Number(w.emailSent) === 1
}

export function isWinnerEmailFailed(w: Pick<LotteryWinner, 'notificationStatus' | 'emailError'>): boolean {
  if (w.notificationStatus === 'failed') return true
  if (w.notificationStatus === 'sent' || w.notificationStatus === 'pending') return false
  return Boolean(w.emailError)
}

export function isWinnerEmailPending(w: Pick<LotteryWinner, 'notificationStatus' | 'emailSent' | 'emailError'>): boolean {
  if (w.notificationStatus === 'pending') return true
  if (w.notificationStatus === 'sent' || w.notificationStatus === 'failed') return false
  return !isWinnerEmailSent(w) && !isWinnerEmailFailed(w)
}

export const countLotteryEmailFailures = (winners: LotteryWinner[]) =>
  winners.filter((w) => isWinnerEmailFailed(w)).length

export const countLotteryEmailPending = (winners: LotteryWinner[]) =>
  winners.filter((w) => isWinnerEmailPending(w)).length

/**
 * 开奖刚完成时的反馈档位：邮件失败必须压过「开奖完成」成功感（开奖结果已落库，邮件失败不回滚）。
 * pure：便于 vitest，不依赖 toast 实现。
 */
export type DrawDoneFeedbackKind = 'ok' | 'email_pending' | 'email_failed' | 'empty'

export function drawDoneFeedbackKind(winners: LotteryWinner[]): DrawDoneFeedbackKind {
  if (!winners.length) return 'empty'
  if (countLotteryEmailFailures(winners) > 0) return 'email_failed'
  if (countLotteryEmailPending(winners) > 0) return 'email_pending'
  return 'ok'
}

/**
 * 中奖名单轮询：pending 收敛后的一次反馈（避免静默结束）。
 * - became_failed：出现/仍有失败（优先于成功）
 * - all_sent：pending 清零且无失败
 * - still_pending：触达轮询上限仍有 pending
 * - none：中间态或无事可报
 */
export type WinnersPollSettleKind = 'none' | 'became_failed' | 'all_sent' | 'still_pending'

export function winnersPollSettleKind(input: {
  prevPending: number
  nextFail: number
  nextPending: number
  hitMaxRefreshes: boolean
}): WinnersPollSettleKind {
  const { prevPending, nextFail, nextPending, hitMaxRefreshes } = input
  // 仍有 pending 且未到上限：继续等，不弹
  if (nextPending > 0 && !hitMaxRefreshes) return 'none'
  if (nextFail > 0) return 'became_failed'
  if (nextPending > 0 && hitMaxRefreshes) return 'still_pending'
  // pending 从有到无且无失败
  if (prevPending > 0 && nextPending === 0 && nextFail === 0) return 'all_sent'
  return 'none'
}

export const formatLotteryEntryProgress = (count?: number | null, max?: number | null) =>
  max ? `${count ?? 0} / ${max}` : `${count ?? 0}`

/**
 * 用户侧是否展示该活动。
 * 缺省 / null / undefined 视为可见（与 DB DEFAULT 1 及旧行无字段一致）。
 * 注意：`visible ?` 会把 undefined 当成 hidden，菜单会误显「展示」。
 */
export function isLotteryUserVisible(visible?: number | null): boolean {
  if (visible === undefined || visible === null) return true
  return Number(visible) !== 0
}

export const formatLotteryVisibilityLabel = (
  visible: number | undefined | null,
  labels: { public: string; hidden: string },
) => (isLotteryUserVisible(visible) ? labels.public : labels.hidden)

export const buildLotteryWinnersCsvRows = (
  winners: LotteryWinner[],
  labels: Record<string, string>,
) => {
  const header = [labels.email, labels.emailStatus]
  // 与中奖名单展示一致：优先 identityDisplay（registered 用户为用户名(邮箱)）
  const rows = winners.map((w) => [
    w.identityDisplay || w.identityValue,
    w.notificationStatus === 'sent'
      ? labels.sent
      : w.notificationStatus === 'failed'
        ? labels.failed
        : labels.pending,
  ])
  return [header, ...rows]
}

export function buildLotteryDuplicateDraft(
  draw: {
    title?: string
    description?: string
    startAt?: string
    endAt?: string
    drawAt?: string | null
    winnerCount?: number
    maxParticipants?: number | null
    participationMode?: string
    activityKind?: string
    allocationPolicy?: string
    experienceType?: string
    resultMode?: string
    activityConfig?: unknown
  },
  opts: { nameSuffix: string; defaultName: string },
  t: ActivityConfigTranslate,
) {
  const participationMode = draw.participationMode || 'open'
  const activityKind = draw.activityKind || 'lottery'
  return {
    name: draw.title ? `${draw.title}${opts.nameSuffix}` : opts.defaultName,
    description: draw.description || '',
    prizeName: '',
    startTime: draw.startAt ? toDateTimeLocalValue(draw.startAt) : '',
    endTime: draw.endAt ? toDateTimeLocalValue(draw.endAt) : '',
    drawTime: draw.drawAt ? toDateTimeLocalValue(draw.drawAt) : '',
    winnerCount: draw.winnerCount || 1,
    maxParticipants: draw.maxParticipants || null,
    participationMode,
    activityKind,
    allocationPolicy: draw.allocationPolicy || 'capacity',
    experienceType: draw.experienceType || defaultExperienceForParticipation(participationMode),
    resultMode: draw.resultMode || defaultResultModeForActivity(activityKind),
    activityConfig: normalizeActivityConfig(activityKind, draw.activityConfig, t),
    accessPassword: '',
  }
}

export const buildLotteryDrawConfirmMessage = (
  draw: { title?: string; entryCount?: number; winnerCount: number },
  labels: Record<string, string>,
) =>
  `${labels.title}\n${labels.name}${draw.title}\n${labels.pool}${draw.entryCount || 0}\n${labels.willDraw}${Math.min(Number(draw.entryCount) || 0, draw.winnerCount)}`

export function percent(numerator: number, denominator: number): string {
  if (!denominator || denominator <= 0) return '-'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

export function conversionIdentity(item: ExternalConversion): string {
  if (!item.identityValue) return '-'
  return item.identityType ? `${item.identityType}:${item.identityValue}` : item.identityValue
}

export function conversionAmount(
  item: ExternalConversion,
  formatCents: (amount: number) => string,
): string {
  if (item.amountCents === null || item.amountCents === undefined) return '-'
  const currency = item.currency ? `${item.currency} ` : ''
  return `${currency}${formatCents(item.amountCents)}`
}

export function formatPublishCheckItems(items: PublishCheckItem[], prefix: string, moreLabel: string): string {
  const topItems = items.slice(0, 3).map((item) => item.message).join('\n')
  const rest = items.length > 3 ? moreLabel : ''
  return `${prefix}\n${topItems}${rest}`
}

export function canDeleteDraw(status: string): boolean {
  return status === 'draft' || status === 'paused' || status === 'drawn' || status === 'cancelled'
}

/**
 * drawn 且当前对用户可见（缺省 visible=1）→ 可批量隐藏。
 * 为什么：清用户视野优先于删；已 hidden 的不必再进 hide 队列。
 */
export function canBatchHideDraw(status: string, visible?: number | null): boolean {
  if (status !== 'drawn') return false
  return isLotteryUserVisible(visible)
}

/** 多选可选：可删或可隐藏（与 bulk 条动作对齐） */
export function canSelectDrawForBulk(status: string, visible?: number | null): boolean {
  return canDeleteDraw(status) || canBatchHideDraw(status, visible)
}

/** 列表状态筛：是否算「非默认」从而走筛选空态文案（默认 active 不算） */
export function isNonDefaultDrawStatusFilter(
  statusFilter: string,
  defaultStatus = 'active',
): boolean {
  const s = String(statusFilter || '').trim()
  return Boolean(s) && s !== defaultStatus
}

/** 管理列表是否处于「有筛选」——默认进行中不算，避免空库误显「无匹配」 */
export function hasActiveDrawListFilter(opts: {
  statusFilter: string
  listQuery?: string
  activityKindFilter?: string
  createdFromFilter?: string
  createdToFilter?: string
  defaultStatus?: string
}): boolean {
  const def = opts.defaultStatus ?? 'active'
  if (isNonDefaultDrawStatusFilter(opts.statusFilter, def)) return true
  if (String(opts.listQuery || '').trim()) return true
  if (String(opts.activityKindFilter || '').trim()) return true
  if (String(opts.createdFromFilter || '').trim()) return true
  if (String(opts.createdToFilter || '').trim()) return true
  return false
}

/** 展示名：API 主字段 title，兼容旧 name */
export function drawDisplayName(draw: { title?: string; name?: string }): string {
  return String(draw.title || draw.name || '').trim() || '—'
}

/** 卡密奖码池剩余（total - used，下限 0） */
export function prizeCodePoolLeft(prize: { totalCount?: number; usedCount?: number }): number {
  return Math.max(0, (Number(prize.totalCount) || 0) - (Number(prize.usedCount) || 0))
}

/** 仅 available 可删（已发放保留审计，对齐后端 DELETE） */
export function canDeletePrizeCode(status: string): boolean {
  return status === 'available'
}

/**
 * 租户成员可否移除。
 * owner 是租户安全锚点，前端不可选、后端也会拦自我删除；批量清场只针对 admin/viewer。
 */
export function canRemoveMember(role: string): boolean {
  return role !== 'owner'
}

/**
 * 平台兑换码可否禁用。
 * 仅 active 可禁；used/expired/disabled 已是终态或已禁，再 PATCH 无业务意义且易误操作。
 */
export function canDisableRedemptionCode(status: string): boolean {
  return status === 'active'
}

/**
 * 平台成员可否批量操作（禁用/移除）。
 * 不能操作自己——后端也会拦，前端先排除避免选中后批量必失败。
 */
export function canOperatePlatformMember(userId: string, myUserId: string): boolean {
  if (!userId) return false
  if (!myUserId) return true
  return userId !== myUserId
}

/**
 * Webhook 投递可否重试。
 * 仅 failed/pending 有意义；sent 再重试会重复打外部 URL。
 */
export function canRetryWebhookDelivery(status: string): boolean {
  return status === 'failed' || status === 'pending'
}

/** 奖品是否启用（缺省 active 视为启用，与常见 DEFAULT 1 一致） */
export function isPrizeActive(active?: number | null): boolean {
  if (active === undefined || active === null) return true
  return Number(active) !== 0
}

/** 状态 → 共享 .tag* class（禁止自造 chip） */
export function statusClass(status: string): string {
  if (status === 'open') return 'tag-success'
  if (status === 'paused') return 'tag-muted'
  if (status === 'drawing') return 'tag-warning'
  if (status === 'drawn') return 'tag-info'
  if (status === 'cancelled') return 'tag-danger'
  return 'tag-muted'
}

export function emailStatusClass(w: LotteryWinner): string {
  // 与 countLotteryEmailFailures / CSV 同源：notificationStatus 优先
  if (isWinnerEmailSent(w)) return 'tag-success'
  if (isWinnerEmailFailed(w)) return 'tag-danger'
  return 'tag-warning'
}

/**
 * 055a P1：发布门禁失败后，判断是否适合「一键进编辑」补齐。
 * - 仅 draft 可编辑（与后端 PATCH 一致）
 * - prizes / participation / basic / activity_config 可在创建表单修
 * - promotion / webhook 多半不在本表单主路径，不自动跳编辑以免空跑
 */
export function canGuidePublishFixInEditor(status: string, errors: PublishCheckItem[]): boolean {
  if (status !== 'draft' || errors.length === 0) return false
  const editableSections = new Set(['basic', 'participation', 'prizes', 'activity_config'])
  return errors.some((item) => editableSections.has(item.section))
}

/** 门禁 section → 创建表单分区 id */
export function publishFixSectionTargetId(errors: PublishCheckItem[]): string | undefined {
  const priority = ['prizes', 'basic', 'participation', 'activity_config', 'promotion', 'webhook']
  const section = priority.find((s) => errors.some((e) => e.section === s)) || errors[0]?.section
  const idMap: Record<string, string> = {
    prizes: 'lottery-prizes',
    basic: 'lottery-basic',
    participation: 'lottery-mode',
    activity_config: 'activity-config',
    promotion: 'lottery-advanced',
  }
  return section ? idMap[section] : undefined
}
