import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 仓库根：frontend/src/views/admin → ../../../../ */
const repoRoot = resolve(new URL('../../../../', import.meta.url).pathname)
const opsDoc = readFileSync(resolve(repoRoot, 'docs/054_开放归因运营契约与冻结说明_2026-07-25.md'), 'utf8')
const strategyDoc = readFileSync(resolve(repoRoot, 'docs/055_L0战略锁定_交易内核与开放归因_2026-07-25.md'), 'utf8')
const indexDoc = readFileSync(resolve(repoRoot, 'docs/000_文档索引_2026-07-14.md'), 'utf8')

describe('open attribution ops doc contract', () => {
  it('is the freeze-period source of truth for open attribution', () => {
    expect(opsDoc).toContain('不挡交易')
    expect(opsDoc).toContain('不校验 registry')
    // L1 落地后：默认关；可开支付成功入账（禁止绝对「永不发奖」冻结语）
    expect(opsDoc).toContain('默认不自动发奖')
    expect(opsDoc).toContain('referral_reward_enabled')
    expect(opsDoc).toContain('?campaign=')
    expect(opsDoc).toContain('?ref=')
    expect(opsDoc).toContain('来源 / 归因')
    expect(opsDoc).toContain('事件数')
    expect(opsDoc).toContain('不是')
    expect(opsDoc).toMatch(/paid|issued|成交/)
    expect(opsDoc).toContain('台账')
    expect(opsDoc).toContain('导出')
    // 禁止把错误运营理解写成正例
    expect(opsDoc).toContain('来源 = 活动码')
    expect(opsDoc).toContain('useCount = 已支付成交数')
    // 与 L0 战略交叉：禁止 campaign 秒杀
    expect(opsDoc).toContain('秒杀')
    expect(opsDoc).toContain('055')
    expect(opsDoc).toContain('056')
  })

  it('locks L0 strategy: no default auto-reward, no campaign flash sale, L1 optional', () => {
    expect(strategyDoc).toContain('轻量交易内核')
    expect(strategyDoc).toContain('开放归因')
    expect(strategyDoc).toContain('L0')
    expect(strategyDoc).toContain('L1')
    expect(strategyDoc).toContain('不')
    expect(strategyDoc).toMatch(/tryGrantReferralReward|自动发奖|自动返佣/)
    expect(strategyDoc).toContain('referral_reward_enabled')
    expect(strategyDoc).toContain('秒杀')
    expect(strategyDoc).toContain('campaigns')
    // L1 触发：支付成功路径上的 markPaidAndIssue 成功（非任意 paid 态 / 非建单）
    expect(strategyDoc).toContain('支付成功')
    expect(strategyDoc).toContain('markPaidAndIssue')
    expect(strategyDoc).toContain('冲正')
    expect(strategyDoc).toMatch(/ylb|GrowthKit/)
    expect(strategyDoc).toContain('导出 CSV')
    // L0 低成本结算路径（运营用透，非 L1）
    expect(strategyDoc).toContain('已成交（结算）')
    expect(strategyDoc).toContain('搜成交')
    expect(strategyDoc).toContain('paid,issued')
  })

  it('is indexed from the docs catalog', () => {
    expect(indexDoc).toContain('054_开放归因运营契约与冻结说明_2026-07-25.md')
    expect(indexDoc).toContain('055_L0战略锁定_交易内核与开放归因_2026-07-25.md')
    expect(indexDoc).toContain('056_L1可选分销自动返佣规格_2026-07-25.md')
    expect(indexDoc).toContain('开放归因')
    expect(indexDoc).toContain('L0')
    expect(indexDoc).toContain('默认不自动发奖')
  })
})
