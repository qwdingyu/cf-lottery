import { describe, expect, it } from 'vitest'
import {
  buildPromotionConfigPayload,
  growthFieldsFromDraw,
  parseJsonObjectField,
} from './growth-config'

describe('growth-config 编辑回填与提交（docs/114 防擦裂变）', () => {
  it('parseJsonObjectField：对象 / JSON 串 / 空', () => {
    expect(parseJsonObjectField({ a: 1 })).toEqual({ a: 1 })
    expect(parseJsonObjectField('{"viral":{"enabled":true}}')).toEqual({ viral: { enabled: true } })
    expect(parseJsonObjectField('{}')).toBeNull()
    expect(parseJsonObjectField('')).toBeNull()
    expect(parseJsonObjectField('not-json')).toBeNull()
  })

  it('growthFieldsFromDraw：字符串 promotionConfig 回填裂变与排行榜缺省 true', () => {
    const g = growthFieldsFromDraw({
      promotionConfig: JSON.stringify({
        version: 1,
        viral: {
          enabled: true,
          extraEntriesPerInvite: 2,
          maxExtraEntries: 8,
          // 故意不写 leaderboardEnabled
        },
      }),
    })
    expect(g.enableViral).toBe(true)
    expect(g.viralExtraEntriesPerInvite).toBe(2)
    expect(g.viralMaxExtraEntries).toBe(8)
    expect(g.viralLeaderboardEnabled).toBe(true)
    expect(g.hasGrowthConfig).toBe(true)
  })

  it('growthFieldsFromDraw：leaderboardEnabled false 回填关', () => {
    const g = growthFieldsFromDraw({
      promotionConfig: {
        viral: { enabled: true, leaderboardEnabled: false, extraEntriesPerInvite: 1, maxExtraEntries: 10 },
      },
    })
    expect(g.enableViral).toBe(true)
    expect(g.viralLeaderboardEnabled).toBe(false)
  })

  it('无 promotion 时 enableViral false，避免编辑默认擦掉前「假开」', () => {
    const g = growthFieldsFromDraw({})
    expect(g.enableViral).toBe(false)
    expect(g.hasGrowthConfig).toBe(false)
    expect(g.viralLeaderboardEnabled).toBe(true) // 表单缺省，与 emptyForm 一致
  })

  it('buildPromotionConfigPayload：创建无增长 → undefined；编辑无增长 → 关闭包', () => {
    expect(buildPromotionConfigPayload({}, { isEditing: false })).toBeUndefined()
    expect(buildPromotionConfigPayload({}, { isEditing: true })).toEqual({
      version: 1,
      enabled: false,
      kind: 'destination',
      placement: 'after_join',
    })
  })

  it('buildPromotionConfigPayload：只开裂变写出 viral，含 leaderboard', () => {
    const payload = buildPromotionConfigPayload(
      {
        enableViral: true,
        viralExtraEntriesPerInvite: 2,
        viralMaxExtraEntries: 6,
        viralLeaderboardEnabled: true,
      },
      { isEditing: true },
    )
    expect(payload).toMatchObject({
      enabled: true,
      viral: {
        enabled: true,
        extraEntriesPerInvite: 2,
        maxExtraEntries: 6,
        leaderboardEnabled: true,
      },
    })
    // 未开商品时不应带 destination
    expect(payload).not.toHaveProperty('destination')
  })

  it('回填后再提交：只改标题场景等价于 enableViral 仍 true → viral 不丢', () => {
    const source = {
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true },
      }),
    }
    const form = growthFieldsFromDraw(source)
    const payload = buildPromotionConfigPayload(
      {
        enableViral: form.enableViral,
        viralExtraEntriesPerInvite: form.viralExtraEntriesPerInvite,
        viralMaxExtraEntries: form.viralMaxExtraEntries,
        viralLeaderboardEnabled: form.viralLeaderboardEnabled,
      },
      { isEditing: true },
    )
    expect((payload as any).viral?.enabled).toBe(true)
    expect((payload as any).viral?.leaderboardEnabled).toBe(true)
  })

  it('显式关闭排行榜时写出 leaderboardEnabled: false（禁止省略导致后端缺省当开）', () => {
    const payload = buildPromotionConfigPayload(
      {
        enableViral: true,
        viralExtraEntriesPerInvite: 1,
        viralMaxExtraEntries: 10,
        viralLeaderboardEnabled: false,
      },
      { isEditing: true },
    )
    expect((payload as any).viral).toEqual({
      enabled: true,
      extraEntriesPerInvite: 1,
      maxExtraEntries: 10,
      leaderboardEnabled: false,
    })
  })

  it('编辑只保留商品、关掉裂变：整包无 viral 键（覆盖写会清掉旧裂变，非静默保留）', () => {
    const payload = buildPromotionConfigPayload(
      {
        enableProductLink: true,
        productLink: { url: 'https://shop.example.com/p/1', title: 'T', imageUrl: '', price: '' },
        enableViral: false,
      },
      { isEditing: true },
    )
    expect(payload).toMatchObject({
      enabled: true,
      destination: { url: 'https://shop.example.com/p/1' },
    })
    expect(payload).not.toHaveProperty('viral')
  })

  it('productLink 列优先于 promotion.destination 回填商品', () => {
    const g = growthFieldsFromDraw({
      productLink: JSON.stringify({
        url: 'https://col.example.com/a',
        title: '列上商品',
        imageUrl: '',
        price: '¥1',
      }),
      promotionConfig: JSON.stringify({
        version: 1,
        destination: { url: 'https://promo.example.com/b', title: '包内商品' },
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 5 },
      }),
    })
    expect(g.enableProductLink).toBe(true)
    expect(g.productLink.url).toBe('https://col.example.com/a')
    expect(g.productLink.title).toBe('列上商品')
    expect(g.enableViral).toBe(true)
    expect(g.viralMaxExtraEntries).toBe(5)
  })
})
