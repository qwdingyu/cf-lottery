
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
  | "external_conversion_reported";

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
  | "activity.event.recorded";

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
