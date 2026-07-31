export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: '待支付', paid: '已支付', issued: '已发卡',
  expired: '已过期', closed: '已关闭', failed: '失败', cancelled: '已取消', refunded: '已退款',
}
export function normalizeOrderStatus(status: string): string { return status }
export function orderStatusLabel(status: string): string { return ORDER_STATUS_LABELS[status] || status }
