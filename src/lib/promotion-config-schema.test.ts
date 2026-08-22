/**
 * promotionConfig zod schema 校验测试（docs/255 G-5）
 *
 * 覆盖：referralRewardDefs 结构校验 + 其他子结构（viral/flashSale/dailyFree/pity）结构级校验。
 */
import { describe, expect, it } from "vitest";
import { validatePromotionConfig, validateReferralRewardDefs } from "./promotion-config-schema";

describe("validateReferralRewardDefs", () => {
  it("未配置 → null（跳过）", () => {
    expect(validateReferralRewardDefs(null)).toBeNull();
    expect(validateReferralRewardDefs({})).toBeNull();
    expect(validateReferralRewardDefs({ referralRewardDefs: undefined })).toBeNull();
  });

  it("合法配置 → null", () => {
    const issues = validateReferralRewardDefs({
      referralRewardDefs: [
        {
          rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "2",
          conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
          metadata: { rewardExit: "bonus_spin" },
        },
      ],
    });
    expect(issues).toBeNull();
  });

  it("conditions 非数组 → 报错（fail-open 根除）", () => {
    const issues = validateReferralRewardDefs({
      referralRewardDefs: [
        {
          rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2",
          conditions: { field: "totalJoinedCount", operator: "GTE", value: "3" }, // 对象非数组
        },
      ],
    });
    expect(issues).not.toBeNull();
    expect(JSON.stringify(issues)).toContain("conditions");
  });

  it("非法字段名 → 报错", () => {
    const issues = validateReferralRewardDefs({
      referralRewardDefs: [
        {
          rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2",
          conditions: [{ field: "joinedCount", operator: "GTE", value: "3" }], // 非法字段
        },
      ],
    });
    expect(issues).not.toBeNull();
  });

  it("非法算子 → 报错", () => {
    const issues = validateReferralRewardDefs({
      referralRewardDefs: [
        {
          rewardId: "m1", type: "FIXED", target: "SOURCE", fixedAmount: "2",
          conditions: [{ field: "totalJoinedCount", operator: "INVALID", value: "3" }],
        },
      ],
    });
    expect(issues).not.toBeNull();
  });

  it("level/parget 类型 → 报错（白名单收窄）", () => {
    const issues = validateReferralRewardDefs({
      referralRewardDefs: [
        { rewardId: "m1", type: "LEVEL", target: "SOURCE", fixedAmount: "2" },
        { rewardId: "m2", type: "FIXED", target: "PARENT", fixedAmount: "2" },
      ],
    });
    expect(issues).not.toBeNull();
  });
});

describe("validatePromotionConfig", () => {
  it("未配置 → null", () => {
    expect(validatePromotionConfig(null)).toBeNull();
    expect(validatePromotionConfig({})).toBeNull();
  });

  it("合法完整配置 → null", () => {
    const issues = validatePromotionConfig({
      version: 1,
      referralRewardDefs: [
        {
          rewardId: "invite_1", type: "FIXED", target: "SOURCE", fixedAmount: "2",
          conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
          metadata: { rewardExit: "bonus_spin" },
        },
      ],
      viral: { enabled: true, extraSpinsPerInvite: 1, maxExtraSpins: 3 },
      flashSale: { enabled: false, sessionLabel: "12:00场", stockLimit: 100, maxPerUser: 5, priceCents: 9900 },
      dailyFreeSpins: { enabled: true, count: 1 },
      pity: { enabled: true, threshold: 3 },
    });
    expect(issues).toBeNull();
  });

  it("viral.enabled 非布尔 → 报错", () => {
    const issues = validatePromotionConfig({
      version: 1,
      viral: { enabled: "true" }, // 字符串非布尔
    });
    expect(issues).not.toBeNull();
  });

  it("flashSale.pricingTiers 元素缺字段 → 报错", () => {
    const issues = validatePromotionConfig({
      version: 1,
      flashSale: { enabled: true, pricingTiers: [{ minQuantity: "5" }] }, // minQuantity 字符串
    });
    expect(issues).not.toBeNull();
  });

  it("未知子结构键保留（passthrough）", () => {
    const issues = validatePromotionConfig({
      version: 1,
      referralRewardDefs: [
        {
          rewardId: "invite_1", type: "FIXED", target: "SOURCE", fixedAmount: "2",
          conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
          metadata: { rewardExit: "bonus_spin" },
        },
      ],
      someFutureKey: { nested: true }, // 未知键应保留不报错
    });
    expect(issues).toBeNull();
  });

  describe("rewardId 唯一性（docs/259 §9.5：重复会让某档位永不发放且无提示）", () => {
    const def = (rewardId: string, amount: string, threshold: string) => ({
      rewardId, type: "FIXED", target: "SOURCE", fixedAmount: amount,
      conditions: [{ field: "totalJoinedCount", operator: "GTE", value: threshold }],
      metadata: { rewardExit: "bonus_spin" },
    });

    it("重复 rewardId → 保存期报错（而非运行时静默剔除）", () => {
      const issues = validatePromotionConfig({
        version: 1,
        referralRewardDefs: [def("invite_1", "2", "1"), def("invite_1", "3", "3")],
      });
      expect(issues).not.toBeNull();
      expect(issues!.join("；")).toContain("rewardId 重复（invite_1）");
      // 报错定位到第 2 条，运营能直接找到要改的行
      expect(issues!.join("；")).toContain("referralRewardDefs.1.rewardId");
    });

    it("同样的重复经 validateReferralRewardDefs 子校验也被拦下", () => {
      const issues = validateReferralRewardDefs({
        referralRewardDefs: [def("m1", "2", "1"), def("m2", "2", "2"), def("m1", "2", "3")],
      });
      expect(issues).not.toBeNull();
      expect(issues!.join("；")).toContain("rewardId 重复（m1）");
    });

    it("id 各不相同 → 通过（不影响正常配置）", () => {
      expect(validatePromotionConfig({
        version: 1,
        referralRewardDefs: [def("invite_1", "2", "1"), def("invite_1_2", "3", "3"), def("legacy-a", "1", "5")],
      })).toBeNull();
    });
  });
});