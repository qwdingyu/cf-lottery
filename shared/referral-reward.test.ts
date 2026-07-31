import { describe, expect, it } from "vitest";
import {
  decideReferralReward,
  looksLikeEmail,
  normalizeOwnerEmail,
  validateFixedRewardConfig,
  DEFAULT_REFERRAL_REWARD_POLICY,
} from "./referral-reward";

const baseOrder = {
  id: "o1",
  status: "paid",
  paidAt: "2026-01-01T00:00:00.000Z",
  amountCents: 1000,
  currency: "CNY",
  referralCode: "partner-a",
  buyerEmail: "buyer@example.com",
};

const baseCode = {
  code: "partner-a",
  ownerContact: "Owner@Example.com",
  rewardType: "fixed",
  rewardValue: 100,
  active: 1,
};

const onPolicy = { ...DEFAULT_REFERRAL_REWARD_POLICY, enabled: true };

describe("looksLikeEmail / normalizeOwnerEmail", () => {
  it("accepts normal emails and canonicalizes gmail", () => {
    expect(looksLikeEmail("a@b.co")).toBe(true);
    expect(normalizeOwnerEmail("A.B+x@gmail.com")).toBe("ab@gmail.com");
    expect(normalizeOwnerEmail("not-an-email")).toBeNull();
  });
});

describe("decideReferralReward", () => {
  it("skips when global disabled", () => {
    expect(decideReferralReward({ order: baseOrder, codeRow: baseCode, policy: DEFAULT_REFERRAL_REWARD_POLICY }))
      .toEqual({ action: "skip", reason: "disabled_global" });
  });

  it("skips no_ref / not_paid / unregistered / inactive / none", () => {
    expect(
      decideReferralReward({
        order: { ...baseOrder, referralCode: "" },
        codeRow: baseCode,
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "no_ref" });
    expect(
      decideReferralReward({
        order: { ...baseOrder, status: "pending" },
        codeRow: baseCode,
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "not_paid" });
    expect(decideReferralReward({ order: baseOrder, codeRow: null, policy: onPolicy }))
      .toMatchObject({ action: "skip", reason: "unregistered" });
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, active: 0 },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "inactive" });
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, rewardType: "none" },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "none" });
  });

  it("skips owner_not_email, zero, exceeds_order, currency, self_purchase", () => {
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, ownerContact: "微信群主" },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "owner_not_email" });
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, rewardValue: 0 },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "zero" });
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, rewardValue: 5000 },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "exceeds_order" });
    expect(
      decideReferralReward({
        order: { ...baseOrder, currency: "USD" },
        codeRow: baseCode,
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "currency" });
    expect(
      decideReferralReward({
        order: { ...baseOrder, buyerEmail: "owner@example.com" },
        codeRow: baseCode,
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "self_purchase" });
  });

  it("grants fixed amount when eligible", () => {
    const d = decideReferralReward({ order: baseOrder, codeRow: baseCode, policy: onPolicy });
    expect(d).toEqual({
      action: "grant",
      amountCents: 100,
      ownerEmail: "owner@example.com",
      referralCode: "partner-a",
      rewardType: "fixed",
      rewardValue: 100,
      currency: "CNY",
    });
  });

  it("skips percent when allowPercent false", () => {
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, rewardType: "percent", rewardValue: 10 },
        policy: { ...onPolicy, allowPercent: false },
      }),
    ).toMatchObject({ action: "skip", reason: "percent_disabled" });
  });

  it("grants percent of order amount (floor)", () => {
    const d = decideReferralReward({
      order: baseOrder, // 1000 分
      codeRow: { ...baseCode, rewardType: "percent", rewardValue: 10 },
      policy: onPolicy,
    });
    expect(d).toEqual({
      action: "grant",
      amountCents: 100, // floor(1000 * 10 / 100)
      ownerEmail: "owner@example.com",
      referralCode: "partner-a",
      rewardType: "percent",
      rewardValue: 10,
      currency: "CNY",
    });
  });

  it("clamps percent grant by maxFixedCents", () => {
    const d = decideReferralReward({
      order: { ...baseOrder, amountCents: 100_000 },
      codeRow: { ...baseCode, rewardType: "percent", rewardValue: 50 },
      policy: { ...onPolicy, maxFixedCents: 500 },
    });
    expect(d).toMatchObject({ action: "grant", amountCents: 500, rewardType: "percent" });
  });

  it("skips invalid percent points", () => {
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, rewardType: "percent", rewardValue: 0 },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "amount_invalid" });
    expect(
      decideReferralReward({
        order: baseOrder,
        codeRow: { ...baseCode, rewardType: "percent", rewardValue: 99 },
        policy: { ...onPolicy, maxPercent: 50 },
      }),
    ).toMatchObject({ action: "skip", reason: "amount_invalid" });
  });

  it("skips percent when floor amount is zero (tiny order)", () => {
    expect(
      decideReferralReward({
        order: { ...baseOrder, amountCents: 1 },
        codeRow: { ...baseCode, rewardType: "percent", rewardValue: 1 },
        policy: onPolicy,
      }),
    ).toMatchObject({ action: "skip", reason: "zero" });
  });
});

describe("validateFixedRewardConfig / validateRewardConfig", () => {
  it("requires email for fixed and caps amount", () => {
    expect(validateFixedRewardConfig({
      ownerContact: "x",
      rewardType: "fixed",
      rewardValue: 10,
      maxFixedCents: 100,
    }).ok).toBe(false);
    expect(validateFixedRewardConfig({
      ownerContact: "a@b.co",
      rewardType: "fixed",
      rewardValue: 200,
      maxFixedCents: 100,
    }).ok).toBe(false);
    const ok = validateFixedRewardConfig({
      ownerContact: "A@B.co",
      rewardType: "fixed",
      rewardValue: 50,
      maxFixedCents: 100,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.ownerEmail).toBe("a@b.co");
  });

  it("accepts percent points and rejects over cap", () => {
    const ok = validateFixedRewardConfig({
      ownerContact: "a@b.co",
      rewardType: "percent",
      rewardValue: 10,
      maxFixedCents: 50_000,
      maxPercent: 50,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.rewardValue).toBe(10);

    expect(
      validateFixedRewardConfig({
        ownerContact: "a@b.co",
        rewardType: "percent",
        rewardValue: 80,
        maxFixedCents: 50_000,
        maxPercent: 50,
      }).ok,
    ).toBe(false);
  });
});
