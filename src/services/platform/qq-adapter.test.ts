/**
 * QQ 适配器私聊/临时消息发送测试（docs/173）。
 *
 * 验证：
 * - sendPrivateMessage 调用 NapCat /send_private_msg 并携带 user_id / group_id / message
 * - sendPrivateMessageSafe 成功时返回 { success:true, messageId }，失败时不抛异常并返回 error
 * - createQQAdapter.send targetType=private 走私聊，缺省走群聊（向后兼容）
 * - 私聊图片走 /send_private_msg 且消息为 CQ image
 */
import { describe, expect, it } from "vitest";
import { createNapCatClient, createQQAdapter } from "./qq-adapter";

/** 构造可注入的 fetch 替身：捕获请求 URL 与 body，返回指定响应 */
function makeFetcher(
  handler: (url: string, init: RequestInit) => Response,
): typeof fetch {
  return async (input, init) =>
    handler(String(input), (init ?? {}) as RequestInit);
}

/** OneBot 成功响应：{ status:'ok', data:{ message_id } } */
function okResponse(messageId: string): Response {
  return new Response(JSON.stringify({ status: "ok", data: { message_id: messageId } }), { status: 200 });
}

describe("qq-adapter 私聊/临时消息发送", () => {
  it("sendPrivateMessage 调用 /send_private_msg 并携带 user_id/group_id/message", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const client = createNapCatClient(
      { baseUrl: "http://localhost:3000" },
      makeFetcher((url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return okResponse("pm-1");
      }),
    );
    await client.sendPrivateMessage("10001", "20002", "私聊内容");
    expect(captured!.url).toContain("/send_private_msg");
    expect(captured!.body.user_id).toBe("10001");
    expect(captured!.body.group_id).toBe("20002");
    expect(captured!.body.message).toBe("私聊内容");
  });

  it("sendPrivateMessageSafe 成功时返回 { success:true, messageId }", async () => {
    const client = createNapCatClient(
      { baseUrl: "http://localhost:3000" },
      makeFetcher(() => okResponse("pm-2")),
    );
    const result = await client.sendPrivateMessageSafe("10001", "20002", "hi");
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("pm-2");
    expect(result.error).toBeUndefined();
  });

  it("sendPrivateMessageSafe 失败时不抛异常并返回 { success:false, error }", async () => {
    const client = createNapCatClient(
      { baseUrl: "http://localhost:3000" },
      makeFetcher(() => new Response("forbidden", { status: 403 })),
    );
    const result = await client.sendPrivateMessageSafe("10001", "20002", "hi");
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 403");
  });

  it("createQQAdapter.send 私聊目标走 /send_private_msg", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const adapter = createQQAdapter(
      { baseUrl: "http://localhost:3000" },
      makeFetcher((url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return okResponse("pm-3");
      }),
    );
    const result = await adapter.send({
      platform: "qq",
      targetType: "private",
      targetId: "10001",
      groupId: "20002",
      type: "text",
      text: "卡密内容",
    });
    expect(result.messageId).toBe("pm-3");
    expect(captured!.url).toContain("/send_private_msg");
    expect(captured!.body.user_id).toBe("10001");
    expect(captured!.body.group_id).toBe("20002");
    expect(captured!.body.message).toBe("卡密内容");
  });

  it("createQQAdapter.send 私聊目标缺省 groupId 时以 targetId 作为临时会话群上下文", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const adapter = createQQAdapter(
      { baseUrl: "http://localhost:3000" },
      makeFetcher((url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return okResponse("pm-4");
      }),
    );
    await adapter.send({
      platform: "qq",
      targetType: "private",
      targetId: "10001",
      type: "text",
      text: "hi",
    });
    expect(captured!.body.group_id).toBe("10001");
  });

  it("createQQAdapter.send 群聊目标（缺省 targetType）仍走 /send_group_msg，向后兼容", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const adapter = createQQAdapter(
      { baseUrl: "http://localhost:3000" },
      makeFetcher((url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return okResponse("gm-1");
      }),
    );
    const result = await adapter.send({
      platform: "qq",
      targetId: "20002",
      type: "text",
      text: "群内容",
    });
    expect(result.messageId).toBe("gm-1");
    expect(captured!.url).toContain("/send_group_msg");
    expect(captured!.body.group_id).toBe("20002");
  });

  it("createQQAdapter.send 私聊图片走 /send_private_msg 且消息为 CQ image", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const adapter = createQQAdapter(
      { baseUrl: "http://localhost:3000" },
      makeFetcher((url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return okResponse("pm-5");
      }),
    );
    await adapter.send({
      platform: "qq",
      targetType: "private",
      targetId: "10001",
      groupId: "20002",
      type: "image",
      imageUrl: "https://example.com/x.png",
    });
    expect(captured!.url).toContain("/send_private_msg");
    expect(String(captured!.body.message)).toContain("[CQ:image");
    expect(String(captured!.body.message)).toContain("https://example.com/x.png");
  });
});