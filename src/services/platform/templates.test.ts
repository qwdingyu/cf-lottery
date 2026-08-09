/**
 * 平台消息模板测试（docs/167 出站方向）
 *
 * 覆盖：
 * - renderPlatformTextTemplate 的纯文本渲染（无 HTML 转义）
 * - renderPlatformEventMessage 各事件类型模板渲染
 * - 条件块 {{#if}} 正常工作
 * - 兜底模板在未知事件类型时生效
 */
import { describe, expect, it } from "vitest";
import { renderPlatformTextTemplate, renderPlatformEventMessage, PLATFORM_EVENT_TEMPLATES } from "./templates";

describe("renderPlatformTextTemplate", () => {
  it("替换简单变量且不做 HTML 转义", () => {
    const result = renderPlatformTextTemplate("{{name}} 你好，分数 {{score}}", { name: "张三", score: "95" });
    expect(result).toBe("张三 你好，分数 95");
  });

  it("保留 & < > 等字符原样（不转义为 HTML 实体）", () => {
    const result = renderPlatformTextTemplate("{{value}}", { value: "a & b < c > d" });
    expect(result).toBe("a & b < c > d");
  });

  it("{{#if}} 条件块在数据存在时保留内容", () => {
    const result = renderPlatformTextTemplate("{{#if bonus}}恭喜获得 {{bonus}}{{/if}}", { bonus: "5 元券", name: "test" });
    expect(result).toBe("恭喜获得 5 元券");
  });

  it("{{#if}} 条件块在数据不存在时移除内容", () => {
    const result = renderPlatformTextTemplate("{{#if bonus}}恭喜获得 {{bonus}}{{/if}}", { name: "test" });
    expect(result).toBe("");
  });

  it("{{#if}} 条件块在数据为空字符串时移除内容", () => {
    const result = renderPlatformTextTemplate("{{#if note}}{{note}}{{/if}}", { note: "" });
    expect(result).toBe("");
  });

  it("混合 {{#if}} 和普通变量", () => {
    const result = renderPlatformTextTemplate(
      "{{userName}}{{#if score}} 得分 {{score}}{{/if}}",
      { userName: "李四", score: "88" },
    );
    expect(result).toBe("李四 得分 88");
  });

  it("缺失变量替换为空字符串", () => {
    const result = renderPlatformTextTemplate("{{a}}|{{b}}", { a: "1" });
    expect(result).toBe("1|");
  });
});

describe("renderPlatformEventMessage", () => {
  it("draw.published 渲染完整", () => {
    const result = renderPlatformEventMessage("draw.published", {
      drawName: "夏日抽奖",
      drawAt: "2026-08-15 20:00",
      shareUrl: "https://example.com/lottery/summer",
    });
    expect(result).toContain("夏日抽奖");
    expect(result).toContain("2026-08-15 20:00");
    expect(result).toContain("example.com");
  });

  it("draw.published 无开奖时间时隐藏开奖时间行", () => {
    const result = renderPlatformEventMessage("draw.published", {
      drawName: "夏日抽奖",
      shareUrl: "https://example.com",
    });
    expect(result).toContain("夏日抽奖");
    expect(result).not.toContain("开奖时间");
  });

  it("draw.completed 渲染", () => {
    const result = renderPlatformEventMessage("draw.completed", {
      drawName: "年终抽奖",
      winnerSummary: "共 10 人获奖，200 人参与",
    });
    expect(result).toContain("年终抽奖");
    expect(result).toContain("10 人获奖");
    expect(result).toContain("200 人参与");
  });

  it("entry.created 渲染", () => {
    const result = renderPlatformEventMessage("entry.created", {
      userName: "王五",
      drawName: "新品体验",
      shareUrl: "https://example.com/lottery/new",
    });
    expect(result).toContain("王五");
    expect(result).toContain("新品体验");
    expect(result).toContain("example.com");
  });

  it("outcome.assigned 渲染含奖品信息", () => {
    const result = renderPlatformEventMessage("outcome.assigned", {
      userName: "赵六",
      drawName: "VIP 抽奖",
      prizeName: "iPhone 16",
      prizeValue: "¥8999",
      claimHint: "请私信客服领取",
    });
    expect(result).toContain("赵六");
    expect(result).toContain("iPhone 16");
    expect(result).toContain("¥8999");
    expect(result).toContain("请私信客服领取");
  });

  it("outcome.assigned 无 prizeValue 时隐藏价值行", () => {
    const result = renderPlatformEventMessage("outcome.assigned", {
      userName: "赵六",
      drawName: "VIP 抽奖",
      prizeName: "优惠券",
    });
    expect(result).toContain("优惠券");
    expect(result).not.toContain("价值");
  });

  it("prize.issued 渲染", () => {
    const result = renderPlatformEventMessage("prize.issued", {
      userName: "钱七",
      prizeName: "50 元券",
      orderNo: "ORD-123",
    });
    expect(result).toContain("钱七");
    expect(result).toContain("50 元券");
    expect(result).toContain("ORD-123");
  });

  it("reward.earned 渲染", () => {
    const result = renderPlatformEventMessage("reward.earned", {
      userName: "孙八",
      rewardLabel: "5 USD",
      rewardValue: "5 USD",
    });
    expect(result).toContain("孙八");
    expect(result).toContain("5 USD");
  });

  it("penalty.requested 渲染", () => {
    const result = renderPlatformEventMessage("penalty.requested", {
      penaltyDetail: "退群成员 xxx 已触发处理，群号 123456",
    });
    expect(result).toContain("退群成员");
    expect(result).toContain("123456");
  });

  it("share.created 渲染", () => {
    const result = renderPlatformEventMessage("share.created", {
      userName: "周九",
      gainUserName: "吴十",
    });
    expect(result).toContain("周九");
    expect(result).toContain("吴十");
  });

  it("checkin.completed 渲染", () => {
    const result = renderPlatformEventMessage("checkin.completed", {
      userName: "郑一",
      bonusText: "获得 1 次抽奖机会",
    });
    expect(result).toContain("郑一");
    expect(result).toContain("获得 1 次抽奖机会");
  });
});

describe("PLATFORM_EVENT_TEMPLATES 完整性", () => {
  it("所有事件类型都有模板定义", () => {
    expect(PLATFORM_EVENT_TEMPLATES["draw.published"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["draw.completed"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["entry.created"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["outcome.assigned"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["prize.issued"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["reward.earned"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["penalty.requested"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["share.created"]).toBeDefined();
    expect(PLATFORM_EVENT_TEMPLATES["checkin.completed"]).toBeDefined();
  });
});