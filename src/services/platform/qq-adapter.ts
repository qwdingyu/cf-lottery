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
