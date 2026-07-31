/**
 * L1 可选分销自动返佣 — 纯决策逻辑（无 I/O、无 DB）。
 *
 * 职责边界：
 * - 本模块：给定订单快照 + 码 registry 快照 + 策略 → grant 或 skip+reason
 * - 服务层（referral-reward-service）：读库、CAS、余额入账/冲正、台账
 *
 * 设计意图：skip 矩阵可用单测穷尽，避免把业务规则埋在异步 I/O 里无法审。
 * 默认策略 DEFAULT_REFERRAL_REWARD_POLICY.enabled=false → 与系统配置 default-off 一致。
 */

import { canonicalBuyerEmail } from "./canonical-email";
/** 支付事实口径：与 order-status.PAID_LIKE / L0 结算同源，禁止本地再写 paid|issued 字面量。 */
import { isPaidLikeOrderStatus } from "./order-status";

export { isPaidLikeOrderStatus };

export type ReferralRewardType = "none" | "fixed" | "percent";

export type ReferralRewardSkipReason =
  | "no_ref"
  | "disabled_global"
  | "not_paid"
  | "unregistered"
  | "inactive"
  | "none"
  | "owner_not_email"
  | "zero"
  | "exceeds_order"
  | "currency"
  | "self_purchase"
  | "percent_disabled"
  | "amount_invalid";

export type ReferralRewardDecision =
  | { action: "skip"; reason: ReferralRewardSkipReason }
  | {
      action: "grant";
      amountCents: number;
      ownerEmail: string;
      referralCode: string;
      /** 配置类型快照；金额已按 fixed/percent 规则算成分 */
      rewardType: "fixed" | "percent";
      rewardValue: number;
      currency: string;
    };

export type ReferralCodeSnapshot = {
  code: string;
  ownerContact: string;
  rewardType: string;
  rewardValue: number;
  active: number | boolean;
};

export type OrderRewardSnapshot = {
  id: string;
  status: string;
  paidAt?: string | null;
  amountCents: number;
  currency: string;
  referralCode?: string | null;
  buyerEmail?: string | null;
};

export type ReferralRewardPolicy = {
  enabled: boolean;
  /** 单笔入账上限（分）；fixed 配置值与 percent 计算结果均受此约束 */
  maxFixedCents: number;
  skipSelfPurchase: boolean;
  /**
   * 是否允许 percent 类型发奖。
   * 默认 true；可在服务层关断作紧急刹车（不删库内 percent 码）。
   */
  allowPercent: boolean;
  /** 站内余额首期仅 CNY */
  balanceCurrency: string;
  /** percent 配置上限（整数百分点 1–100）；默认 50 */
  maxPercent: number;
};

export const DEFAULT_REFERRAL_REWARD_POLICY: ReferralRewardPolicy = {
  enabled: false,
  maxFixedCents: 50_000,
  skipSelfPurchase: true,
  allowPercent: true,
  balanceCurrency: "CNY",
  maxPercent: 50,
};

/** percent 的 rewardValue：整数百分点（10 = 订单实付的 10%）。 */
export function isValidPercentPoints(value: unknown, maxPercent: number): value is number {
  const n = Number(value);
  const cap = Math.min(100, Math.max(1, Math.floor(maxPercent) || 50));
  return Number.isInteger(n) && n >= 1 && n <= cap;
}

/** 宽松邮箱形态：含 @ 且两侧非空；入账前再经 canonicalBuyerEmail。 */
export function looksLikeEmail(value: string): boolean {
  const v = (value || "").trim();
  if (!v || v.length > 120) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@") || at === v.length - 1) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !/\s/.test(v);
}

export function normalizeOwnerEmail(ownerContact: string): string | null {
  if (!looksLikeEmail(ownerContact)) return null;
  const canonical = canonicalBuyerEmail(ownerContact);
  return looksLikeEmail(canonical) ? canonical : null;
}

/**
 * 计算是否应发奖及金额。不读写库。
 * registry 缺失时传 codeRow=null → unregistered。
 */
export function decideReferralReward(input: {
  order: OrderRewardSnapshot;
  codeRow: ReferralCodeSnapshot | null;
  policy: ReferralRewardPolicy;
}): ReferralRewardDecision {
  const { order, codeRow, policy } = input;
  const ref = String(order.referralCode || "").trim().toLowerCase();
  if (!ref) return { action: "skip", reason: "no_ref" };
  if (!policy.enabled) return { action: "skip", reason: "disabled_global" };
  if (!isPaidLikeOrderStatus(order.status, order.paidAt)) {
    return { action: "skip", reason: "not_paid" };
  }
  if (!codeRow) return { action: "skip", reason: "unregistered" };

  const active = codeRow.active === true || codeRow.active === 1;
  if (!active) return { action: "skip", reason: "inactive" };

  const rewardType = String(codeRow.rewardType || "none").toLowerCase();
  if (rewardType === "none") return { action: "skip", reason: "none" };
  if (rewardType !== "fixed" && rewardType !== "percent") {
    return { action: "skip", reason: "none" };
  }
  if (rewardType === "percent" && !policy.allowPercent) {
    return { action: "skip", reason: "percent_disabled" };
  }

  const ownerEmail = normalizeOwnerEmail(codeRow.ownerContact);
  if (!ownerEmail) return { action: "skip", reason: "owner_not_email" };

  const currency = String(order.currency || "CNY").toUpperCase() || "CNY";
  if (currency !== policy.balanceCurrency.toUpperCase()) {
    return { action: "skip", reason: "currency" };
  }

  const rewardValue = Number(codeRow.rewardValue);
  const orderAmount = Number(order.amountCents);
  if (!Number.isFinite(orderAmount) || orderAmount < 0) {
    return { action: "skip", reason: "amount_invalid" };
  }

  let amountCents = 0;
  if (rewardType === "fixed") {
    if (!Number.isInteger(rewardValue) || rewardValue <= 0) {
      return { action: "skip", reason: "zero" };
    }
    if (rewardValue > policy.maxFixedCents) {
      return { action: "skip", reason: "amount_invalid" };
    }
    if (rewardValue > orderAmount) {
      return { action: "skip", reason: "exceeds_order" };
    }
    amountCents = rewardValue;
  } else {
    // percent：rewardValue = 整数百分点；金额 = floor(实付 × pct / 100)，再夹紧单笔上限
    const maxPct = policy.maxPercent ?? DEFAULT_REFERRAL_REWARD_POLICY.maxPercent;
    if (!isValidPercentPoints(rewardValue, maxPct)) {
      return { action: "skip", reason: "amount_invalid" };
    }
    amountCents = Math.floor((orderAmount * rewardValue) / 100);
    if (amountCents <= 0) return { action: "skip", reason: "zero" };
    if (amountCents > policy.maxFixedCents) {
      amountCents = policy.maxFixedCents;
    }
    if (amountCents > orderAmount) {
      amountCents = Math.floor(orderAmount);
    }
    if (amountCents <= 0) return { action: "skip", reason: "zero" };
  }

  if (policy.skipSelfPurchase) {
    const buyer = String(order.buyerEmail || "").trim();
    if (buyer && looksLikeEmail(buyer)) {
      const buyerCanon = canonicalBuyerEmail(buyer);
      if (buyerCanon === ownerEmail) {
        return { action: "skip", reason: "self_purchase" };
      }
    }
  }

  return {
    action: "grant",
    amountCents,
    ownerEmail,
    referralCode: String(codeRow.code || ref).trim().toLowerCase() || ref,
    rewardType,
    rewardValue,
    currency,
  };
}

/**
 * 配置校验：none / fixed（分）/ percent（整数百分点）。
 * 历史名 validateFixedRewardConfig 保留作别名。
 */
export function validateRewardConfig(input: {
  ownerContact: string;
  rewardType: string;
  rewardValue: number;
  maxFixedCents: number;
  maxPercent?: number;
}): { ok: true; ownerEmail: string; rewardValue: number; rewardType: "none" | "fixed" | "percent" }
  | { ok: false; message: string } {
  const type = String(input.rewardType || "none").toLowerCase();
  if (type === "none") {
    return {
      ok: true,
      ownerEmail: String(input.ownerContact || "").trim(),
      rewardValue: 0,
      rewardType: "none",
    };
  }
  if (type !== "fixed" && type !== "percent") {
    return { ok: false, message: "rewardType 仅支持 none、fixed 或 percent" };
  }
  const ownerEmail = normalizeOwnerEmail(input.ownerContact);
  if (!ownerEmail) {
    return { ok: false, message: "启用返佣时码主必须为有效邮箱" };
  }
  const value = Number(input.rewardValue);
  if (type === "fixed") {
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, message: "fixed 佣金必须为正整数（分）" };
    }
    if (value > input.maxFixedCents) {
      return { ok: false, message: `fixed 佣金不得超过上限 ${input.maxFixedCents} 分` };
    }
    return { ok: true, ownerEmail, rewardValue: value, rewardType: "fixed" };
  }
  const maxPct = input.maxPercent ?? DEFAULT_REFERRAL_REWARD_POLICY.maxPercent;
  if (!isValidPercentPoints(value, maxPct)) {
    return {
      ok: false,
      message: `percent 佣金须为 1–${Math.min(100, Math.max(1, Math.floor(maxPct) || 50))} 的整数百分点`,
    };
  }
  return { ok: true, ownerEmail, rewardValue: value, rewardType: "percent" };
}

/** @deprecated 使用 validateRewardConfig；保留别名避免调用方大面积改名 */
export function validateFixedRewardConfig(input: {
  ownerContact: string;
  rewardType: string;
  rewardValue: number;
  maxFixedCents: number;
  maxPercent?: number;
}): { ok: true; ownerEmail: string; rewardValue: number } | { ok: false; message: string } {
  const result = validateRewardConfig(input);
  if (!result.ok) return result;
  return { ok: true, ownerEmail: result.ownerEmail, rewardValue: result.rewardValue };
}
