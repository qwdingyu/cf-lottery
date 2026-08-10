/**
 * 平台适配器工厂（docs/167）。
 *
 * 新增平台只需在此注册一行工厂函数 + 创建适配器文件。
 * 命令服务和出站投递层不直接 import 任何平台适配器，只通过此工厂获取。
 */
import type { PlatformAdapter, PlatformMessage } from "./types";
import { createQQAdapter } from "./qq-adapter";
import { createTelegramAdapter } from "./telegram-adapter";

/**
 * 适配器工厂映射表：平台标识 → 构造工厂。
 *
 * 扩展方式：
 *   import { createTelegramAdapter } from "./telegram-adapter";
 *   PLATFORM_ADAPTER_FACTORIES["telegram"] = (config, fetcher) =>
 *     createTelegramAdapter({ botToken: String(config.botToken || "") }, fetcher);
 */
const PLATFORM_ADAPTER_FACTORIES: Record<
  string,
  (config: Record<string, unknown>, fetcher: typeof fetch) => PlatformAdapter
> = {
  qq: (config, fetcher) => createQQAdapter({
    baseUrl: String(config.baseUrl || ""),
    token: String(config.token || ""),
  }, fetcher),
  telegram: (config, fetcher) =>
    createTelegramAdapter({ botToken: String(config.botToken || "") }, fetcher),
};

/**
 * 根据平台标识获取适配器实例。
 * 平台不存在时抛出明确错误，而非静默 fallback。
 */
export function getPlatformAdapter(
  platform: string,
  config: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): PlatformAdapter {
  const factory = PLATFORM_ADAPTER_FACTORIES[platform];
  if (!factory) {
    throw new Error(`不支持的平台类型: ${platform}`);
  }
  return factory(config, fetcher);
}

/**
 * 发送单条消息的便捷方法。
 * 读写 adapterConfig 的 baseUrl 字段，用适配器工厂构造适配器后发送。
 */
export async function sendPlatformMessage(
  platform: string,
  adapterConfig: Record<string, unknown>,
  message: PlatformMessage,
  fetcher: typeof fetch = fetch,
): Promise<{ messageId: string; response?: unknown }> {
  const adapter = getPlatformAdapter(platform, adapterConfig, fetcher);
  return adapter.send(message);
}

/** 已注册的适配器平台列表（用于管理端校验等场景） */
export function getSupportedPlatforms(): string[] {
  return Object.keys(PLATFORM_ADAPTER_FACTORIES);
}

/** 已注册的适配器提供方列表（用于管理端校验等场景） */
export function getSupportedProviders(): string[] {
  // 提供方白名单：每个平台可注册自己的适配器提供方
  // QQ 使用 napcat（OneBot 协议），Telegram 直接调用 Bot API（不需要中间件提供方）
  // Telegram 目标创建时 adapterProvider 可留空
  return ["napcat"];
}
