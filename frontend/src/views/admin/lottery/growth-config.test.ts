import { describe, expect, it } from 'vitest'
import {
  buildPromotionConfigPayload,
  growthFieldsFromDraw,
  normalizePrizePanelMode,
  parseJsonObjectField,
  sanitizeRitualPhrasesForSave,
} from './growth-config'

describe('growth-config 编辑回填与提交（docs/114 防擦裂变）', () => {
  it('parseJsonObjectField：对象 / JSON 串 / 空', () => {
    expect(parseJsonObjectField({ a: 1 })).toEqual({ a: 1 })
    expect(parseJsonObjectField('{"viral":{"enabled":true}}')).toEqual({ viral: { enabled: true } })
    expect(parseJsonObjectField('{}')).toBeNull()
    expect(parseJsonObjectField('')).toBeNull()
    expect(parseJsonObjectField('not-json')).toBeNull()
  })

  it('normalizePrizePanelMode：合法值 trim/大小写保留，非法与空回退 auto', () => {
    expect(normalizePrizePanelMode('full_on_shell')).toBe('full_on_shell')
    expect(normalizePrizePanelMode(' SHELL_RITUAL_POOL_SUMMARY ')).toBe('shell_ritual_pool_summary')
    expect(normalizePrizePanelMode('ritual_only')).toBe('ritual_only')
    expect(normalizePrizePanelMode('bogus_mode')).toBe('auto')
    expect(normalizePrizePanelMode('')).toBe('auto')
    expect(normalizePrizePanelMode(undefined)).toBe('auto')
    expect(normalizePrizePanelMode(null)).toBe('auto')
  })

  it('sanitizeRitualPhrasesForSave：分行/去重/截断/拒收中奖词/上限', () => {
    // 换行分隔 + 去重
    expect(sanitizeRitualPhrasesForSave('好运连连\n好运连连\n期待开奖')).toEqual(['好运连连', '期待开奖'])
    // 拒收「一等奖」与含「中奖」的词；超 8 字截断
    expect(sanitizeRitualPhrasesForSave('一等奖\n恭喜中奖\n参与有礼呀呀呀呀呀')).toEqual(['参与有礼呀呀呀呀'])
    // 数组输入 + 去空白
    expect(sanitizeRitualPhrasesForSave(['好运', ' 感谢参与 ', ''])).toEqual(['好运', '感谢参与'])
    // 逗号/分号分隔符
    expect(sanitizeRitualPhrasesForSave('好运,感谢；期待开奖')).toEqual(['好运', '感谢', '期待开奖'])
    // 空输入
    expect(sanitizeRitualPhrasesForSave(null)).toEqual([])
    expect(sanitizeRitualPhrasesForSave(undefined)).toEqual([])
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

  it('buildPromotionConfigPayload：创建无增长 → undefined；编辑无增长 → 关闭包（含壳策略回退 auto）', () => {
    expect(buildPromotionConfigPayload({}, { isEditing: false })).toBeUndefined()
    expect(buildPromotionConfigPayload({}, { isEditing: true })).toEqual({
      version: 1,
      enabled: false,
      kind: 'destination',
      placement: 'after_join',
      // docs/128：编辑态始终带 experience.auto，防止二次保存把壳配置静默擦掉
      experience: { prizePanelMode: 'auto' },
    })
  })

  it('编辑态提交必须始终携带 experience 块（防二次保存擦壳配置）', () => {
    // 只开商品、壳字段保持表单默认 auto：experience 仍必须存在
    const payload = buildPromotionConfigPayload(
      {
        enableProductLink: true,
        productLink: { url: 'https://shop.example.com/p/1', title: 'T' },
        prizePanelMode: 'auto',
        ritualPhrasesText: '',
      },
      { isEditing: true },
    )
    expect((payload as any).experience).toEqual({ prizePanelMode: 'auto' })
  })

  it('自定义壳配置写出 experience 且回填后二次保存不丢', () => {
    const form = growthFieldsFromDraw({
      promotionConfig: JSON.stringify({
        version: 1,
        experience: { prizePanelMode: 'shell_ritual_pool_summary', ritualPhrases: ['期待开奖', '好运连连'] },
      }),
    })
    expect(form.prizePanelMode).toBe('shell_ritual_pool_summary')
    expect(form.ritualPhrasesText).toBe('期待开奖\n好运连连')
    const payload = buildPromotionConfigPayload(
      {
        prizePanelMode: form.prizePanelMode,
        ritualPhrasesText: form.ritualPhrasesText,
      },
      { isEditing: true },
    )
    expect((payload as any).experience).toEqual({
      prizePanelMode: 'shell_ritual_pool_summary',
      ritualPhrases: ['期待开奖', '好运连连'],
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
    // delayed：不写 extraSpins*（避免误导加权语义）
    expect((payload as any).viral?.extraSpinsPerInvite).toBeUndefined()
    // 未开商品时不应带 destination
    expect(payload).not.toHaveProperty('destination')
  })

  it('buildPromotionConfigPayload：instant 裂变双写 extraSpins* 与 extraEntries*', () => {
    const payload = buildPromotionConfigPayload(
      {
        enableViral: true,
        viralExtraEntriesPerInvite: 2,
        viralMaxExtraEntries: 5,
        viralLeaderboardEnabled: true,
        resultMode: 'instant',
      },
      { isEditing: false },
    )
    expect(payload).toMatchObject({
      viral: {
        enabled: true,
        extraEntriesPerInvite: 2,
        maxExtraEntries: 5,
        extraSpinsPerInvite: 2,
        maxExtraSpins: 5,
        leaderboardEnabled: true,
      },
    })
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
