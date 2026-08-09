/**
 * 平台适配器工厂测试（docs/167）。
 *
 * 验证：
 * - qq 平台能通过工厂构造适配器
 * - 未注册平台抛出明确错误
 * - getSupportedPlatforms 返回已注册平台
 * - 适配器工厂是扩展点，新增平台只需注册工厂
 */
import { describe, expect, it } from "vitest";
import { getPlatformAdapter, getSupportedPlatforms, sendPlatformMessage } from "./adapter-factory";

describe("adapter-factory", () => {
  it("能通过工厂构造 QQ 适配器", () => {
    const adapter = getPlatformAdapter("qq", { baseUrl: "http://localhost:3000" });
    expect(adapter.platform).toBe("qq");
  });

  it("能通过工厂构造 Telegram 适配器", () => {
    const adapter = getPlatformAdapter("telegram", { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" });
    expect(adapter.platform).toBe("telegram");
  });

  it("getSupportedPlatforms 包含 telegram", () => {
    const platforms = getSupportedPlatforms();
    expect(platforms).toContain("telegram");
  });


  it("未注册平台抛出明确错误", () => {
    expect(() => getPlatformAdapter("unknown-platform", {}))
      .toThrow("不支持的平台类型: unknown-platform");
  });

  it("QQ 适配器缺少 baseUrl 时构造失败", () => {
    expect(() => getPlatformAdapter("qq", {}))
      .toThrow("baseUrl");
  });

  it("getSupportedPlatforms 返回已注册平台", () => {
    const platforms = getSupportedPlatforms();
    expect(platforms).toContain("qq");
  });

  it("sendPlatformMessage 发送消息并返回 messageId", async () => {
    const result = await sendPlatformMessage(
      "qq",
      { baseUrl: "http://localhost:3000" },
      { platform: "qq", targetId: "123", type: "text", text: "hello" },
      async () => new Response(JSON.stringify({ data: { message_id: "msg-1" } }), { status: 200 }),
    );
    expect(result.messageId).toBe("msg-1");
  });
});