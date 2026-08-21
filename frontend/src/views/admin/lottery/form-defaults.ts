/**
 * 创建/编辑活动表单默认值。
 *
 * 为什么独立：emptyForm 字段多、与模板 apply / 复制草稿共用语义，
 * 放在 SFC 里会让「默认值变更」与「提交编排」缠在一起。
 */
import { defaultActivityConfigForKind, type ActivityConfigTranslate } from './activity-config'
import type { LotteryEditorForm } from './types'

export function emptyLotteryEditorForm(t: ActivityConfigTranslate): LotteryEditorForm {
  return {
    id: '',
    name: '',
    description: '',
    startTime: '',
    endTime: '',
    drawTime: '',
    winnerCount: 1,
    maxParticipants: null,
    expectedParticipants: 0,
    activityKind: 'lottery',
    participationMode: 'open',
    experienceType: 'wheel',
    resultMode: 'manual',
    allocationPolicy: 'capacity',
    accessPassword: '',
    showWinners: false,
    /** 是否公开参与人数（0/1）；模板 defaults 可覆盖，创建时透传后端 */
    showParticipantCount: 1,
    /** instant 默认 1 次；delayed 创建时后端会强制 0 */
    maxSpinsPerEntry: 1,
    // 奖项配置（抽奖活动专用）：选择奖品库中的奖品，设置中奖名额 + instant weight
    tiers: [],
    // 导流配置
    enableProductLink: false,
    productLink: { url: '', title: '', imageUrl: '', price: '' },
    // 裂变配置
    enableViral: false,
    viralExtraEntriesPerInvite: 1,
    viralMaxExtraEntries: 10,
    viralLeaderboardEnabled: true,
    // docs/218 保底（仅 instant）：默认关
    enablePity: false,
    pityThreshold: 3,
    // docs/218 每日免费（仅 instant）：默认关
    enableDailyFreeSpins: false,
    dailyFreeSpinsCount: 1,
    // docs/218 排行榜奖励明细（多行 "名次:spins次数"）
    leaderboardRewardsText: '',
    // docs/250/254 引擎推荐奖励（多行 "邀请数:类型:数量[:券label]"）
    referralRewardDefsText: '',
    // 多状态 CTA
    enableAfterWinCta: false,
    afterWinCtaUrl: '',
    afterWinCtaTitle: '',
    enableAfterLossCta: false,
    afterLossCtaUrl: '',
    afterLossCtaTitle: '',
    // docs/128：壳展示默认 auto（delayed=仪式短语，instant=真奖名）
    prizePanelMode: 'auto',
    ritualPhrasesText: '',
    // docs/130：秒杀壳默认关；开启后写入 promotion.flashSale
    enableFlashSale: false,
    flashSaleSessionLabel: '',
    flashSaleSalesMode: 'redirect',
    flashSaleStockLimit: null,
    flashSaleMaxPerUser: 1,
    flashSaleCtaLabel: '抢',
    flashSaleShowCountdown: true,
    flashSaleShowProgress: true,
    flashSaleShowStock: true,
    flashSalePaymentRequired: false,
    flashSalePriceCents: null,
    flashSaleCurrency: 'cny',
    flashSaleTitle: '',
    flashSaleImageUrl: '',
    flashSalePricingTiers: [],
    // 玩法配置：问卷/投票共用 activity_config，避免再拆 forms/votes 重表。
    activityConfig: defaultActivityConfigForKind('lottery', t),
  }
}
