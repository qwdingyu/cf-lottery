import { describe, expect, it } from 'vitest'
import {
  buildPromotionConfigPayload,
  growthFieldsFromDraw,
  normalizePrizePanelMode,
  parseJsonObjectField,
  sanitizeRitualPhrasesForSave,
  parseLeaderboardRewardsText,
  formatLeaderboardRewardsText,
  parseReferralRewardsText,
  formatReferralRewardsText,
  parseReferralRewardDefsText,
  formatReferralRewardDefsText,
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

  it('docs/130：flashSale 回填与提交闭环，二次保存不丢', () => {
    const g = growthFieldsFromDraw({
      promotionConfig: JSON.stringify({
        version: 1,
        flashSale: {
          enabled: true,
          sessionLabel: '12:00场',
          stockLimit: 100,
          maxPerUser: 1,
          ctaLabel: '抢',
          showCountdown: true,
          showProgress: true,
          showStock: false,
        },
        destination: { url: 'https://shop.example.com/p/1', title: '去购买' },
      }),
    })
    expect(g.enableFlashSale).toBe(true)
    expect(g.flashSaleSessionLabel).toBe('12:00场')
    expect(g.flashSaleStockLimit).toBe(100)
    expect(g.flashSaleShowStock).toBe(false)
    expect(g.hasGrowthConfig).toBe(true)

    const payload = buildPromotionConfigPayload(
      {
        enableFlashSale: g.enableFlashSale,
        flashSaleSessionLabel: g.flashSaleSessionLabel,
        flashSaleStockLimit: g.flashSaleStockLimit,
        flashSaleMaxPerUser: g.flashSaleMaxPerUser,
        flashSaleCtaLabel: g.flashSaleCtaLabel,
        flashSaleShowCountdown: g.flashSaleShowCountdown,
        flashSaleShowProgress: g.flashSaleShowProgress,
        flashSaleShowStock: g.flashSaleShowStock,
        enableProductLink: true,
        productLink: { url: 'https://shop.example.com/p/1', title: '去购买' },
      },
      { isEditing: true },
    )
    expect((payload as any).flashSale).toMatchObject({
      enabled: true,
      sessionLabel: '12:00场',
      stockLimit: 100,
      maxPerUser: 1,
      ctaLabel: '抢',
      showStock: false,
    })
    expect((payload as any).flashSale).not.toHaveProperty('paymentRequired')
  })

  it('docs/131：直付秒杀字段回填与提交闭环，二次保存不丢', () => {
    const g = growthFieldsFromDraw({
      promotionConfig: JSON.stringify({
        version: 1,
        flashSale: {
          enabled: true,
          sessionLabel: '20:00场',
          stockLimit: 50,
          maxPerUser: 10,
          paymentRequired: true,
          priceCents: 9900,
          currency: 'cny',
          title: '秒杀卡密',
          pricingTiers: [{ minQuantity: 10, unitPriceCents: 7900, label: '批发价' }],
        },
      }),
    })
    expect(g.enableFlashSale).toBe(true)
    expect(g.flashSalePaymentRequired).toBe(true)
    expect(g.flashSalePriceCents).toBe(9900)
    expect(g.flashSaleCurrency).toBe('cny')
    expect(g.flashSaleTitle).toBe('秒杀卡密')
    expect(g.flashSaleMaxPerUser).toBe(10)
    expect(g.flashSalePricingTiers).toEqual([{ minQuantity: 10, unitPriceCents: 7900, label: '批发价' }])

    const payload = buildPromotionConfigPayload(
      {
        enableFlashSale: g.enableFlashSale,
        flashSaleSessionLabel: g.flashSaleSessionLabel,
        flashSaleStockLimit: g.flashSaleStockLimit,
        flashSaleMaxPerUser: g.flashSaleMaxPerUser,
        flashSaleCtaLabel: g.flashSaleCtaLabel,
        flashSaleShowCountdown: g.flashSaleShowCountdown,
        flashSaleShowProgress: g.flashSaleShowProgress,
        flashSaleShowStock: g.flashSaleShowStock,
        flashSalePaymentRequired: g.flashSalePaymentRequired,
        flashSalePriceCents: g.flashSalePriceCents,
        flashSaleCurrency: g.flashSaleCurrency,
        flashSaleTitle: g.flashSaleTitle,
        flashSalePricingTiers: g.flashSalePricingTiers,
      },
      { isEditing: true },
    )
    expect((payload as any).flashSale).toMatchObject({
      enabled: true,
      sessionLabel: '20:00场',
      stockLimit: 50,
      maxPerUser: 10,
      paymentRequired: true,
      priceCents: 9900,
      currency: 'cny',
      title: '秒杀卡密',
      pricingTiers: [{ minQuantity: 10, unitPriceCents: 7900, label: '批发价' }],
    })
  })

  it('docs/130：关闭秒杀后提交包无 flashSale 键', () => {
    const payload = buildPromotionConfigPayload(
      {
        enableFlashSale: false,
        enableProductLink: true,
        productLink: { url: 'https://shop.example.com/p/1', title: 'T' },
      },
      { isEditing: true },
    )
    expect(payload).not.toHaveProperty('flashSale')
  })

  describe('docs/218 保底 / 每日免费 / 排行榜奖励', () => {
    it('parseLeaderboardRewardsText：正常解析、去重、非法行跳过、上下限', () => {
      expect(parseLeaderboardRewardsText('1:3\n2:1\n3:1')).toEqual([
        { rank: 1, rewardType: 'bonus_spin', rewardValue: 3 },
        { rank: 2, rewardType: 'bonus_spin', rewardValue: 1 },
        { rank: 3, rewardType: 'bonus_spin', rewardValue: 1 },
      ])
      // 乱序 → 按名次排序；重复名次保留首个
      expect(parseLeaderboardRewardsText('3:1\n1:5\n3:9\n2:2')).toEqual([
        { rank: 1, rewardType: 'bonus_spin', rewardValue: 5 },
        { rank: 2, rewardType: 'bonus_spin', rewardValue: 2 },
        { rank: 3, rewardType: 'bonus_spin', rewardValue: 1 },
      ])
      // 非法：0 名次 / 负数次数 / 非数字 / 超上限 → 全部跳过
      expect(parseLeaderboardRewardsText('0:3\n1:-1\nabc\n101:1\n1:2000')).toEqual([])
      expect(parseLeaderboardRewardsText(null)).toEqual([])
      expect(parseLeaderboardRewardsText('')).toEqual([])
    })

    it('formatLeaderboardRewardsText：与 parse 互逆', () => {
      const text = '2:1\n1:3'
      expect(formatLeaderboardRewardsText(parseLeaderboardRewardsText(text))).toBe('1:3\n2:1')
      expect(formatLeaderboardRewardsText(null)).toBe('')
    })

    it('growthFieldsFromDraw：回填保底 / 每日免费 / 排行榜奖励（编辑防擦）', () => {
      const g = growthFieldsFromDraw({
        promotionConfig: JSON.stringify({
          version: 1,
          pity: { enabled: true, threshold: 5 },
          dailyFreeSpins: { enabled: true, count: 2 },
          viral: {
            enabled: true,
            leaderboardEnabled: true,
            leaderboardRewards: [
              { rank: 1, rewardType: 'bonus_spin', rewardValue: 3 },
              { rank: 2, rewardType: 'bonus_spin', rewardValue: 1 },
            ],
          },
        }),
      })
      expect(g.enablePity).toBe(true)
      expect(g.pityThreshold).toBe(5)
      expect(g.enableDailyFreeSpins).toBe(true)
      expect(g.dailyFreeSpinsCount).toBe(2)
      expect(g.leaderboardRewardsText).toBe('1:3\n2:1')
      expect(g.hasGrowthConfig).toBe(true)
    })

    it('编辑回填后再提交：保底 / 每日免费 / 排行榜奖励 round-trip 不丢（只改标题场景）', () => {
      const source = {
        promotionConfig: JSON.stringify({
          version: 1,
          pity: { enabled: true, threshold: 5 },
          dailyFreeSpins: { enabled: true, count: 2 },
          viral: {
            enabled: true,
            extraEntriesPerInvite: 1,
            maxExtraEntries: 10,
            leaderboardEnabled: true,
            leaderboardRewards: [
              { rank: 1, rewardType: 'bonus_spin', rewardValue: 3 },
            ],
          },
        }),
      }
      const form = growthFieldsFromDraw(source)
      const payload = buildPromotionConfigPayload(
        {
          resultMode: 'instant',
          enableViral: form.enableViral,
          viralExtraEntriesPerInvite: form.viralExtraEntriesPerInvite,
          viralMaxExtraEntries: form.viralMaxExtraEntries,
          viralLeaderboardEnabled: form.viralLeaderboardEnabled,
          enablePity: form.enablePity,
          pityThreshold: form.pityThreshold,
          enableDailyFreeSpins: form.enableDailyFreeSpins,
          dailyFreeSpinsCount: form.dailyFreeSpinsCount,
          leaderboardRewardsText: form.leaderboardRewardsText,
        },
        { isEditing: true },
      )
      expect((payload as any).pity).toEqual({ enabled: true, threshold: 5 })
      expect((payload as any).dailyFreeSpins).toEqual({ enabled: true, count: 2 })
      expect((payload as any).viral.leaderboardRewards).toEqual([
        { rank: 1, rewardType: 'bonus_spin', rewardValue: 3 },
      ])
    })

    it('非 instant 模式：保底/每日免费配置不写入包（后端该校验阻断）', () => {
      const payload = buildPromotionConfigPayload(
        {
          resultMode: 'manual',
          enableViral: true,
          viralExtraEntriesPerInvite: 1,
          viralMaxExtraEntries: 5,
          enablePity: true,
          pityThreshold: 3,
          enableDailyFreeSpins: true,
          dailyFreeSpinsCount: 1,
        },
        { isEditing: false },
      )
      expect(payload).not.toHaveProperty('pity')
      expect(payload).not.toHaveProperty('dailyFreeSpins')
    })

    it('仅配置保底（未开裂变）也能独立提交', () => {
      const payload = buildPromotionConfigPayload(
        {
          resultMode: 'instant',
          enablePity: true,
          pityThreshold: 4,
        },
        { isEditing: false },
      )
      expect(payload).toMatchObject({ enabled: true, pity: { enabled: true, threshold: 4 } })
      expect(payload).not.toHaveProperty('viral')
    })
  })

  describe('docs/217 推荐里程碑（referralRewards）', () => {
    it('parseReferralRewardsText：正常解析、去重、非法行跳过、上下限', () => {
      expect(parseReferralRewardsText('1:2\n3:5\n5:10')).toEqual([
        { requireCount: 1, rewardType: 'bonus_spin', rewardValue: 2 },
        { requireCount: 3, rewardType: 'bonus_spin', rewardValue: 5 },
        { requireCount: 5, rewardType: 'bonus_spin', rewardValue: 10 },
      ])
      // 乱序 → 排序；重复门槛保留首个
      expect(parseReferralRewardsText('3:5\n1:2\n3:9')).toEqual([
        { requireCount: 1, rewardType: 'bonus_spin', rewardValue: 2 },
        { requireCount: 3, rewardType: 'bonus_spin', rewardValue: 5 },
      ])
      // 非法：0 门槛 / 负数 / 非数字 / 超上限 → 跳过
      expect(parseReferralRewardsText('0:2\n1:-1\nabc\n101:1\n1:2000')).toEqual([])
      expect(parseReferralRewardsText(null)).toEqual([])
      expect(formatReferralRewardsText(null)).toBe('')
    })

    it('growthFieldsFromDraw：回填 referallRewards（编辑防擦）', () => {
      const g = growthFieldsFromDraw({
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewards: [
            { requireCount: 1, rewardType: 'bonus_spin', rewardValue: 2 },
            { requireCount: 3, rewardType: 'bonus_spin', rewardValue: 5 },
          ],
        }),
      })
      expect(g.referralRewardsText).toBe('1:2\n3:5')
      expect(g.hasGrowthConfig).toBe(true)
    })

    it('编辑回填后再提交：referralRewards round-trip 不丢（只改标题场景）', () => {
      const source = {
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewards: [
            { requireCount: 1, rewardType: 'bonus_spin', rewardValue: 2 },
            { requireCount: 3, rewardType: 'bonus_spin', rewardValue: 5 },
          ],
        }),
      }
      const form = growthFieldsFromDraw(source)
      const payload = buildPromotionConfigPayload(
        { resultMode: 'instant', referralRewardsText: form.referralRewardsText },
        { isEditing: true },
      )
      expect((payload as any).referralRewards).toEqual([
        { requireCount: 1, rewardType: 'bonus_spin', rewardValue: 2 },
        { requireCount: 3, rewardType: 'bonus_spin', rewardValue: 5 },
      ])
    })

    it('仅配置里程碑（未开裂变）也能独立提交；非 instant 不写入', () => {
      const instant = buildPromotionConfigPayload(
        { resultMode: 'instant', referralRewardsText: '1:2\n3:5' },
        { isEditing: false },
      )
      expect(instant).toMatchObject({
        enabled: true,
        referralRewards: [
          { requireCount: 1, rewardType: 'bonus_spin', rewardValue: 2 },
          { requireCount: 3, rewardType: 'bonus_spin', rewardValue: 5 },
        ],
      })
      expect(instant).not.toHaveProperty('viral')

      const manual = buildPromotionConfigPayload(
        { resultMode: 'manual', referralRewardsText: '1:2' },
        { isEditing: false },
      )
      expect(manual).toBeUndefined() // 非 instant 里程碑不生效 → 无增长配置 → undefined
    })
  })

  describe('docs/250/254 引擎推荐奖励（referralRewardDefs）', () => {
    it('parseReferralRewardDefsText：正常解析、去重、非法行跳过、上下限', () => {
      expect(parseReferralRewardDefsText('1:bonus_spin:2\n3:bonus_coupon:1:invite')).toEqual([
        { requireCount: 1, rewardExit: 'bonus_spin', rewardValue: 2 },
        { requireCount: 3, rewardExit: 'bonus_coupon', rewardValue: 1, couponLabel: 'invite' },
      ])
      // 乱序 → 排序；重复门槛保留首个；非法类型/数值跳过
      expect(parseReferralRewardDefsText('3:bonus_spin:5\n1:bonus_spin:2\n3:bonus_spin:9')).toEqual([
        { requireCount: 1, rewardExit: 'bonus_spin', rewardValue: 2 },
        { requireCount: 3, rewardExit: 'bonus_spin', rewardValue: 5 },
      ])
      expect(parseReferralRewardDefsText('0:bonus_spin:2\n1:bad_type:2\n1:bonus_spin:-1\nabc\n101:bonus_spin:1\n1:bonus_spin:2000')).toEqual([])
      expect(parseReferralRewardDefsText(null)).toEqual([])
      expect(formatReferralRewardDefsText(null)).toBe('')
    })

    it('growthFieldsFromDraw：回填 referralRewardDefs（编辑防擦）', () => {
      const g = growthFieldsFromDraw({
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: 'invite_1', type: 'FIXED', target: 'SOURCE', fixedAmount: '2',
              conditions: [{ field: 'totalJoinedCount', operator: 'GTE', value: '1' }],
              metadata: { rewardExit: 'bonus_spin' },
            },
            {
              rewardId: 'invite_3', type: 'FIXED', target: 'SOURCE', fixedAmount: '1',
              conditions: [{ field: 'totalJoinedCount', operator: 'GTE', value: '3' }],
              metadata: { rewardExit: 'bonus_coupon', couponLabel: 'invite' },
            },
          ],
        }),
      })
      expect(g.referralRewardDefsText).toBe('1:bonus_spin:2\n3:bonus_coupon:1:invite')
      expect(g.hasGrowthConfig).toBe(true)
    })

    it('编辑回填后再提交：referralRewardDefs round-trip 不丢', () => {
      const source = {
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: 'invite_1', type: 'FIXED', target: 'SOURCE', fixedAmount: '2',
              conditions: [{ field: 'totalJoinedCount', operator: 'GTE', value: '1' }],
              metadata: { rewardExit: 'bonus_spin' },
            },
          ],
        }),
      }
      const form = growthFieldsFromDraw(source)
      const payload = buildPromotionConfigPayload(
        { resultMode: 'instant', referralRewardDefsText: form.referralRewardDefsText },
        { isEditing: true },
      )
      expect((payload as any).referralRewardDefs).toEqual([
        {
          rewardId: 'invite_1', type: 'FIXED', target: 'SOURCE', fixedAmount: '2',
          conditions: [{ field: 'totalJoinedCount', operator: 'GTE', value: '1' }],
          metadata: { rewardExit: 'bonus_spin' },
        },
      ])
    })

    it('非 instant 的 bonus_coupon 也能提交（claim 等类型，不依赖 instant）', () => {
      const manual = buildPromotionConfigPayload(
        { resultMode: 'manual', referralRewardDefsText: '3:bonus_coupon:1:invite' },
        { isEditing: false },
      )
      expect(manual).toMatchObject({
        enabled: true,
        referralRewardDefs: [
          {
            rewardId: 'invite_3', type: 'FIXED', target: 'SOURCE', fixedAmount: '1',
            conditions: [{ field: 'totalJoinedCount', operator: 'GTE', value: '3' }],
            metadata: { rewardExit: 'bonus_coupon', couponLabel: 'invite' },
          },
        ],
      })
    })
    it('rewardId 必须恒为 invite_${requireCount}（幂等键契约，加出口后缀会导致存量重复发奖）', () => {
      // docs/255 P2-11 审查结论：rewardId 就是后端幂等键
      // （share_records.rewardMilestonesGranted 按字符串比对），而编辑回填不读 rewardId，
      // 所以格式一旦变化，存量活动重新保存后已发过的档位会被再发一次。
      // 本用例锁死格式：改动必须同时提供存量迁移，否则这里会红。
      const payload = buildPromotionConfigPayload(
        { resultMode: 'instant', referralRewardDefsText: '2:bonus_spin:3\n5:bonus_coupon:1:invite' },
        { isEditing: false },
      )
      const ids = ((payload as any).referralRewardDefs as Array<{ rewardId: string }>).map((d) => d.rewardId)
      expect(ids).toEqual(['invite_2', 'invite_5'])
    })
  })
})
