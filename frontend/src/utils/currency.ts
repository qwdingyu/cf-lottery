/** 货币工具：分 ↔ 元 转换 */

/** 分 → 元字符串（保留两位小数） */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '0.00'
  return (cents / 100).toFixed(2)
}

/** 元字符串 → 分（整数） */
export function parseYuanToCents(yuan: string): number {
  if (!yuan.trim()) return 0
  const num = parseFloat(yuan)
  if (!Number.isFinite(num)) return 0
  return Math.round(num * 100)
}

/** 安全转换为整数分 */
export function normalizeCents(value: unknown): number {
  const cents = Number(value)
  return Number.isSafeInteger(cents) ? cents : 0
}
