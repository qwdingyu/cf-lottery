/**
 * 平台入站密钥工具（docs/167）。
 *
 * 每个租户/群绑定拥有自己的入站密钥，明文只在绑定向导或扫码配置时下发一次，
 * 数据库存 SHA-256 哈希，避免泄漏后可直接伪造平台事件。
 */

export async function hashPlatformInboundSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createPlatformInboundSecret(): string {
  return `pin_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().slice(0, 8)}`;
}
