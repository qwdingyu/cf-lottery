/**
 * 格式化工具：日期时间 + 管理端错误/批量 toast 兼容 re-export。
 *
 * docs/123：AdminLotteryView 从本模块 import toErrorMessage / resolveBatchToastType，
 * 实现在 @usethink/cf-admin-fe；此处 re-export 降低 import 噪音并保证 frontend:build 可解析。
 * 勿在本文件复制实现，避免与 kit 分叉。
 */
export { toErrorMessage, resolveBatchToastType } from '@usethink/cf-admin-fe'

/** 格式化 ISO 时间为本地可读字符串 */
export function formatDate(iso?: string | null): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
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
