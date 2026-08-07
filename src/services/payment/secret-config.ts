/**
 * 支付敏感配置加解密适配层。
 *
 * 新写入统一使用 cf-core `enc:v2:corejson:`；读取保留旧版 bare `enc:` 兼容，
 * 避免已经保存的易支付密钥在升级后失效。
 */
import {
  decryptSecretConfigResult,
  encryptSecretConfigValue,
  isValidSecretEncryptionKey,
  SECRET_CONFIG_PREFIX_V1,
  SECRET_CONFIG_PREFIX_V2_CORE_JSON,
} from "../../lib/secret-config";

const LEGACY_BARE_PREFIX = "enc:";

export function isEncryptedPaymentConfigValue(value: string): boolean {
  return value.startsWith(LEGACY_BARE_PREFIX);
}

function isVersionedSecret(value: string): boolean {
  return value.startsWith(SECRET_CONFIG_PREFIX_V2_CORE_JSON) || value.startsWith(SECRET_CONFIG_PREFIX_V1);
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

  if (isVersionedSecret(value)) {
    const result = await decryptSecretConfigResult(value, encryptionKey);
    return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
  }

  if (!isValidSecretEncryptionKey(encryptionKey)) {
    return { ok: false, reason: "invalid_key" };
  }

  try {
    const { decrypt } = await import("@usethink/cf-core");
    const decrypted = await decrypt(value.slice(LEGACY_BARE_PREFIX.length), encryptionKey);
    if (typeof decrypted === "string") return { ok: true, value: decrypted };
    if (decrypted && typeof decrypted === "object" && typeof (decrypted as { value?: unknown }).value === "string") {
      return { ok: true, value: (decrypted as { value: string }).value };
    }
    return { ok: true, value: String(decrypted ?? "") };
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }
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
