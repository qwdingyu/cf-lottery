import { describe, expect, it } from "vitest";
import {
  canEnableDrawNow,
  draftPublishBlockerSnippet,
  onboardingSuccessPath,
  OPEN_PUBLIC_PREVIEW_OPTION_KEY,
  shouldOpenPublicPreview,
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

  it("开启后预览：取消不开；默认勾选确认则开；取消勾选确认则不开", () => {
    expect(shouldOpenPublicPreview(false, { [OPEN_PUBLIC_PREVIEW_OPTION_KEY]: true })).toBe(false);
    expect(shouldOpenPublicPreview(true, { [OPEN_PUBLIC_PREVIEW_OPTION_KEY]: true })).toBe(true);
    expect(shouldOpenPublicPreview(true, { [OPEN_PUBLIC_PREVIEW_OPTION_KEY]: false })).toBe(false);
    // 旧 askConfirm 无 options：确认即开
    expect(shouldOpenPublicPreview(true)).toBe(true);
    expect(shouldOpenPublicPreview(true, {})).toBe(true);
  });

  it("草稿阻断文案截断", () => {
    expect(draftPublishBlockerSnippet("")).toBe("");
    expect(draftPublishBlockerSnippet("缺少奖项")).toBe("缺少奖项");
    const long = "x".repeat(60);
    const snip = draftPublishBlockerSnippet(long, 20);
    expect(snip.length).toBe(20);
    expect(snip.endsWith("…")).toBe(true);
  });
});
