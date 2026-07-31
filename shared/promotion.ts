import { z } from "zod";

export const PROMOTION_TYPES = [
  "group_buy",
  "flash_sale",
  "first_purchase",
  "spend_save",
  "bundle",
  "sign_in",
] as const;

export type PromotionType = typeof PROMOTION_TYPES[number];

export const PROMOTION_STATUSES = [
  "draft",
  "active",
  "paused",
  "ended",
  "archived",
] as const;

export type PromotionStatus = typeof PROMOTION_STATUSES[number];

export const ADMIN_PROMOTION_VISIBLE_STATUSES = [
  ...PROMOTION_STATUSES,
  "scheduled",
  "expired",
] as const;

export type AdminPromotionVisibleStatus = typeof ADMIN_PROMOTION_VISIBLE_STATUSES[number];

export const PROMOTION_INSTANCE_STATUSES = [
  "active",
  "fulfilled",
  "expired",
  "cancelled",
] as const;

export type PromotionInstanceStatus = typeof PROMOTION_INSTANCE_STATUSES[number];

export const PROMOTION_USAGE_TYPES = [
  "quoted",
  "reserved",
  "qualified",
  "fulfilled",
  "skipped",
  "reversed",
] as const;

export type PromotionUsageType = typeof PROMOTION_USAGE_TYPES[number];

export type PromotionRewardType =
  | "discount"
  | "balance_credit"
  | "coupon"
  | "free_item"
  | "fixed_price";

export const PRICING_PROMOTION_TYPES = [
  "flash_sale",
  "first_purchase",
  "spend_save",
  "bundle",
] as const satisfies readonly PromotionType[];

export const REBATE_PROMOTION_TYPES = [
  "group_buy",
] as const satisfies readonly PromotionType[];

const pricingSet = new Set<PromotionType>(PRICING_PROMOTION_TYPES);

/** 促销配置适用范围。空数组表示不限制对应维度。 */
export const promotionScopeSchema = z.object({
  storefrontIds: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  productIds: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
  emailDomains: z.array(z.string().trim().toLowerCase().min(1).max(120)).max(100).default([]),
}).strict();

export type PromotionScope = z.infer<typeof promotionScopeSchema>;

export const groupBuyTriggerSchema = z.object({
  requiredInvites: z.number().int().min(1).max(100),
  expireHours: z.number().int().min(1).max(24 * 365),
  minInviteeOrderAmountCents: z.number().int().min(0).max(10_000_000).default(1),
  countUniqueInviteeEmail: z.literal(true).default(true),
}).strict();

export type GroupBuyTrigger = z.infer<typeof groupBuyTriggerSchema>;

export const groupBuyRewardSchema = z.object({
  type: z.literal("balance_credit"),
  amount: z.literal("origin_order_paid_amount"),
  /** 0 表示不额外封顶，由原始订单实付金额自然限制。 */
  maxRewardCents: z.number().int().min(0).max(10_000_000).default(0),
}).strict();

export type GroupBuyReward = z.infer<typeof groupBuyRewardSchema>;

export const promotionDefinitionSchema = z.object({
  type: z.enum(PROMOTION_TYPES),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  status: z.enum(PROMOTION_STATUSES).default("draft"),
  schemaVersion: z.literal(1).default(1),
  priority: z.number().int().min(-1000).max(1000).default(0),
  stackable: z.boolean().default(false),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  scope: promotionScopeSchema.default({ storefrontIds: [], productIds: [], emailDomains: [] }),
  trigger: z.unknown(),
  reward: z.unknown(),
}).strict().superRefine((value, ctx) => {
  if (value.startsAt && value.endsAt && value.startsAt >= value.endsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: "endsAt must be later than startsAt",
    });
  }

  if (value.type === "group_buy") {
    const trigger = groupBuyTriggerSchema.safeParse(value.trigger);
    if (!trigger.success) {
      for (const issue of trigger.error.issues) {
        ctx.addIssue({ ...issue, path: ["trigger", ...issue.path] });
      }
    }
    const reward = groupBuyRewardSchema.safeParse(value.reward);
    if (!reward.success) {
      for (const issue of reward.error.issues) {
        ctx.addIssue({ ...issue, path: ["reward", ...issue.path] });
      }
    }
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["type"],
    message: "Only group_buy is accepted in P0 runtime validation",
  });
});

export type PromotionDefinition = z.infer<typeof promotionDefinitionSchema>;

/** 两个促销类型是否允许同时影响同一订单。 */
export function canStackPromotionTypes(a: PromotionType, b: PromotionType): boolean {
  if (a === b) return false;
  return !(pricingSet.has(a) && pricingSet.has(b));
}

/** P0 不让促销配置绕过 storefront 商品发布边界。 */
export function promotionScopeMatches(input: {
  scope: PromotionScope;
  storefrontId: string;
  productId: string;
  emailDomain?: string;
}): boolean {
  const storefrontIds = new Set(input.scope.storefrontIds);
  if (storefrontIds.size > 0 && !storefrontIds.has(input.storefrontId)) return false;

  const productIds = new Set(input.scope.productIds);
  if (productIds.size > 0 && !productIds.has(input.productId)) return false;

  const domains = new Set(input.scope.emailDomains.map((domain) => domain.toLowerCase()));
  if (domains.size > 0 && !domains.has((input.emailDomain || "").toLowerCase())) return false;

  return true;
}
