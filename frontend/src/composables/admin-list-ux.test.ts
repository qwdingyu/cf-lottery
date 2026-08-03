import { describe, expect, it } from "vitest";
import {
  canEnableDrawNow,
  onboardingSuccessPath,
  shouldPrioritizeShareForOpenLottery,
} from "./admin-list-ux";

describe("admin-list-ux", () => {
  it("open 抽奖始终优先分享", () => {
    expect(shouldPrioritizeShareForOpenLottery(0)).toBe(true);
    expect(shouldPrioritizeShareForOpenLottery(12)).toBe(true);
  });

  it("无参与不可开奖；有参与可开奖", () => {
    expect(canEnableDrawNow(0)).toBe(false);
    expect(canEnableDrawNow(undefined)).toBe(false);
    expect(canEnableDrawNow(1)).toBe(true);
  });

  it("onboarding 成功直达创建活动 + new=true", () => {
    expect(onboardingSuccessPath()).toEqual({
      path: "/admin/draws",
      query: { new: "true" },
    });
  });
});
