/**
 * 活动创建/运行时通用判断工具（docs/212 衍生）。
 *
 * 封装重复判断模式，避免多处散布同一条件（如 resultMode 是否 instant、体验是否 flash_sale）。
 * 全量替换后，新增判断条件只需改此文件，无需改 10+ 处调用方。
 */

/**
 * 结果模式是否为 instant（即时——结果当场产生，无需定时开奖）。
 *
 * 防御式空安全处理（trim + toLowerCase），与 prize-shell-display 的
 * isInstantLotteryResultMode 实现一致，但定位为公共函数供全项目使用。
 * 调用处：routes/ 与 services/ 共 20+ 处，统一替换为 isInstantResultMode(draw.resultMode)。
 */
export function isInstantResultMode(resultMode: string | null | undefined): boolean {
  return String(resultMode || "").trim().toLowerCase() === "instant";
}

/**
 * 体验类型是否为 flash_sale（直付秒杀壳）。
 *
 * 配合 needsTiersActivity（前端 ops-utils）与后端 admin-lottery-draw-ops.ts 的
 * isFlashSaleDirect 判断，统一全项目对 flash_sale 体验的识别方式。
 */
export function isFlashSaleExperience(experienceType: string | null | undefined): boolean {
  return String(experienceType || "").trim() === "flash_sale";
}

/**
 * 仅按参与模式给抽奖类体验的默认（open→转盘等）。
 *
 * 收敛点（P2 审查项）：旧实现分别在 src/services/lottery/draws.ts 与
 * src/routes/admin-lottery-helpers.ts 各写一份（逐字重复），新增活动类型需改两处、易漂移。
 * 现统一收口到本文件，draws.ts / admin-lottery-helpers.ts 均从此引用。
 */
export function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

/**
 * 按活动类型 + 参与模式选默认体验；非 lottery 类型优先类型语义。
 */
export function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === "signup_chain") return "list";
  if (activityKind === "reservation") return "calendar";
  if (activityKind === "vote") return "ballot";
  if (activityKind === "survey") return "form";
  if (activityKind === "checkin") return "checkin";
  if (activityKind === "waitlist") return "queue";
  if (activityKind === "approval") return "form";
  if (activityKind === "claim") return "reveal";
  return defaultExperienceForParticipation(participationMode);
}

/**
 * 根据活动类型和开奖触发方式计算默认结果模式。
 *
 * 这是活动引擎的规则入口：不同 activity_kind 对应不同的结果分配方式。
 * 抽奖类默认 manual（管理员手动开奖）或 scheduled（定时开奖）；
 * 接龙类默认 ordered_assignment（按报名顺序分配）；
 * 问卷/签到类默认 no_result（无结果分配）。
 *
 * 收敛点（P2 审查项）：与 defaultExperienceForActivity 同批收敛到本文件，
 * 消除 draws.ts 私有定义与 admin-lottery-helpers.ts 导出定义的双份维护。
 */
export function defaultResultModeForActivity(activityKind: string, drawTrigger: string): string {
  if (activityKind === "signup_chain") return "ordered_assignment";
  if (activityKind === "reservation") return "capacity_assignment";
  if (activityKind === "vote") return "vote_tally";
  if (activityKind === "survey") return "no_result";
  if (activityKind === "checkin") return "no_result";
  if (activityKind === "waitlist") return "ordered_assignment";
  if (activityKind === "approval") return "review_decision";
  if (activityKind === "claim") return "instant";
  if (activityKind === "assignment") return "ordered_assignment";
  return drawTrigger === "scheduled" ? "scheduled" : "manual";
}