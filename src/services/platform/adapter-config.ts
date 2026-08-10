/**
 * 平台适配器配置安全封装。
 *
 * adapterConfigJson 需要同时服务两类场景：
 * - 管理端展示：必须脱敏，不能把 botToken / NapCat token 回传给浏览器；
 * - 运行时出站：必须解密后交给具体适配器，否则 Telegram / QQ 私聊无法发送。
 *
 * 发布前策略：敏感字段只允许密文参与运行。项目尚未发布，不保留历史明文兼容分支，
 * 避免“能跑但库中有明文凭据”的隐性维护债。
 */
import {
  decryptSecretConfigResult,
  encryptSecretConfigValue,
  isValidSecretEncryptionKey,
  SECRET_CONFIG_PREFIX_V2_CORE_JSON,
} from "../../lib/secret-config";

export const PLATFORM_SECRET_PLACEHOLDER = "••••••••";

const SENSITIVE_KEYS = new Set(["botToken", "token", "accessToken", "authorization"]);

export function isEncryptedPlatformSecret(value: string): boolean {
  return value.startsWith(SECRET_CONFIG_PREFIX_V2_CORE_JSON);
}

export function parsePlatformAdapterConfigJson(rawJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * 保存前加密敏感字段。
 *
 * placeholder 表示“沿用旧值”，由调用方先把旧值合并进输入；本函数只负责把真实明文加密。
 */
export async function encryptPlatformAdapterConfig(
  config: Record<string, string>,
  encryptionKey: string,
): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!isSensitiveKey(key) || !value || isEncryptedPlatformSecret(value)) {
      output[key] = value;
      continue;
    }
    if (!isValidSecretEncryptionKey(encryptionKey)) {
      throw new Error("CREDENTIALS_ENCRYPTION_KEY 必须配置为 64 位 hex，才能加密保存平台凭据");
    }
    output[key] = await encryptSecretConfigValue(value, encryptionKey);
  }
  return output;
}

/**
 * 运行时解密适配器配置。
 *
 * 明文敏感值直接视为配置错误；密文解密失败也抛明确错误。
 * delivery 会进入重试/失败状态，管理端测试发送会返回 502。
 */
export async function resolvePlatformAdapterConfigForRuntime(
  rawConfig: Record<string, unknown>,
  encryptionKey?: string,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = { ...rawConfig };
  for (const key of Object.keys(output)) {
    const value = typeof output[key] === "string" ? String(output[key]) : "";
    if (!isSensitiveKey(key) || !value) continue;
    if (!isEncryptedPlatformSecret(value)) {
      throw new Error(`平台适配器凭据 ${key} 必须以密文存储，请在管理端重新保存配置`);
    }
    const result = await decryptSecretConfigResult(value, encryptionKey);
    if (!result.ok) {
      throw new Error(`平台适配器凭据 ${key} 解密失败：${result.reason}`);
    }
    output[key] = result.value;
  }
  return output;
}

/**
 * 管理端脱敏展示。敏感字段只暴露“已配置”占位符，不返回明文或密文。
 */
export function sanitizePlatformAdapterConfigForAdmin(rawJson: string | null | undefined): string {
  const config = parsePlatformAdapterConfigJson(rawJson);
  for (const key of Object.keys(config)) {
    if (isSensitiveKey(key) && String(config[key] || "")) {
      config[key] = PLATFORM_SECRET_PLACEHOLDER;
    }
  }
  return JSON.stringify(config);
}
