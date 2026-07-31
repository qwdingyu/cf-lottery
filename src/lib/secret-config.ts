/**
 * 敏感配置加密（cf-lottery 精简版）
 *
 * 从 cf-shop 抽取，移除 @usethink/cf-core 依赖。
 * 使用 Web Crypto API 实现 AES-GCM 加密。
 */
const ENCRYPTED_CONFIG_PREFIX = "enc:v1:";

export function isValidSecretEncryptionKey(value: string | undefined): value is string {
  return Boolean(value && /^[a-fA-F0-9]{64}$/.test(value));
}

/** 从 hex 密钥派生 AES-GCM 密钥 */
async function deriveKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(hexKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecretConfigValue(value: string, encryptionKey: string): Promise<string> {
  if (!value) return "";
  if (!isValidSecretEncryptionKey(encryptionKey)) throw new Error("敏感配置加密密钥无效");
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  const b64 = btoa(String.fromCharCode(...combined));
  return `${ENCRYPTED_CONFIG_PREFIX}${b64}`;
}

export async function decryptSecretConfigValue(value: string, encryptionKey?: string): Promise<string> {
  if (!value || !value.startsWith(ENCRYPTED_CONFIG_PREFIX)) return value;
  if (!isValidSecretEncryptionKey(encryptionKey)) return "";
  try {
    const b64 = value.slice(ENCRYPTED_CONFIG_PREFIX.length);
    const combined = new Uint8Array(atob(b64).split("").map(c => c.charCodeAt(0)));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const key = await deriveKey(encryptionKey!);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    return new TextDecoder().decode(decrypted);
  } catch {
    return "";
  }
}