/**
 * 模板差异字段契约：锁住高频模板的可见性白名单，防回归成「全量平铺」。
 */
import { describe, expect, it } from 'vitest'
import {
  FULL_EDITOR_FIELD_VISIBILITY,
  isFieldScopedTemplate,
  resolveEditorFieldVisibility,
  shouldAutoExpandAdvancedForTemplate,
} from './template-field-visibility'

describe('resolveEditorFieldVisibility', () => {
  it('空白 / 未知模板：全量可见', () => {
    expect(resolveEditorFieldVisibility('')).toEqual(FULL_EDITOR_FIELD_VISIBILITY)
    expect(resolveEditorFieldVisibility(null)).toEqual(FULL_EDITOR_FIELD_VISIBILITY)
    expect(resolveEditorFieldVisibility('survey-feedback')).toEqual(FULL_EDITOR_FIELD_VISIBILITY)
  })

  it('编辑已有活动：即使带 templateId 也全量（避免藏已开配置）', () => {
    expect(
      resolveEditorFieldVisibility('flash-sale-rush', { isEditing: true }),
    ).toEqual(FULL_EDITOR_FIELD_VISIBILITY)
    expect(
      resolveEditorFieldVisibility('lottery-wheel', { isEditing: true }),
    ).toEqual(FULL_EDITOR_FIELD_VISIBILITY)
  })

  it('大转盘：隐藏秒杀与 instant 专属字段，保留奖项与壳', () => {
    const v = resolveEditorFieldVisibility('lottery-wheel')
    expect(v.flashSale).toBe(false)
    expect(v.maxSpins).toBe(false)
    expect(v.instantWeight).toBe(false)
    expect(v.tiers).toBe(true)
    expect(v.prizeShell).toBe(true)
    expect(v.viral).toBe(true)
    expect(v.productLink).toBe(true)
  })

  it('即时大转盘：展示 maxSpins + weight，仍隐藏秒杀', () => {
    const v = resolveEditorFieldVisibility('lottery-wheel-instant')
    expect(v.flashSale).toBe(false)
    expect(v.maxSpins).toBe(true)
    expect(v.instantWeight).toBe(true)
    expect(v.tiers).toBe(true)
  })

  it('限时抢购：展示秒杀、商品、卡密奖档和社交传播，隐藏奖项壳/安慰奖', () => {
    const v = resolveEditorFieldVisibility('flash-sale-rush')
    expect(v.flashSale).toBe(true)
    expect(v.productLink).toBe(true)
    expect(v.cta).toBe(true)
    expect(v.prizeShell).toBe(false)
    // 直付秒杀必须绑定唯一卡密奖品，隐藏奖档会让用户无法通过发布预检。
    expect(v.tiers).toBe(true)
    // 9f0bc7f：秒杀邀请配置改为「社交传播」后 viral 保留可见（不影响购买优先级）
    expect(v.viral).toBe(true)
    expect(v.loserReward).toBe(false)
    expect(v.experienceType).toBe(false)
  })
})

describe('shouldAutoExpandAdvancedForTemplate', () => {
  it('限时抢购自动展开高级区；大转盘不展开', () => {
    expect(shouldAutoExpandAdvancedForTemplate('flash-sale-rush')).toBe(true)
    expect(shouldAutoExpandAdvancedForTemplate('lottery-wheel')).toBe(false)
    expect(shouldAutoExpandAdvancedForTemplate('')).toBe(false)
  })
})

describe('isFieldScopedTemplate', () => {
  it('仅高频三模板为 scoped', () => {
    expect(isFieldScopedTemplate('lottery-wheel')).toBe(true)
    expect(isFieldScopedTemplate('lottery-wheel-instant')).toBe(true)
    expect(isFieldScopedTemplate('flash-sale-rush')).toBe(true)
    expect(isFieldScopedTemplate('signup-chain')).toBe(false)
  })
})
