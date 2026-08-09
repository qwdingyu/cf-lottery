/**
 * Telegram 平台适配器（桩）。
 *
 * 实现 PlatformAdapter 接口，使用 Telegram Bot API。
 * 接入步骤：
 *   1. 实现 send/sendBatch 方法
 *   2. 在 adapter-factory.ts 中注册工厂
 *   3. 创建 platform-telegram.ts 路由
 *   4. 编写测试
 */
import type { PlatformAdapter, PlatformMessage } from "./types";

export type TelegramAdapterEnv = {
  botToken: string;
};

export function createTelegramAdapter(
  env: TelegramAdapterEnv,
  _fetcher: typeof fetch = fetch,
): PlatformAdapter {
  return {
    platform: "telegram" as const,
    async send(message: PlatformMessage) {
      // TODO: 实现 Telegram Bot API sendMessage 调用
      // 参考: https://core.telegram.org/bots/api#sendmessage
      void env;
      void message;
      return { messageId: crypto.randomUUID() };
    },
    async sendBatch(messages: PlatformMessage[]) {
      const results: Array<{ messageId: string; response?: unknown }> = [];
      for (const msg of messages) {
        results.push(await this.send(msg));
      }
      return results;
    },
  };
}