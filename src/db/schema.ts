/**
 * cf-lottery 数据库 Schema
 *
 * 从 cf-shop 抽取，只保留抽奖核心表，新增 SaaS 多租户表。
 * 不包含：products、orders、cards、coupons、referral、voucher、storefront。
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
// P1-13：cf-core 管理员审计日志表（统一审计入口，需迁移创建 admin_audit_logs）
import { adminAuditLogs } from "@usethink/cf-core/db/schema";
export { adminAuditLogs };

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
  /** 店铺公开 Slug(公开唯一,不暴露内部 ID;L2 可自定义) */
  storeSlug: text("store_slug").unique(),
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

/**
 * 临时访问令牌（docs/179）。
 *
 * 核心用途：Bot 在群内命令（如 /我的卡密）中生成一次性 Web 链接，
 * 用户无需登录即可在浏览器查看卡密。解决「私聊失败后卡密无法 Web 找回」的闭环。
 *
 * 设计决策：
 * - token_hash 存 SHA-256 哈希，不存明文（防库泄漏后直接窃取可用令牌）。
 * - 一次性：used=1 后不可再复用；短时效：expires_at 到期作废。
 * - purpose 预留扩展（card_code / my_prize / ...），当前仅 card_code。
 */
export const accessTokens = sqliteTable("access_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** 令牌明文 SHA-256 哈希（明文只在 Bot 私聊/群回复中下发一次） */
  tokenHash: text("token_hash").notNull(),
  /** 用途：card_code 等 */
  purpose: text("purpose").notNull().default("card_code"),
  /**
   * 令牌所属 drawId（P0-1 安全修复：跨租户隔离）。
   * 非空时，public-access.ts 查询 winner 时按 drawId 过滤，防止同一 userId 跨租户看到其他租户的卡密。
   * 空字符串表示旧版本令牌；公共卡密访问接口会拒绝此类令牌，
   * 必须重新生成带活动范围的令牌。
   */
  drawId: text("draw_id").notNull().default(""),
  /** 过期时间（ISO 字符串） */
  expiresAt: text("expires_at").notNull(),
  /** 是否已使用（一次性） */
  used: integer("used").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  tokenHashUnique: uniqueIndex("idx_access_tokens_hash").on(t.tokenHash),
  userPurposeIdx: index("idx_access_tokens_user").on(t.userId, t.purpose),
}));

/**
 * 跨平台身份绑定（docs/179）。
 *
 * 核心用途：同一用户希望把 QQ 与 Telegram 两个平台身份关联到同一个 users.id，
 * 从而在任一平台参与的卡密都能通过统一 Web 链接查看。
 *
 * 设计决策：
 * - 绑定码（code）为 6 位短码，短时效（10 分钟）、一次性。
 * - 用户在「第一平台」执行 /绑定 生成码，在「第二平台」执行 /绑定 <code> 完成关联，
 *   从而证明用户同时拥有两个平台身份（ownership proof）。
 * - 合并只重写 auth_identities.userId，不迁移 lottery_entries（保持存量约束）。
 */
export const platformBindings = sqliteTable("platform_bindings", {
  id: text("id").primaryKey(),
  /** 6 位绑定码（无需哈希：短时效 + 一次性 + 高熵，且需要明文回显给用户） */
  code: text("code").notNull(),
  /** 发起绑定码的平台：qq / telegram */
  sourceProvider: text("source_provider").notNull(),
  /** 发起方平台用户 ID */
  sourceProviderUserId: text("source_provider_user_id").notNull(),
  /** 发起方关联的 users.id（合并目标） */
  sourceUserId: text("source_user_id").notNull(),
  /** 过期时间（ISO 字符串） */
  expiresAt: text("expires_at").notNull(),
  /** 是否已使用（一次性） */
  used: integer("used").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  codeUnique: uniqueIndex("idx_platform_bindings_code").on(t.code),
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
 *   - platform_support: 只读查看租户数据（必须通过 tenantId 指定租户，禁止全量拉取，docs/129 §五）
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
  /** maintenance 清理按 key 前缀 + created_at 判断保留窗口，补 key+created_at 索引降低大表扫描。 */
  keyCreatedIdx: index("idx_rate_limit_key_created").on(t.key, t.createdAt),
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
  /** 批量直付订单 ID；同一订单可发多张码，winner_id 保留给中奖/核销兼容。 */
  paymentOrderId: text("payment_order_id"),
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
  /**
   * 直付秒杀当前占用名额计数器（reserved/pending/paid）。
   * 参与热路径用条件 UPDATE 做 CAS，避免 COUNT(lottery_entries) 随规模线性增长。
   */
  activeParticipantCount: integer("active_participant_count").notNull().default(0),
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
  /**
   * instant 同一 entry 累计成功 spin 次数硬顶（docs/116）。
   * 0 = 未配置（delayed 默认）；result_mode=instant 发布预检要求 ≥1。
   */
  maxSpinsPerEntry: integer("max_spins_per_entry").notNull().default(0),
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
  /** 已发放数量（CAS 乐观锁计数器，用于 instant spin 奖档上限）。使用
   * UPDATE ... SET awarded_count = awarded_count + 1 WHERE awarded_count < winner_count
   * 替代 SELECT COUNT(lottery_winners) 读改写，消除 PostgreSQL/MySQL 多写者超发风险。 */
  awardedCount: integer("awarded_count").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(100),
  /** instant 加权抽样权重；0=不参与即时抽（delayed performDraw 忽略本列） */
  weight: integer("weight").notNull().default(0),
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
  /** instant：当前剩余可抽次数（docs/116 不变量 left = granted - used） */
  spinsLeft: integer("spins_left").notNull().default(0),
  /** instant：累计已发放额度（含 join 初值 + 裂变） */
  spinsTotalGranted: integer("spins_total_granted").notNull().default(0),
  /** instant：因有效邀请累计加到 granted 的部分（≤ maxExtraSpins） */
  spinsViralEarned: integer("spins_viral_earned").notNull().default(0),
  /**
   * 支付状态（docs/131 §8 软释放）：秒杀直付专用。
   * '' = 无支付需求（普通参与）；reserved = 直付秒杀已预约待创建订单；
   * pending = 订单创建中/待支付；paid = 已支付；expired = 超时释放。
   * 名额统计（claimed）排除 expired，实现软释放（不删 entry，保留审计链）。
   */
  /**
   * 直付秒杀名额状态（普通非支付活动固定为 ""）：
   * reserved=参与成功且名额 CAS 已占用，pending=已建支付单，
   * paid=已支付并完成发卡，expired=支付超时且名额已释放。
   * 已收款但暂时未发卡的异常只写入 payment_orders.status，
   * entry 保持 pending 以继续占住名额；完整定义统一维护在
   * services/payment/payment-status.ts。
   */
  paymentStatus: text("payment_status").notNull().default(""),
  /** 最近一次签到日期（YYYY-MM-DD，NULL 表示从未签到）。用于并发安全的每日签到去重：
   * UPDATE ... SET spins_left += ?, last_checkin_date = ?
   * WHERE ... AND (last_checkin_date IS NULL OR last_checkin_date < today)
   * 只有第一个并发请求能通过 WHERE 条件，第二个 UPDATE 影响 0 行即判定已签到。 */
  lastCheckinDate: text("last_checkin_date"),
  /** 连续签到天数（docs/172）。用于连续签到递增奖励计算：
   *  - 0 = 未签到（初始值）
   *  - 1+ = 连续签到天数，断签重置为 1
   *  与 lastCheckinDate 在同一个原子 UPDATE 中维护，无需额外事务。 */
  checkinStreak: integer("checkin_streak").notNull().default(0),
}, (t) => ({
  unique: uniqueIndex("idx_entries_unique").on(t.tenantId, t.drawId, t.identityType, t.identityValue),
  identityIdx: index("idx_entries_identity").on(t.tenantId, t.identityType, t.identityValue),
  /** 公开卡密找回/平台身份映射按活动 + 身份查 entry，避免跨活动全表扫描。 */
  drawIdentityIdx: index("idx_entries_identity_lookup").on(t.drawId, t.identityType, t.identityValue),
  /** 直付秒杀热路径：容量 COUNT 与公开进度都按活动和支付软释放状态过滤。 */
  drawPaymentIdx: index("idx_entries_tenant_draw_payment_status").on(t.tenantId, t.drawId, t.paymentStatus),
}));

/**
 * spins 流水日志（docs/172 §5.5 P1）。
 *
 * 审计能力：记录每次 spins 变动（签到奖励 / 抽奖消耗 / 裂变邀请 / join 初始额度），
 * 便于排查「次数从哪来、用到哪去」。只追加不更新，与 lottery_entries 分表解耦，
 * 避免在热路径的 entry 行上做读改写。
 *
 * 约定：
 * - delta > 0 为收入（签到/裂变/join 初始），delta < 0 为支出（抽奖消耗）
 * - balanceAfter 为本次变动后的余额快照（best-effort，SQLite 单写者下读改写一致）
 * - reason 枚举：join / checkin / spin / viral / purchase（purchase 预留，当前无购买加次流程）
 * - refId：关联单据号（spin 关联 lottery_spins.id，裂变关联邀请事件等）
 */
export const spinsLog = sqliteTable(
  "spins_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    entryId: text("entry_id").notNull(),
    /** 用户标识（identityType + identityValue 的面向用户口径，便于不 join 直接审计） */
    userId: text("user_id").notNull(),
    /** 本次变动量（正=收入，负=支出） */
    delta: integer("delta").notNull(),
    /** 变动后余额快照 */
    balanceAfter: integer("balance_after").notNull(),
    /** 变动原因：join/checkin/spin/viral/purchase */
    reason: text("reason").notNull(),
    /** 关联单据号（spin_id / 邀请事件等） */
    refId: text("ref_id"),
    /** 变动时间 */
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    entryIdx: index("idx_spins_log_entry").on(t.tenantId, t.entryId),
    userIdIdx: index("idx_spins_log_user").on(t.tenantId, t.userId),
    reasonIdx: index("idx_spins_log_reason").on(t.tenantId, t.reason, t.createdAt),
  }),
);

/**
 * 即时开奖每次 spin 审计行（含未中）。
 * 幂等：UNIQUE(tenant, draw, idempotency_key)；多奖靠 winners.spin_id 1:1。
 */
export const lotterySpins = sqliteTable("lottery_spins", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  entryId: text("entry_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  won: integer("won").notNull().default(0),
  tierId: text("tier_id").notNull().default(""),
  prizeCodeId: text("prize_code_id").notNull().default(""),
  prizeIndex: integer("prize_index").notNull().default(-1),
  algorithmVersion: text("algorithm_version").notNull().default("instant_weight_v1"),
  ipHash: text("ip_hash").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  idempotencyUnique: uniqueIndex("idx_spins_idempotency").on(t.tenantId, t.drawId, t.idempotencyKey),
  entryIdx: index("idx_spins_entry").on(t.tenantId, t.drawId, t.entryId, t.createdAt),
  drawIdx: index("idx_spins_draw").on(t.tenantId, t.drawId, t.createdAt),
  /** maintenance 清理过期幂等 spin 时按 created_at 扫描。 */
  createdIdx: index("idx_spins_created").on(t.createdAt),
}));

export const lotteryWinners = sqliteTable("lottery_winners", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  tierId: text("tier_id").notNull(),
  entryId: text("entry_id").notNull(),
  /**
   * 关联 lottery_spins.id（instant 多奖）；delayed performDraw 写入 winner 自身 id 作占位，
   * 保证 UNIQUE(tenant, draw, spin_id) 下每 entry 仍可落一行。
   */
  spinId: text("spin_id").notNull().default(""),
  identityType: text("identity_type").notNull(),
  identityValue: text("identity_value").notNull(),
  prizeCodeId: text("prize_code_id").default(""),
  drawnAt: text("drawn_at").notNull().default(sql`(datetime('now'))`),
  notificationStatus: text("notification_status").notNull().default("pending"),
  notificationError: text("notification_error").notNull().default(""),
  /** 邮件通知失败重试次数，每次发送失败 +1，超过 maxRetryAttempts 后不再尝试 */
  notificationRetryCount: integer("notification_retry_count").notNull().default(0),
}, (t) => ({
  spinUnique: uniqueIndex("idx_winners_spin_unique").on(t.tenantId, t.drawId, t.spinId),
  entryIdx: index("idx_winners_entry").on(t.tenantId, t.drawId, t.entryId),
  drawIdx: index("idx_winners_draw").on(t.tenantId, t.drawId, t.drawnAt),
  /** 通知状态索引：用于快速筛选通知失败且未超重试次数的中奖记录 */
  notificationStatusIdx: index("idx_winners_notification_status").on(t.tenantId, t.notificationStatus),
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
  /** maintenance 重试扫描按 status + next_retry_at + created_at 取待投递任务。 */
  deliveryRetryIdx: index("idx_webhook_deliveries_status_retry_created").on(t.status, t.nextRetryAt, t.createdAt),
  deliveryEventIdx: uniqueIndex("idx_webhook_deliveries_event").on(t.webhookConfigId, t.eventId),
}));

/**
 * 统一邮件投递队列。
 *
 * 验证码邮件保持同步发送（用户正在等待验证码）；中奖、成交发卡、开奖提醒、安慰券这类
 * 业务通知必须先落库，再由 maintenance/管理端重发路径发送，避免进程崩溃导致通知丢失。
 */
export const emailDeliveries = sqliteTable("email_deliveries", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default(""),
  drawId: text("draw_id").notNull().default(""),
  /** 幂等来源：lottery_winner/payment_order/draw_reminder/loser_consolation。 */
  sourceType: text("source_type").notNull(),
  /** 来源业务 ID：winnerId/orderId 或 drawId:email 等合成键。 */
  sourceId: text("source_id").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  template: text("template").notNull(),
  templateDataJson: text("template_data_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: text("next_retry_at"),
  providerMessageId: text("provider_message_id").notNull().default(""),
  responseBody: text("response_body").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  sentAt: text("sent_at"),
}, (t) => ({
  /** maintenance 邮件发送按 status + next_retry_at + created_at 领取任务。 */
  retryIdx: index("idx_email_deliveries_status_retry_created").on(t.status, t.nextRetryAt, t.createdAt),
  tenantStatusIdx: index("idx_email_deliveries_tenant_status").on(t.tenantId, t.status, t.createdAt),
  /** 同一业务来源只允许一封队列任务，防止 retry/cron 重复入队。 */
  sourceUnique: uniqueIndex("idx_email_deliveries_source_unique").on(t.tenantId, t.sourceType, t.sourceId),
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
  // ROI 仪表盘查询：WHERE tenantId=? AND occurredAt>=?（dashboard_roi_days 窗口聚合）
  // docs/155 P3-3：此前 occurredAt 不在任何索引中，查询需回表过滤；此索引把 O(N) 降到 O(log N)
  conversionOccurredIdx: index("idx_external_conversions_occurred").on(t.tenantId, t.occurredAt),
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

// ── 租户配置（多租户隔离，通用配置表：支付/风控/其他，docs/131） ──
// 一租户一行，按 JSON 字段承载各模块配置（providers 存支付渠道，未来可加其他）
// 凭据加密存储（enc:base64），解密密钥 CREDENTIALS_ENCRYPTION_KEY
export const tenantConfigs = sqliteTable("tenant_configs", {
  tenantId: text("tenant_id").primaryKey(),
  providers: text("providers").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ── 支付订单（秒杀卡密支付，一参与一订单） ──
export const paymentOrders = sqliteTable("payment_orders", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  /**
   * V2（docs/158）：entry_id 不再唯一。同一参与身份可产生多笔独立订单（一次下单=一笔订单）。
   * entry 只表达"谁参与了活动"，订单是独立的购买/履约事实。
   */
  entryId: text("entry_id").notNull(),
  /**
   * 购买身份快照（V2 新增）。下单时把参与者的身份拷贝到订单上，即使后续 entry 被改名/回收，
   * 订单仍保留"谁在何时购买"的审计事实。公开找回/查单按此身份匹配，不再回查 entry。
   */
  buyerIdentityType: text("buyer_identity_type").notNull().default("email"),
  buyerIdentityValue: text("buyer_identity_value").notNull().default(""),
  buyerDisplayName: text("buyer_display_name").notNull().default(""),
  /** 单笔购买件数。批发/批量购买不新增 entry，而是在一笔订单内购买多件。 */
  quantity: integer("quantity").notNull().default(1),
  /** 下单时命中的单价快照（分），避免运营改价影响历史订单和重试。 */
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  /** 下单时的阶梯价快照 JSON，保留命中阶梯与配置摘要用于审计。 */
  pricingSnapshotJson: text("pricing_snapshot_json").notNull().default("{}"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("cny"),
  /**
   * 逻辑订单状态：pending → paid（已发卡）或 paid_fulfillment_failed（已收款待补发）；
   * pending 超时进入 expired 并释放名额，迟到付款进入 paid_late_needs_refund。
   * 状态常量与跨表转换规则统一维护在 services/payment/payment-status.ts。
   */
  status: text("status").notNull().default("pending"),
  provider: text("provider").notNull(),
  providerTradeNo: text("provider_trade_no"),
  /** 当前有效支付尝试；网关回调必须先命中 attempt，再进入逻辑订单。 */
  currentAttemptId: text("current_attempt_id"),
  /** 仅存 SHA-256，公开查单使用短期 Bearer 令牌，不把邮箱放进 URL。 */
  accessTokenHash: text("access_token_hash"),
  accessTokenExpiresAt: text("access_token_expires_at"),
  paidAt: text("paid_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  tenantOrderIdx: index("idx_payment_orders_tenant").on(t.tenantId, t.createdAt),
  statusIdx: index("idx_payment_orders_status").on(t.status, t.createdAt),
  tenantStatusCreatedIdx: index("idx_payment_orders_tenant_status_created").on(t.tenantId, t.status, t.createdAt),
  currentAttemptIdx: index("idx_payment_orders_current_attempt").on(t.currentAttemptId),
  // V2：entry_id 从唯一约束改为普通索引，支持一参与多订单（docs/158）。
  entryIdx: index("idx_payment_orders_entry").on(t.tenantId, t.entryId),
  // V2：购买身份快照复合索引，公开找回按 type + value 直接匹配（不再回查 entry）。
  buyerIdentityIdx: index("idx_payment_orders_buyer_identity").on(t.tenantId, t.drawId, t.buyerIdentityType, t.buyerIdentityValue),
  // 支付平台交易号是外部事实键；同一租户同一渠道必须唯一，避免重复通知或脏数据串单。
  providerTradeNoUnique: uniqueIndex("idx_payment_orders_provider_trade_no")
    .on(t.tenantId, t.provider, t.providerTradeNo)
    .where(sql`${t.providerTradeNo} IS NOT NULL AND ${t.providerTradeNo} <> ''`),
}));

/**
 * 支付尝试（一次逻辑订单可以有多次网关下单）。
 *
 * payment_orders 负责购买事实和履约结果；本表负责外部支付世界的每次交易号。
 * 这样取消/超时后重试不会复用旧 out_trade_no，迟到回调也能被精确识别为旧尝试。
 */
export const paymentOrderAttempts = sqliteTable("payment_order_attempts", {
  id: text("id").primaryKey(),
  paymentOrderId: text("payment_order_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  provider: text("provider").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("cny"),
  /** 一次网关交易尝试的状态；旧尝试迟到付款必须保留为待退款审计事实。 */
  status: text("status").notNull().default("pending"),
  providerTradeNo: text("provider_trade_no"),
  paidAt: text("paid_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  orderAttemptUnique: uniqueIndex("idx_payment_order_attempts_order_no").on(t.paymentOrderId, t.attemptNo),
  tenantStatusIdx: index("idx_payment_order_attempts_tenant_status").on(t.tenantId, t.status, t.createdAt),
  orderIdx: index("idx_payment_order_attempts_order").on(t.paymentOrderId, t.createdAt),
  // 单次支付尝试的交易号也必须唯一收口；否则重复回调或网关异常会污染审计链。
  providerTradeNoUnique: uniqueIndex("idx_payment_order_attempts_provider_trade_no")
    .on(t.tenantId, t.provider, t.providerTradeNo)
    .where(sql`${t.providerTradeNo} IS NOT NULL AND ${t.providerTradeNo} <> ''`),
}));

/**
 * V2 订单项（docs/158）：一笔订单（payment_orders）下的每个已购单元。
 *
 * 为什么引入订单项：
 * - V1 把"一身份一订单"与"一订单一件/多件"混在一起，发卡时用订单上的 quantity 循环取码，
 *   无法表达"同笔订单里每一件卡密的独立履约/退款/换码"。
 * - V2 一次下单即一笔订单，quantity 件 → quantity 个订单项；每项在履约后绑定一个 prize_code_id。
 * - 订单项状态：pending（下单未履约）→ fulfilled（已发卡）或 refunded（退款/作废）。
 *   它负责明细级履约，payment_orders.status 只负责订单整体支付与收尾。
 */
export const paymentOrderItems = sqliteTable("payment_order_items", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  drawId: text("draw_id").notNull(),
  paymentOrderId: text("payment_order_id").notNull(),
  lineNo: integer("line_no").notNull().default(1),
  itemType: text("item_type").notNull().default("flash_sale"),
  title: text("title").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  /** 履约后绑定的卡密；履约前为 null。 */
  prizeCodeId: text("prize_code_id"),
  amountCents: integer("amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("cny"),
  pricingSnapshotJson: text("pricing_snapshot_json").notNull().default("{}"),
  /** 明细状态：pending → fulfilled / refunded；与 payment_orders.status 解耦。 */
  status: text("status").notNull().default("pending"),
  /** 该件单价快照（分），与订单 unit_price_cents 一致，明细级审计。 */
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  // 按订单取全部明细（公开查单/找回/邮件展示）。
  orderIdx: index("idx_payment_order_items_order").on(t.tenantId, t.paymentOrderId),
  orderLineUnique: uniqueIndex("idx_payment_order_items_order_line").on(t.paymentOrderId, t.lineNo),
  // 按卡密反查归属订单（退款/换码/核销链路）。
  prizeCodeIdx: index("idx_payment_order_items_prize_code").on(t.tenantId, t.prizeCodeId),
}));

/** V2 订单项状态唯一权威定义（与 payment-status.ts 的 PAYMENT_ORDER_ITEM_STATUS 对齐）。 */
export const PAYMENT_ORDER_ITEM_STATUS = {
  PENDING: "pending",
  FULFILLED: "fulfilled",
  REFUNDED: "refunded",
} as const;

/**
 * 平台目标绑定（docs/167）：租户把一个 QQ 群绑定到一个当前活动。
 *
 * 为什么独立于 webhook_configs：
 * - webhook_configs 的核心语义是 HTTP URL + HMAC 投递；
 * - QQ 群是平台目标，不是 URL。混用会污染投递审计与失败重试模型。
 *
 * QQ 底层可由 NapCat/OneBot 提供；Telegram 直接使用 Bot API。
 * 字段保留 platform 是为了不同平台共用同一绑定模型。
 */
export const platformTargets = sqliteTable("platform_targets", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  platform: text("platform").notNull().default("qq"),
  /** 平台侧目标 ID：QQ 群号 / 未来 Telegram chat_id。 */
  targetId: text("target_id").notNull(),
  targetName: text("target_name").notNull().default(""),
  /** 当前绑定活动。群内内置命令围绕这一个活动执行，降低 SaaS 配置复杂度。 */
  activeDrawId: text("active_draw_id").notNull(),
  activePublicSlug: text("active_public_slug").notNull().default(""),
  assistantEnabled: integer("assistant_enabled").notNull().default(1),
  /**
   * 部署模式：
   * - managed：平台托管 QQ 机器人实例。适合低门槛试用，但平台承担账号风控和运维责任。
   * - tenant_hosted：租户自托管 NapCat/OneBot，只把回调 URL 和密钥配置到自己的实例。
   */
  adapterDeploymentMode: text("adapter_deployment_mode").notNull().default("tenant_hosted"),
  /** 每个租户/目标自己的适配器来源。QQ 为 napcat，Telegram 等其他平台可不设置或存储其他值。 */
  adapterProvider: text("adapter_provider").notNull().default("napcat"),
  /**
   * 每个租户/群自己的连接配置。敏感凭据不得明文写入此字段；
   * 示例：{ "baseUrl": "http://x.x.x.x:3000" }
   */
  adapterConfigJson: text("adapter_config_json").notNull().default("{}"),
  /** NapCat/OneBot 上报该群消息时使用的共享密钥哈希，明文只在绑定向导中展示/下发一次。 */
  inboundSecretHash: text("inbound_secret_hash").notNull().default(""),
  /** 内置命令开关与文案覆盖。命令语义固定，不支持租户动态新增任意命令。 */
  builtinCommandsJson: text("builtin_commands_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  tenantIdx: index("idx_platform_targets_tenant").on(t.tenantId, t.platform, t.createdAt),
  targetUnique: uniqueIndex("idx_platform_targets_target_unique").on(t.platform, t.targetId),
  activeDrawIdx: index("idx_platform_targets_active_draw").on(t.tenantId, t.activeDrawId),
}));

/**
 * 租户社群功能覆写表（docs/180）。
 * 1:1 关联 tenants；存在即覆盖套餐默认值。
 * 由平台运营者（L3）通过 PATCH /api/platform/tenants/:id/community 维护。
 */
export const tenantCommunityOverrides = sqliteTable("tenant_community_overrides", {
  tenantId: text("tenant_id").primaryKey(),                    // 1:1 主键
  communityEnabled: integer("community_enabled").notNull().default(1), // 0/1
  maxPlatformTargets: integer("max_platform_targets"),          // null=不限（群数）
  maxGroupMembers: integer("max_group_members"),               // null=不限（群人数）
  note: text("note").notNull().default(""),                     // 运营备注（如"违约观察期"）
  updatedBy: text("updated_by").notNull().default(""),          // 操作者 userId
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * 群绑定成员注册表（docs/180 §3.3）。
 * 记录每个群绑定下已服务过的去重成员。
 * 用于运行时强制 maxGroupMembers 上限，跨活动累计。
 * 注意：表名 community_members 而非 platform_members，
 * 避免与现有平台运营者表（schema.ts:148）冲突。
 */
export const communityMembers = sqliteTable("community_members", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  platformTargetId: text("platform_target_id").notNull(),
  userId: text("user_id").notNull(),          // users.id（Phase B 稳定 ID）
  // 当前实现写入 users.id 作为冗余身份值，用于排障和未来迁移；真实去重依赖 user_id 唯一索引。
  identityValue: text("identity_value").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  uniqTargetUser: uniqueIndex("uq_community_members_target_user").on(table.platformTargetId, table.userId),
  tenantIdx: index("idx_community_members_tenant").on(table.tenantId),
}));

/**
 * 平台消息投递审计（docs/167）。
 *
 * HTTP webhook 继续使用 webhook_deliveries；QQ 群消息使用本表记录平台 target、
 * provider message_id、命令或事件来源，方便后台排查“消息是否真正发到群里”。
 */
export const platformDeliveries = sqliteTable("platform_deliveries", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  platformTargetId: text("platform_target_id").notNull(),
  platform: text("platform").notNull().default("qq"),
  targetId: text("target_id").notNull(),
  eventId: text("event_id").notNull().default(""),
  eventType: text("event_type").notNull().default(""),
  command: text("command").notNull().default(""),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  providerMessageId: text("provider_message_id").notNull().default(""),
  responseBody: text("response_body").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  nextRetryAt: text("next_retry_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  sentAt: text("sent_at"),
}, (t) => ({
  tenantStatusIdx: index("idx_platform_deliveries_tenant_status").on(t.tenantId, t.status, t.createdAt),
  /** maintenance 平台投递队列按 status + next_retry_at + created_at 领取任务。 */
  retryIdx: index("idx_platform_deliveries_status_retry_created").on(t.status, t.nextRetryAt, t.createdAt),
  targetIdx: index("idx_platform_deliveries_target").on(t.platformTargetId, t.createdAt),
  eventIdx: index("idx_platform_deliveries_event").on(t.tenantId, t.eventType, t.createdAt),
}));
