import { describe, expect, it } from "vitest";
import {
  publicNonOpenPrimaryCta,
  publicNonOpenSecondaryCta,
  publicStatusBannerTone,
} from "./lottery-public-ux";

describe("lottery-public-ux", () => {
  it("draft/paused 主 CTA 为刷新；次 CTA 为复制链接", () => {
    expect(publicNonOpenPrimaryCta({ status: "draft", joined: false, hasSession: false })).toBe("refresh");
    expect(publicNonOpenPrimaryCta({ status: "paused", joined: true, hasSession: true })).toBe("refresh");
    expect(publicNonOpenSecondaryCta("draft")).toBe("copy_link");
    expect(publicNonOpenSecondaryCta("paused")).toBe("copy_link");
    expect(publicNonOpenSecondaryCta("drawn")).toBe("none");
  });

  it("drawn：有会话或已参与 → 查结果；否则登录查询", () => {
    expect(publicNonOpenPrimaryCta({ status: "drawn", joined: true, hasSession: false })).toBe("query_result");
    expect(publicNonOpenPrimaryCta({ status: "drawn", joined: false, hasSession: true })).toBe("query_result");
    expect(publicNonOpenPrimaryCta({ status: "drawn", joined: false, hasSession: false })).toBe("login_to_check");
  });

  it("drawing：已参与可查结果，否则刷新等待", () => {
    expect(publicNonOpenPrimaryCta({ status: "drawing", joined: true, hasSession: false })).toBe("query_result");
    expect(publicNonOpenPrimaryCta({ status: "drawing", joined: false, hasSession: false })).toBe("refresh");
  });

  it("横幅色调：draft/paused 警告", () => {
    expect(publicStatusBannerTone("draft")).toBe("warn");
    expect(publicStatusBannerTone("paused")).toBe("warn");
    expect(publicStatusBannerTone("open")).toBe("success");
  });
});
