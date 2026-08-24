/**
 * 活动三维默认值（前端共享）。
 *
 * 为什么抽到 lib：Admin 创建表单与公开页 GameRegistry 都要同一套默认体验/结果模式，
 * 避免两处各写一份后「后台默认 wheel、前台却 submit」的漂移。
 *
 * 注意：participation_mode / experience_type / result_mode 是独立维度，不能互相推导成唯一真相；
 * 这里只提供「未显式配置时」的合理默认。
 */

/** 仅按参与模式给抽奖类体验的默认（open→转盘等） */
export function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === 'invite_code') return 'slot'
  if (participationMode === 'password') return 'scratch'
  if (participationMode === 'roster') return 'card'
  return 'wheel'
}

/**
 * 按活动类型 + 参与模式选默认体验；非 lottery 类型优先类型语义。
 * 取值须能被 GameRegistry 解析（含 list/queue 等别名 → Submit/Form），
 * 避免公开页「有活动无主 CTA 壳」（docs/096）。
 */
export function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === 'signup_chain') return 'list'
  if (activityKind === 'reservation') return 'calendar'
  if (activityKind === 'vote') return 'ballot'
  if (activityKind === 'survey') return 'form'
  if (activityKind === 'checkin') return 'checkin'
  if (activityKind === 'waitlist') return 'queue'
  if (activityKind === 'approval') return 'form'
  if (activityKind === 'claim') return 'reveal'
  return defaultExperienceForParticipation(participationMode)
}

/**
 * 活动类型（activityKind）允许的体验类型（experienceType）白名单。
 *
 * 与后端 src/lib/activity-utils.ts 中的 ALLOWED_EXPERIENCE_TYPES 保持同步。
 * 前端据此过滤 experienceType 下拉框选项，防止语义不匹配的组合。
 */
export const ALLOWED_EXPERIENCE_TYPES: Record<string, readonly string[]> = {
  lottery:       ['wheel', 'slot', 'scratch', 'card', 'grid', 'flash_sale'],
  signup_chain:  ['list', 'submit'],
  reservation:   ['calendar', 'submit'],
  vote:          ['ballot', 'form', 'submit'],
  survey:        ['form', 'submit'],
  checkin:       ['checkin', 'submit'],
  waitlist:      ['queue', 'submit'],
  approval:      ['form', 'submit'],
  claim:         ['reveal', 'flash_sale'],
}

/**
 * 校验 activityKind + experienceType 组合是否合法。
 * 未知 activityKind 时放行（防御式，避免阻断未来新增类型）。
 */
export function isValidExperienceForActivity(activityKind: string, experienceType: string): boolean {
  const allowed = ALLOWED_EXPERIENCE_TYPES[activityKind]
  if (!allowed) return true
  return allowed.includes(experienceType)
}

/** 按活动类型选默认结果模式（何时/如何产生结果） */
export function defaultResultModeForActivity(activityKind: string): string {
  if (activityKind === 'signup_chain') return 'ordered_assignment'
  if (activityKind === 'reservation') return 'capacity_assignment'
  if (activityKind === 'vote') return 'vote_tally'
  if (activityKind === 'survey') return 'no_result'
  if (activityKind === 'checkin') return 'no_result'
  if (activityKind === 'waitlist') return 'ordered_assignment'
  if (activityKind === 'approval') return 'review_decision'
  if (activityKind === 'claim') return 'instant'
  return 'manual'
}

/**
 * 管理端「开奖时间」与后端 drawTrigger 对齐（docs/115 续审）。
 *
 * 证据：Cron / dashboard 到期列表只扫 `drawTrigger === 'scheduled'`；
 * 旧表单必填 drawTime 并写 drawAt，却不传 drawTrigger → 落库 manual → **到点不会自动开奖**。
 *
 * 规则：
 * - 显式 `manual` / `scheduled` 优先
 * - 仅 `activityKind=lottery` 且有 drawAt 时推断为 scheduled
 * - 非 lottery 即使有 drawAt 也保持 manual（避免问卷被 Cron 误开奖）
 */
export function resolveDrawTrigger(opts: {
  activityKind?: string | null
  drawAt?: string | null
  drawTrigger?: string | null
}): 'manual' | 'scheduled' {
  const explicit = String(opts.drawTrigger || '')
    .trim()
    .toLowerCase()
  if (explicit === 'scheduled' || explicit === 'manual') return explicit
  const kind = String(opts.activityKind || 'lottery').trim() || 'lottery'
  if (kind !== 'lottery') return 'manual'
  const hasDrawAt = Boolean(opts.drawAt && String(opts.drawAt).trim())
  return hasDrawAt ? 'scheduled' : 'manual'
}

/** lottery 的 resultMode 与 drawTrigger 对齐（公开文案 scheduled vs manual） */
export function resultModeForLotteryDrawTrigger(trigger: string): 'manual' | 'scheduled' {
  return trigger === 'scheduled' ? 'scheduled' : 'manual'
}
