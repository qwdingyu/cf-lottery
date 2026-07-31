import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_CONFIG_SECTION_ID,
  SYSTEM_CONFIG_SECTIONS,
  auditSystemConfigSectionCoverage,
  listedSystemConfigGroups,
  resolveSystemConfigSectionId,
} from './system-config-sections'

const definitionsPath = fileURLToPath(
  new URL('../../../../src/lib/system-config-definitions.json', import.meta.url),
)
const definitions = JSON.parse(readFileSync(definitionsPath, 'utf8')) as Array<{
  key: string
  group?: string
}>

const viewSource = readFileSync(new URL('./AdminSystemConfigView.vue', import.meta.url), 'utf8')
const paymentSource = readFileSync(new URL('./AdminPaymentView.vue', import.meta.url), 'utf8')

describe('system config section mapping (方案 A)', () => {
  it('covers every definition group/key exactly once', () => {
    const audit = auditSystemConfigSectionCoverage(definitions)
    expect(audit.unmappedGroups).toEqual([])
    expect(audit.unmappedKeys).toEqual([])
    expect(audit.duplicateGroups).toEqual([])
    expect(audit.extraGroupsInMap).toEqual([])
    expect(audit.ok).toBe(true)
    expect(audit.totalKeys).toBe(definitions.length)
    expect(audit.totalKeys).toBe(44)
    // 与设计文档一致的项数（防 silent 漂移）；分销含全员佣金模板 2 项，已无 partner 门户
    // referral 由 5 → 7：新增 referral_reward_allow_percent / referral_reward_max_percent
    expect(audit.sectionKeyCounts).toEqual({
      general: 2,
      payment: 7,
      security: 16,
      email: 5,
      referral: 7,
      ops: 7,
    })
  })

  it('lists six tabs and only ops includes danger zone', () => {
    expect(SYSTEM_CONFIG_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'payment',
      'security',
      'email',
      'referral',
      'ops',
    ])
    expect(SYSTEM_CONFIG_SECTIONS.filter((s) => s.includeDangerZone).map((s) => s.id)).toEqual(['ops'])
    expect(listedSystemConfigGroups()).toEqual([
      '基础信息',
      '支付配置',
      '安全与验证',
      '邮箱策略',
      '订单与限流',
      '后台与安全',
      '邮件服务',
      '库存预警',
      '分销与返佣',
      '数据保留与清理',
    ])
  })

  it('resolves tab query safely and never defaults to ops', () => {
    expect(resolveSystemConfigSectionId(undefined)).toBe(DEFAULT_SYSTEM_CONFIG_SECTION_ID)
    expect(resolveSystemConfigSectionId('')).toBe('general')
    expect(resolveSystemConfigSectionId('security')).toBe('security')
    expect(resolveSystemConfigSectionId('nope')).toBe('general')
    expect(DEFAULT_SYSTEM_CONFIG_SECTION_ID).toBe('general')
  })
})

describe('AdminSystemConfigView section UI contract', () => {
  it('uses section mapping, top tabs, and drops primary/advanced split', () => {
    expect(viewSource).toContain("from './system-config-sections'")
    expect(viewSource).toContain('SYSTEM_CONFIG_SECTIONS')
    expect(viewSource).toContain('resolveSystemConfigSectionId')
    expect(viewSource).toContain('activeSection')
    expect(viewSource).toContain('role="tablist"')
    expect(viewSource).toContain("$t('adminConfig.sectionTabsLabel')")
    expect(viewSource).not.toContain('primaryConfigKeys')
    expect(viewSource).not.toContain('常用配置')
    expect(viewSource).not.toContain('高级配置')
  })

  it('scopes turnstile banner, email test, and danger clear to the right sections', () => {
    expect(viewSource).toContain("activeSection === 'security'")
    expect(viewSource).toContain("group.name === '邮件服务'")
    expect(viewSource).toContain('includeDangerZone')
    expect(viewSource).toContain("activeSectionDef.includeDangerZone")
  })

  it('keeps payment dual entry and links to payment / referral pages', () => {
    expect(viewSource).toContain('/admin/payment')
    expect(viewSource).toContain('/admin/referral-codes')
    // 支付页仍保留余额/充值快捷开关（双入口 R1）
    expect(paymentSource).toContain('balance_payment_enabled')
    expect(paymentSource).toContain('balance_recharge_enabled')
    expect(paymentSource).toContain('toggleBalancePayment')
    expect(paymentSource).toContain('toggleBalanceRecharge')
  })

  it('hydrates active tab from route query tab', () => {
    expect(viewSource).toContain('route.query.tab')
    expect(viewSource).toContain('...route.query')
    expect(viewSource).toContain('tab: id')
    expect(viewSource).toContain('router.replace')
  })
})
