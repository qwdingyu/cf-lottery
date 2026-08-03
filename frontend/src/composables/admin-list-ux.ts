/**
 * 管理端列表行内主操作启发式（纯函数，可 vitest）。
 *
 * 上线前 UX（docs/074）：
 * - 进行中抽奖：运营主任务是「分享链接」，不是「立即开奖」
 * - 无参与者时禁用/降级开奖，减少空池误操作
 */

/** 是否应把「复制链接」作为 open 抽奖行的主按钮 */
export function shouldPrioritizeShareForOpenLottery(entryCount: number | null | undefined): boolean {
  // 始终优先分享；entryCount 只影响开奖是否可点
  void entryCount
  return true
}

/** 立即开奖按钮是否应可点（有参与才有意义） */
export function canEnableDrawNow(entryCount: number | null | undefined): boolean {
  return Number(entryCount) > 0
}

/**
 * Onboarding 成功后落地路径（少一次运营台空态点击）。
 * AdminLotteryView 识别 query.new=true 打开模板选择。
 */
export function onboardingSuccessPath(): { path: string; query: { new: string } } {
  return { path: "/admin/draws", query: { new: "true" } }
}
