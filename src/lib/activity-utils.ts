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