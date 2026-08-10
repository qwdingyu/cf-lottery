/**
 * QQ 平台适配器（docs/167）。
 *
 * 领域层只依赖 qq-adapter。P0 底层实现选择 NapCat/OneBot HTTP，
 * 后续如切换官方 QQ Bot，不应影响平台命令服务。
 */
import type { PlatformAdapter, PlatformMessage } from "./types";

type NapCatEnv = {
  baseUrl: string;
  token?: string;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createNapCatClient(env: NapCatEnv, fetcher: typeof fetch = fetch) {
  async function request(path: string, body: Record<string, unknown>) {
    const res = await fetcher(joinUrl(env.baseUrl, path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.token ? { Authorization: `Bearer ${env.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`QQ adapter ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  /**
   * 发送私聊/临时消息（调用 NapCat /send_private_msg）。
   * 传 group_id 以支持非好友临时消息：NapCat 识别非好友 + 有 group_id 时，
   * 自动走 KCHATTYPETEMPC2CFROMGROUP (100) 并调用 prepareTempChat 建立临时会话。
   */
  const sendPrivateMessage = (userId: string, groupId: string, text: string) => {
    return request("/send_private_msg", {
      user_id: userId,
      group_id: groupId,
      message: text,
    });
  };

  /**
   * 安全版私聊发送：捕获异常，不向上抛。
   * 返回 { success, messageId?, error? }，供业务层根据 success 决定是否在群内降级 @ 通知。
   */
  const sendPrivateMessageSafe = async (
    userId: string,
    groupId: string,
    text: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    try {
      const response = await sendPrivateMessage(userId, groupId, text);
      return { success: true, messageId: readProviderMessageId(response) };
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) };
    }
  };

  return {
    sendGroupMessage(groupId: string, text: string) {
      return request("/send_group_msg", { group_id: groupId, message: text });
    },
    sendGroupImage(groupId: string, imageUrl: string) {
      return request("/send_group_msg", {
        group_id: groupId,
        message: `[CQ:image,file=${imageUrl}]`,
      });
    },
    getGroupMemberList(groupId: string) {
      return request("/get_group_member_list", { group_id: groupId });
    },
    sendPrivateMessage,
    sendPrivateMessageSafe,
  };
}

function readProviderMessageId(response: unknown): string {
  if (!response || typeof response !== "object") return crypto.randomUUID();
  const record = response as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : record;
  return String(data.message_id || data.messageId || crypto.randomUUID());
}

export function createQQAdapter(env: NapCatEnv, fetcher: typeof fetch = fetch): PlatformAdapter {
  const baseUrl = String(env.baseUrl || "").trim();
  if (!baseUrl) {
    throw new Error("QQ 适配器缺少 baseUrl 配置");
  }
  const client = createNapCatClient({ baseUrl, token: env.token }, fetcher);
  return {
    platform: "qq",
    async send(message: PlatformMessage) {
      // 私聊目标：targetId 为 user_id，groupId 为临时会话上下文（群 ID）
      if (message.targetType === "private") {
        const groupId = message.groupId || message.targetId;
        const response = message.type === "image" && message.imageUrl
          ? await client.sendPrivateMessage(message.targetId, groupId, `[CQ:image,file=${message.imageUrl}]`)
          : await client.sendPrivateMessage(message.targetId, groupId, message.text || "");
        return { messageId: readProviderMessageId(response), response };
      }
      const response = message.type === "image" && message.imageUrl
        ? await client.sendGroupImage(message.targetId, message.imageUrl)
        : await client.sendGroupMessage(message.targetId, message.text || "");
      return { messageId: readProviderMessageId(response), response };
    },
    async sendBatch(messages: PlatformMessage[]) {
      const results: Array<{ messageId: string; response?: unknown }> = [];
      for (const message of messages) {
        results.push(await this.send(message));
      }
      return results;
    },
  };
}
