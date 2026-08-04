/**
 * cf-lottery 数据库 Schema
 *
 * 从 cf-shop 抽取，只保留抽奖核心表，新增 SaaS 多租户表。
 * 不包含：products、orders、cards、coupons、referral、voucher、storefront。
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── SaaS 多租户 ──
export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  brandConfig: text("brand_config").notNull().default("{}"),
  extraActivityQuota: integer("extra_activity_quota").notNull().default(0),
  extraParticipantQuota: integer("extra_participant_quota").notNull().default(0),
  extraQuotaExpiresAt: text("extra_quota_expires_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().default(""),
  emailVerified: integer("email_verified").notNull().default(0),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * 外部 IdP 身份绑定（docs/062）。
 * - provider + provider_user_id 唯一：同一 cf-auth sub 只对应一个本地用户。
 * - JWT.sub 始终用本地 users.id，create-tenant / requireAuth 才能闭环。
 * - 禁止仅凭未验证 email 自动合并账号（防接管）。
 */
export const authIdentities = sqliteTable("auth_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** 如 cf-auth */
  provider: text("provider").notNull(),
  /** IdP 侧 sub */
  providerUserId: text("provider_user_id").notNull(),
  email: text("email").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  providerSub: uniqueIndex("idx_auth_identities_provider_sub").on(t.provider, t.providerUserId),
  userIdx: index("idx_auth_identities_user").on(t.userId),
}));

export const tenantMembers = sqliteTable("tenant_members", {
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("owner"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: uniqueIndex("pk_tenant_members").on(t.tenantId, t.userId),
}));

/**
 * 平台成员表（L3 平台运营者）
 *
 * 与 tenant_members 分离，独立管理平台运营者身份。
 * 一个用户可以同时是某租户的成员（通过 tenant_members）和平台运营者（通过 platform_members），
 * 两者互不冲突。
 *
 * role 创建时必须显式写入，不留模糊默认值。
 * 取值：platform_owner | platform_operator | platform_support
 *   - platform_owner: 管理平台成员、系统配置、套餐、兑换码、租户状态
 *   - platform_operator: 查看租户、生成兑换码、查看用量和失败投递
 *   - platform_support: 只读查看指定租户数据
 */
export const platformMembers = sqliteTable("platform_members", {
  userId: text("user_id").primaryKey(),
  role: text("role").notNull(),  // 必须显式写入，不留默认值
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * 平台审计日志（L3 平台运营者写操作）
 *
 * 平台后台跨租户管理系统配置、额度码、租户状态等能力，不能继续复用租户 audit_logs。
 * 单独落表可以避免 tenant_id='__platform__' 这类特殊租户污染租户隔离、统计和审计口径。
 */
export const platformAuditLogs = sqliteTable("platform_audit_logs", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull(),
  actorRole: text("actor_role").notNull().default(""),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull().default(""),
  tenantId: text("tenant_id").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  createdIdx: index("idx_platform_audit_created").on(t.createdAt),
  // 平台审计是低频写入、高价值排查数据；租户和动作筛选必须走索引，
  // 否则审计表增长后平台后台会在 Turso 上产生不必要 rows read 和延迟。
  tenantIdx: index("idx_platform_audit_tenant").on(t.tenantId, t.createdAt),
  actionIdx: index("idx_platform_audit_action").on(t.action, t.createdAt),
  actorIdx: index("idx_platform_audit_actor").on(t.actorUserId, t.createdAt),
  targetIdx: index("idx_platform_audit_target").on(t.targetType, t.targetId, t.createdAt),
}));

/**
 * 持久化限流日志表
 *
 * 替代内存 Map 实现多 Worker 实例下一致的限流。
 * 每次受限操作写入一条记录，查询时按 key + action + 时间窗口 COUNT。
 * 旧记录由定时清理任务删除，或由写入时附带清理。
 *
 * key 格式：`action:identifier`，如 `login:ip_hash`、`register:email`
 */
export const rateLimitLog = sqliteTable("rate_limit_log", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  action: text("action").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  keyActionIdx: index("idx_rate_limit_key_action").on(t.key, t.action, t.createdAt),
}));

/**
 * 租户用量快照表
 *
 * 替代实时 COUNT，用于平台运营后台展示租户用量。
 * 由 Cron 定时任务刷新，避免在管理后台做全表扫描 COUNT。
 * 按租户+日期维度存储，支持按日/月/年聚合。
 */
export const tenantUsageSnapshots = sqliteTable("tenant_usage_snapshots", {
  tenantId: text("tenant_id").notNull(),
  snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD
  activityCount: integer("activity_count").notNull().default(0),
  participantCount: integer("participant_count").notNull().default(0),
  eventCount: integer("event_count").notNull().default(0),
  winnerCount: integer("winner_count").notNull().default(0),
  webhookCount: integer("webhook_count").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: uniqueIndex("pk_tenant_usage_snapshots").on(t.tenantId, t.snapshotDate),
}));

// ── 奖品与码池 ──
export const prizes = sqliteTable("prizes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  imageUrl: text("image_url").notNull().default(""),
  valueText: text("value_text").notNull().default(""),
  prizeType: text("prize_type").notNull().default("code"),
  fulfillmentNote: text("fulfillment_note").notNull().default(""),
  totalCount: integer("total_count").notNull().default(0),
  usedCount: integer("used_count").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const prizeCodes = sqliteTable("prize_codes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  prizeId: text("prize_id").notNull(),
  code: text("code").notNull(),
  secret: text("secret").notNull().default(""),
  note: text("note").notNull().default(""),
  /**
   * 状态机（docs/111 §7.3 + docs/114 §4）：
   *   available → issued（中奖发放）
   *   issued → redeemed（中转站回传核销确认，ext:reward.redeemed）
   *   issued → revoked（违规撤奖 / 运营人工作废 / 退群未核销收回）
   *   issued + expires_at 到期 → expired（自动作废，由 cron 标记）
   *   available → revoked（导入后直接作废）
   */
  status: text("status").notNull().default("available"),
  winnerId: text("winner_id").default(""),
  issuedAt: text("issued_at"),
  /** 奖品卡密过期时间（可空，空=永不过期，限时卡密奖品刚需） */
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  // 这是按租户、奖品、状态领取可用码的性能索引，不是业务唯一约束。
  // 如果误用 uniqueIndex，同一秒导入多条可用码会被数据库拒绝，直接破坏码池能力。
  prizeStatusIdx: index("idx_prize_codes_prize_status").on(t.tenantId, t.prizeId, t.status, t.createdAt),
}));

// ── 抽奖活动 ──
export const lotteryDraws = sqliteTable("lottery_draws", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  publicSlug: text("public_slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("draft"),
  activityKind: text("activity_kind").notNull().default("lottery"),
  participationMode: text("participation_mode").notNull().default("open"),
  experienceType: text("experience_type").notNull().default("wheel"),
  drawTrigger: text("draw_trigger").notNull().default("manual"),
  resultMode: text("result_mode").notNull().default("manual"),
  allocationPolicy: text("allocation_policy").notNull().default("capacity"),
  policyVersion: integer("policy_version").notNull().default(1),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  drawAt: text("draw_at"),
  accessPassword: text("access_password").notNull().default(""),
  maxParticipants: integer("max_participants"),
  winnerCount: integer("winner_count").notNull().default(1),
  showParticipantCount: integer("show_participant_count").notNull().default(1),
  showWinnerCount: integer("show_winner_count").notNull().default(1),
  showWinnerList: integer("show_winner_list").notNull().default(0),
  /**
   * 公开展示：1 用户面可见；0 公开详情/列表拒绝（管理端仍可见）。
   * 与 status、start/end 时间窗独立——drawn 后可隐藏公示而不改业务终态（docs/083，对齐 cf-shop）。
   */
  visible: integer("visible").notNull().default(1),
  drawnAt: text("drawn_at"),
  failureReason: text("failure_reason").notNull().default(""),
  drawSeedHash: text("draw_seed_hash").notNull().default(""),
  drawSeed: text("draw_seed").notNull().default(""),
  algorithmVersion: text("algorithm_version").notNull().default("uniform_v1"),
  // 导流：关联商品推广链接（JSON 格式：{url, title, imageUrl, price}）
  productLink: text("product_link").notNull().default("{}"),
  // 活动引擎导流配置（版本化 JSON）。productLink 保留为旧字段兼容。
  promotionConfig: text("promotion_config").notNull().default("{}"),
  // 活动玩法配置（版本化 JSON）。问卷字段、投票选项等低成本玩法的规则源统一放这里，
  // 提交时由后端按该配置做白名单校验，避免把选项塞进 identity_value 或让前端自说自话。
  activityConfig: text("activity_config").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  // 后台列表和定时任务只需要普通索引；同一租户同一状态下当然允许存在多个活动。
  tenantStatusIdx: index("idx_draws_tenant_status").on(t.tenantId, t.status, t.createdAt),
  // 同一开奖时间可能对应多个活动，定时扫描必须是普通索引，不能限制业务并发排期。
  dueIdx: index("idx_draws_due").on(t.status, t.drawAt),
}));

export const lotteryPrizeTiers = sqliteTable("lottery_prize_tiers", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  prizeId: text("prize_id").notNull(),
  tierName: text("tier_name").notNull().default("中奖"),
  winnerCount: integer("winner_count").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(100),
});

// ── 参与资格 ──
export const lotteryRosterMembers = sqliteTable("lottery_roster_members", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  identityType: text("identity_type").notNull().default("email"),
  identityValue: text("identity_value").notNull(),
  displayName: text("display_name").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  unique: uniqueIndex("idx_roster_unique").on(t.tenantId, t.drawId, t.identityType, t.identityValue),
}));

export const lotteryInviteCodes = sqliteTable("lottery_invite_codes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  code: text("code").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  unique: uniqueIndex("idx_invite_unique").on(t.tenantId, t.drawId, t.code),
}));

// ── 候选池与中奖记录 ──
export const lotteryEntries = sqliteTable("lottery_entries", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  identityType: text("identity_type").notNull().default("email"),
  identityValue: text("identity_value").notNull(),
  displayName: text("display_name").notNull().default(""),
  inviteCodeId: text("invite_code_id").default(""),
  ipHash: text("ip_hash").notNull().default(""),
  joinedAt: text("joined_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  unique: uniqueIndex("idx_entries_unique").on(t.tenantId, t.drawId, t.identityType, t.identityValue),
  identityIdx: index("idx_entries_identity").on(t.tenantId, t.identityType, t.identityValue),
}));

export const lotteryWinners = sqliteTable("lottery_winners", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  tierId: text("tier_id").notNull(),
  entryId: text("entry_id").notNull(),
  identityType: text("identity_type").notNull(),
  identityValue: text("identity_value").notNull(),
  prizeCodeId: text("prize_code_id").default(""),
  drawnAt: text("drawn_at").notNull().default(sql`(datetime('now'))`),
  notificationStatus: text("notification_status").notNull().default("pending"),
  notificationError: text("notification_error").notNull().default(""),
}, (t) => ({
  unique: uniqueIndex("idx_winners_unique").on(t.tenantId, t.drawId, t.entryId),
}));

// ── 审计日志 ──
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ── 活动结果 ──
// 抽奖继续使用 lottery_winners；接龙、预约、候补、审核等活动使用统一 outcome 记录。
export const activityOutcomes = sqliteTable("activity_outcomes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  entryId: text("entry_id").notNull(),
  outcomeType: text("outcome_type").notNull().default("assignment"),
  status: text("status").notNull().default("assigned"),
  sequenceNo: integer("sequence_no").notNull(),
  assignmentNo: integer("assignment_no"),
  resultKey: text("result_key").notNull().default(""),
  resultLabel: text("result_label").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  decidedAt: text("decided_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  entryUnique: uniqueIndex("idx_activity_outcomes_entry").on(
    t.tenantId, t.drawId, t.outcomeType, t.entryId,
  ),
  sequenceUnique: uniqueIndex("idx_activity_outcomes_sequence").on(
    t.tenantId, t.drawId, t.outcomeType, t.sequenceNo,
  ),
  assignmentUnique: uniqueIndex("idx_activity_outcomes_assignment").on(
    t.tenantId, t.drawId, t.outcomeType, t.assignmentNo,
  ),
  drawStatusIdx: index("idx_activity_outcomes_draw_status").on(
    t.tenantId, t.drawId, t.outcomeType, t.status, t.sequenceNo,
  ),
}));

// ── 邮箱验证码 ──
export const emailAccessCodes = sqliteTable("email_access_codes", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  drawId: text("draw_id").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  used: integer("used").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  // 只限制“未使用验证码”唯一，允许历史 used=1 记录保留审计痕迹。
  // 旧的 UNIQUE(email, draw_id, used) 会在第二次发码时把多个 used=1 历史记录互相冲突。
  activeEmailDrawUnique: uniqueIndex("idx_email_code_active").on(t.email, t.drawId).where(sql`used = 0`),
}));

// ── 系统配置（key-value 存储，供管理后台动态配置） ──
export const systemConfig = sqliteTable("system_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ── 参与者黑名单（按租户级别，防止同一人用多个邮箱参与） ──
export const lotteryBlacklist = sqliteTable("lottery_blacklist", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  identityValue: text("identity_value").notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  blacklistTenantIdx: uniqueIndex("idx_blacklist_value").on(t.tenantId, t.identityValue),
}));

// ── API 密钥（用于外部系统集成） ──
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  apiKeyTenantIdx: index("idx_api_key_tenant").on(t.tenantId, t.active, t.createdAt),
}));

// ── Webhook 配置（外部系统事件通知） ──
export const webhookConfigs = sqliteTable("webhook_configs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  url: text("url").notNull(),
  events: text("events").notNull().default("[\"draw.completed\",\"prize.issued\"]"),
  signingSecret: text("signing_secret").notNull().default(""),
  active: integer("active").notNull().default(1),
  lastSentAt: text("last_sent_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  webhookTenantIdx: index("idx_webhook_tenant").on(t.tenantId, t.active, t.createdAt),
}));

// ── Webhook 投递记录（签名、重试、失败原因） ──
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  webhookConfigId: text("webhook_config_id").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  url: text("url").notNull(),
  payloadJson: text("payload_json").notNull(),
  signature: text("signature").notNull().default(""),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: text("next_retry_at"),
  responseStatus: integer("response_status"),
  responseBody: text("response_body").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  sentAt: text("sent_at"),
}, (t) => ({
  deliveryTenantIdx: index("idx_webhook_deliveries_tenant").on(t.tenantId, t.status, t.createdAt),
  deliveryEventIdx: uniqueIndex("idx_webhook_deliveries_event").on(t.webhookConfigId, t.eventId),
}));

// ── 优惠券码池（唯一码，支持核销） ──
export const couponCodes = sqliteTable("coupon_codes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id"),
  code: text("code").notNull(),
  label: text("label").notNull().default(""),
  status: text("status").notNull().default("available"), // available/reserved/issued/redeemed/expired/revoked
  recipientEmail: text("recipient_email"),
  redeemedAt: text("redeemed_at"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  couponTenantIdx: index("idx_coupon_tenant").on(t.tenantId, t.status, t.createdAt),
  couponCodeUnique: uniqueIndex("idx_coupon_code").on(t.tenantId, t.code),
}));

// ── 分享裂变记录（追踪分享带来的新参与） ──
export const shareRecords = sqliteTable("share_records", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  sharerEntryId: text("sharer_entry_id").notNull(),
  shareCode: text("share_code").notNull().unique(),
  clickedCount: integer("clicked_count").notNull().default(0),
  joinedCount: integer("joined_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  shareDrawIdx: index("idx_share_draw").on(t.tenantId, t.drawId, t.createdAt),
  shareCodeUnique: uniqueIndex("idx_share_code").on(t.shareCode),
}));

// ── 活动事件（导流、归因、漏斗统计的统一事实表） ──
export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  entryId: text("entry_id").notNull().default(""),
  eventType: text("event_type").notNull(),
  source: text("source").notNull().default(""),
  medium: text("medium").notNull().default(""),
  campaign: text("campaign").notNull().default(""),
  refCode: text("ref_code").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  ipHash: text("ip_hash").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  drawEventIdx: index("idx_activity_events_draw_event").on(t.tenantId, t.drawId, t.eventType, t.createdAt),
  entryIdx: index("idx_activity_events_entry").on(t.tenantId, t.drawId, t.entryId, t.createdAt),
  refIdx: index("idx_activity_events_ref").on(t.tenantId, t.drawId, t.refCode, t.createdAt),
}));

// ── 活动提交（问卷答案、投票选项、资料领取请求等动态表单 payload） ──
// 033 基线要求：所有玩法的动态表单答案统一走 activity_submissions，
// 不做独立的 forms / votes / claims 表。一个 entry 最多一条 submission（UNIQUE 约束），
// 保证"参与即提交"的原子语义。
export const activitySubmissions = sqliteTable("activity_submissions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  entryId: text("entry_id").notNull(),
  /** 动态表单答案（JSON 格式，字段由 activity_config 定义） */
  payloadJson: text("payload_json").notNull().default("{}"),
  /** 幂等键（P2 阶段启用，防止网络重试导致重复提交） */
  idempotencyKey: text("idempotency_key").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  // 一个 entry 最多一条提交；join/verify-and-join 同事务写入时利用此约束防重复
  entryUnique: uniqueIndex("idx_activity_submissions_entry").on(t.tenantId, t.drawId, t.entryId),
  // 后台查询某个活动下所有提交记录
  drawIdx: index("idx_activity_submissions_draw").on(t.tenantId, t.drawId, t.createdAt),
  // 幂等键索引（P2）
  idempotencyIdx: index("idx_activity_submissions_idempotency").on(t.tenantId, t.drawId, t.idempotencyKey),
}));

// ── 外部转化回传（成交、核销、注册等外部系统事实） ──
// 只有外部系统通过 API Key 回传后，平台才可把它展示为外部转化；UTM、点击和参与不能替代本表。
export const externalConversions = sqliteTable("external_conversions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  entryId: text("entry_id").notNull().default(""),
  externalEventId: text("external_event_id").notNull(),
  conversionType: text("conversion_type").notNull(),
  source: text("source").notNull().default(""),
  refCode: text("ref_code").notNull().default(""),
  amountCents: integer("amount_cents"),
  currency: text("currency").notNull().default(""),
  identityType: text("identity_type").notNull().default(""),
  identityValue: text("identity_value").notNull().default(""),
  payloadJson: text("payload_json").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  conversionEventUnique: uniqueIndex("idx_external_conversions_event").on(t.tenantId, t.source, t.externalEventId),
  conversionDrawIdx: index("idx_external_conversions_draw").on(t.tenantId, t.drawId, t.conversionType, t.createdAt),
  conversionEntryIdx: index("idx_external_conversions_entry").on(t.tenantId, t.drawId, t.entryId, t.createdAt),
  conversionRefIdx: index("idx_external_conversions_ref").on(t.tenantId, t.drawId, t.refCode, t.createdAt),
}));

// ── 兑换码（运营者生成，终端用户兑换获取活动额度） ──
export const redemptionCodes = sqliteTable("redemption_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),          // 兑换码，如 LUCKY-XXXX-XXXX
  plan: text("plan").notNull().default("custom"),  // 套餐标识
  activityQuota: integer("activity_quota").notNull().default(0),   // 额外活动次数
  participantQuota: integer("participant_quota").notNull().default(0), // 额外参与人数
  durationDays: integer("duration_days").notNull().default(30),     // 有效天数
  maxUses: integer("max_uses").notNull().default(1),  // 最大使用次数
  usedCount: integer("used_count").notNull().default(0), // 已使用次数
  status: text("status").notNull().default("active"),   // active/used/expired/disabled
  note: text("note").notNull().default(""),              // 备注
  createdBy: text("created_by").notNull().default(""),   // 创建者
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  codeStatusIdx: index("idx_redemption_code_status").on(t.status, t.expiresAt, t.createdAt),
}));

// ── 兑换记录（谁在什么时候兑换了什么码） ──
export const redemptionRecords = sqliteTable("redemption_records", {
  id: text("id").primaryKey(),
  codeId: text("code_id").notNull(),               // 兑换码 ID
  code: text("code").notNull(),                    // 兑换码原文
  tenantId: text("tenant_id").notNull(),            // 兑换的租户 ID
  tenantName: text("tenant_name").notNull().default(""), // 兑换的租户名
  activityQuotaGranted: integer("activity_quota_granted").notNull().default(0),  // 获得的活动次数
  participantQuotaGranted: integer("participant_quota_granted").notNull().default(0), // 获得的参与人数
  durationDaysGranted: integer("duration_days_granted").notNull().default(30),  // 获得的有效天数
  expiresAt: text("expires_at"),                   // 额度到期时间
  redeemedAt: text("redeemed_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  recordTenantIdx: index("idx_redemption_record_tenant").on(t.tenantId, t.redeemedAt),
  recordCodeIdx: index("idx_redemption_record_code").on(t.codeId, t.redeemedAt),
}));
