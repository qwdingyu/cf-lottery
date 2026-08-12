/**
 * 公开路由纯函数：OG 兜底等（docs/104）
 */
import { describe, expect, it } from "vitest";
import { ogDescriptionFallback, renderPublicOgHtml, defaultOgImageUrl } from "./public-lottery-helpers";

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

describe("renderPublicOgHtml（P0: og:image 补齐）", () => {
  it("提供 imageUrl 时输出 og:image 与 twitter:image", () => {
    const html = renderPublicOgHtml({
      title: "活动标题",
      description: "活动描述",
      pageUrl: "https://example.com/lottery/abc",
      imageUrl: "https://cdn.example.com/prize.png",
    });
    expect(html).toContain('property="og:image" content="https://cdn.example.com/prize.png"');
    expect(html).toContain('name="twitter:image" content="https://cdn.example.com/prize.png"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
  });

  it("未提供 imageUrl 时使用默认 SVG 兜底图（不出现空白卡片）", () => {
    const html = renderPublicOgHtml({
      title: "活动标题",
      pageUrl: "https://example.com/lottery/abc",
    });
    expect(html).toContain('property="og:image" content="data:image/svg+xml');
    // 属性中的单引号会被 HTML 转义为 &#39;
    expect(html).toContain("width=&#39;1200&#39;");
  });

  it("imageUrl 为空字符串时同样走默认图", () => {
    const html = renderPublicOgHtml({
      title: "活动标题",
      description: "描述",
      status: "open",
      pageUrl: "https://example.com/lottery/abc",
      imageUrl: "",
    });
    expect(html).toContain('property="og:image" content="data:image/svg+xml');
  });

  it("恶意 imageUrl 会被 HTML 转义（防注入）", () => {
    const html = renderPublicOgHtml({
      title: "活动标题",
      pageUrl: "https://example.com/lottery/abc",
      imageUrl: 'https://example.com/x" onload="alert(1)',
    });
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("defaultOgImageUrl 生成 1200x630 的 SVG 数据图", () => {
    const url = defaultOgImageUrl("https://example.com/lottery/abc");
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    expect(url).toContain("1200");
    expect(url).toContain("630");
  });
});
