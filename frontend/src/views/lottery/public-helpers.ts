/**
 * 公开页抽奖纯辅助。
 *
 * 为什么独立：类型归一化、氛围时长、CTA 协议白名单等不依赖 Vue 实例，
 * 从 LotteryView 抽出可减负且可单测；交互态（submissionDrafts）仍留在页面编排层。
 */
import { defaultExperienceForParticipation } from '@/lib/activity-defaults'
import type { LotteryDraw } from './types'

export { defaultExperienceForParticipation }

/**
 * 参与成功后氛围动画时长（ms）：先让用户看见游戏反馈，再出结果弹窗。
 * 时长与组件内 celebrate 动画大致对齐；无长动画的体验立即弹窗。动画仍不表示开奖结果。
 */
export function ambienceMsForExperience(
  experienceType: string | undefined,
  participationMode: string | undefined,
): number {
  const exp = String(
    experienceType || defaultExperienceForParticipation(participationMode || 'open'),
  ).toLowerCase()
  if (exp === 'wheel') return 3000
  if (exp === 'slot') return 2000
  if (exp === 'grid' || exp === 'card' || exp === 'scratch') return 700
  return 0
}

/**
 * 解析有效体验类型（未配置时与 GameRegistry / 默认体验一致）。
 */
export function resolveExperienceType(
  experienceType: string | undefined,
  participationMode: string | undefined,
): string {
  return String(
    experienceType || defaultExperienceForParticipation(participationMode || 'open'),
  )
    .trim()
    .toLowerCase()
}

/**
 * 有游戏壳时底部提示文案的 i18n key（按体验细分，避免「点转盘」套在老虎机上）。
 * 返回 lottery.* 下的 key 名（不含 lottery. 前缀由调用方拼）。
 */
export function gamePrimaryCtaHintKey(
  experienceType: string | undefined,
  participationMode: string | undefined,
): string {
  const exp = resolveExperienceType(experienceType, participationMode)
  if (exp === 'wheel') return 'gamePrimaryCtaHintWheel'
  if (exp === 'slot') return 'gamePrimaryCtaHintSlot'
  if (exp === 'scratch') return 'gamePrimaryCtaHintScratch'
  if (exp === 'card') return 'gamePrimaryCtaHintCard'
  if (exp === 'grid') return 'gamePrimaryCtaHintGrid'
  if (exp === 'form' || exp === 'ballot') return 'gamePrimaryCtaHintForm'
  if (exp === 'reveal') return 'gamePrimaryCtaHintReveal'
  // list/queue/calendar/checkin/submit 等 → 一键提交壳
  if (
    exp === 'submit' ||
    exp === 'list' ||
    exp === 'queue' ||
    exp === 'calendar' ||
    exp === 'checkin'
  ) {
    return 'gamePrimaryCtaHintSubmit'
  }
  return 'gamePrimaryCtaHint'
}

export function requiresActivitySubmission(draw: LotteryDraw): boolean {
  return draw.activityConfig?.kind === 'survey' || draw.activityConfig?.kind === 'vote'
}

/** 规范化公开活动 payload：后端 id=publicSlug；title→name；showWinnerList→showWinners */
export function normalizePublicDraw(raw: any, routeSlug?: string): LotteryDraw {
  const publicSlug = String(raw.publicSlug || routeSlug || raw.id || '').trim()
  const title = String(raw.title || raw.name || '').trim()
  return {
    ...raw,
    id: publicSlug || String(raw.id || ''),
    publicSlug: publicSlug || undefined,
    title,
    name: title || raw.name,
    // 公开 API 用 showWinnerList 数值；UI 用 showWinners 布尔
    showWinners:
      raw.showWinners != null ? Boolean(raw.showWinners) : Number(raw.showWinnerList) === 1,
    entryCount: raw.entryCount != null ? raw.entryCount : raw.participantCount,
  } as LotteryDraw
}

/**
 * 从活动 promotionConfig 中提取指定状态的 CTA 配置。
 *
 * 安全：只返回 http/https 协议的外部链接。
 * 纵深防御：后端发布校验（publish-check）已拦截危险协议，这里再兜底一次，
 * 防止历史数据或配置被绕过时 `<a href>` 渲染 javascript: 等危险协议。
 */
/**
 * 「邀请更多人参与 / 分享好运」是否应展示。
 *
 * 裂变与邀请只在活动仍可参与（或未终态）时有意义；
 * 已开奖 / 已取消后再推邀请链接是错误产品语义（docs/103）。
 *
 * @param drawStatus 活动 status：open / drawn / cancelled …
 * @returns false 表示必须隐藏邀请分享 CTA
 */
export function shouldShowInviteShareCta(drawStatus: string | null | undefined): boolean {
  const st = String(drawStatus || '').trim().toLowerCase()
  if (st === 'drawn' || st === 'cancelled' || st === 'closed') return false
  // 未知状态：偏参与成功路径（常不带 status），允许分享
  return true
}

/**
 * 是否「抽奖结果族」活动（lottery / claim）。
 * 用于列表「未中奖」标签、已结束横幅等——禁止接龙/问卷仅因 status=drawn 套中奖语义（docs/104）。
 */
export function isLotteryResultFamilyKind(activityKind: string | null | undefined): boolean {
  const kind = String(activityKind || '')
    .trim()
    .toLowerCase()
  return kind === 'lottery' || kind === 'claim'
}

/**
 * 「我的记录」行是否展示「未中奖」。
 * 仅：未标记中奖 + status=drawn + 玩法为 lottery/claim。
 * activityKind 缺失时不标「未中奖」（保守，避免非抽奖误伤）。
 */
export function shouldShowNotWonRecordTag(input: {
  drawStatus?: string | null
  activityKind?: string | null
  won?: boolean
}): boolean {
  if (input.won) return false
  const st = String(input.drawStatus || '')
    .trim()
    .toLowerCase()
  if (st !== 'drawn') return false
  return isLotteryResultFamilyKind(input.activityKind)
}

/**
 * 活动已 ended/drawn 时横幅 i18n key（lottery.*）。
 * 抽奖族可说「是否中奖」；其它玩法只说「查询结果」（docs/104）。
 */
export function statusHintDrawnI18nKey(activityKind?: string | null): string {
  if (isLotteryResultFamilyKind(activityKind) || !String(activityKind || '').trim()) {
    // 缺 kind 时公开页多为抽奖深链；仍用抽奖文案。记录列表另走 shouldShowNotWonRecordTag 保守策略。
    return 'statusHintDrawn'
  }
  return 'statusHintDrawnGeneric'
}

/**
 * drawing 状态横幅 key：仅抽奖族说「正在开奖」；其它说中性「结果处理中」（docs/105）。
 */
export function statusHintDrawingI18nKey(activityKind?: string | null): string {
  if (isLotteryResultFamilyKind(activityKind) || !String(activityKind || '').trim()) {
    return 'statusHintDrawing'
  }
  return 'statusHintDrawingGeneric'
}

/**
 * 卡片角标 status 短标签 key（lottery.*）。
 * drawing 仅抽奖族用「开奖中」；其它玩法用「处理中」（docs/106）。
 * 其它 status 与玩法无关。
 */
export function publicStatusTagI18nKey(
  status: string | null | undefined,
  activityKind?: string | null,
): string {
  const s = String(status || '')
    .trim()
    .toLowerCase()
  if (s === 'drawing') {
    if (isLotteryResultFamilyKind(activityKind) || !String(activityKind || '').trim()) {
      return 'statusDrawing'
    }
    return 'statusDrawingTagGeneric'
  }
  const map: Record<string, string> = {
    draft: 'adminDrawDraft',
    open: 'statusOpen',
    paused: 'statusPaused',
    drawn: 'ended',
    cancelled: 'adminDrawCancelled',
  }
  return map[s] || ''
}

/**
 * 公开页 result_mode 短标签 key。
 * scheduled/manual 不再写死「开奖」——非抽奖同样可能用这两种 result_mode（docs/106）。
 */
export function resultModeTagI18nKey(resultMode: string | null | undefined): string {
  const mode = String(resultMode || '')
    .trim()
    .toLowerCase()
  if (mode === 'instant') return 'resultModeInstantTag'
  if (mode === 'scheduled') return 'resultModeScheduledTag'
  if (mode === 'manual') return 'resultModeManualTag'
  if (mode === 'no_result') return 'adminResultNoResult'
  if (mode === 'vote_tally') return 'adminResultVoteTally'
  if (mode === 'ordered_assignment' || mode === 'capacity_assignment') {
    return 'adminResultOrdered'
  }
  if (mode === 'review_decision') return 'adminResultReview'
  return ''
}

/**
 * 即时出结果后的说明文案 key。
 * 邀请 CTA 由 shouldShowInviteShareCta 单独门禁；此处 hint **永不**鼓动「邀请好友」（docs/103/104）。
 */
export function joinResultHintInstantDoneI18nKey(): string {
  return 'joinResultHintInstantDone'
}

export function getResultCta(
  draw: LotteryDraw | null,
  key: 'after_win' | 'after_loss',
): { url: string; title: string } | null {
  if (!draw) return null
  const pc = (draw as any)?.promotionConfig
  const cta = pc?.ctas?.[key]
  if (!cta?.url) return null
  // 协议白名单：仅 http/https，防止 javascript:/data: 等危险协议
  try {
    const parsed = new URL(cta.url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch {
    return null // 非法 URL 不渲染，避免坏链接和注入
  }
  return { url: cta.url, title: cta.title || '' }
}
