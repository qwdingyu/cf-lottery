import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORDER_DETAIL_SECTION_ID,
  ORDER_DETAIL_SECTIONS,
  resolveOrderDetailSectionId,
} from './order-detail-sections'

const ordersSource = readFileSync(new URL('./AdminOrdersView.vue', import.meta.url), 'utf8')

describe('order detail section mapping', () => {
  it('lists three tabs with summary default and legacy id aliases', () => {
    expect(ORDER_DETAIL_SECTIONS.map((s) => s.id)).toEqual([
      'summary',
      'fulfillment',
      'events',
    ])
    expect(DEFAULT_ORDER_DETAIL_SECTION_ID).toBe('summary')
    expect(resolveOrderDetailSectionId(undefined)).toBe('summary')
    expect(resolveOrderDetailSectionId('')).toBe('summary')
    expect(resolveOrderDetailSectionId('fulfillment')).toBe('fulfillment')
    expect(resolveOrderDetailSectionId('events')).toBe('events')
    expect(resolveOrderDetailSectionId('nope')).toBe('summary')
    // 旧 6-Tab id 回落
    expect(resolveOrderDetailSectionId('overview')).toBe('summary')
    expect(resolveOrderDetailSectionId('source')).toBe('summary')
    expect(resolveOrderDetailSectionId('buyer')).toBe('summary')
    expect(resolveOrderDetailSectionId('delivery')).toBe('fulfillment')
    expect(resolveOrderDetailSectionId('referral')).toBe('fulfillment')
  })
})

describe('AdminOrdersView order detail tab UI contract', () => {
  it('uses section mapping and top tablist like system config', () => {
    expect(ordersSource).toContain("from './order-detail-sections'")
    expect(ordersSource).toContain('ORDER_DETAIL_SECTIONS')
    expect(ordersSource).toContain('resolveOrderDetailSectionId')
    expect(ordersSource).toContain('detailSection')
    expect(ordersSource).toContain('role="tablist"')
    expect(ordersSource).toContain("$t('adminOrders.detailSectionLabel')")
    expect(ordersSource).toContain('order-detail-section-tabs')
    expect(ordersSource).toContain('order-detail-scroll')
    expect(ordersSource).toContain('selectOrderDetailSection')
    // 固定高度，避免内容少时弹窗变矮
    expect(ordersSource).toMatch(/\.order-detail-box\s*\{[\s\S]*?height:\s*min\(/)
  })

  it('keeps L1 / deliveryVisibility / actions across three tabs', () => {
    expect(ordersSource).toContain("detailSection === 'fulfillment'")
    expect(ordersSource).toContain("detailSection === 'summary'")
    expect(ordersSource).toContain("detailSection === 'events'")
    expect(ordersSource).toContain('deliveryVisibilityText')
    expect(ordersSource).toContain("$t('adminOrders.detailMarkRefunded')")
    expect(ordersSource).toContain('order-detail-actions')
    expect(ordersSource).toContain('order-detail-chrome')
    expect(ordersSource).toContain('order-detail-panel-fulfillment')
  })

  it('resets detail tab to summary when opening an order', () => {
    expect(ordersSource).toContain('detailSection.value = DEFAULT_ORDER_DETAIL_SECTION_ID')
    expect(ordersSource).toContain('resetOrderDetailScroll')
  })
})
