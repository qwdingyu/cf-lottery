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

export const countLotteryEmailFailures = (winners: LotteryWinner[]) =>
  winners.filter((w) => w.notificationStatus === 'failed').length

export const formatLotteryEntryProgress = (count?: number | null, max?: number | null) =>
  max ? `${count ?? 0} / ${max}` : `${count ?? 0}`

export const formatLotteryVisibilityLabel = (
  visible: number | undefined | null,
  labels: { public: string; hidden: string },
) => (visible ? labels.public : labels.hidden)

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
  if (Number(w.emailSent) === 1) return 'tag-success'
  if (w.emailError) return 'tag-danger'
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
