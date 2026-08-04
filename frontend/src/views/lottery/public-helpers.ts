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
