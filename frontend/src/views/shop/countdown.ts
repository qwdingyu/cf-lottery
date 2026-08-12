/**
 * 秒杀倒计时纯函数（docs/205）
 *
 * 职责：格式化剩余毫秒数，不依赖 Vue 运行时，可测试。
 */

/**
 * 将毫秒数拆分为天、时、分、秒。
 */
export function countdownParts(ms: number): { days: number; hours: number; minutes: number; seconds: number } {
  if (!Number.isFinite(ms) || ms < 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 }
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  return { days, hours, minutes, seconds }
}

/**
 * 格式化秒杀倒计时文本。
 * - 剩余 > 1 天：`2天 15:30:45`
 * - 剩余 <= 1 天：`15:30:45`
 * - 已结束/无时间：空字符串
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const { days, hours, minutes, seconds } = countdownParts(ms)
  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  if (days > 0) {
    return `${days}天 ${hh}:${mm}:${ss}`
  }
  return `${hh}:${mm}:${ss}`
}

/**
 * 格式化活动结束时间（绝对时间，不含日期）。
 * 输入 ISO 8601 字符串，输出 `HH:mm`。
 */
export function formatEndTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}