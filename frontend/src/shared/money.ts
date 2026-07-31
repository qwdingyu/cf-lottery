/** 格式化金额（分 → 元），简单的除以 100 */
export function formatMoney(cents: number, currency?: string): string {
  const major = (cents / 100).toFixed(2)
  return currency === 'CNY' ? `¥${major}` : `${currency || ''}${major}`
}

export function minorToMajorString(cents: number, currency?: string): string {
  return formatMoney(cents, currency)
}

export function parseMajorToMinor(value: string): number {
  return Math.round(parseFloat(value) * 100)
}
