/**
 * Logto 身份认证集成模块（docs/051 方案）
 *
 * 功能：
 * 1. 从 Logto JWKS 端点获取公钥并缓存（减少额外请求，适合 Workers 无状态环境）
 * 2. 验证 Logto ID Token（使用 jose 库，纯 JS，Workers 兼容）
 * 3. 签发自签 JWT（含现有 tenantId/role 等字段，与现有中间件兼容）
 *
 * 为什么不是直接用 Logto Access Token 验证 API：
 * - Logto Free 方案无 API Resource，无法验证 audience
 * - 自签 JWT 可以携带现有 tenantId/role 等字段，不需要改动现有中间件
 * - 自签 JWT 使用现有 JWT_SECRET 签名，与现有流程一致
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { signJwt } from "../middleware/auth";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";

/** Logto JWKS 端点 URL（每个租户固定） */
function getJwksUrl(c: Context<AppEnv>): string {
  const endpoint = c.env?.LOGTO_ENDPOINT || "";
  if (!endpoint) throw new Error("LOGTO_ENDPOINT 未配置");
  return `${endpoint.replace(/\/$/, "")}/oidc/.well-known/jwks.json`;
}

/** Logto 应用 ID（用于验证 ID Token 的 audience） */
function getAppId(c: Context<AppEnv>): string {
  return c.env?.LOGTO_APP_ID || "";
}

/** JWKS 缓存（Workers 无状态，每次请求独立缓存） */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * 获取并缓存 JWKS 客户端
 *
 * Workers 中每个请求都是独立 isolate，无法跨请求共享缓存。
 * 但在单个请求内多次调用 `verifyLogtoIdToken` 时复用同一 JWKS 客户端。
 * 生产环境建议缩短 JWKS 轮换周期（Logto 默认 24h 轮换一次）。
 */
function getJwksClient(url: string) {
  if (!jwksCache.has(url)) {
    jwksCache.set(url, createRemoteJWKSet(new URL(url)));
  }
  return jwksCache.get(url)!;
}

/**
 * 验证 Logto ID Token 并返回 payload
 *
 * 支持两种 token 类型：
 * 1. ID Token — 验证签名、issuer、audience（推荐）
 * 2. Access Token — 验证签名、issuer（不验证 audience，
 *    因为 Free 方案无 API Resource，Access Token 不含 audience）
 *
 * @param idToken - Logto 签发的 ID Token 或 Access Token
 * @param c - Hono Context（用于获取 Logto 配置）
 * @returns 验证通过后的 token payload
 * @throws 验证失败时抛出错误
 */
export async function verifyLogtoIdToken(idToken: string, c: Context<AppEnv>) {
  const jwksUrl = getJwksUrl(c);
  const appId = getAppId(c);
  if (!appId) throw new Error("LOGTO_APP_ID 未配置");

  const jwks = getJwksClient(jwksUrl);
  // 先尝试作为 ID Token 验证（含 audience 检查）
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: jwksUrl.replace("/oidc/.well-known/jwks.json", "/oidc"),
      audience: appId,
      algorithms: ["RS256"],
    });
    return payload;
  } catch {
    // ID Token 验证失败（可能是 Access Token），改用宽松模式验证
    // 只验证签名和 issuer，不验证 audience
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: jwksUrl.replace("/oidc/.well-known/jwks.json", "/oidc"),
      algorithms: ["RS256"],
    });
    return payload;
  }
}

/**
 * 验证 Logto ID Token 后，签发自签 JWT
 *
 * @param logtoPayload - verifyLogtoIdToken 返回的 payload
 * @param jwtSecret - 用于签名的 JWT_SECRET
 * @returns 自签 JWT 字符串
 */
export async function exchangeLogtoToken(
  logtoPayload: Awaited<ReturnType<typeof verifyLogtoIdToken>>,
  jwtSecret: string,
): Promise<string> {
  const sub = String(logtoPayload.sub || "");
  const email = String(logtoPayload.email || logtoPayload.preferred_username || "");

  // 自签 JWT 与现有 JWT 格式兼容（docs/051 方案）
  // 现有中间件（requireAuth）验证 sub、exp、email 等字段
  return signJwt(
    {
      sub,
      email,
      // 以下字段由现有逻辑填充（后续可通过自有用户表查询补充）
      tenantId: "",
      tenantRole: "",
      platformRole: null,
      impersonated: false,
    },
    jwtSecret,
    24 * 3600, // 24 小时有效期，与现有 session token 一致
  );
}