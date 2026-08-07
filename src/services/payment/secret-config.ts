/**
 * 支付敏感配置加解密适配层。
 *
 * 测试期不保留旧格式兼容：新写入和运行时读取都统一使用 cf-core
 * `enc:v2:corejson:`，避免支付配置长期出现多套密文布局。
 */
import {
  decryptSecretConfigResult,
  encryptSecretConfigValue,
  isValidSecretEncryptionKey,
  SECRET_CONFIG_PREFIX_V2_CORE_JSON,
} from "../../lib/secret-config";

export function isEncryptedPaymentConfigValue(value: string): boolean {
  return value.startsWith(SECRET_CONFIG_PREFIX_V2_CORE_JSON);
}

export type PaymentSecretDecryptResult =
  | { ok: true; value: string }
  | { ok: false; reason: "invalid_key" | "decrypt_failed" | "empty_payload" | "invalid_shape" };

export async function decryptPaymentConfigValueResult(
  value: string,
  encryptionKey?: string,
): Promise<PaymentSecretDecryptResult> {
  if (!value) return { ok: true, value: "" };
  if (!isEncryptedPaymentConfigValue(value)) return { ok: true, value };

  const result = await decryptSecretConfigResult(value, encryptionKey);
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
}

export async function decryptPaymentConfigValue(value: string, encryptionKey?: string): Promise<string> {
  const result = await decryptPaymentConfigValueResult(value, encryptionKey);
  if (!result.ok) throw new Error(`支付敏感配置解密失败：${result.reason}`);
  return result.value;
}

export async function encryptPaymentConfigValue(value: string, encryptionKey: string): Promise<string> {
  return encryptSecretConfigValue(value, encryptionKey);
}

export { isValidSecretEncryptionKey };
