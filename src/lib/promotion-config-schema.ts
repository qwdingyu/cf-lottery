/**
 * promotionConfig 的 zod schema 校验（docs/255 G-5）
 *
 * 目标：在创建/编辑活动时提前发现配置错误（而非发布时），
 * 与运行时白名单（normalizeReferralRewardDefs）+ 发布预检（collectReferralRewardDefIssues）
 * 形成三层防线。
 *
 * 范围：校验 referralRewardDefs 子结构（P1-3 的根因放大器）+ 其他关键子结构
 * （viral/flashSale/dailyFree/pity）的**结构级**校验（字段存在性/类型）。
 * 业务值（如 stockLimit 范围、priceCents 非负）由各自运行时解析器 + 发布预检兜底，
 * 避免 zod 与解析器重复实现业务规则（过度设计）。
 *
 * 注意：zod 4.x 的 API（z.object / z.array / z.enum / z.string / z.number）。
 */
import { z } from "zod";

/** conditions 字段白名单（对齐 referral-rewards-engine.ts 的 CONDITION_FIELD_WHITELIST） */
const CONDITION_FIELD = z.enum(["totalJoinedCount", "activityKind", "eventValue", "eventType"]);
/** conditions 算子白名单 */
const CONDITION_OPERATOR = z.enum(["GTE", "GT", "LTE", "LT", "EQ", "NE"]);

/** 单个 conditions 节点（COMPARE 或逻辑节点 AND/OR/NOT） */
const conditionNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    // COMPARE 叶子（无 type，引擎自动包装）
    z.object({
      field: CONDITION_FIELD,
      operator: CONDITION_OPERATOR,
      value: z.union([z.string(), z.number()]),
    }),
    // 显式 COMPARE
    z.object({
      type: z.literal("COMPARE"),
      field: CONDITION_FIELD,
      operator: CONDITION_OPERATOR,
      value: z.union([z.string(), z.number()]),
    }),
    // 逻辑节点
    z.object({
      type: z.enum(["AND", "OR", "NOT"]),
      children: z.array(conditionNodeSchema).min(1),
    }),
  ]),
);

/** referralRewardDefs 单条定义 */
const referralRewardDefSchema = z.object({
  rewardId: z.string().min(1),
  type: z.enum(["FIXED", "CUSTOM", "DIRECT"]),
  target: z.literal("SOURCE"),
  fixedAmount: z.string().optional(),
  amount: z.string().optional(),
  amountFrom: z.string().optional(),
  rate: z.string().optional(),
  conditions: z.array(conditionNodeSchema).optional(),
  metadata: z.object({
    rewardExit: z.enum(["bonus_spin", "bonus_coupon"]).optional(),
    couponLabel: z.string().optional(),
    exitLabel: z.string().optional(),
  }).optional(),
});

/** promotionConfig 的 referralRewardDefs 子结构 schema */
export const referralRewardDefsSchema = z.array(referralRewardDefSchema);

/**
 * 校验 promotionConfig 中的 referralRewardDefs。
 * @returns 合法返回 null；非法返回错误消息数组
 */
export function validateReferralRewardDefs(promotionConfig: unknown): string[] | null {
  if (promotionConfig == null || typeof promotionConfig !== "object") return null;
  const pc = promotionConfig as Record<string, unknown>;
  const defs = pc.referralRewardDefs;
  if (defs === undefined || defs === null) return null; // 未配置，无需校验
  const result = referralRewardDefsSchema.safeParse(defs);
  if (result.success) return null;
  return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

// ── 其他关键子结构的结构级 schema（docs/255 G-5 收尾）──
// 只校验字段存在性/类型，业务值由运行时解析器 + 发布预检兜底。

/** viral 裂变子结构（结构级） */
const viralSchema = z.object({
  enabled: z.boolean().optional(),
  extraSpinsPerInvite: z.number().optional(),
  maxExtraSpins: z.number().optional(),
  extraEntriesPerInvite: z.number().optional(),
  maxExtraEntries: z.number().optional(),
  leaderboardEnabled: z.boolean().optional(),
  leaderboardRewards: z.array(z.object({
    rank: z.number().optional(),
    rewardType: z.string().optional(),
    rewardValue: z.number().optional(),
  })).optional(),
}).passthrough();

/** flashSale 秒杀子结构（结构级） */
const flashSaleSchema = z.object({
  enabled: z.boolean().optional(),
  sessionLabel: z.string().optional(),
  stockLimit: z.number().nullable().optional(),
  maxPerUser: z.number().optional(),
  showCountdown: z.boolean().optional(),
  showProgress: z.boolean().optional(),
  showStock: z.boolean().optional(),
  ctaLabel: z.string().optional(),
  paymentRequired: z.boolean().optional(),
  priceCents: z.number().nullable().optional(),
  currency: z.string().optional(),
  title: z.string().optional(),
  imageUrl: z.string().optional(),
  pricingTiers: z.array(z.object({
    minQuantity: z.number().optional(),
    unitPriceCents: z.number().optional(),
    label: z.string().optional(),
  })).optional(),
}).passthrough();

/** dailyFree 每日免费子结构（结构级） */
const dailyFreeSchema = z.object({
  enabled: z.boolean().optional(),
  count: z.number().optional(),
}).passthrough();

/** pity 保底子结构（结构级） */
const pitySchema = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().optional(),
}).passthrough();

/** promotionConfig 整体结构 schema（各子结构可选，未知键保留） */
const promotionConfigSchema = z.object({
  version: z.number().optional(),
  referralRewardDefs: referralRewardDefsSchema.optional(),
  viral: viralSchema.optional(),
  flashSale: flashSaleSchema.optional(),
  dailyFreeSpins: dailyFreeSchema.optional(),
  pity: pitySchema.optional(),
}).passthrough();

/**
 * 校验整个 promotionConfig 的结构（docs/255 G-5 收尾）。
 * 覆盖 referralRewardDefs + viral + flashSale + dailyFreeSpins + pity 的结构级校验。
 * @returns 合法返回 null；非法返回错误消息数组
 */
export function validatePromotionConfig(promotionConfig: unknown): string[] | null {
  if (promotionConfig == null || typeof promotionConfig !== "object") return null;
  const result = promotionConfigSchema.safeParse(promotionConfig);
  if (result.success) return null;
  return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}