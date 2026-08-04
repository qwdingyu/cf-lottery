/**
 * 管理端列表行内主操作启发式（纯函数，可 vitest）。
 *
 * 上线前 UX（docs/074–075）：
 * - 进行中抽奖：运营主任务是「分享链接」，不是「立即开奖」
 * - 无参与者时禁用/降级开奖，减少空池误操作
 * - 开启/创建后是否打开公开页：与 Confirm 勾选结果解耦，便于测
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

/** 开启/创建成功后确认框里「打开用户页」勾选项的 key */
export const OPEN_PUBLIC_PREVIEW_OPTION_KEY = "openPublic"

/**
 * 是否应打开公开页预览。
 * - 取消确认 → 否
 * - 无 options 映射（旧 askConfirm 路径）→ 确认即开
 * - 有 openPublic 键 → 以勾选为准（默认勾选时确认即开）
 */
export function shouldOpenPublicPreview(
  confirmed: boolean,
  options?: Record<string, boolean> | null,
  key: string = OPEN_PUBLIC_PREVIEW_OPTION_KEY,
): boolean {
  if (!confirmed) return false
  if (!options || !(key in options)) return true
  return options[key] === true
}

/**
 * 发布门禁失败后的列表行内短提示（避免运营反复点「开启」却只看到 toast）。
 * 只取首条 error message，截断防撑破表格。
 */
export function draftPublishBlockerSnippet(
  firstErrorMessage: string | null | undefined,
  maxLen = 48,
): string {
  const raw = String(firstErrorMessage || "").trim()
  if (!raw) return ""
  if (raw.length <= maxLen) return raw
  return `${raw.slice(0, Math.max(1, maxLen - 1))}…`
}
