
/**
 * 抽奖服务层 — 类型与常量模块（lottery-service 拆分，docs/049 #17）
 *
 * 纯声明、无运行时依赖：全平台共享的类型定义 + 事件/转化类型白名单常量
 * + 单活动默认参与人数上限。被 plan / utils / 业务域等子模块复用。
 */

/** 开奖结果 */
export type DrawResult = {
  drawId: string;        // 活动 ID
  winnerCount: number;   // 实际中奖人数
  candidateCount: number; // 候选池总人数
};

export type ActivityOutcome = {
  id: string;
  drawId: string;
  entryId: string;
  outcomeType: string;
  status: string;
  sequenceNo: number;
  assignmentNo: number | null;
  resultKey: string;
  resultLabel: string;
  metadataJson: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TenantPlanLimits = {
  plan: string;
  maxActivities: number | null;
  maxParticipantsPerActivity: number;
  maxMembers: number | null;
  maxWebhooks: number | null;
};

export type ActivityEventType =
  | "page_view"
  | "participation_started"
  | "participation_completed"
  | "participation_cancelled"
  | "outcome_assigned"
  | "cta_impression"
  | "cta_click"
  | "share_created"
  | "share_click"
  | "attributed_join"
  | "external_conversion_reported"
  /** 奖励意图已生成（通知中转站发卡时记录） */
  | "reward_earned"
  /** 处罚请求已发起（波及名单计算后记录） */
  | "penalty_requested"
  /** 外部事件：退群上报 */
  | "ext:member.left_group"
  /** 外部事件：中转站回传发卡确认 */
  | "ext:reward.issued"
  /** 外部事件：中转站回传处罚执行确认 */
  | "ext:penalty.executed"
  /** 外部事件：中转站回传兑换码核销确认（标记 prizeCode redeemed，docs/114 §4） */
  | "ext:reward.redeemed"
  /** 平台签到：群助手每日签到奖励（docs/171） */
  | "daily_checkin";

export type RecordActivityEventInput = {
  tenantId: string;
  drawId: string;
  entryId?: string;
  eventType: ActivityEventType;
  source?: string;
  medium?: string;
  campaign?: string;
  refCode?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string;
  userAgent?: string;
};

export type WebhookEventType =
  | "draw.published"
  | "draw.completed"
  | "entry.created"
  | "outcome.assigned"
  | "prize.issued"
  | "share.created"
  | "share.clicked"
  | "activity.event.recorded"
  | "reward.earned"
  | "penalty.requested";

export type EnqueueWebhookEventInput = {
  tenantId: string;
  eventType: WebhookEventType;
  data: Record<string, unknown>;
  eventId?: string;
};

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ExternalConversionType =
  | "registration"
  | "purchase"
  | "coupon_redeemed"
  | "lead_qualified"
  | "offline_redeemed"
  | "custom";

export type RecordExternalConversionInput = {
  tenantId: string;
  drawId?: string;
  publicSlug?: string;
  externalEventId: string;
  conversionType: ExternalConversionType;
  source?: string;
  entryId?: string;
  identityType?: string;
  identityValue?: string;
  refCode?: string;
  amountCents?: number | null;
  currency?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
};

export const ACTIVITY_EVENT_TYPES = new Set<ActivityEventType>([
  "page_view",
  "participation_started",
  "participation_completed",
  "outcome_assigned",
  "cta_impression",
  "cta_click",
  "share_created",
  "share_click",
  "attributed_join",
  "external_conversion_reported",
  "reward_earned",
  "penalty_requested",
  "ext:member.left_group",
  "ext:reward.issued",
  "ext:penalty.executed",
  "ext:reward.redeemed",
  "daily_checkin",
]);

export const WEBHOOK_EVENT_TYPES = new Set<WebhookEventType>([
  "draw.published",
  "draw.completed",
  "entry.created",
  "outcome.assigned",
  "prize.issued",
  "share.created",
  "share.clicked",
  "activity.event.recorded",
  /** 通知中转站生成奖励（111 方案：拉新归因成功后触发） */
  "reward.earned",
  /** 通知中转站执行处罚（111 方案：退群波及名单计算后触发） */
  "penalty.requested",
]);

export const EXTERNAL_CONVERSION_TYPES = new Set<ExternalConversionType>([
  "registration",
  "purchase",
  "coupon_redeemed",
  "lead_qualified",
  "offline_redeemed",
  "custom",
]);

export const DEFAULT_ACTIVITY_PARTICIPANT_CAP = 5000;
