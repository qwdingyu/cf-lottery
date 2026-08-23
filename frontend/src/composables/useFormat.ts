/**
 * 格式化工具：日期时间 + 管理端错误/批量 toast 兼容 re-export。
 *
 * docs/123：AdminLotteryView 从本模块 import toErrorMessage / resolveBatchToastType。
 * 必须从 `@usethink/cf-admin-fe/utils` re-export（纯 TS），勿从包根入口引入——
 * 根入口会连带 export .vue 组件，vitest 无 plugin-vue 时 ops-utils 等纯函数测试会炸。
 * 勿在本文件复制实现，避免与 kit 分叉。
 */
export { toErrorMessage, resolveBatchToastType } from '@usethink/cf-admin-fe/utils'

/** 格式化 ISO 时间为本地可读字符串 */
export function formatDate(iso?: string | null): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 解析为"东八区视角"的时间戳（formatDateCST 的解析核心，独立导出便于单测）。
 *
 * API 返回的时间字符串存在三种格式（历史原因，语义不同）：
 * 1. "YYYY-MM-DD HH:MM:SS" —— SQLite datetime('now') 生成，UTC 语义，无时区标记
 * 2. "YYYY-MM-DDTHH:mm(:ss)?" —— 管理端 datetime-local 输入，运营者按东八时间录入
 * 3. ISO 8601 带时区（结尾 Z 或 ±HH:mm）—— 标准格式
 *
 * 无时区字符串若直接 new Date() 会按浏览器本地时区解释：
 * 东八浏览器会把后端 UTC 时间（格式 1）当作本地时间，展示偏 8 小时，
 * "统一东八区"的目标就失效了。因此按来源格式显式补时区后再返回，
 * 交给 toLocaleString(timeZone: 'Asia/Shanghai') 统一展示。
 */
export function toCSTDate(iso: string): Date {
  // 已带时区信息（结尾 Z 或 ±HH:mm）→ 标准解析，不补时区
  if (/[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso)
  // SQLite UTC 格式 "YYYY-MM-DD HH:MM:SS"（空格分隔、无 T）→ 按 UTC 解释
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(iso)) return new Date(`${iso.replace(' ', 'T')}Z`)
  // 无时区 ISO（datetime-local 输入 "YYYY-MM-DDTHH:mm"）→ 运营者以东八时间录入，补 +08:00
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return new Date(`${iso}+08:00`)
  return new Date(iso)
}

/** 统一：ISO 时间按东八区（Asia/Shanghai）展示，避免浏览器时区差异 */
export function formatDateCST(iso?: string | null, locale: string | undefined = 'zh-CN'): string {
  if (!iso) return '-'
  const date = toCSTDate(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale || 'zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** ISO → datetime-local 输入值 */
export function toDateTimeLocalValue(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** datetime-local 输入值 → ISO */
export function dateTimeLocalToIso(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** ISO → datetime-local（与 toDateTimeLocalValue 等价） */
export function isoToDateTimeLocal(iso?: string | null): string {
  return toDateTimeLocalValue(iso)
}
