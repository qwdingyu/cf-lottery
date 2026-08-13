/**
 * 管理端抽奖页纯工具：CSV、复制草稿、展示辅助。
 *
 * 为什么独立：这些函数不依赖 Vue 组件实例，只吃数据 + 文案参数，
 * 便于单测与从 3k+ 行 SFC 中减负，同时不拆成十几个 50 行碎片文件。
 */
import { toDateTimeLocalValue } from '@/composables/useFormat'
import { downloadCsv as kitDownloadCsv } from '@usethink/cf-admin-fe/utils'
import {
  defaultExperienceForParticipation,
  defaultResultModeForActivity,
  resolveDrawTrigger,
  resultModeForLotteryDrawTrigger,
} from '@/lib/activity-defaults'
import { normalizeActivityConfig, type ActivityConfigTranslate } from './activity-config'
import type { ExternalConversion, LotteryWinner, PublishCheckItem } from './types'

/**
 * 下载 CSV（公式注入防护在 cf-admin-fe safeCsvCell）。
 * 后端 admin-lottery.ts 服务端导出须保持同类语义，不跨运行时共享实现。
 */
export function downloadCsv(filename: string, rows: string[][]) {
  kitDownloadCsv(filename, rows)
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
  // docs/102：导出含奖品与履约（卡密/人工），不再假装有电商订单号
  const header = [
    labels.email,
    labels.prize || labels.orderNo || 'prize',
    labels.fulfillment || labels.card || 'fulfillment',
    labels.emailStatus,
  ]
  const rows = winners.map((w) => {
    const prizeLabel = w.prizeName || w.tierName || ''
    let fulfill = ''
    if (w.prizeCode || w.cardAccountLabel) {
      fulfill = w.prizeCode || (w.cardDeliverySecret
        ? `${w.cardAccountLabel}:${w.cardDeliverySecret}`
        : String(w.cardAccountLabel || ''))
    } else if (w.fulfillmentKind === 'manual' || w.prizeType === 'manual_fulfillment' || w.prizeType === 'manual') {
      fulfill = labels.manual || 'manual'
      if (w.fulfillmentNote) fulfill = `${fulfill}: ${w.fulfillmentNote}`
    } else if (w.fulfillmentKind === 'code_missing') {
      fulfill = labels.codeMissing || 'code_missing'
    }
    return [
      w.identityDisplay || w.identityValue,
      prizeLabel,
      fulfill,
      w.notificationStatus === 'sent'
        ? labels.sent
        : w.notificationStatus === 'failed'
          ? labels.failed
          : labels.pending,
    ]
  })
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

/**
 * 创建/编辑活动时：drawAt ↔ drawTrigger ↔ lottery resultMode 单一真相。
 * 禁止只写 drawAt 却保持 manual（Cron 永远扫不到）。
 * instant（docs/116）：独立 spin 结果机，不得被 drawAt→scheduled 覆盖。
 */
export function resolveLotteryScheduleFields(input: {
  activityKind?: string | null
  drawAt?: string | null
  drawTrigger?: string | null
  resultMode?: string | null
}): {
  drawTrigger: 'manual' | 'scheduled'
  resultMode: string
} {
  const activityKind = String(input.activityKind || 'lottery')
  const requestedMode = String(input.resultMode || '').trim()
  // instant 不走 performDraw/Cron：强制 manual trigger，保留 resultMode=instant
  if (activityKind === 'lottery' && requestedMode === 'instant') {
    return { drawTrigger: 'manual', resultMode: 'instant' }
  }
  const drawTrigger = resolveDrawTrigger({
    activityKind,
    drawAt: input.drawAt,
    drawTrigger: input.drawTrigger,
  })
  if (activityKind === 'lottery') {
    // delayed lottery：resultMode 跟 trigger；勿让表单默认 manual 覆盖 scheduled
    return {
      drawTrigger,
      resultMode: resultModeForLotteryDrawTrigger(drawTrigger),
    }
  }
  // 非 lottery：保留调用方 resultMode（问卷/接龙等），trigger 恒 manual
  return {
    drawTrigger,
    resultMode: String(input.resultMode || defaultResultModeForActivity(activityKind)),
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
 * 列表「即时出结果」标签：resultMode=instant 一眼可辨（docs/118/119）。
 * 与 AdminLotteryView 模板一致：不限 activityKind（非 lottery 极少 instant）。
 */
export function shouldShowAdminInstantResultTag(resultMode: string | null | undefined): boolean {
  return String(resultMode || '') === 'instant'
}

/**
 * open 抽奖行次按钮：instant 隐藏「立即开奖」改暂停；delayed 才允许 performDraw。
 */
export function adminOpenLotterySecondaryAction(input: {
  status?: string | null
  activityKind?: string | null
  resultMode?: string | null
}): 'draw_now' | 'pause' | 'none' {
  if (String(input.status || '') !== 'open') return 'none'
  if (String(input.activityKind || '') !== 'lottery') return 'none'
  if (String(input.resultMode || '') === 'instant') return 'pause'
  return 'draw_now'
}

/** 是否展示「立即开奖」按钮（instant 恒 false） */
export function shouldShowAdminDrawNowButton(input: {
  status?: string | null
  activityKind?: string | null
  resultMode?: string | null
}): boolean {
  return adminOpenLotterySecondaryAction(input) === 'draw_now'
}

/**
 * drawn 且当前对用户可见（缺省 visible=1）→ 可批量隐藏。
 * 为什么：清用户视野优先于删；已 hidden 的不必再进 hide 队列。
 */
export function canBatchHideDraw(status: string, visible?: number | null): boolean {
  if (status !== 'drawn') return false
  return isLotteryUserVisible(visible)
}

/** open → paused（对齐 pauseDraw） */
export function canPauseDraw(status: string): boolean {
  return status === 'open'
}

/** paused → open（对齐 resumeDraw） */
export function canResumeDraw(status: string): boolean {
  return status === 'paused'
}

/**
 * 可取消：draft/open/paused → cancelled（对齐 cancelDraw）。
 * drawn/drawing 不可取消，避免开奖中/已履约数据不一致。
 * 取消是终态但保留记录，比物理删除更适合「关停测试活动」。
 */
export function canCancelDraw(status: string): boolean {
  return status === 'draft' || status === 'open' || status === 'paused'
}

/**
 * 多选可选：可删 / 可隐藏 / 可暂停 / 可恢复 / 可取消（与 bulk 条动作对齐）。
 * open 本身不可删，但必须能勾选才能批量暂停/取消。
 */
export function canSelectDrawForBulk(status: string, visible?: number | null): boolean {
  return canDeleteDraw(status)
    || canBatchHideDraw(status, visible)
    || canPauseDraw(status)
    || canResumeDraw(status)
    || canCancelDraw(status)
}

/**
 * 活动删除策略摘要（与后端 DELETE /draws/:id 对齐，供 UI/文档同源）。
 * - 默认可删：draft / paused / drawn / cancelled
 * - 不可删：open（须先暂停或取消）、drawing（开奖中）
 * - 不 force 删 open/drawing；已开奖删会清候选/中奖行，订单与卡密交付保留
 */
export function describeDrawDeletePolicy(): {
  deletableStatuses: string[]
  nonDeletableStatuses: string[]
  notes: string[]
} {
  return {
    deletableStatuses: ['draft', 'paused', 'drawn', 'cancelled'],
    nonDeletableStatuses: ['open', 'drawing'],
    notes: [
      'open 须先 pause 或 cancel 再删',
      'drawing 不可删、不可取消',
      '删除级联 entries/winners/tiers 等；不默认 force 已履约',
    ],
  }
}

/** 已选活动元数据 CSV 行（含表头；测试排障/交接用，不含敏感参与者数据） */
export function buildSelectedDrawsCsvRows(
  draws: Array<{
    id?: string
    publicSlug?: string
    title?: string
    name?: string
    status?: string
    activityKind?: string
    visible?: number | null
    createdAt?: string
  }>,
): string[][] {
  return [
    ['id', 'publicSlug', 'title', 'status', 'activityKind', 'visible', 'createdAt'],
    ...draws.map((d) => [
      String(d.id || ''),
      String(d.publicSlug || ''),
      drawDisplayName(d),
      String(d.status || ''),
      String(d.activityKind || ''),
      isLotteryUserVisible(d.visible) ? '1' : '0',
      String(d.createdAt || ''),
    ]),
  ]
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
  const priority = ['prizes', 'basic', 'participation', 'activity_config', 'payment', 'promotion', 'webhook']
  const section = priority.find((s) => errors.some((e) => e.section === s)) || errors[0]?.section
  const idMap: Record<string, string> = {
    prizes: 'lottery-prizes',
    basic: 'lottery-basic',
    participation: 'lottery-mode',
    activity_config: 'activity-config',
    payment: 'lottery-advanced',  // 秒杀/直付配置在高级区
    promotion: 'lottery-advanced',
  }
  return section ? idMap[section] : undefined
}

/**
 * 活动是否需要奖项配置（壳层面 —— 奖档区可显示、saveDrawTiers 可调用、后端可保存）。
 *
 * 仅两类活动需要：
 * ① lottery（抽奖奖档）；② claim + flash_sale（直付秒杀绑定唯一卡密奖品）。
 * 其他活动（资料领取/问卷/报名/投票/签到/审核/预约）不需要奖项配置。
 *
 * 与后端 admin-lottery-draw-ops.ts 的 `isFlashSaleDirect` 判断一致。
 * 调用处：奖档区显示、saveDrawTiers 调用、后端保存（4 层统一）。
 */
export function needsTiersActivity(kind: string, experienceType: string): boolean {
  return kind === 'lottery' || (kind === 'claim' && experienceType === 'flash_sale')
}

/**
 * 活动是否必须配置奖项（强制层面 —— 创建步骤第 4 步强制检查、发布检查强制要求）。
 *
 * 在 needsTiersActivity 的基础上，额外要求直付秒杀必须启用并直付（enableFlashSale && paymentRequired），
 * 否则奖档可选但不强制（导流模式）。
 *
 * 与后端 publish-check 的 validateFlashSalePayment（paymentRequired 保护）一致。
 * 调用处：createStepDone 第 4 步、createReadinessLabel。
 */
export function needsTiersMandatory(
  kind: string,
  experienceType: string,
  enableFlashSale: boolean,
  paymentRequired: boolean,
): boolean {
  if (kind === 'lottery') return true
  if (kind === 'claim' && experienceType === 'flash_sale' && enableFlashSale && paymentRequired) return true
  return false
}

/**
 * 秒杀壳配置是否适用于当前（活动类型 × 体验类型）组合（2026-08 体验优化）。
 *
 * 为什么需要：切换活动类型/参与模式时，experienceType 会被重置为默认，但 enableFlashSale /
 * flashSalePaymentRequired 可能残留 true（如 lottery 开了秒杀壳后切到 survey）。
 * 残留会导致：
 * - 高级区仍显示秒杀配置，但活动语义不匹配；
 * - 提交 payload 带 flashSale.enabled=true → 后端发布预检（validateFlashSalePayment）要求
 *   绑定卡密奖品 + 配置支付渠道，而 survey/vote 等无法配置 → 发布卡死且运营困惑（交叉组合死角）。
 *
 * 秒杀壳合法组合：lottery + flash_sale（展示/导流壳，docs/130）、claim + flash_sale（直付发卡或导流）。
 * 其他组合一律视为不适用 → 联动清理秒杀开关。
 */
export function isFlashSaleApplicable(kind: string, experienceType: string): boolean {
  if (String(experienceType || '').trim() !== 'flash_sale') return false
  return kind === 'lottery' || kind === 'claim'
}
