
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
  /* 社群功能（docs/180）：差异化开放社群绑定能力 */
  communityEnabled: boolean;          // 套餐是否开放社群功能（布尔硬门）
  maxPlatformTargets: number | null;  // 最大群绑定数（null=不限，软配额，POST/PUT 拦增量）
  maxGroupMembers: number | null;     // 每群最大成员数（null=不限，运行时硬配额，跨活动累计）
};

/**
 * 活动真实状态常量。
 *
 * 为什么集中定义：活动状态参与发布、暂停、开奖、删除、公开查询等多条核心链路。
 * 字符串散落时最容易出现「某条路径漏改状态名」或把管理端虚拟筛选值 active
 * 当成真实 DB 状态的问题。这里仅放 lottery_draws.status 会持久化的真实值。
 */
export const DRAW_STATUS = {
  DRAFT: "draft",
  OPEN: "open",
  PAUSED: "paused",
  DRAWING: "drawing",
  DRAWN: "drawn",
  CANCELLED: "cancelled",
} as const;

export type DrawStatus = typeof DRAW_STATUS[keyof typeof DRAW_STATUS];

export const DRAW_STATUS_VALUES = Object.values(DRAW_STATUS) as DrawStatus[];

/**
 * 管理端「进行中」虚拟筛选使用的状态集合。
 * 注意：active 不是数据库状态，只是列表筛选语义，必须由路由层单独处理。
 */
export const ACTIVE_DRAW_STATUSES = [
  DRAW_STATUS.DRAFT,
  DRAW_STATUS.OPEN,
  DRAW_STATUS.PAUSED,
  DRAW_STATUS.DRAWING,
] as const;

/**
 * 直付卡密池占用的唯一状态口径。
 * draft 尚未对外售卖，不占用；open/paused/drawing 可能已有支付、补单或履约在途，必须独占。
 */
export const DIRECT_SALE_CODE_POOL_OCCUPYING_STATUSES = [
  DRAW_STATUS.OPEN,
  DRAW_STATUS.PAUSED,
  DRAW_STATUS.DRAWING,
] as const;

/** 选择器提前反馈与发布预检共用，避免一处把“0 条占用”误判为冲突。 */
export function hasDirectSaleCodePoolConflict(activeUsageCount: number): boolean {
  return activeUsageCount > 0;
}

/** 可物理删除的活动状态；open/drawing 会影响参与和开奖并发，必须拒绝删除。 */
export const DELETABLE_DRAW_STATUSES = [
  DRAW_STATUS.DRAFT,
  DRAW_STATUS.PAUSED,
  DRAW_STATUS.DRAWN,
  DRAW_STATUS.CANCELLED,
] as const;

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
