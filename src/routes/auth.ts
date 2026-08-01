/**
 * 认证路由：注册 / 登录
 *
 * 安全约束：
 * - 注册必须提供邮箱，注册后发送验证码，验证通过后账号才可登录
 * - 登录使用用户名+密码（已验证邮箱后的账号）
 * - JWT_SECRET 必须通过 wrangler secret put 设置
 * - 密码使用 PBKDF2 + SHA-256 × 100000 迭代
 * - 登录/注册接口包含基本限流（通过 IP hash 识别）
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb } from "../lib/http";
import { users, tenantMembers, tenants } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { signJwt } from "../middleware/auth";
import { sendAccessCode } from "../services/email-service";

export const authRoute = new Hono<AppEnv>();

/** 简单内存限流 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit = 5, windowMs = 60000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{2,40}$/;

function getJwtSecret(c: any): string {
  const secret = c.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET 未配置");
  return secret;
}

/** 生成 6 位验证码 */
function generateCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num = new DataView(bytes.buffer).getUint32(0) % 1000000;
  return String(num).padStart(6, "0");
}

/** 验证码 hash */
async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// 内存存储注册验证码：email -> { codeHash, expiresAt }
const regCodeStore = new Map<string, { codeHash: string; expiresAt: number }>();

// ══════════════════════════════════════════════════════════
// 注册流程：提交信息 → 发送验证码 → 验证邮箱 → 完成注册
// ══════════════════════════════════════════════════════════

/** 第一步：提交注册信息，发送验证码 */
authRoute.post("/register", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!checkRateLimit(`register:${ip}`, 3, 60000)) {
    return c.json({ ok: false, message: "注册过于频繁，请稍后再试" }, 429);
  }

  const db = getDb(c);
  const body = await c.req.json<{ username: string; password: string; email: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const email = String(body.email || "").trim().toLowerCase();

  // 校验
  if (!USERNAME_RE.test(username)) {
    return c.json({ ok: false, message: "用户名需要 4-20 个字符，只允许字母、数字和下划线" }, 400);
  }
  if (password.length < 8) {
    return c.json({ ok: false, message: "密码需要至少 8 个字符" }, 400);
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return c.json({ ok: false, message: "密码必须包含字母和数字" }, 400);
  }
  if (!email || !email.includes("@")) {
    return c.json({ ok: false, message: "请输入有效的邮箱地址" }, 400);
  }

  // 检查用户名是否已存在
  const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existingUser) {
    return c.json({ ok: false, message: "用户名已存在" }, 409);
  }
  // 检查邮箱是否已被注册
  const [existingEmail] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), eq(users.emailVerified, 1))).limit(1);
  if (existingEmail) {
    return c.json({ ok: false, message: "该邮箱已被注册" }, 409);
  }

  // 生成密码 hash
  const passwordHash = await hashPassword(password);

  // 创建用户（未验证邮箱）
  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, username, email, passwordHash, emailVerified: 0 });
  await db.insert(tenants).values({ id: tenantId, name: username });
  await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

  // 生成并发送验证码
  const code = generateCode();
  const codeHash = await hashCode(code);
  regCodeStore.set(email, { codeHash, expiresAt: Date.now() + 10 * 60 * 1000 });

  const emailEnv = { resendApiKey: c.env.RESEND_API_KEY || "", emailFrom: c.env.EMAIL_FROM || "" };
  try {
    await sendAccessCode(emailEnv, email, "注册验证", code);
  } catch (err) {
    console.warn("[auth] sendAccessCode failed:", (err as Error).message);
    // 邮件发送失败不阻止注册，验证码已存入内存
  }

  return c.json({ ok: true, message: "验证码已发送到邮箱", expiresInSeconds: 600 });
});

/** 第二步：验证邮箱码 */
authRoute.post("/verify-email", async (c) => {
  const body = await c.req.json<{ email: string; code: string }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  const stored = regCodeStore.get(email);
  if (!stored) return c.json({ ok: false, message: "请先提交注册信息" }, 400);
  if (Date.now() > stored.expiresAt) {
    regCodeStore.delete(email);
    return c.json({ ok: false, message: "验证码已过期" }, 400);
  }

  const inputHash = await hashCode(code);
  if (inputHash !== stored.codeHash) {
    return c.json({ ok: false, message: "验证码错误" }, 400);
  }

  regCodeStore.delete(email);

  // 标记邮箱已验证
  const db = getDb(c);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) return c.json({ ok: false, message: "用户不存在" }, 404);

  await db.update(users).set({ emailVerified: 1 }).where(eq(users.id, user.id));

  // 获取租户 ID
  const [member] = await db.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).where(eq(tenantMembers.userId, user.id)).limit(1);
  const tenantId = member?.tenantId || "";

  // 签发 JWT
  const jwtSecret = getJwtSecret(c);
  const token = await signJwt({ sub: user.id, tenantId }, jwtSecret, 7 * 86400);

  return c.json({ ok: true, token, tenantId });
});

// ══════════════════════════════════════════════════════════
// 登录
// ══════════════════════════════════════════════════════════

/** 登录（仅已验证邮箱的用户可登录） */
authRoute.post("/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!checkRateLimit(`login:${ip}`, 5, 60000)) {
    return c.json({ ok: false, message: "登录过于频繁，请稍后再试" }, 429);
  }

  const db = getDb(c);
  const body = await c.req.json<{ username: string; password: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!username || !password) {
    return c.json({ ok: false, message: "请输入用户名和密码" }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) return c.json({ ok: false, message: "用户名或密码错误" }, 401);

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return c.json({ ok: false, message: "用户名或密码错误" }, 401);

  if (user.status !== "active") return c.json({ ok: false, message: "账号已被禁用" }, 403);

  // 检查邮箱是否已验证
  if (!user.emailVerified) {
    // 重新发送验证码
    const code = generateCode();
    const codeHash = await hashCode(code);
    regCodeStore.set(user.email, { codeHash, expiresAt: Date.now() + 10 * 60 * 1000 });
    const emailEnv = { resendApiKey: c.env.RESEND_API_KEY || "", emailFrom: c.env.EMAIL_FROM || "" };
    try {
      await sendAccessCode(emailEnv, user.email, "注册验证", code);
    } catch (err) {
      console.warn("[auth] login sendAccessCode failed:", (err as Error).message);
    }
    return c.json({ ok: false, message: "邮箱未验证，验证码已重新发送", email: user.email, needVerify: true });
  }

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

/** 密码 hash（PBKDF2 + SHA-256 × 100000） */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
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
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}