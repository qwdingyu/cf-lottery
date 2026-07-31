/**
 * JWT 认证中间件
 *
 * 从请求头 Authorization: Bearer <token> 中提取 JWT，
 * 验证签名后将 userId 和 tenantId 注入上下文。
 * 所有管理端路由必须通过此中间件。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return c.json({ ok: false, message: "未登录" }, 401);
  }

  // JWT 验证
  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json({ ok: false, message: "服务未配置 JWT 密钥" }, 500);
  }

  try {
    const payload = await verifyJwt(token, jwtSecret);
    if (!payload || !payload.sub) {
      return c.json({ ok: false, message: "登录已过期" }, 401);
    }
    c.set("userId", payload.sub);
    c.set("tenantId", payload.tenantId || "");
  } catch {
    return c.json({ ok: false, message: "登录已过期" }, 401);
  }

  await next();
}

/**
 * JWT 签名和验证（简化版，复刻 cf-shop 的 signJwt/verifyJwt 模式）
 */
import { subtle } from "crypto";

async function verifyJwt(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    // 验证签名
    const encoder = new TextEncoder();
    const key = await subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;

    // 解码 payload
    const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

    // 检查过期
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

export async function signJwt(payload: Record<string, any>, secret: string, ttlSeconds: number): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + ttlSeconds };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadB64 = btoa(JSON.stringify(fullPayload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data = encoder.encode(`${headerB64}.${payloadB64}`);

  const key = await subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await subtle.sign("HMAC", key, data);
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}