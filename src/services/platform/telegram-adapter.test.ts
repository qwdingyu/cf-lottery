/**
 * Telegram 平台适配器测试。
 *
 * 覆盖：
 * - 成功发送消息（mock fetch 返回 200）
 * - 正确提取 Telegram message_id
 * - 不支持 image/card 类型时抛出错误
 * - 超长消息自动分片
 * - API 返回非 200 时抛出错误
 * - 429 错误触发指数退避重试
 * - 5xx 错误触发指数退避重试
 * - sendBatch 顺序执行所有消息
 * - 非 JSON 响应抛出错误
 */
import { describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "./telegram-adapter";

/** 创建一个模拟的 fetch 函数，返回指定的状态码和 JSON 响应体 */
function mockFetch(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): typeof fetch {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
    ),
  ) as unknown as typeof fetch;
}

/** 创建一个模拟的 fetch 函数，返回非 JSON 响应 */
function mockFetchNonJson(status: number, text: string): typeof fetch {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(text, { status, headers: { "Content-Type": "text/plain" } }),
    ),
  ) as unknown as typeof fetch;
}

describe("createTelegramAdapter", () => {
  const adapter = createTelegramAdapter(
    { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" },
    mockFetch(200, {
      ok: true,
      result: { message_id: 42, chat: { id: "-1001234567890" } },
    }),
  );

  it("成功发送消息并返回 message_id", async () => {
    const result = await adapter.send({
      platform: "telegram",
      targetId: "-1001234567890",
      type: "text",
      text: "Hello from cf-lottery!",
    });
    expect(result.messageId).toBe("42");
    expect(result.response).toBeDefined();
  });

  it("不支持 image 类型消息时抛出错误", async () => {
    await expect(adapter.send({
      platform: "telegram",
      targetId: "-1001234567890",
      type: "image",
      imageUrl: "https://example.com/pic.jpg",
    })).rejects.toThrow("不支持 image 类型消息");
  });

  it("不支持 card 类型消息时抛出错误", async () => {
    await expect(adapter.send({
      platform: "telegram",
      targetId: "-1001234567890",
      type: "card",
      cardData: { title: "test" },
    })).rejects.toThrow("不支持 card 类型消息");
  });
});

describe("sendBatch", () => {
  it("顺序执行所有消息并返回结果数组", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ))
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ));

    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      fetcher as unknown as typeof fetch,
    );

    const results = await adapter.sendBatch([
      { platform: "telegram", targetId: "-1001", type: "text", text: "msg1" },
      { platform: "telegram", targetId: "-1001", type: "text", text: "msg2" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].messageId).toBe("1");
    expect(results[1].messageId).toBe("2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("API 错误处理", () => {
  it("API 返回 400 时抛出错误", async () => {
    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      mockFetch(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    );
    await expect(adapter.send({
      platform: "telegram",
      targetId: "-100999",
      type: "text",
      text: "test",
    })).rejects.toThrow("Telegram API 错误 400");
  });

  it("API 返回非 JSON 时抛出错误", async () => {
    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      mockFetchNonJson(502, "<html>Bad Gateway</html>"),
    );
    await expect(adapter.send({
      platform: "telegram",
      targetId: "-100999",
      type: "text",
      text: "test",
    })).rejects.toThrow("Telegram API 返回非 JSON");
  });
});

describe("指数退避重试", () => {
  it("429 错误触发重试并最终成功", async () => {
    // 第一次返回 429，第二次返回 200
    const fetcher = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      ))
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ));

    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      fetcher as unknown as typeof fetch,
    );

    const result = await adapter.send({
      platform: "telegram",
      targetId: "-100123",
      type: "text",
      text: "retry test",
    });

    expect(result.messageId).toBe("99");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("5xx 错误触发重试并最终成功", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ ok: false, error_code: 503, description: "Service Unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ))
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ));

    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      fetcher as unknown as typeof fetch,
    );

    const result = await adapter.send({
      platform: "telegram",
      targetId: "-100123",
      type: "text",
      text: "retry 503",
    });

    expect(result.messageId).toBe("88");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("超长消息分片", () => {
  it("短消息不分割", async () => {
    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      mockFetch(200, { ok: true, result: { message_id: 1 } }),
    );
    const result = await adapter.send({
      platform: "telegram",
      targetId: "-1001",
      type: "text",
      text: "短消息",
    });
    expect(result.messageId).toBe("1");
  });

  it("超长消息分割为多段发送", async () => {
    // 创建超过 4000 字符的文本
    const paragraph = "这是一个测试段落，用于验证 Telegram 适配器的超长消息分割功能。\n\n";
    const longText = paragraph.repeat(150); // 远超过 4000 字符

    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      fetcher as unknown as typeof fetch,
    );

    await adapter.send({
      platform: "telegram",
      targetId: "-1001",
      type: "text",
      text: longText,
    });

    // 验证 fetch 被调用了多次（分片发送）：5700 字符 / 4000 上限 = 2 段
    expect(fetcher).toHaveBeenCalledTimes(2);

    // 验证每个请求的 body 都不超过 4000 字符
    for (const call of fetcher.mock.calls) {
      const body = JSON.parse((call as [string, Record<string, unknown>])[1].body as string);
      expect(body.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("超长无断点文本在字符边界强制分割", async () => {
    // 5000 个连续字符（无空格、无换行）
    const longText = "a".repeat(5000);

    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const adapter = createTelegramAdapter(
      { botToken: "123456:test" },
      fetcher as unknown as typeof fetch,
    );

    await adapter.send({
      platform: "telegram",
      targetId: "-1001",
      type: "text",
      text: longText,
    });

    // 5000 字符，4000 上限，应分 2 段
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
