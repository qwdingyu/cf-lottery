/**
 * JWT 认证中间件
 *
 * 从请求头 Authorization: Bearer <token> 中提取 JWT，
 * 验证签名后将 userId 和 tenantId 注入上下文。
 * 所有管理端路由必须通过此中间件。
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import { getDb } from "../lib/http";
import { getEnv } from "../lib/platform";
import { tenantMembers, platformMembers, users, tenants } from "../db/schema";
import { eq, and } from "drizzle-orm";

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return c.json({ ok: false, message: "未登录" }, 401);
  }

  // JWT 验证
  const jwtSecret = getEnv(c, "JWT_SECRET");
  if (!jwtSecret) {
    return c.json({ ok: false, message: "服务未配置 JWT 密钥" }, 500);
  }

  try {
    const payload = await verifyJwt(token, jwtSecret);
    if (!payload || !payload.sub) {
      return c.json({ ok: false, message: "登录已过期" }, 401);
    }
    /**
     * 禁用用户后已签发 JWT 不得继续调管理 API（docs/070 HIGH #3）。
     * 每次鉴权轻量查 status；免费层可接受，优于 24h 盲信 token。
     */
    try {
      const db = getDb(c);
      const [row] = await db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);
      if (!row) {
        return c.json({ ok: false, message: "登录已过期" }, 401);
      }
      if (row.status !== "active") {
        return c.json({ ok: false, message: "账号已被禁用" }, 403);
      }
    } catch (err) {
      // getDb 未注入时（极端）不放行管理写：与「无库」一致
      console.error("[auth] requireAuth user status check failed:", err);
      return c.json({ ok: false, message: "权限验证失败" }, 500);
    }
    c.set("userId", payload.sub);
    c.set("tenantId", payload.tenantId || "");
  } catch {
    return c.json({ ok: false, message: "登录已过期" }, 401);
  }

  await next();
}

/**
 * 租户成员权限中间件（L2 路由）
 *
 * 在 requireAuth 之后使用，校验当前用户是否仍属于 JWT 中的 tenantId，
 * 且 tenant_members.role 在 allowedRoles 列表中。
 * 每次查询数据库（而非仅信 JWT），确保成员被移除后立即失效。
 *
 * @param allowedRoles 允许的角色列表，默认只接受 026 基线冻结的 owner/admin/viewer。
 */
export function requireTenantMember(allowedRoles: string[] = ["owner", "admin", "viewer"]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const userId = c.get("userId") as string;
    const tenantId = c.get("tenantId") as string;
    if (!tenantId) {
      return c.json({ ok: false, message: "无租户上下文" }, 403);
    }

    try {
      const db = getDb(c);
      const [member] = await db
        .select({ role: tenantMembers.role })
        .from(tenantMembers)
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
        .limit(1);

      if (!member) {
        return c.json({ ok: false, message: "您不是该租户的成员" }, 403);
      }
      // 开发期不再兼容 operator/member 等历史同义角色。角色名一旦发散，
      // 后续每个路由都要背兼容分支，最终会把 RBAC-lite 拖成重型权限系统。
      if (!allowedRoles.includes(member.role)) {
        return c.json({ ok: false, message: "权限不足" }, 403);
      }
      // 租户暂停/禁用后，已持有 JWT 的成员立即不可写（docs/070 HIGH #3）
      const [tenant] = await db
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant || tenant.status !== "active") {
        return c.json({ ok: false, message: "租户已暂停或不可用" }, 403);
      }
      c.set("tenantRole", member.role);
    } catch (err) {
      console.error("[auth] requireTenantMember error:", err);
      return c.json({ ok: false, message: "权限验证失败" }, 500);
    }

    await next();
  };
}

/**
 * 平台成员权限中间件（L3 路由）
 *
 * 在 requireAuth 之后使用，校验当前用户是否是 platform_members 表中的活跃成员，
 * 且 role 在 allowedRoles 列表中。
 * 每次查询数据库，确保禁用/移除后立即生效。
 *
 * @param allowedRoles 允许的平台角色列表，默认 ['platform_owner', 'platform_operator', 'platform_support']
 */
export function requirePlatformMember(allowedRoles: string[] = ["platform_owner", "platform_operator", "platform_support"]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const userId = c.get("userId") as string;

    try {
      const db = getDb(c);
      const [member] = await db
        .select({ role: platformMembers.role, status: platformMembers.status })
        .from(platformMembers)
        .where(eq(platformMembers.userId, userId))
        .limit(1);

      if (!member) {
        return c.json({ ok: false, message: "不是平台运营者" }, 403);
      }
      if (member.status !== "active") {
        return c.json({ ok: false, message: "平台账号已被禁用" }, 403);
      }
      if (!allowedRoles.includes(member.role)) {
        return c.json({ ok: false, message: "平台权限不足" }, 403);
      }
      c.set("platformRole", member.role);
    } catch (err) {
      console.error("[auth] requirePlatformMember error:", err);
      return c.json({ ok: false, message: "权限验证失败" }, 500);
    }

    await next();
  };
}

/**
 * JWT 签名和验证（使用 Web Crypto API，Cloudflare Workers 原生支持）
 */
export async function verifyJwt(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;

    const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

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

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
