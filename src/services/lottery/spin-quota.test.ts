/**
 * instant 次数不变量单测（docs/116 §3.3.3、docs/217 §5 推荐奖励阶梯）
 */
import { describe, expect, it } from "vitest";
import {
  canConsumeSpin,
  computeViralSpinGrant,
  evaluateReferralMilestones,
  initialSpinsForJoin,
  isInstantSpinQuotaConfigured,
  normalizeInstantSpinQuota,
  normalizeReferralRewards,
  normalizePityConfig,
  normalizeDailyFreeSpinConfig,
  parseGrantedMilestones,
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

describe("normalizeReferralRewards（P0 推荐奖励阶梯）", () => {
  it("非数组/空数组 → []", () => {
    expect(normalizeReferralRewards(undefined)).toEqual([]);
    expect(normalizeReferralRewards(null)).toEqual([]);
    expect(normalizeReferralRewards("not-array")).toEqual([]);
    expect(normalizeReferralRewards({})).toEqual([]);
    expect(normalizeReferralRewards([])).toEqual([]);
  });

  it("过滤非法项：requireCount/rewardValue < 1、未知 rewardType", () => {
    expect(normalizeReferralRewards([
      { requireCount: 0, rewardType: "bonus_spin", rewardValue: 3 },
      { requireCount: 0.5, rewardType: "bonus_spin", rewardValue: 3 }, // floor=0 → 过滤
      { requireCount: 2, rewardType: "bonus_spin", rewardValue: 0 },
      { requireCount: 3, rewardType: "bonus_entry", rewardValue: 3 }, // 非 P0 类型剔除
      "junk",
      null,
    ])).toEqual([]);
  });

  it("按 requireCount 升序 + 同门槛去重（首个生效）", () => {
    const r = normalizeReferralRewards([
      { requireCount: 5, rewardType: "bonus_spin", rewardValue: 10 },
      { requireCount: 1, rewardType: "bonus_spin", rewardValue: 2 },
      { requireCount: 3, rewardType: "bonus_spin", rewardValue: 5 },
      { requireCount: 3, rewardType: "bonus_spin", rewardValue: 99 }, // 重复门槛被忽略
    ]);
    expect(r).toEqual([
      { requireCount: 1, rewardType: "bonus_spin", rewardValue: 2 },
      { requireCount: 3, rewardType: "bonus_spin", rewardValue: 5 },
      { requireCount: 5, rewardType: "bonus_spin", rewardValue: 10 },
    ]);
  });

  it("浮点 requireCount 向下取整且 ≥1 视为有效", () => {
    const r = normalizeReferralRewards([
      { requireCount: 2.9, rewardType: "bonus_spin", rewardValue: 1 },
      { requireCount: -1, rewardType: "bonus_spin", rewardValue: 1 },
    ]);
    expect(r).toEqual([{ requireCount: 2, rewardType: "bonus_spin", rewardValue: 1 }]);
  });
});

describe("parseGrantedMilestones", () => {
  it("空/非法 JSON → []", () => {
    expect(parseGrantedMilestones(null)).toEqual([]);
    expect(parseGrantedMilestones(undefined)).toEqual([]);
    expect(parseGrantedMilestones("")).toEqual([]);
    expect(parseGrantedMilestones("{bad json")).toEqual([]);
    expect(parseGrantedMilestones("{}")).toEqual([]);
  });

  it("合法数组 → 去重 + 升序 + 过滤非正数", () => {
    expect(parseGrantedMilestones('[3,1,"5",0,3,-2]')).toEqual([1, 3, 5]);
  });
});

describe("evaluateReferralMilestones（P0 发放判定）", () => {
  const milestones = [
    { requireCount: 1, rewardType: "bonus_spin" as const, rewardValue: 2 },
    { requireCount: 3, rewardType: "bonus_spin" as const, rewardValue: 5 },
    { requireCount: 5, rewardType: "bonus_spin" as const, rewardValue: 10 },
  ];

  it("joinedCount 未达任何门槛 → 无发放", () => {
    const r = evaluateReferralMilestones({ joinedCount: 0, milestones, granted: [] });
    expect(r.dueMilestones).toEqual([]);
    expect(r.totalSpinBonus).toBe(0);
    expect(r.nextGranted).toEqual([]);
  });

  it("跨过第 1 个门槛 → 只发该里程碑", () => {
    const r = evaluateReferralMilestones({ joinedCount: 2, milestones, granted: [] });
    expect(r.dueMilestones).toHaveLength(1);
    expect(r.dueMilestones[0]?.requireCount).toBe(1);
    expect(r.totalSpinBonus).toBe(2);
    expect(r.nextGranted).toEqual([1]);
  });

  it("多个里程碑同时达标（如配置后置）→ 全量计算", () => {
    const r = evaluateReferralMilestones({ joinedCount: 5, milestones, granted: [] });
    expect(r.dueMilestones.map((m) => m.requireCount)).toEqual([1, 3, 5]);
    expect(r.totalSpinBonus).toBe(17);
    expect(r.nextGranted).toEqual([1, 3, 5]);
  });

  it("已发放过的里程碑不再重复发放", () => {
    const r = evaluateReferralMilestones({ joinedCount: 3, milestones, granted: [1] });
    expect(r.dueMilestones.map((m) => m.requireCount)).toEqual([3]);
    expect(r.totalSpinBonus).toBe(5);
    expect(r.nextGranted).toEqual([1, 3]);
  });

  it("已发放集合含配置外的门槛 → 保持原样", () => {
    const r = evaluateReferralMilestones({ joinedCount: 5, milestones, granted: [99] });
    expect(r.dueMilestones.map((m) => m.requireCount)).toEqual([1, 3, 5]);
    expect(r.nextGranted).toEqual([1, 3, 5, 99]);
  });

  it("非法 granted 值被剔除", () => {
    const r = evaluateReferralMilestones({ joinedCount: 3, milestones, granted: [0, -1, 1] });
    expect(r.dueMilestones.map((m) => m.requireCount)).toEqual([3]);
    expect(r.nextGranted).toEqual([1, 3]);
  });
});

// P2 审查项：后端 normalize 上限校验（与前端表单一致，防 API 直写绕过）
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

  it("referralRewards requireCount>100 / rewardValue>1000 剔除", () => {
    const r = normalizeReferralRewards([
      { requireCount: 1, rewardType: "bonus_spin", rewardValue: 1000 },
      { requireCount: 101, rewardType: "bonus_spin", rewardValue: 1 },
      { requireCount: 5, rewardType: "bonus_spin", rewardValue: 1001 },
      { requireCount: 3, rewardType: "bonus_spin", rewardValue: 2 },
    ]);
    expect(r.map((m) => m.requireCount)).toEqual([1, 3]);
  });
});
