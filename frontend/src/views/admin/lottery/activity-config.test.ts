import { describe, expect, it } from 'vitest'
import { defaultActivityConfigForKind, normalizeActivityConfig } from './activity-config'

// 最小翻译桩：normalize 只透传 key，测试不需要真实 i18n 实例
const t = (key: string) => key

describe('activity-config normalize（lottery loserReward 保留，P0 回归）', () => {
  it('normalize 保留已启用 loserReward（enabled:true + couponLabel 原样保留）', () => {
    const result = normalizeActivityConfig(
      'lottery',
      { version: 1, kind: 'lottery', loserReward: { enabled: true, couponLabel: '安慰奖' } },
      t,
    )
    // 编辑回填必须原样保留，否则保存构造会回落默认关
    expect(result).toMatchObject({
      version: 1,
      kind: 'lottery',
      loserReward: { enabled: true, couponLabel: '安慰奖' },
    })
  })

  it('normalize 对无 loserReward 的配置返回默认 false', () => {
    const result = normalizeActivityConfig('lottery', { version: 1, kind: 'lottery' }, t)
    expect(result).toMatchObject({
      version: 1,
      kind: 'lottery',
      loserReward: { enabled: false, couponLabel: '' },
    })
    // 整包缺失（null / 非对象）同样回落默认
    expect(normalizeActivityConfig('lottery', null, t)).toMatchObject({
      loserReward: { enabled: false, couponLabel: '' },
    })
    expect(defaultActivityConfigForKind('lottery', t)).toMatchObject({
      version: 1,
      kind: 'lottery',
      loserReward: { enabled: false, couponLabel: '' },
    })
  })

  it('normalize 对非法 loserReward（null/字符串/数组/数字/布尔）容错返回默认', () => {
    const badValues: unknown[] = [null, 'oops', ['x'], 42, true]
    for (const bad of badValues) {
      const result = normalizeActivityConfig('lottery', { version: 1, kind: 'lottery', loserReward: bad }, t)
      expect(result).toMatchObject({ loserReward: { enabled: false, couponLabel: '' } })
    }
  })

  it('round-trip：normalize → 保存构造（AdminLotteryView 语义）不丢 enabled:true', () => {
    const normalized = normalizeActivityConfig(
      'lottery',
      { version: 1, kind: 'lottery', loserReward: { enabled: true, couponLabel: '安慰奖' } },
      t,
    )
    // 模拟 AdminLotteryView handleCreate 的 lottery 保存构造：
    // { version:1, kind:'lottery', loserReward: config?.loserReward || {enabled:false,couponLabel:''} }
    const config = normalized as { loserReward?: { enabled: boolean; couponLabel: string } }
    const savePayload = {
      version: 1,
      kind: 'lottery',
      loserReward: config?.loserReward || { enabled: false, couponLabel: '' },
    }
    // 若 normalize 丢失 loserReward，保存构造会回落默认 false，这里必须锁住 enabled:true 不丢
    expect(savePayload.loserReward).toEqual({ enabled: true, couponLabel: '安慰奖' })
  })

  it('normalize 对非法 reward（null/字符串/数组/数字/布尔）容错返回默认（不含 reward 字段）', () => {
    const badValues: unknown[] = [null, 'oops', ['x'], 42, true]
    for (const bad of badValues) {
      const result = normalizeActivityConfig('lottery', { version: 1, kind: 'lottery', reward: bad }, t)
      expect(result).not.toHaveProperty('reward')
    }
  })

  it('normalize 对 reward 非法数值做容错：perInviteAmount 非有限数字回退 0，currency 非法或缺失时不写入（由后端从 flashSale.currency 或默认 cny 获取）', () => {
    const cases: Array<{ input: any; expected: any }> = [
      { input: { perInviteAmount: 'abc' }, expected: { perInviteAmount: 0 } },
      { input: { perInviteAmount: NaN }, expected: { perInviteAmount: 0 } },
      { input: { perInviteAmount: Infinity }, expected: { perInviteAmount: 0 } },
      { input: { perInviteAmount: -5 }, expected: { perInviteAmount: 0 } },
      { input: { perInviteAmount: 3.7 }, expected: { perInviteAmount: 3 } },
      { input: { currency: 123 }, expected: { perInviteAmount: 0 } },
      { input: { currency: '' }, expected: { perInviteAmount: 0 } },
      { input: { currency: '  ' }, expected: { perInviteAmount: 0 } },
      { input: { currency: 'CNY' }, expected: { perInviteAmount: 0, currency: 'CNY' } },
    ]
    for (const c of cases) {
      const result = normalizeActivityConfig('lottery', { version: 1, kind: 'lottery', reward: c.input }, t)
      expect(result).toMatchObject({ reward: c.expected })
    }
  })

  it('normalize 对 quota 顶层非法值容错：非对象返回 undefined，非法数字忽略该字段', () => {
    // quota 在 activityConfig 顶层（对齐后端 triggerRewardEarned: config?.quota），非 reward 内部
    const result = normalizeActivityConfig('lottery', { version: 1, kind: 'lottery', quota: 'bad' }, t)
    expect(result).not.toHaveProperty('quota')

    const result2 = normalizeActivityConfig('lottery', { version: 1, kind: 'lottery', quota: { perUserPerDay: 'x', globalPerDay: -1 } }, t)
    expect(result2).not.toHaveProperty('quota')
  })

  it('normalize 正确从顶层解析 quota：perUserPerDay/globalPerDay 合并到返回结构', () => {
    const result = normalizeActivityConfig('lottery', {
      version: 1, kind: 'lottery',
      reward: { perInviteAmount: 10, currency: 'CNY' },
      quota: { perUserPerDay: 5, globalPerDay: 100 },
    }, t)
    expect(result).toMatchObject({
      reward: { perInviteAmount: 10, currency: 'CNY' },
      quota: { perUserPerDay: 5, globalPerDay: 100 },
    })
  })
})
