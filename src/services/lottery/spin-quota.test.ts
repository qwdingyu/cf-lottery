/**
 * instant 次数不变量单测（docs/116 §3.3.3）
 */
import { describe, expect, it } from "vitest";
import {
  canConsumeSpin,
  computeViralSpinGrant,
  initialSpinsForJoin,
  isInstantSpinQuotaConfigured,
  normalizeInstantSpinQuota,
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

  it("按权重命中", () => {
    const tiers = [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ];
    expect(weightedPickTier(tiers, () => 0)?.id).toBe("a");
    expect(weightedPickTier(tiers, () => 0.49)?.id).toBe("a");
    expect(weightedPickTier(tiers, () => 0.5)?.id).toBe("b");
  });
});
