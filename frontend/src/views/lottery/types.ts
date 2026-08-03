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
  }>
  productId?: string
  productTitle?: string
  productLink?: { url: string; title: string; imageUrl?: string; price?: string }
  activityConfig?: ActivityConfig
  /** 运营者配置的多状态 CTA（中奖/未中奖导流） */
  promotionConfig?: {
    ctas?: {
      after_win?: { url?: string; title?: string }
      after_loss?: { url?: string; title?: string }
    }
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
}

export type ActivityEventType =
  | 'page_view'
  | 'participation_started'
  | 'participation_completed'
  | 'cta_click'
  | 'share_click'
