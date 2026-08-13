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
})
