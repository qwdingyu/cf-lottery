/**
 * 公开页抽奖类型。
 *
 * 与管理端 types 分离：公开页字段更瘦（无 tenantId / policyVersion 等），
 * 避免把后台表单 shape 泄漏到 C 端。
 */

export type LotteryDraw = {
  id: string
  publicSlug?: string
  title: string
  name?: string
  description?: string
  status: string
  activityKind?: string
  participationMode: string
  experienceType?: string
  resultMode?: string
  allocationPolicy?: string
  startAt: string
  startTime?: string
  endAt: string
  endTime?: string
  drawAt: string | null
  drawTime?: string | null
  winnerCount: number
  /** instant：每人 spin 次数硬顶（公开详情返回） */
  maxSpinsPerEntry?: number
  maxParticipants?: number | null
  showParticipantCount: number
  showWinnerCount: number
  showWinnerList: number
  showWinners?: boolean
  maxWinners?: number
  participantCount?: number
  entryCount?: number
  winners?: Array<{ identity: string }>
  prizes?: Array<{
    name?: string
    tierName?: string
    description?: string
    imageUrl?: string
    valueText?: string
    winnerCount?: number
    /** 与 spin.prizeIndex 对齐的扇区索引 */
    prizeIndex?: number
    weight?: number
  }>
  /**
   * 游戏壳展示（docs/128，公开 API 计算）：
   * delayed 默认仪式短语；instant 真奖名。
   */
  prizePanelMode?: string
  shellLabels?: string[]
  shellUsesRealPrizes?: boolean
  prizePoolDisplay?: 'full' | 'summary' | 'hidden' | string
  productId?: string
  productTitle?: string
  productLink?: { url: string; title: string; imageUrl?: string; price?: string }
  activityConfig?: ActivityConfig
  /** 运营者配置的多状态 CTA / 裂变（公开 API 已解析 JSON） */
  promotionConfig?: {
    ctas?: {
      after_win?: { url?: string; title?: string }
      after_loss?: { url?: string; title?: string }
    }
    viral?: {
      enabled?: boolean
      extraEntriesPerInvite?: number
      maxExtraEntries?: number
      leaderboardEnabled?: boolean
    }
    /** 体验壳：仪式短语 / 面板模式（docs/128） */
    experience?: {
      prizePanelMode?: string
      ritualPhrases?: string[]
    }
    /** 秒杀配置节点（原始配置；运行时以 flashSale 顶层字段为准） */
    flashSale?: Record<string, unknown>
  }
  /**
   * 秒杀运行时快照（docs/130，公开 API 计算）。
   * claimed/progress 来自真实 entries，不是运营手填假进度。
   */
  flashSale?: {
    enabled?: boolean
    sessionLabel?: string
    stockLimit?: number | null
    effectiveStockLimit?: number | null
    maxPerUser?: number
    showCountdown?: boolean
    showProgress?: boolean
    showStock?: boolean
    ctaLabel?: string
    paymentRequired?: boolean
    priceCents?: number | null
    pricingTiers?: Array<{ minQuantity?: number; unitPriceCents?: number; label?: string }>
    currency?: string
    title?: string
    claimed?: number
    remaining?: number | null
    progressPercent?: number
  }
}

export type ActivityConfig =
  | {
      version: 1
      kind: 'survey'
      fields: Array<{
        id: string
        label: string
        type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox'
        required: boolean
        maxLength: number
        options: Array<{ id: string; label: string }>
      }>
    }
  | {
      version: 1
      kind: 'vote'
      selection: 'single'
      options: Array<{ id: string; label: string; description: string; imageUrl: string }>
    }

export type ActivityOutcome = {
  id?: string
  outcomeType?: string
  status: string
  sequenceNo?: number
  assignmentNo?: number | null
  resultLabel?: string
  decidedAt?: string | null
}

export type MyEntry = {
  drawId: string
  joinedAt?: string
  drawName?: string
  drawStatus?: string
  drawTime?: string
  /** 玩法类型：记录行「未中奖」标签仅 lottery/claim 使用（docs/104） */
  activityKind?: string
  /** 本场参与记录 ID：裂变分享 / 排行榜「我的」数据依赖（docs/108） */
  entryId?: string
}

export type ActivityEventType =
  | 'page_view'
  | 'participation_started'
  | 'participation_completed'
  | 'cta_click'
  | 'share_click'
