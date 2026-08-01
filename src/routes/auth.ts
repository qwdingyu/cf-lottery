/**
 * 认证路由：注册 / 登录
 *
 * 安全约束：
 * - 注册必须提供邮箱，注册后发送验证码，验证通过后账号才可登录
 * - 登录使用用户名+密码（已验证邮箱后的账号）
 * - JWT_SECRET 必须通过 wrangler secret put 设置
 * - 免费 Workers CPU 时间有限，密码采用带服务端 pepper 的 HMAC-SHA256 存储
 * - 登录/注册接口包含基本限流（通过 IP hash 识别）
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb } from "../lib/http";
import { users, tenantMembers, tenants, emailAccessCodes, systemConfig } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { signJwt } from "../middleware/auth";
import { sendAccessCode } from "../services/email-service";
import { checkDbRateLimit } from "../lib/rate-limit";

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
const PASSWORD_HASH_ALGORITHM = "hmac_sha256_v1";
// 免费 Workers 的登录热路径不能默认尝试高迭代 PBKDF2；当前仓库已发布过的旧格式使用 100 次。
const LEGACY_PBKDF2_ITERATIONS = [100];
const LEGACY_SHA256_RE = /^[a-f0-9]{64}$/i;

function getJwtSecret(c: any): string {
  const secret = c.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET 未配置");
  return secret;
}

function getPasswordPepper(c: any): string {
  const pepper = c.env.PASSWORD_PEPPER || c.env.JWT_SECRET;
  if (!pepper || String(pepper).length < 16) {
    throw new Error("PASSWORD_PEPPER 或 JWT_SECRET 未配置");
  }
  return String(pepper);
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
  return bytesToHex(new Uint8Array(hash));
}

// 数据库存储验证码（替代内存 Map，确保跨 Worker 实例可用）

// ══════════════════════════════════════════════════════════
// 注册流程：提交信息 → 发送验证码 → 验证邮箱 → 完成注册
// ══════════════════════════════════════════════════════════

/** 第一步：提交注册信息，发送验证码 */
authRoute.post("/register", async (c) => {
  try {
    const ip = c.req.header("CF-Connecting-IP") || "unknown";
    if (!checkRateLimit(`register:${ip}`, 3, 60000)) {
      return c.json({ ok: false, message: "注册过于频繁，请稍后再试" }, 429);
    }

    const db = getDb(c);

    // 平台运营者可关闭公开注册用于 MVP 内测/邀请制。
    // 这个检查放在数据库级限流写入之前，避免注册关闭期间的无效请求持续写 rate_limit_log。
    const [regCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "enable_registration")).limit(1);
    if (regCfg && regCfg.value === "false") {
      return c.json({ ok: false, message: "当前暂不开放公开注册" }, 403);
    }

    // 数据库级限流：多实例下全局一致；只对真正可能进入注册流程的请求落库。
    if (!(await checkDbRateLimit(db, `register:${ip}`, 3, 60000))) {
      return c.json({ ok: false, message: "注册过于频繁，请稍后再试" }, 429);
    }

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
    const passwordHash = await hashPassword(password, getPasswordPepper(c));

    // 创建用户（未验证邮箱）
    const userId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, username, email, passwordHash, emailVerified: 0 });
    await db.insert(tenants).values({ id: tenantId, name: username });
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

    // 生成并存入数据库
    const code = generateCode();
    const codeHash = await hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId: "",
      codeHash,
      used: 0,
      expiresAt,
    });

    // 邮件发送失败不回滚注册：验证码已经落库，MVP 环境未配置 Resend 时仍可通过测试/人工渠道完成验证。
    const emailEnv = { resendApiKey: c.env.RESEND_API_KEY || "", emailFrom: c.env.EMAIL_FROM || "" };
    try {
      await sendAccessCode(emailEnv, email, "注册验证", code);
    } catch (err) {
      console.warn("[auth] register sendAccessCode failed:", (err as Error).message);
    }

    return c.json({ ok: true, message: "验证码已发送到邮箱", expiresInSeconds: 600 });
  } catch (err) {
    console.error("[auth] register failed:", err, err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, message: "注册失败，请稍后再试" }, 500);
  }
});

/** 第二步：验证邮箱码 */
authRoute.post("/verify-email", async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ email: string; code: string }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  const stored = await db
    .select()
    .from(emailAccessCodes)
    .where(and(eq(emailAccessCodes.email, email), eq(emailAccessCodes.used, 0)))
    .orderBy(sql`${emailAccessCodes.createdAt} DESC`)
    .limit(1);
  if (stored.length === 0) return c.json({ ok: false, message: "请先提交注册信息" }, 400);
  const codeRecord = stored[0]!;
  if (new Date() > new Date(codeRecord.expiresAt)) {
    await db.delete(emailAccessCodes).where(eq(emailAccessCodes.id, codeRecord.id));
    return c.json({ ok: false, message: "验证码已过期" }, 400);
  }

  const inputHash = await hashCode(code);
  if (inputHash !== codeRecord.codeHash) {
    return c.json({ ok: false, message: "验证码错误" }, 400);
  }

  await db.update(emailAccessCodes).set({ used: 1 }).where(eq(emailAccessCodes.id, codeRecord.id));

  // 标记邮箱已验证
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
  // 数据库级限流：多实例下全局一致
  if (!(await checkDbRateLimit(db, `login:${ip}`, 5, 60000))) {
    return c.json({ ok: false, message: "登录过于频繁，请稍后再试" }, 429);
  }

  const body = await c.req.json<{ username: string; password: string }>();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!username || !password) {
    return c.json({ ok: false, message: "请输入用户名和密码" }, 400);
  }

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!user) return c.json({ ok: false, message: "用户名或密码错误" }, 401);

  const passwordPepper = getPasswordPepper(c);
  const valid = await verifyPassword(password, user.passwordHash, passwordPepper);
  if (!valid) return c.json({ ok: false, message: "用户名或密码错误" }, 401);
  if (!isCurrentPasswordHash(user.passwordHash)) {
    await db.update(users).set({ passwordHash: await hashPassword(password, passwordPepper), updatedAt: new Date().toISOString() }).where(eq(users.id, user.id));
  }

  if (user.status !== "active") return c.json({ ok: false, message: "账号已被禁用" }, 403);

  // 检查邮箱是否已验证
  if (!user.emailVerified) {
    // 重新发送验证码
    const code = generateCode();
    const codeHash = await hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email: user.email,
      drawId: "",
      codeHash,
      used: 0,
      expiresAt,
    });
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

/** 密码 hash：带服务端 pepper 的 HMAC-SHA256，避免免费 Worker 内做高 CPU KDF。 */
async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await hmacPassword(password, salt, pepper);
  return `${PASSWORD_HASH_ALGORITHM}:${bytesToHex(salt)}:${hash}`;
}

async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  if (isCurrentPasswordHash(stored)) {
    const [, saltHex, hashHex] = stored.split(":");
    const salt = saltHex ? hexToBytes(saltHex) : null;
    if (!salt || !hashHex || !/^[a-f0-9]{64}$/i.test(hashHex)) return false;
    return await hmacPassword(password, salt, pepper) === hashHex.toLowerCase();
  }

  if (isLegacySha256Hash(stored)) {
    return await legacySha256PasswordHash(password) === stored;
  }

  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = hexToBytes(saltHex);
  if (!salt || !/^[a-f0-9]{64}$/i.test(hashHex)) return false;

  for (const iterations of LEGACY_PBKDF2_ITERATIONS) {
    if (await legacyPbkdf2PasswordHash(password, salt, iterations) === hashHex.toLowerCase()) return true;
  }
  return false;
}

function isCurrentPasswordHash(stored: string): boolean {
  return stored.startsWith(`${PASSWORD_HASH_ALGORITHM}:`);
}

async function hmacPassword(password: string, salt: Uint8Array, pepper: string): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const payload = new Uint8Array(salt.length + passwordBytes.length);
  payload.set(salt);
  payload.set(passwordBytes, salt.length);
  const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(mac));
}

async function legacyPbkdf2PasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(hash));
}

function isLegacySha256Hash(stored: string): boolean {
  return LEGACY_SHA256_RE.test(stored);
}

async function legacySha256PasswordHash(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[a-f0-9]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}
