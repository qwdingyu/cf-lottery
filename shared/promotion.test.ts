import { describe, expect, it } from "vitest";
import {
  canStackPromotionTypes,
  groupBuyRewardSchema,
  groupBuyTriggerSchema,
  promotionDefinitionSchema,
  promotionScopeMatches,
} from "./promotion";

describe("promotion framework P0 contracts", () => {
  it("keeps pricing promotions mutually exclusive", () => {
    expect(canStackPromotionTypes("flash_sale", "first_purchase")).toBe(false);
    expect(canStackPromotionTypes("spend_save", "bundle")).toBe(false);
    expect(canStackPromotionTypes("group_buy", "flash_sale")).toBe(true);
    expect(canStackPromotionTypes("group_buy", "group_buy")).toBe(false);
  });

  it("validates group_buy trigger and reward JSON strictly", () => {
    expect(groupBuyTriggerSchema.parse({
      requiredInvites: 3,
      expireHours: 48,
      minInviteeOrderAmountCents: 1,
      countUniqueInviteeEmail: true,
    })).toEqual({
      requiredInvites: 3,
      expireHours: 48,
      minInviteeOrderAmountCents: 1,
      countUniqueInviteeEmail: true,
    });

    expect(groupBuyTriggerSchema.safeParse({
      requiredInvites: 0,
      expireHours: 48,
      countUniqueInviteeEmail: true,
    }).success).toBe(false);

    expect(groupBuyRewardSchema.safeParse({
      type: "balance_credit",
      amount: "origin_order_paid_amount",
      maxRewardCents: 0,
    }).success).toBe(true);

    expect(groupBuyRewardSchema.safeParse({
      type: "balance_credit",
      amount: "buyer_order_amount",
    }).success).toBe(false);
  });

  it("accepts only group_buy in the P0 promotion definition validator", () => {
    const ok = promotionDefinitionSchema.safeParse({
      type: "group_buy",
      name: "邀请 3 人免单",
      status: "active",
      startsAt: "2026-07-30T00:00:00.000Z",
      endsAt: "2026-08-30T00:00:00.000Z",
      scope: { storefrontIds: ["sf_default"], productIds: ["prod_1"], emailDomains: [] },
      trigger: {
        requiredInvites: 3,
        expireHours: 48,
        minInviteeOrderAmountCents: 1,
        countUniqueInviteeEmail: true,
      },
      reward: {
        type: "balance_credit",
        amount: "origin_order_paid_amount",
        maxRewardCents: 0,
      },
    });
    expect(ok.success).toBe(true);

    expect(promotionDefinitionSchema.safeParse({
      type: "flash_sale",
      name: "秒杀",
      trigger: {},
      reward: {},
    }).success).toBe(false);

    expect(promotionDefinitionSchema.safeParse({
      type: "group_buy",
      name: "时间错误",
      startsAt: "2026-08-30T00:00:00.000Z",
      endsAt: "2026-07-30T00:00:00.000Z",
      trigger: {
        requiredInvites: 3,
        expireHours: 48,
        countUniqueInviteeEmail: true,
      },
      reward: {
        type: "balance_credit",
        amount: "origin_order_paid_amount",
      },
    }).success).toBe(false);
  });

  it("keeps storefront and product scope as a hard eligibility boundary", () => {
    const scope = {
      storefrontIds: ["sf_a"],
      productIds: ["prod_a"],
      emailDomains: ["example.com"],
    };
    expect(promotionScopeMatches({
      scope,
      storefrontId: "sf_a",
      productId: "prod_a",
      emailDomain: "example.com",
    })).toBe(true);
    expect(promotionScopeMatches({
      scope,
      storefrontId: "sf_b",
      productId: "prod_a",
      emailDomain: "example.com",
    })).toBe(false);
    expect(promotionScopeMatches({
      scope,
      storefrontId: "sf_a",
      productId: "prod_b",
      emailDomain: "example.com",
    })).toBe(false);
  });
});
