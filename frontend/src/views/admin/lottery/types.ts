/**
 * 管理端抽奖页类型。
 *
 * 为什么单独成文件：AdminLotteryView 曾把类型、API、表单、列表编排全堆在一个 SFC，
 * 改表单时易误伤列表。类型与实现解耦后，API/工具模块可独立引用。
 */

export type LotteryDraw = {
  id: string
  tenantId: string
  publicSlug: string
  title: string
  name?: string
  description: string
  status: string
  activityKind: string
  participationMode: string
  experienceType: string
  drawTrigger: string
  resultMode: string
  allocationPolicy?: string
  policyVersion: number
  startAt: string
  startTime?: string
  endAt: string
  endTime?: string
  drawAt: string | null
  drawTime?: string | null
  winnerCount: number
  /** instant：每人累计 spin 次数硬顶（0=未配置/delayed） */
  maxSpinsPerEntry?: number
  maxParticipants: number | null
  expectedParticipants?: number
  entryCount?: number
  visible?: number
  showParticipantCount: number
  showWinnerCount: number
  showWinnerList: number
  drawnAt: string | null
  failureReason: string
  activityConfig?: ActivityConfigForm
  createdAt: string
  updatedAt: string
}

export type SurveyFieldType = 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox'

export type SurveyFieldForm = {
  id: string
  label: string
  type: SurveyFieldType
  required: boolean
  maxLength: number
  options: Array<{ id: string; label: string }>
}

export type ActivityConfigForm =
  | { version: 1; kind: 'survey'; fields: SurveyFieldForm[] }
  | { version: 1; kind: 'vote'; selection: 'single'; options: Array<{ id: string; label: string; description: string; imageUrl: string }> }
  | {
      version?: 1
      kind?: string
      fields?: SurveyFieldForm[]
      options?: Array<{ id: string; label: string; description?: string; imageUrl?: string }>
      /** 未中奖自动发券（安慰奖）：仅 lottery 活动生效，enabled 默认 false */
      loserReward?: { enabled: boolean; couponLabel: string }
    }

export type LotteryWinner = {
  id: string
  drawId: string
  tierId: string
  entryId: string
  identityType: string
  identityValue: string
  prizeCodeId: string
  drawnAt: string
  notificationStatus: string
  notificationError: string
  email?: string
  /** 独立孵化后不再创建 0 元订单；恒空（docs/102） */
  orderNo?: string | null
  cardAccountLabel?: string | null
  cardDeliverySecret?: string | null
  prizeCode?: string | null
  hasPrizeCode?: boolean
  tierName?: string | null
  prizeName?: string | null
  prizeType?: string | null
  prizeValueText?: string | null
  fulfillmentNote?: string | null
  /** code | manual | code_missing | none */
  fulfillmentKind?: string | null
  emailSent?: number
  emailError?: string
  /** 后端 decorateIdentityDisplay 注入：registered 身份解析为用户名(邮箱)；email 身份不注入 */
  identityDisplay?: string
}

export type ActivityEventSummary = {
  totals: Record<string, number>
  pageViews: number
  participationCompleted: number
  ctaClicks: number
  /** 导流商品卡点击（docs/246/249） */
  trafficClicks: number
  shareClicks: number
  attributedJoins: number
  externalConversionsReported: number
}

export type ExternalConversionSummary = {
  totalCount: number
  totalAmountCents: number
  totals: Record<string, { count: number; amountCents: number }>
}

export type DrawAnalyticsStats = {
  entryCount: number
  events: ActivityEventSummary
  externalConversions: ExternalConversionSummary
  /** ★ P1-3: 未中奖安慰券发放与核销统计 */
  consolation: {
    issued: number
    redeemed: number
  }
}

export type PublishCheckItem = {
  code: string
  message: string
  section: string
}

export type PublishCheckResult = {
  canPublish: boolean
  errors: PublishCheckItem[]
  warnings: PublishCheckItem[]
  infos: PublishCheckItem[]
}

export type ExternalConversion = {
  id: string
  drawId: string
  entryId: string
  externalEventId: string
  conversionType: string
  source: string
  refCode: string
  amountCents: number | null
  currency: string
  identityType: string
  identityValue: string
  payloadJson: string
  occurredAt: string
  createdAt: string
}

/** 创建/编辑表单 shape（与 emptyForm 对齐） */
export type LotteryEditorForm = {
  id: string
  name: string
  description: string
  startTime: string
  endTime: string
  drawTime: string
  winnerCount: number
  maxParticipants: number | null
  expectedParticipants: number
  activityKind: string
  participationMode: string
  experienceType: string
  resultMode: string
  allocationPolicy: string
  accessPassword: string
  showWinners: boolean
  showParticipantCount: 0 | 1
  /** instant：每人最多 spin 次数（≥1）；delayed 忽略 */
  maxSpinsPerEntry: number
  tiers: Array<{ prizeId: string; tierName: string; winnerCount: number; weight?: number }>
  enableProductLink: boolean
  productLink: { url: string; title: string; imageUrl: string; price: string }
  enableViral: boolean
  viralExtraEntriesPerInvite: number
  viralMaxExtraEntries: number
  viralLeaderboardEnabled: boolean
  /** docs/218 保底（仅 instant）：连空 threshold 次后下次必中 */
  enablePity: boolean
  pityThreshold: number
  /** docs/218 每日免费（仅 instant）：每自然日首抽免费 */
  enableDailyFreeSpins: boolean
  dailyFreeSpinsCount: number
  /** docs/218 排行榜奖励明细（多行 "名次:spins次数"，如 "1:3\n2:1"） */
  leaderboardRewardsText: string
  /** docs/217 推荐里程碑（多行 "邀请数:spins次数"，如 "1:2\n3:5"，仅 instant） */
  referralRewardsText: string
  /** docs/250/254 引擎推荐奖励（多行 "邀请数:类型:数量[:券label]"） */
  referralRewardDefsText: string
  enableAfterWinCta: boolean
  afterWinCtaUrl: string
  afterWinCtaTitle: string
  enableAfterLossCta: boolean
  afterLossCtaUrl: string
  afterLossCtaTitle: string
  /**
   * 游戏壳展示（docs/128，写入 promotion.experience）
   * auto：instant 真奖上壳 / delayed 仪式短语
   */
  prizePanelMode: string
  /** 每行一条仪式短语；空则公开端用默认中性词 */
  ritualPhrasesText: string
  /**
   * 秒杀壳（docs/130/131，写入 promotion.flashSale）
   * paymentRequired=false 时为展示/导流壳；true 时进入 cf-lottery 直付发卡门禁。
   */
  enableFlashSale: boolean
  flashSaleSessionLabel: string
  /** docs/222 6.2.1 销售模式：redirect=展示导流, direct_single=直付单件, direct_bulk=直付批发 */
  flashSaleSalesMode: 'redirect' | 'direct_single' | 'direct_bulk'
  flashSaleStockLimit: number | null
  flashSaleMaxPerUser: number
  flashSaleCtaLabel: string
  flashSaleShowCountdown: boolean
  flashSaleShowProgress: boolean
  flashSaleShowStock: boolean
  flashSalePaymentRequired: boolean
  flashSalePriceCents: number | null
  flashSaleCurrency: string
  flashSaleTitle: string
  flashSaleImageUrl: string
  flashSalePricingTiers: Array<{ minQuantity: number; unitPriceCents: number; label: string }>
  /** 表单内按 kind 切换；模板直接读 fields/options，用 any 避免联合类型收窄失败 */
  activityConfig: any
}
