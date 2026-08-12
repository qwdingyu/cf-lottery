/**
 * 奖项配置规则单元测试（docs/212 条件组合矩阵）
 *
 * 覆盖 needsTiersActivity（壳层面：奖档区可显示/可保存）与
 * needsTiersMandatory（强制层面：创建步骤/发布检查必须绑定卡密奖品）。
 * 保证前端 4 层判断（奖档区显示/saveDrawTiers/创建步骤/发布清单）与后端保持一致。
 */
import { describe, expect, it } from 'vitest'
import { needsTiersActivity, needsTiersMandatory } from './ops-utils'

describe('needsTiersActivity（壳层面：奖档区可显示/可保存）', () => {
  it('lottery 任意体验都需要奖项', () => {
    expect(needsTiersActivity('lottery', 'wheel')).toBe(true)
    expect(needsTiersActivity('lottery', 'scratch')).toBe(true)
    expect(needsTiersActivity('lottery', '')).toBe(true)
  })

  it('claim + flash_sale（直付秒杀）需要奖项', () => {
    expect(needsTiersActivity('claim', 'flash_sale')).toBe(true)
  })

  it('claim + reveal（资料领取/领券）不需要奖项', () => {
    expect(needsTiersActivity('claim', 'reveal')).toBe(false)
  })

  it('claim + 其他体验不需要奖项', () => {
    expect(needsTiersActivity('claim', 'submit')).toBe(false)
    expect(needsTiersActivity('claim', '')).toBe(false)
  })

  it('其他活动类型不需要奖项', () => {
    expect(needsTiersActivity('signup_chain', 'list')).toBe(false)
    expect(needsTiersActivity('survey', 'form')).toBe(false)
    expect(needsTiersActivity('vote', 'ballot')).toBe(false)
    expect(needsTiersActivity('checkin', 'submit')).toBe(false)
    expect(needsTiersActivity('approval', 'form')).toBe(false)
    expect(needsTiersActivity('reservation', 'calendar')).toBe(false)
  })
})

describe('needsTiersMandatory（强制层面：必须配置奖项）', () => {
  it('lottery 必须配置奖项', () => {
    expect(needsTiersMandatory('lottery', 'wheel', false, false)).toBe(true)
    expect(needsTiersMandatory('lottery', 'scratch', true, false)).toBe(true)
  })

  it('直付秒杀（claim + flash_sale + 启用 + 直付）必须配置奖项', () => {
    expect(needsTiersMandatory('claim', 'flash_sale', true, true)).toBe(true)
  })

  it('导流模式（非直付）不强制奖项', () => {
    expect(needsTiersMandatory('claim', 'flash_sale', true, false)).toBe(false)
  })

  it('未启用秒杀不强制奖项', () => {
    expect(needsTiersMandatory('claim', 'flash_sale', false, true)).toBe(false)
    expect(needsTiersMandatory('claim', 'flash_sale', false, false)).toBe(false)
  })

  it('资料领取（claim + reveal）不强制奖项', () => {
    expect(needsTiersMandatory('claim', 'reveal', true, true)).toBe(false)
  })

  it('其他活动类型不强制奖项', () => {
    expect(needsTiersMandatory('signup_chain', 'list', false, false)).toBe(false)
    expect(needsTiersMandatory('survey', 'form', true, true)).toBe(false)
  })
})