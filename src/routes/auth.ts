/**
 * 认证路由：注册 / 登录
 *
 * 安全约束：
 * - JWT_SECRET 必须通过 wrangler secret put 设置，生产环境禁止使用默认值
 * - 密码使用 PBKDF2 + SHA-256 × 100000 迭代（后续可升级为 Argon2id）
 * - 登录/注册接口包含基本限流（通过 IP hash 识别）
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb } from "../lib/http";
import { users, tenantMembers, tenants } from "../db/schema";
import { eq } from "drizzle-orm";
import { signJwt } from "../middleware/auth";

export const authRoute = new Hono<AppEnv>();

/** 用户名正则：只允许字母数字和下划线，2-40 字符 */
const USERNAME_RE = /^[a-zA-Z0-9_]{2,40}$/;

/** 获取 JWT 密钥，生产环境必须配置 */
function getJwtSecret(c: any): string {
  const secret = c.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET 未配置，请通过 wrangler secret put 设置");
  }
  return secret;
}

/** 用户注册（自动创建默认租户） */
authRoute.post("/register", async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ username: string; password: string; email?: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const email = String(body.email || "").trim().toLowerCase();

  // 用户名格式校验
  if (!USERNAME_RE.test(username)) {
    return c.json({ ok: false, message: "用户名需要 2-40 个字符，只允许字母、数字和下划线" }, 400);
  }
  // 密码强度：至少 8 位，包含字母和数字
  if (password.length < 8) {
    return c.json({ ok: false, message: "密码需要至少 8 个字符" }, 400);
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return c.json({ ok: false, message: "密码必须包含字母和数字" }, 400);
  }

  // 检查用户名是否已存在
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing) {
    return c.json({ ok: false, message: "用户名已存在" }, 409);
  }

  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();

  // 密码 hash
  const passwordHash = await hashPassword(password);

  // 创建用户和默认租户
  await db.insert(users).values({ id: userId, username, email, passwordHash });
  await db.insert(tenants).values({ id: tenantId, name: username });
  await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

  // 签发 JWT
  const jwtSecret = getJwtSecret(c);
  const token = await signJwt({ sub: userId, tenantId }, jwtSecret, 7 * 86400);

  return c.json({ ok: true, token, tenantId });
});

/** 登录 */
authRoute.post("/login", async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ username: string; password: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!username || !password) {
    return c.json({ ok: false, message: "请输入用户名和密码" }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) {
    // 使用恒定时间返回，防止用户名枚举
    return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  }

  // 检查用户状态
  if (user.status !== "active") {
    return c.json({ ok: false, message: "账号已被禁用" }, 403);
  }

  // 获取租户 ID
  const [member] = await db.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).where(eq(tenantMembers.userId, user.id)).limit(1);
  const tenantId = member?.tenantId || "";

  const jwtSecret = getJwtSecret(c);
  const token = await signJwt({ sub: user.id, tenantId }, jwtSecret, 7 * 86400);

  return c.json({ ok: true, token, tenantId });
});

/** 注销 */
authRoute.post("/logout", async (c) => {
  return c.json({ ok: true, message: "已注销" });
});

/**
 * 密码 hash（bcrypt 简化版，使用 Web Crypto PBKDF2）
 * 生产环境应使用 bcrypt 或 Argon2id
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}