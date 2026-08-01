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

export const tenantMembers = sqliteTable("tenant_members", {
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("owner"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: uniqueIndex("pk_tenant_members").on(t.tenantId, t.userId),
}));

// ── 奖品与码池 ──
export const prizes = sqliteTable("prizes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  imageUrl: text("image_url").notNull().default(""),
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
  status: text("status").notNull().default("available"),
  winnerId: text("winner_id").default(""),
  issuedAt: text("issued_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  prizeStatusIdx: uniqueIndex("idx_prize_codes_prize_status").on(t.tenantId, t.prizeId, t.status, t.createdAt),
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
  drawnAt: text("drawn_at"),
  failureReason: text("failure_reason").notNull().default(""),
  drawSeedHash: text("draw_seed_hash").notNull().default(""),
  drawSeed: text("draw_seed").notNull().default(""),
  algorithmVersion: text("algorithm_version").notNull().default("uniform_v1"),
  // 导流：关联商品推广链接（JSON 格式：{url, title, imageUrl, price}）
  productLink: text("product_link").notNull().default("{}"),
  // 活动引擎导流配置（版本化 JSON）。productLink 保留为旧字段兼容。
  promotionConfig: text("promotion_config").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  tenantStatusIdx: uniqueIndex("idx_draws_tenant_status").on(t.tenantId, t.status, t.createdAt),
  dueIdx: uniqueIndex("idx_draws_due").on(t.status, t.drawAt),
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
  emailDrawIdx: uniqueIndex("idx_email_code_draw").on(t.email, t.drawId, t.used),
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
  active: integer("active").notNull().default(1),
  lastSentAt: text("last_sent_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  webhookTenantIdx: index("idx_webhook_tenant").on(t.tenantId, t.active, t.createdAt),
}));

// ── 优惠券码池（唯一码，支持核销） ──
export const couponCodes = sqliteTable("coupon_codes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id"),
  code: text("code").notNull(),
  label: text("label").notNull().default(""),
  status: text("status").notNull().default("available"), // available/reserved/issued/redeemed/expired
  recipientEmail: text("recipient_email"),
  redeemedAt: text("redeemed_at"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  couponTenantIdx: index("idx_coupon_tenant").on(t.tenantId, t.status, t.createdAt),
  couponCodeUnique: uniqueIndex("idx_coupon_code").on(t.tenantId, t.code),
}));
