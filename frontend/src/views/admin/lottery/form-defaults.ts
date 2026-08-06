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
    prizeName: '',
    productName: '',
    startTime: '',
    endTime: '',
    drawTime: '',
    winnerCount: 1,
    maxWinners: 1,
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
    // 玩法配置：问卷/投票共用 activity_config，避免再拆 forms/votes 重表。
    activityConfig: defaultActivityConfigForKind('lottery', t),
  }
}
