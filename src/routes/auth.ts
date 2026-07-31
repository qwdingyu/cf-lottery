/**
 * 认证路由：注册 / 登录
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb } from "../lib/http";
import { users, tenantMembers, tenants } from "../db/schema";
import { eq } from "drizzle-orm";
import { signJwt } from "../middleware/auth";

export const authRoute = new Hono<AppEnv>();

/** 用户注册（自动创建默认租户） */
authRoute.post("/register", async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ username: string; password: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (username.length < 2 || username.length > 40) {
    return c.json({ ok: false, message: "用户名需要 2-40 个字符" }, 400);
  }
  if (password.length < 6) {
    return c.json({ ok: false, message: "密码需要至少 6 个字符" }, 400);
  }

  // 检查用户名是否已存在
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing) {
    return c.json({ ok: false, message: "用户名已存在" }, 409);
  }

  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();

  // bcrypt hash 密码
  const passwordHash = await hashPassword(password);

  // 创建用户和默认租户
  await db.insert(users).values({ id: userId, username, passwordHash });
  await db.insert(tenants).values({ id: tenantId, name: username });
  await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

  // 签发 JWT
  const jwtSecret = c.env.JWT_SECRET || "dev-secret";
  const token = await signJwt({ sub: userId, tenantId }, jwtSecret, 7 * 86400);

  return c.json({ ok: true, token, tenantId });
});

/** 登录 */
authRoute.post("/login", async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ username: string; password: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) {
    return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  }

  // 获取租户 ID
  const [member] = await db.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).where(eq(tenantMembers.userId, user.id)).limit(1);
  const tenantId = member?.tenantId || "";

  const jwtSecret = c.env.JWT_SECRET || "dev-secret";
  const token = await signJwt({ sub: user.id, tenantId }, jwtSecret, 7 * 86400);

  return c.json({ ok: true, token, tenantId });
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