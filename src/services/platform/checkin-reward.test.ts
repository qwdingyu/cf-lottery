/**
 * 签到奖励配置计算单元测试（docs/172）。
 *
 * 覆盖：
 * 1. parseStoredCheckinPolicy — 各种配置解析
 * 2. computeCheckinReward — 4 种模式（daily/linear/step/cycle）
 * 3. nextStreakAfterCheckin — 连续/断签/首次
 * 4. 边界：随机注入、封顶、周期重置
 */
import { describe, expect, it } from "vitest";
import {
  parseStoredCheckinPolicy,
  computeCheckinReward,
  nextStreakAfterCheckin,
  todayStr,
} from "./checkin-reward";

describe("parseStoredCheckinPolicy", () => {
  it("返回 undefined 当输入非法/空", () => {
    expect(parseStoredCheckinPolicy(null)).toBeUndefined();
    expect(parseStoredCheckinPolicy(undefined)).toBeUndefined();
    expect(parseStoredCheckinPolicy("")).toBeUndefined();
    expect(parseStoredCheckinPolicy({})).toBeUndefined();
  });

  it("解析旧字段 grantSpinCount", () => {
    const result = parseStoredCheckinPolicy({ grantSpinCount: 5 });
    expect(result).toEqual({ grantSpinCount: 5 });
  });

  it("忽略 grantSpinCount 为 0", () => {
    expect(parseStoredCheckinPolicy({ grantSpinCount: 0 })).toBeUndefined();
  });

  it("忽略 grantSpinCount 为负数", () => {
    expect(parseStoredCheckinPolicy({ grantSpinCount: -1 })).toBeUndefined();
  });

  it("解析 daily 模式", () => {
    const result = parseStoredCheckinPolicy({
      rewardConfig: { mode: "daily", baseRange: { min: 3, max: 5 } },
    });
    expect(result?.rewardConfig?.mode).toBe("daily");
    expect(result?.rewardConfig?.baseRange).toEqual({ min: 3, max: 5 });
  });

  it("解析 linear 模式完整字段", () => {
    const result = parseStoredCheckinPolicy({
      rewardConfig: { mode: "linear", baseRange: { min: 1, max: 1 }, increment: 2, cap: 10 },
    });
    expect(result?.rewardConfig?.mode).toBe("linear");
    expect(result?.rewardConfig?.increment).toBe(2);
    expect(result?.rewardConfig?.cap).toBe(10);
  });

  it("解析 step 模式", () => {
    const result = parseStoredCheckinPolicy({
      rewardConfig: { mode: "step", baseRange: { min: 1, max: 1 }, increment: 3, stepDays: 7, cap: 20 },
    });
    expect(result?.rewardConfig?.mode).toBe("step");
    expect(result?.rewardConfig?.stepDays).toBe(7);
  });

  it("解析 cycle 模式", () => {
    const result = parseStoredCheckinPolicy({
      rewardConfig: { mode: "cycle", baseRange: { min: 2, max: 2 }, cycleDays: 7, cycleBonus: 5, cap: 10 },
    });
    expect(result?.rewardConfig?.mode).toBe("cycle");
    expect(result?.rewardConfig?.cycleDays).toBe(7);
    expect(result?.rewardConfig?.cycleBonus).toBe(5);
  });

  it("忽略非法模式", () => {
    expect(parseStoredCheckinPolicy({ rewardConfig: { mode: "unknown", baseRange: { min: 1, max: 1 } } })).toBeUndefined();
  });

  it("忽略不合法的 baseRange", () => {
    expect(parseStoredCheckinPolicy({ rewardConfig: { mode: "daily", baseRange: { min: 5, max: 1 } } })).toBeUndefined();
  });

  describe("randomBonus（P2 随机签到事件）", () => {
    it("解析 randomBonus 与 rewardConfig 共存", () => {
      const result = parseStoredCheckinPolicy({
        rewardConfig: { mode: "daily", baseRange: { min: 2, max: 2 } },
        randomBonus: { enabled: true, probability: 0.2, bonusRange: { min: 1, max: 3 } },
      });
      expect(result?.rewardConfig?.mode).toBe("daily");
      expect(result?.randomBonus).toEqual({ enabled: true, probability: 0.2, bonusRange: { min: 1, max: 3 } });
    });

    it("解析 randomBonus 与 grantSpinCount 共存", () => {
      const result = parseStoredCheckinPolicy({
        grantSpinCount: 3,
        randomBonus: { enabled: true, probability: 0.15, bonusRange: { min: 1, max: 2 } },
      });
      expect(result?.grantSpinCount).toBe(3);
      expect(result?.randomBonus).toEqual({ enabled: true, probability: 0.15, bonusRange: { min: 1, max: 2 } });
    });

    it("忽略非法概率（超出 0~1 范围）", () => {
      const result = parseStoredCheckinPolicy({
        grantSpinCount: 1,
        randomBonus: { enabled: true, probability: 1.5, bonusRange: { min: 1, max: 3 } },
      });
      expect(result?.grantSpinCount).toBe(1);
      expect(result?.randomBonus).toBeUndefined();
    });

    it("忽略非法范围（max < min）", () => {
      const result = parseStoredCheckinPolicy({
        grantSpinCount: 1,
        randomBonus: { enabled: true, probability: 0.2, bonusRange: { min: 5, max: 3 } },
      });
      expect(result?.grantSpinCount).toBe(1);
      expect(result?.randomBonus).toBeUndefined();
    });

    it("忽略不完整的 randomBonus（无 probability）", () => {
      const result = parseStoredCheckinPolicy({
        grantSpinCount: 1,
        randomBonus: { enabled: true, bonusRange: { min: 1, max: 3 } },
      });
      expect(result?.grantSpinCount).toBe(1);
      expect(result?.randomBonus).toBeUndefined();
    });
  });
});

describe("computeCheckinReward", () => {
  it("无 streakConfig 时返回 grantSpinCount", () => {
    expect(computeCheckinReward(undefined, 5, 0, 1)).toBe(5);
  });

  it("无 streakConfig 且无 grantSpinCount 时返回 0", () => {
    expect(computeCheckinReward(undefined, undefined, 0, 1)).toBe(0);
  });

  describe("daily 模式", () => {
    it("固定值（min===max）", () => {
      const cfg = { mode: "daily" as const, baseRange: { min: 3, max: 3 } };
      expect(computeCheckinReward(cfg, 0, 0, 1)).toBe(3);
    });

    it("区间随机：min<max 时返回区间内的值", () => {
      const cfg = { mode: "daily" as const, baseRange: { min: 1, max: 5 } };
      expect(computeCheckinReward(cfg, 0, 0, 1, () => 0.5)).toBe(3);
      expect(computeCheckinReward(cfg, 0, 0, 1, () => 0.0)).toBe(1);
      expect(computeCheckinReward(cfg, 0, 0, 1, () => 0.999)).toBe(5);
    });
  });

  describe("linear 模式", () => {
    const cfg = { mode: "linear" as const, baseRange: { min: 1, max: 1 }, increment: 2, cap: 10 };

    it("第 1 天 = base", () => {
      expect(computeCheckinReward(cfg, 0, 0, 1)).toBe(1);
    });

    it("第 3 天 = base + 2*2 = 5", () => {
      expect(computeCheckinReward(cfg, 0, 2, 3)).toBe(5);
    });

    it("封顶 cap=10", () => {
      expect(computeCheckinReward(cfg, 0, 9, 10)).toBe(10);
    });
  });

  describe("step 模式", () => {
    const cfg = { mode: "step" as const, baseRange: { min: 1, max: 1 }, increment: 3, stepDays: 7, cap: 20 };

    it("第 1 天 = base", () => {
      expect(computeCheckinReward(cfg, 0, 0, 1)).toBe(1);
    });

    it("第 7 天 = base（仍在第一阶梯）", () => {
      expect(computeCheckinReward(cfg, 0, 6, 7)).toBe(1);
    });

    it("第 8 天 = base + increment（进入第二阶梯）", () => {
      expect(computeCheckinReward(cfg, 0, 7, 8)).toBe(4);
    });
  });

  describe("cycle 模式", () => {
    const cfg = { mode: "cycle" as const, baseRange: { min: 2, max: 2 }, cycleDays: 7, cycleBonus: 5, cap: 10 };

    it("第 1-6 天 = base", () => {
      expect(computeCheckinReward(cfg, 0, 0, 1)).toBe(2);
      expect(computeCheckinReward(cfg, 0, 5, 6)).toBe(2);
    });

    it("第 7 天 = base + cycleBonus", () => {
      expect(computeCheckinReward(cfg, 0, 6, 7)).toBe(7);
    });

    it("第 8 天 = base（周期重置，新周期第 1 天）", () => {
      expect(computeCheckinReward(cfg, 0, 0, 1)).toBe(2);
    });
  });

  describe("randomBonus（P2 随机签到事件）", () => {
    const rb = { enabled: true, probability: 0.5, bonusRange: { min: 2, max: 2 } };

    it("固定奖励 + 随机命中：random01<概率则加 bonus", () => {
      // 基础=3（固定），random01()=0.0 < 0.5 → 触发，bonus=2，合计 5
      expect(computeCheckinReward(undefined, 3, 0, 1, () => 0.0, rb)).toBe(5);
    });

    it("固定奖励 + 随机未命中：random01>=概率则不加", () => {
      // 基础=3，random01()=0.9 >= 0.5 → 不触发，保持 3
      expect(computeCheckinReward(undefined, 3, 0, 1, () => 0.9, rb)).toBe(3);
    });

    it("区间 bonus：随机命中时在 [min,max] 内取值", () => {
      const rbRange = { enabled: true, probability: 1.0, bonusRange: { min: 1, max: 5 } };
      // 概率 1.0 必触发；random01 第一次用于 bonus 命中判断（0.0<1.0），第二次用于区间取值
      expect(computeCheckinReward(undefined, 1, 0, 1, () => 0.5, rbRange)).toBe(1 + 3);
      expect(computeCheckinReward(undefined, 1, 0, 1, () => 0.0, rbRange)).toBe(1 + 1);
      expect(computeCheckinReward(undefined, 1, 0, 1, () => 0.999, rbRange)).toBe(1 + 5);
    });

    it("未启用 randomBonus 时不影响基础奖励", () => {
      expect(computeCheckinReward(undefined, 3, 0, 1, () => 0.0, { ...rb, enabled: false })).toBe(3);
    });

    it("与递增模式叠加：linear + 随机 bonus", () => {
      const cfg = { mode: "linear" as const, baseRange: { min: 1, max: 1 }, increment: 2, cap: 10 };
      // 第 3 天基础 = 1 + 2*2 = 5，random01()=0.0 触发 bonus=2 → 7
      expect(computeCheckinReward(cfg, 0, 2, 3, () => 0.0, rb)).toBe(7);
    });

    it("不传 randomBonus 时行为不变（向后兼容）", () => {
      expect(computeCheckinReward(undefined, 5, 0, 1)).toBe(5);
    });
  });
});

describe("nextStreakAfterCheckin", () => {
  const today = "2026-08-10";

  it("从未签到 → 1", () => {
    expect(nextStreakAfterCheckin(null, 0, today)).toBe(1);
    expect(nextStreakAfterCheckin(undefined, 0, today)).toBe(1);
  });

  it("昨天签过 → currentStreak + 1", () => {
    expect(nextStreakAfterCheckin("2026-08-09", 5, today)).toBe(6);
  });

  it("更早签过（断签）→ 重置为 1", () => {
    expect(nextStreakAfterCheckin("2026-08-08", 5, today)).toBe(1);
  });

  it("今天已签过（同日）→ 重置为 1", () => {
    expect(nextStreakAfterCheckin(today, 5, today)).toBe(1);
  });
});

describe("todayStr", () => {
  it("返回 YYYY-MM-DD 格式", () => {
    const str = todayStr();
    expect(str).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
