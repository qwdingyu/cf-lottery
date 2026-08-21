/**
 * promotionConfig 的 zod schema 校验（docs/255 G-5）
 *
 * 目标：在创建/编辑活动时提前发现配置错误（而非发布时），
 * 与运行时白名单（normalizeReferralRewardDefs）+ 发布预检（collectReferralRewardDefIssues）
 * 形成三层防线。
 *
 * 范围：只校验 referralRewardDefs 子结构（P1-3 的根因放大器），
 * 不校验整个 promotionConfig（viral/flashSale 等子结构由各自解析器 + 发布预检兜底，
 * 避免过度设计）。
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