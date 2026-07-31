/**
 * 订单详情弹窗顶栏分区（对齐系统配置：Tab + 可滚动内容；仅前端映射，不改 API）。
 *
 * 设计取舍（相对早期 6 Tab）：
 * - 3 Tab 足够降低纵向堆叠，又不把客服常用字段拆得过碎
 * - 顶栏/底栏固定，中间固定高度滚动，避免内容少时弹窗「越来越矮」
 */
export type OrderDetailSectionId =
  | 'summary'
  | 'fulfillment'
  | 'events'

export type OrderDetailSectionDef = {
  id: OrderDetailSectionId
  label: string
  /** 分区一句话说明 */
  description: string
}

export const ORDER_DETAIL_SECTIONS: readonly OrderDetailSectionDef[] = [
  {
    id: 'summary',
    label: '概要',
    description: '交易主事实、买家与来源归因。',
  },
  {
    id: 'fulfillment',
    label: '履约',
    description: '明细、交付内容、卡密与 L1 佣金台账。',
  },
  {
    id: 'events',
    label: '事件',
    description: '订单事件时间线（最近 50 条）。',
  },
] as const

export const DEFAULT_ORDER_DETAIL_SECTION_ID: OrderDetailSectionId = 'summary'

/** 旧 6-Tab id → 新 3-Tab（防御性回落，避免缓存/书签态落到非法 id） */
const LEGACY_SECTION_ALIASES: Record<string, OrderDetailSectionId> = {
  overview: 'summary',
  source: 'summary',
  buyer: 'summary',
  delivery: 'fulfillment',
  referral: 'fulfillment',
}

const sectionIdSet = new Set<string>(ORDER_DETAIL_SECTIONS.map((s) => s.id))

/** 非法或空 → 默认概要；兼容旧分区 id */
export function resolveOrderDetailSectionId(raw: unknown): OrderDetailSectionId {
  if (typeof raw !== 'string') return DEFAULT_ORDER_DETAIL_SECTION_ID
  const id = raw.trim()
  if (sectionIdSet.has(id)) return id as OrderDetailSectionId
  if (LEGACY_SECTION_ALIASES[id]) return LEGACY_SECTION_ALIASES[id]!
  return DEFAULT_ORDER_DETAIL_SECTION_ID
}

export function getOrderDetailSection(id: OrderDetailSectionId): OrderDetailSectionDef {
  const found = ORDER_DETAIL_SECTIONS.find((s) => s.id === id)
  return found ?? ORDER_DETAIL_SECTIONS[0]!
}
