/**
 * instant 次数不变量单测（docs/116 §3.3.3、docs/217 §5 推荐奖励阶梯）
 */
import { describe, expect, it } from "vitest";
import {
  canConsumeSpin,
  computeViralSpinGrant,
  initialSpinsForJoin,
  isInstantSpinQuotaConfigured,
  normalizeInstantSpinQuota,
  normalizePityConfig,
  normalizeDailyFreeSpinConfig,
  weightedPickTier,
} from "./spin-quota";

describe("normalizeInstantSpinQuota / isConfigured", () => {
  it("max<1 视为未配置", () => {
    expect(isInstantSpinQuotaConfigured(0)).toBe(false);
    expect(isInstantSpinQuotaConfigured(-1)).toBe(false);
    expect(isInstantSpinQuotaConfigured(1)).toBe(true);
    expect(normalizeInstantSpinQuota({ maxSpinsPerEntry: 5 }).maxSpinsPerEntry).toBe(5);
  });

  it("initial 夹在 [1, max]", () => {
    expect(normalizeInstantSpinQuota({ maxSpinsPerEntry: 3, initialSpinsOnJoin: 99 }).initialSpinsOnJoin).toBe(3);
    expect(normalizeInstantSpinQuota({ maxSpinsPerEntry: 3, initialSpinsOnJoin: 0 }).initialSpinsOnJoin).toBe(1);
  });
});

describe("initialSpinsForJoin", () => {
  it("delayed max=0 → 全 0", () => {
    expect(initialSpinsForJoin(0)).toEqual({
      spinsLeft: 0,
      spinsTotalGranted: 0,
      spinsViralEarned: 0,
    });
  });

  it("instant max=1 → 发 1 次", () => {
    expect(initialSpinsForJoin(1)).toEqual({
      spinsLeft: 1,
      spinsTotalGranted: 1,
      spinsViralEarned: 0,
    });
  });

  it("initial 不超过 max", () => {
    expect(initialSpinsForJoin(2, 5).spinsTotalGranted).toBe(2);
  });
});

describe("computeViralSpinGrant 双封顶", () => {
  it("maxSpins=1 已满 → actual=0（只涨榜场景）", () => {
    const r = computeViralSpinGrant({
      maxSpinsPerEntry: 1,
      extraSpinsPerInvite: 1,
      maxExtraSpins: 10,
      spinsTotalGranted: 1,
      spinsViralEarned: 0,
    });
    expect(r.actual).toBe(0);
  });

  it("受 maxExtra 限制", () => {
    const r = computeViralSpinGrant({
      maxSpinsPerEntry: 10,
      extraSpinsPerInvite: 2,
      maxExtraSpins: 2,
      spinsTotalGranted: 1,
      spinsViralEarned: 1,
    });
    expect(r.actual).toBe(1);
    expect(r.nextViralEarned).toBe(2);
    expect(r.nextGranted).toBe(2);
  });

  it("受 maxSpins 总顶", () => {
    const r = computeViralSpinGrant({
      maxSpinsPerEntry: 3,
      extraSpinsPerInvite: 5,
      maxExtraSpins: 10,
      spinsTotalGranted: 2,
      spinsViralEarned: 0,
    });
    expect(r.actual).toBe(1);
    expect(r.nextGranted).toBe(3);
  });

  it("k=0 或未配置 max → 0", () => {
    expect(
      computeViralSpinGrant({
        maxSpinsPerEntry: 0,
        extraSpinsPerInvite: 1,
        maxExtraSpins: 5,
        spinsTotalGranted: 0,
        spinsViralEarned: 0,
      }).actual,
    ).toBe(0);
  });
});

describe("canConsumeSpin", () => {
  it("left≥1 可抽", () => {
    expect(canConsumeSpin(1)).toBe(true);
    expect(canConsumeSpin(0)).toBe(false);
  });
});

describe("weightedPickTier", () => {
  it("全 0 权重 → null", () => {
    expect(weightedPickTier([{ id: "a", weight: 0 }], () => 0.5)).toBeNull();
  });

  it("空池 / 非法 random 仍安全", () => {
    expect(weightedPickTier([], () => 0.5)).toBeNull();
    // random 越界夹到 0 → 第一档
    expect(weightedPickTier([{ id: "a", weight: 3 }], () => 1.5)?.id).toBe("a");
    expect(weightedPickTier([{ id: "a", weight: 3 }], () => -0.1)?.id).toBe("a");
  });

  it("按权重命中", () => {
    const tiers = [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ];
    expect(weightedPickTier(tiers, () => 0)?.id).toBe("a");
    expect(weightedPickTier(tiers, () => 0.49)?.id).toBe("a");
    expect(weightedPickTier(tiers, () => 0.5)?.id).toBe("b");
    // 接近 1 落在最后一档（cursor 耗尽兜底）
    expect(weightedPickTier(tiers, () => 0.999999)?.id).toBe("b");
  });

  it("权重比例 1:3 边界", () => {
    const tiers = [
      { id: "a", weight: 1 },
      { id: "b", weight: 3 },
    ];
    // total=4；u=0.24 → cursor=0.96 → a；u=0.25 → cursor=1 → 扣 a 后 0 不 <0 → b
    expect(weightedPickTier(tiers, () => 0.24)?.id).toBe("a");
    expect(weightedPickTier(tiers, () => 0.25)?.id).toBe("b");
  });
});

describe("normalize 上限校验（P2 审查修复）", () => {
  it("pity threshold 有效区间 2..100，越界视为未启用", () => {
    expect(normalizePityConfig({ enabled: true, threshold: 2 }).enabled).toBe(true);
    expect(normalizePityConfig({ enabled: true, threshold: 100 }).enabled).toBe(true);
    expect(normalizePityConfig({ enabled: true, threshold: 1 })).toEqual({ enabled: false, threshold: 0 });
    expect(normalizePityConfig({ enabled: true, threshold: 101 })).toEqual({ enabled: false, threshold: 0 });
  });

  it("dailyFree count 有效区间 1..10，越界视为未启用", () => {
    expect(normalizeDailyFreeSpinConfig({ enabled: true, count: 1 }).enabled).toBe(true);
    expect(normalizeDailyFreeSpinConfig({ enabled: true, count: 10 }).enabled).toBe(true);
    expect(normalizeDailyFreeSpinConfig({ enabled: true, count: 0 })).toEqual({ enabled: false, count: 0 });
    expect(normalizeDailyFreeSpinConfig({ enabled: true, count: 11 })).toEqual({ enabled: false, count: 0 });
  });
});
