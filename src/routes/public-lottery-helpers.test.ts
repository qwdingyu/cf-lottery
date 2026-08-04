/**
 * 公开路由纯函数：OG 兜底等（docs/104）
 */
import { describe, expect, it } from "vitest";
import { ogDescriptionFallback } from "./public-lottery-helpers";

describe("ogDescriptionFallback", () => {
  it("终态不写「快来参与」", () => {
    expect(ogDescriptionFallback("drawn")).toContain("已结束");
    expect(ogDescriptionFallback("drawn")).not.toContain("参与活动");
    expect(ogDescriptionFallback("closed")).toContain("已结束");
    expect(ogDescriptionFallback("cancelled")).toContain("已取消");
    expect(ogDescriptionFallback("DRAWN")).toContain("已结束");
  });

  it("未开放 / 开奖中用中性说明", () => {
    expect(ogDescriptionFallback("draft")).toContain("暂未开放");
    expect(ogDescriptionFallback("paused")).toContain("暂未开放");
    expect(ogDescriptionFallback("drawing")).toContain("出结果");
  });

  it("进行中或未知仍可鼓励参与", () => {
    expect(ogDescriptionFallback("open")).toBe("快来参与活动吧！");
    expect(ogDescriptionFallback("")).toBe("快来参与活动吧！");
    expect(ogDescriptionFallback(undefined)).toBe("快来参与活动吧！");
  });
});
