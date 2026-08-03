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

/** 按活动类型 + 参与模式选默认体验；非 lottery 类型优先类型语义 */
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
