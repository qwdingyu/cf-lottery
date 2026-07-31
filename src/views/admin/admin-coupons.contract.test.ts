import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viewSource = readFileSync(new URL('./AdminCouponsView.vue', import.meta.url), 'utf8')
const adminRouteSource = readFileSync(new URL('../../../../src/routes/admin.ts', import.meta.url), 'utf8')

describe('admin coupons V-013 maxUses=0 contract', () => {
  it('openEdit preserves maxUses=0 (unlimited) instead of coercing with || 1', () => {
    expect(viewSource).toContain('function openEdit')
    expect(viewSource).toContain('Number.isFinite(Number(item.maxUses)) ? Number(item.maxUses) : 1')
    // 禁止把 0 静默改成 1 的旧写法
    expect(viewSource).not.toMatch(/maxUses:\s*item\.maxUses\s*\|\|\s*1/)
  })

  it('lists unlimited coupons with explicit 不限 warning tag', () => {
    expect(viewSource).toContain('!item.maxUses')
    expect(viewSource).toContain("$t('adminCoupons.unlimited')")
    expect(viewSource).toContain('tag-warning')
    expect(viewSource).toContain("$t('adminCoupons.hintMaxUses')")
  })

  it('form and generate inputs allow 0 and document secondary confirm', () => {
    expect(viewSource).toMatch(/v-model\.number="form\.maxUses"[\s\S]*?min="0"/)
    expect(viewSource).toMatch(/v-model\.number="genForm\.maxUses"[\s\S]*?min="0"/)
    expect(viewSource).toContain("$t('adminCoupons.hintMaxUsesGenerate')")
  })

  it('validateCouponForm requires confirm when maxUses===0 and couponPayload keeps 0', () => {
    expect(viewSource).toContain('async function validateCouponForm')
    expect(viewSource).toContain('maxUses === 0')
    expect(viewSource).toContain('askConfirm')
    expect(viewSource).toContain("$t('adminCoupons.unlimited')")
    expect(viewSource).toContain('function couponPayload')
    expect(viewSource).toContain('Number.isInteger(maxUses) && maxUses >= 0 ? maxUses : 1')
  })

  it('CSV export serializes maxUses=0 as "0" not empty string', () => {
    expect(viewSource).toContain('exportSelectedCodes')
    expect(viewSource).toContain('Number.isFinite(Number(item.maxUses)) ? Number(item.maxUses) : \'\'')
    // 禁止 maxUses || '' 把 0 抹掉
    expect(viewSource).not.toMatch(/String\(item\.maxUses\s*\|\|\s*['"]['"]\)/)
  })

  it('API coupon schemas default omitted maxUses to 1, still allow explicit 0', () => {
    // 创建 / 批量生成：缺省 1；显式 0 仍合法
    expect(adminRouteSource).toMatch(/maxUses:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(100000\)\.default\(1\)/)
    expect(adminRouteSource).toContain('缺省字段默认 1')
    // 不得再把 API 缺省设为 0（漏传即无限）
    expect(adminRouteSource).not.toMatch(/maxUses:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(100000\)\.default\(0\)/)
  })
})
