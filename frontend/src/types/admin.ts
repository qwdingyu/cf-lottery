// cf-shop 残留类型已删除，以下为兼容占位类型
type StockDisplayMode = string;
type DeliveryVisibility = string;
type FulfillmentInputType = string;
type StorefrontTemplate = string;
type Delivery = Record<string, unknown>;

export interface AdminSummary {
  products: number
  availableCards: number
  totalCards: number
  totalOrders: number
  pendingOrders: number
  lowStockCount: number
  ordersToday: number
  issuedToday: number
  totalIncomeCents: number
  todayIncomeCents: number
  todayAlipayCents: number
  todayEasyPayCents: number
}

export interface DailyIncome {
  date: string
  amountCents: number
}

export interface AdminMarketingSummaryRow {
  code: string
  orderCount: number
  amountCents: number
  storefrontId?: string
}

export interface AdminMarketingSummary {
  days: number
  campaigns: AdminMarketingSummaryRow[]
  referrals: AdminMarketingSummaryRow[]
  storefronts: AdminMarketingSummaryRow[]
}

export interface AdminProduct {
  id: string
  /** 与库内 products.slug 对齐；复制用户购买链接时优先使用 */
  slug?: string
  title: string
  description?: string
  priceCents: number
  /** 货架对比价；仅展示，不参与计费 */
  originalPriceCents?: number | null
  /** 限时营销角标；仅展示，不参与计费 */
  marketingBadge?: string
  /** 限时营销截止时间；仅展示倒计时，不参与计费 */
  marketingEndsAt?: string
  /** 最近成交人数展示；仅前台信任感，不参与计费 */
  showRecentBuyers?: number
  currency?: string
  active?: boolean
  category?: string
  issueMode?: string
  coverUrl?: string
  salesCopy?: string
  tagsJson?: string
  sortOrder?: number
  stock?: number
  purchasedCount?: number
  stockDisplayMode?: StockDisplayMode
  fulfillmentMode?: string
  purchaseLimit?: number | null
  purchaseLimitPeriod?: 'lifetime' | 'daily'
  purchaseLimitDisplay?: boolean
  deliveryVisibility?: DeliveryVisibility
  fulfillmentInputType?: FulfillmentInputType
  fulfillmentInputLabel?: string
  fulfillmentInputHint?: string
  fulfillmentInputRequired?: boolean
  createdAt?: string
  updatedAt?: string
  storefrontIds?: string[]
  storefronts?: Array<{
    id: string
    slug?: string
    name?: string
    active?: boolean
    isDefault?: boolean
    visible?: boolean
    sortOrder?: number
  }>
}

export interface AdminProductFilter {
  q?: string
  active?: string
  category?: string
  stock?: string
  storefrontId?: string
  page?: number
  limit?: number
}

export interface AdminStorefront {
  id: string
  slug: string
  name: string
  logoUrl: string
  supportEmail: string
  templateKey: StorefrontTemplate
  active: boolean
  isDefault: boolean
  sortOrder: number
  productCount: number
  orderCount: number
  homePath: string
  createdAt: string
  updatedAt: string
}

export interface AdminStorefrontProduct {
  productId: string
  productTitle: string
  visible: boolean
  sortOrder: number
}

export interface AdminStorefrontDetail {
  storefront: AdminStorefront
  products: AdminStorefrontProduct[]
}

export interface AdminCreateStorefrontBody {
  slug: string
  name: string
  logoUrl?: string
  supportEmail?: string
  templateKey?: StorefrontTemplate
  active?: boolean
  sortOrder?: number
}

export interface AdminUpdateStorefrontBody {
  name?: string
  logoUrl?: string
  supportEmail?: string
  templateKey?: StorefrontTemplate
  active?: boolean
  sortOrder?: number
}

export interface AdminStorefrontProductBody {
  productId: string
  visible: boolean
  sortOrder: number
}

export interface AdminProductListResult {
  total: number
  products: AdminProduct[]
}

export interface AdminProductCategory {
  id: string
  name: string
  sortOrder: number
  active: boolean
  productCount: number
  createdAt?: string
  updatedAt?: string | null
}

export interface AdminProductCategoryBody {
  id?: string
  name: string
  sortOrder?: number
  active?: boolean
}

export interface AdminMediaImageUploadResult {
  key: string
  url: string
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
  size: number
}

export interface AdminCard {
  id: string
  productId?: string
  productTitle?: string
  accountLabel?: string
  deliverySecret?: string
  deliveryNote?: string
  status?: string
  batchId?: string
  buyerEmail?: string
  buyerContact?: string
  expiresAt?: string
  createdAt?: string
  updatedAt?: string
}

export interface AdminCardFilter {
  productId?: string
  batchId?: string
  status?: string
  buyerEmail?: string
  buyerContact?: string
  /**
   * 内容关键词（API 参数名 deliverySecret）。
   * 匹配卡密密钥、同码交付内容（deliveryNote）、账号/标签。
   */
  deliverySecret?: string
  genericOnly?: boolean
  page?: number
  limit?: number
}

export interface AdminCardListResult {
  total: number
  results: AdminCard[]
}

export interface AdminImportCardItem {
  accountLabel: string
  deliverySecret: string
  deliveryNote?: string
  expiresAt?: string
}

export interface AdminImportCardsPayload {
  productId: string
  batchName: string
  cards: AdminImportCardItem[]
}

export interface AdminImportCardsResult {
  batchId: string
  imported: number
  skipped: number
  errors: string[]
}

export interface AdminGenerateGenericCardsPayload {
  productId: string
  count: number
  genericCode: string
  /** 可选账号/标签；空则后端自动 card-001… */
  accountLabel?: string
  batchName: string
  expiresAt?: string
}

export interface AdminGenerateGenericCardsResult {
  batchId: string
  generated: number
  message: string
}

export interface AdminOrder {
  id: string
  orderNo: string
  productId?: string
  productTitle?: string
  quantity?: number
  amountCents?: number
  discountCents?: number
  currency?: string
  status?: string
  issueMode?: string
  fulfillmentMode?: string
  /** 订单级交付可见性快照（web_and_email | email_only）；详情来自 orders.delivery_visibility */
  deliveryVisibility?: DeliveryVisibility
  paymentMethod?: string
  paymentProvider?: string
  paymentRef?: string
  orderTokenHash?: string
  issuedCardId?: string
  campaignCode?: string
  referralCode?: string
  couponCode?: string
  buyerContact?: string
  buyerEmail?: string
  /** 客户端 IP 明文（新单）；历史单可能为空 */
  clientIp?: string
  ipHash?: string
  userAgent?: string
  /** 推荐码登记状态（只读；不参与下单校验） */
  referralRegistryStatus?: AdminReferralRegistryStatus
  createdAt?: string
  paidAt?: string
  issuedAt?: string
  expiresAt?: string
  /** 列表/导出：发卡批次元数据（详情可能走 cards[]） */
  batchId?: string
  accountLabel?: string
  deliveryNote?: string
  delivery?: Delivery
  cards?: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }>
  items?: Array<{
    id: string
    productId: string
    productTitle: string
    fulfillmentMode: string
    quantity: number
    unitPriceCents: number
    discountCents: number
    amountCents: number
    deliveryJson?: string
  }>
  events?: Array<{
    id: string
    type: string
    message: string
    createdAt: string
  }>
  cardExpiresAt?: string
  orderSource?: 'storefront' | 'coupon_redeem' | 'telegram' | 'lottery'
  storefrontId?: string | null
  storefrontSlugSnapshot?: string
  storefrontNameSnapshot?: string
  fulfillmentInput?: {
    type: FulfillmentInputType
    label: string
    value: string
  } | null
}

/** L1 推荐佣金台账（GET /orders/:id/referral-reward） */
export interface AdminReferralReward {
  id: string
  orderId: string
  referralCode: string
  ownerEmail: string
  rewardType: string
  rewardValue: number
  amountCents: number
  currency: string
  status: string
  skipReason?: string
  balanceTxId?: string
  reverseTxId?: string
  grantedAt?: string | null
  reversedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface AdminMarkOrderRefundedResult {
  orderId: string
  orderStatus: string
  reverse: {
    outcome: string
    reason?: string
    rewardId?: string
    amountCents?: number
    message?: string
  }
  groupBuyReverse?: {
    reversed: number
    alreadyReversed: number
    failed: number
    failures: Array<{ instanceId: string; reason: string }>
  }
}

export interface AdminRetryReferralRewardResult {
  result: {
    outcome: string
    reason?: string
    rewardId?: string
    amountCents?: number
    ownerEmail?: string
    status?: string
    message?: string
  }
}

export interface AdminOrderFilter {
  status?: string | string[]
  productId?: string
  q?: string
  buyerContact?: string
  paymentMethod?: string
  orderSource?: string
  storefrontId?: string
  page?: number
  limit?: number
}

export interface AdminOrderListResult {
  total: number
  orders: AdminOrder[]
}

export interface AdminOrderExportParams {
  status?: string | string[]
  productId?: string
  q?: string
  paymentMethod?: string
  orderSource?: string
  storefrontId?: string
  format?: 'csv' | 'json'
  cursor?: string
  limit?: number
}

export interface AdminOrderExportResult {
  orders?: AdminOrder[]
  nextCursor?: string
  hasMore?: boolean
}

export interface AdminCoupon {
  code: string
  productId?: string
  productTitle?: string
  discountType?: 'fixed' | 'percent'
  discountValue?: number
  maxUses?: number
  usedCount?: number
  active?: boolean
  expiresAt?: string
  createdAt?: string
}

export interface AdminCouponFilter {
  productId?: string
  status?: string
  search?: string
  page?: number
  limit?: number
}

export interface AdminCouponListResult {
  total: number
  results: AdminCoupon[]
}

export interface AdminCreateCouponBody {
  productId?: string
  code?: string
  discountType: 'fixed' | 'percent'
  discountValue: number
  maxUses?: number
  active?: boolean
  expiresAt?: string
}

export interface AdminGenerateCouponBody {
  productId: string
  prefix?: string
  discountType?: 'fixed' | 'percent'
  discountValue: number
  maxUses?: number
  active?: boolean
  expiresAt?: string
  count: number
}

export interface AdminUpdateCouponBody {
  productId?: string
  discountType?: 'fixed' | 'percent'
  discountValue?: number
  maxUses?: number
  active?: boolean
  expiresAt?: string
}

export interface AdminBalanceTransaction {
  id?: string
  email?: string
  type?: 'voucher_redeem' | 'recharge' | 'order_spend' | 'refund' | 'adjustment'
  amountCents?: number
  balanceAfterCents?: number
  referenceType?: string
  referenceId?: string
  note?: string
  createdAt?: string
}

export interface AdminBalanceTransactionFilter {
  email?: string
  type?: string
  referenceType?: string
  referenceId?: string
  limit?: number
  offset?: number
}

export interface AdminBalanceTransactionListResult {
  total: number
  limit: number
  offset: number
  transactions: AdminBalanceTransaction[]
}

/** 用户余额账户（user_balances 表真实余额） */
export interface AdminUserBalance {
  email: string
  balanceCents: number
  totalDepositedCents: number
  totalSpentCents: number
  updatedAt: string
}

export interface AdminUserBalanceFilter {
  email?: string
  /** 仅余额 > 0；传 '1' / 'true' */
  positiveOnly?: string
  limit?: number
  offset?: number
}

export interface AdminUserBalanceListResult {
  total: number
  limit: number
  offset: number
  items: AdminUserBalance[]
}

export interface AdminAdjustUserBalanceBody {
  email: string
  /** 分；正数加款，负数扣款 */
  amountCents: number
  note: string
}

export interface AdminAdjustUserBalanceResult {
  email: string
  amountCents: number
  balanceCents: number
  message: string
}

export type AdminVoucherStatus = 'active' | 'used' | 'expired' | 'revoked'

export interface AdminVoucher {
  code: string
  amountCents: number
  status: AdminVoucherStatus
  usedByEmail?: string
  usedAt?: string
  expiresAt?: string
  batchId?: string
  notes?: string
  createdAt?: string
}

export interface AdminVoucherFilter {
  status?: AdminVoucherStatus | ''
  batchId?: string
  search?: string
  limit?: number
  offset?: number
}

export interface AdminVoucherListResult {
  total: number
  limit: number
  offset: number
  items: AdminVoucher[]
}

export interface AdminVoucherStats {
  active: number
  used: number
  expired: number
  revoked: number
  totalAmount: number
  usedAmount: number
}

export interface AdminGenerateVoucherBody {
  count: number
  amountCents: number
  batchId: string
  expiresAt?: string
  notes?: string
}

export interface AdminRechargeOrder {
  id: string
  orderNo: string
  buyerEmail: string
  amountCents: number
  currency: string
  status: 'pending' | 'paid' | 'expired' | 'failed'
  paymentProvider: string
  paymentRef?: string
  createdAt: string
  paidAt?: string
  expiresAt: string
}

export interface AdminRechargeOrderFilter {
  email?: string
  status?: AdminRechargeOrder['status'] | ''
  /** 订单号 / 支付流水 / 邮箱统一关键词 */
  q?: string
  limit?: number
  offset?: number
}

export interface AdminRechargeOrderListResult {
  total: number
  limit: number
  offset: number
  items: AdminRechargeOrder[]
}

export interface AdminSystemConfigDefinition {
  key: string
  label: string
  description?: string
  type: 'string' | 'boolean' | 'integer'
  /** integer 存储单位：cents=库内分、Admin 按元编辑；缺省为普通整数 */
  unit?: 'cents' | 'count'
  sensitive?: boolean
  configured?: boolean
  defaultValue?: string
  min?: number
  max?: number
  maxLength?: number
  effect?: string
  group?: string
  order?: number
  scope?: 'public' | 'admin'
  difficulty?: 'basic' | 'advanced'
  /** 枚举选项列表（type=string 时的多选展示，值仍以逗号分隔存储） */
  enum?: string[]
  /** 枚举选项的中文标签映射 */
  enumLabels?: Record<string, string>
}

export interface AdminSystemConfigResult {
  config: Record<string, string>
  definitions: AdminSystemConfigDefinition[]
}

export interface AdminUpdateSystemConfigBody {
  key: string
  value: string
}

export interface AdminPaymentProviderField {
  key: string
  label: string
  type?: string
  required?: boolean
  sensitive?: boolean
  placeholder?: string
  hint?: string
}

export interface AdminPaymentProvider {
  name: string
  displayName: string
  description: string
  supportedCurrencies: string[]
  configured: boolean
  enabled: boolean
  hasValidCredentials: boolean
  fields: AdminPaymentProviderField[]
}

export interface AdminPaymentProviderResult {
  providers: AdminPaymentProvider[]
}

export interface AdminPaymentHealthResult {
  credentialsEncryptionKey: {
    configured: boolean
    valid: boolean
  }
}

export interface AdminPaymentConfigItem {
  name: string
  enabled: boolean
  configured: boolean
  hasValidCredentials: boolean
  values?: Record<string, string>
}

export interface AdminPaymentConfigsResult {
  configs: AdminPaymentConfigItem[]
}

export interface AdminBatch {
  id?: string
  productId?: string
  productTitle?: string
  name?: string
  totalCount?: number
  /** 当前仍关联的卡密行数（含各状态）；空批次 cardCount=0 */
  cardCount?: number
  count?: number
  availableCount?: number
  issuedCount?: number
  disabledCount?: number
  createdAt?: string
}

export interface AdminBatchListResult {
  results: AdminBatch[]
}

export interface AdminLowStockProduct {
  id: string
  title: string
  stock?: number
  availableStock?: number
}

export interface AdminTestEmailBody {
  to: string
}

export interface AdminEmailLog {
  id?: string
  orderId?: string | null
  toEmail?: string
  /** 兼容旧字段名 */
  to?: string
  template?: string
  subject?: string
  status?: string
  displayStatus?: string
  provider?: string
  errorMessage?: string
  displayErrorMessage?: string
  error?: string
  createdAt?: string
  sentAt?: string | null
}

export interface AdminEmailLogListResult {
  total: number
  results: AdminEmailLog[]
  snapshotAt: string
  nextCursor: string
  hasMore: boolean
}

export interface AdminEmailLogFilter {
  status?: string
  search?: string
  limit?: number
  snapshotAt?: string
  cursor?: string
}

export interface AdminAuditLog {
  type?: 'request' | 'admin'
  id?: string
  action?: string
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  ipHash?: string
  createdAt?: string
}

export interface AdminAuditLogListResult {
  total: number
  logs: AdminAuditLog[]
  snapshotAt: string
  nextCursor: string
  hasMore: boolean
}

export interface AdminAuditLogFilter {
  action?: string
  targetType?: string
  targetId?: string
  limit?: number
  snapshotAt?: string
  cursor?: string
}

export interface AdminCampaign {
  code: string
  name: string
  active?: boolean
  startsAt?: string
  endsAt?: string
  metadataJson?: string
  createdAt?: string
  updatedAt?: string
}

export interface AdminCreateCampaignBody {
  code: string
  name: string
  active?: boolean
  startsAt?: string
  endsAt?: string
  metadataJson?: string
}

export interface AdminUpdateCampaignBody {
  name?: string
  active?: boolean
  startsAt?: string
  endsAt?: string
  metadataJson?: string
}

export interface AdminPromotion {
  id: string
  type: 'group_buy'
  name: string
  description: string
  status: 'draft' | 'active' | 'paused' | 'ended' | 'archived'
  visibleStatus?: 'draft' | 'active' | 'paused' | 'ended' | 'archived' | 'scheduled' | 'expired'
  startsAt?: string | null
  endsAt?: string | null
  scope: { storefrontIds?: string[]; productIds?: string[]; emailDomains?: string[] }
  trigger: { requiredInvites?: number; expireHours?: number; minInviteeOrderAmountCents?: number }
  reward: { type?: string; amount?: string; maxRewardCents?: number }
  instances: number
  fulfilledInstances: number
  createdAt: string
  updatedAt: string
}

export interface AdminPromotionInstance {
  id: string
  promotionId: string
  originOrderId: string
  originOrderNo?: string | null
  originOrderStatus?: string | null
  ownerEmail: string
  referralCode: string
  status: string
  requiredCount: number
  qualifiedCount: number
  rewardAmountCents: number
  currency: string
  expiresAt?: string | null
  fulfilledAt?: string | null
  usageCount: number
  skippedCount?: number
  fulfilledUsageCount?: number
  reversedCount?: number
  latestUsageAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminCreateGroupBuyPromotionBody {
  name: string
  description?: string
  status?: 'draft' | 'active'
  startsAt?: string | null
  endsAt?: string | null
  scope: { storefrontIds?: string[]; productIds?: string[]; emailDomains?: string[] }
  trigger: {
    requiredInvites: number
    expireHours: number
    minInviteeOrderAmountCents?: number
    countUniqueInviteeEmail: true
  }
  reward: {
    type: 'balance_credit'
    amount: 'origin_order_paid_amount'
    maxRewardCents?: number
  }
}

export interface AdminReferralCode {
  code: string
  ownerContact?: string
  rewardType?: 'none' | 'fixed' | 'percent'
  rewardValue?: number
  active?: boolean
  createdAt?: string
  updatedAt?: string
  /** 来自 referral_events 计数；未登记码不会出现在列表里 */
  useCount?: number
}

/**
 * 订单详情只读：推荐码是否在 registry 中（不挡交易）。
 * unknown = 无推荐码；unregistered = 订单有码但表中无行；
 * active / inactive = 表中有行。
 */
export type AdminReferralRegistryStatus =
  | 'unknown'
  | 'unregistered'
  | 'active'
  | 'inactive'

export interface AdminCreateReferralCodeBody {
  code: string
  ownerContact: string
  rewardType?: 'none' | 'fixed' | 'percent'
  rewardValue?: number
  active?: boolean
}

export interface AdminUpdateReferralCodeBody {
  ownerContact?: string
  rewardType?: 'none' | 'fixed' | 'percent'
  rewardValue?: number
  active?: boolean
}

export interface AdminCleanupResult {
  message: string
  reconciledPayments?: number
  expiredOrders: number
  expiredRechargeOrders?: number
  releasedCards: number
  disabledExpiredCards?: number
  operationalData: {
    enabled: boolean
    retentionDays: Record<string, number>
    deleted: Record<string, number>
  }
}

export interface AdminFinanceExportParams {
  status?: string | string[]
  productId?: string
  q?: string
  paymentMethod?: string
  orderSource?: string
  storefrontId?: string
  format?: 'csv' | 'json'
  cursor?: string
  limit?: number
}

export interface AdminFinanceExportResult {
  orders?: Record<string, unknown>[]
  balanceTransactions?: Record<string, unknown>[]
  summary?: {
    currency: 'CNY'
    totalIncomeCents: number
    totalCardIssuedCents: number
    totalBalanceSpentCents: number
    totalRefundCents: number
    totalsByCurrency: Record<string, {
      totalIncomeCents: number
      totalCardIssuedCents: number
      totalBalanceSpentCents: number
      totalRefundCents: number
    }>
  }
  nextCursor?: string
  hasMore?: boolean
}

export interface AdminPendingTasks {
  pendingOfflinePayments: Record<string, unknown>[]
  paidButNotIssued: Record<string, unknown>[]
  lowStockProducts: AdminLowStockProduct[]
}
