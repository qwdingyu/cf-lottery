/**
 * 邀请里程碑进度纯计算单测（docs/259 D2 ②）
 */
import { describe, expect, it } from "vitest";
import {
  buildGrantedMark,
  buildMilestoneProgress,
  extractMilestoneThreshold,
  parseGrantedRewardIds,
  splitGrantedMarks,
} from "./referral-milestones";

describe("parseGrantedRewardIds", () => {
  it("非法 JSON / 非数组 / 空值一律回退空集", () => {
    expect(parseGrantedRewardIds(null)).toEqual([]);
    expect(parseGrantedRewardIds("")).toEqual([]);
    expect(parseGrantedRewardIds("{oops")).toEqual([]);
    expect(parseGrantedRewardIds('{"a":1}')).toEqual([]);
  });

  it("剔除非字符串与空串", () => {
    expect(parseGrantedRewardIds('["m1", 2, "", null, "m2"]')).toEqual(["m1", "m2"]);
  });
});

describe("splitGrantedMarks", () => {
  it("整标记与部分标记分流", () => {
    const { full, partial } = splitGrantedMarks(["m1", "c1:2"]);
    expect([...full]).toEqual(["m1"]);
    expect(partial.get("c1")).toBe(2);
  });

  it("同一 rewardId 多个部分标记取最大值（保守不重复发）", () => {
    expect(splitGrantedMarks(["c1:1", "c1:3", "c1:2"]).partial.get("c1")).toBe(3);
  });

  it("rewardId 自身含冒号但后缀非正整数 → 视为整标记", () => {
    const { full, partial } = splitGrantedMarks(["invite:5人", "c1:0"]);
    expect(full.has("invite:5人")).toBe(true);
    expect(full.has("c1:0")).toBe(true);
    expect(partial.size).toBe(0);
  });
});

describe("buildGrantedMark", () => {
  it("发满写整标记，未发满写份数", () => {
    expect(buildGrantedMark("c1", 3, 3)).toBe("c1");
    expect(buildGrantedMark("c1", 5, 3)).toBe("c1");
    expect(buildGrantedMark("c1", 2, 3)).toBe("c1:2");
  });
});

describe("extractMilestoneThreshold", () => {
  it("GTE 直接取值；GT 换算为 +1", () => {
    expect(extractMilestoneThreshold([{ field: "totalJoinedCount", operator: "GTE", value: "5" }])).toBe(5);
    expect(extractMilestoneThreshold([{ field: "totalJoinedCount", operator: "GT", value: "5" }])).toBe(6);
  });

  it("多个阈值取最严格（AND 语义）", () => {
    expect(extractMilestoneThreshold([
      { field: "totalJoinedCount", operator: "GTE", value: "3" },
      { field: "totalJoinedCount", operator: "GTE", value: "7" },
    ])).toBe(7);
  });

  it("显式 AND 节点递归", () => {
    expect(extractMilestoneThreshold([
      { type: "AND", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "4" }] },
    ])).toBe(4);
  });

  it("OR / NOT 不可归约 → null（不猜测）", () => {
    expect(extractMilestoneThreshold([
      { type: "OR", conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "4" }] },
    ])).toBeNull();
  });

  it("其他字段 / 其他算子 / 非数组 / 非数值 → null", () => {
    expect(extractMilestoneThreshold([{ field: "activityKind", operator: "EQ", value: "lottery" }])).toBeNull();
    expect(extractMilestoneThreshold([{ field: "totalJoinedCount", operator: "LTE", value: "5" }])).toBeNull();
    expect(extractMilestoneThreshold([{ field: "totalJoinedCount", operator: "GTE", value: "x" }])).toBeNull();
    expect(extractMilestoneThreshold(undefined)).toBeNull();
    expect(extractMilestoneThreshold("[]")).toBeNull();
  });
});

const def = (rewardId: string, requireCount: number, extra: Record<string, unknown> = {}) => ({
  rewardId,
  type: "FIXED",
  target: "SOURCE",
  fixedAmount: "2",
  conditions: [{ field: "totalJoinedCount", operator: "GTE", value: String(requireCount) }],
  metadata: { rewardExit: "bonus_spin" },
  ...extra,
});

describe("buildMilestoneProgress", () => {
  it("按阈值升序 + 达标/已发放判定 + 下一档", () => {
    const p = buildMilestoneProgress({
      defs: [def("m5", 5), def("m1", 1), def("m3", 3)],
      totalJoined: 3,
      marks: ["m1"],
    });
    expect(p.milestones.map((m) => m.rewardId)).toEqual(["m1", "m3", "m5"]);
    expect(p.milestones.map((m) => m.reached)).toEqual([true, true, false]);
    expect(p.unlockedCount).toBe(2);
    expect(p.grantedCount).toBe(1);
    expect(p.nextMilestone?.rewardId).toBe("m5");
    expect(p.milestones[0]!.granted).toBe(true);
    expect(p.milestones[0]!.grantedCount).toBe(2);   // 整标记 → 视为发满 amount
    expect(p.milestones[1]!.granted).toBe(false);
  });

  it("部分标记体现续发进度", () => {
    const p = buildMilestoneProgress({
      defs: [def("c1", 2, { metadata: { rewardExit: "bonus_coupon", couponLabel: "double11" }, fixedAmount: "5" })],
      totalJoined: 2,
      marks: ["c1:3"],
    });
    expect(p.milestones[0]!.rewardExit).toBe("bonus_coupon");
    expect(p.milestones[0]!.couponLabel).toBe("double11");
    expect(p.milestones[0]!.amount).toBe(5);
    expect(p.milestones[0]!.granted).toBe(false);
    expect(p.milestones[0]!.grantedCount).toBe(3);
  });

  it("非 FIXED 不预告份数（引擎实时算，不猜测）", () => {
    const p = buildMilestoneProgress({
      defs: [{ ...def("d1", 2), type: "DIRECT", fixedAmount: undefined }],
      totalJoined: 2,
      marks: [],
    });
    expect(p.milestones[0]!.amount).toBeNull();
    expect(p.milestones[0]!.grantedCount).toBe(0);
  });

  it("阈值不可归约的档位排最后且不算达标、不进 nextMilestone", () => {
    const p = buildMilestoneProgress({
      defs: [{ ...def("x1", 1), conditions: [] }, def("m2", 2)],
      totalJoined: 9,
      marks: [],
    });
    expect(p.milestones.map((m) => m.rewardId)).toEqual(["m2", "x1"]);
    expect(p.milestones[1]!.requireCount).toBeNull();
    expect(p.milestones[1]!.reached).toBe(false);
    expect(p.nextMilestone).toBeNull();
    expect(p.unlockedCount).toBe(1);
  });

  it("空 defs → 空进度", () => {
    const p = buildMilestoneProgress({ defs: [], totalJoined: 5, marks: [] });
    expect(p.milestones).toEqual([]);
    expect(p.nextMilestone).toBeNull();
    expect(p.unlockedCount).toBe(0);
  });
});
