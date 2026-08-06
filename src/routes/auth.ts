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
import { getClientIp, getEnv } from "../lib/platform";
import { getDb, isValidEmail } from "../lib/http";
import { withDbTransaction } from "../db/client";
import { users, tenantMembers, tenants, emailAccessCodes, systemConfig, platformMembers } from "../db/schema";
import { generateCode, hashCode } from "./public-lottery-helpers";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { signJwt } from "../middleware/auth";
import { sendAccessCode } from "../services/email-service";
import { checkDbRateLimit } from "../lib/rate-limit";
import {
  resolveCfAuthConfig,
  publicCfAuthMeta,
  completeCfAuthCodeExchange,
} from "../lib/cf-auth-oauth";
import {
  IDP_PROVIDER_CF_AUTH,
  provisionIdpUser,
} from "../services/idp-user-provision";
import { timingSafeEqualHex, timingSafeEqualString } from "../lib/crypto-compare";
import { MemoryRateLimiter } from "@usethink/cf-core/rate-limit";

export const authRoute = new Hono<AppEnv>();

/** 内存固定窗口限流（docs/091 P0-5：统一到 cf-core MemoryRateLimiter，替代两份本地 Map 实现） */
const memoryLimiter = new MemoryRateLimiter();

const USERNAME_RE = /^[a-zA-Z0-9_]{2,40}$/;
// 会话 token 有效期：24 小时（#7）。7 天过长——token 存 localStorage 且无服务端吊销机制，
// 泄露后影响窗口大；缩短为 24 小时 + 前端 8 小时 localStorage 管理（更早过期）是免费层下
// 务实折中（引入吊销表会增加每次请求的 DB 读取，不符合 023 Turso rows read 约束）。
const SESSION_TOKEN_TTL_SECONDS = 24 * 3600;
// 密码存储方案依据 docs/023（Cloudflare 免费版与 Turso 约束下认证和运行安全方案）：
// 免费层 CPU 10ms/请求的硬约束下，注册/登录热路径禁止高迭代 KDF（PBKDF2 高迭代/bcrypt/Argon2 会
// 触发 1102 CPU 超限，且攻击者撞接口可用极低成本耗尽免费 CPU）。
// 故维持"低 CPU 单次 HMAC-SHA256 + 服务端 pepper"方案，离线防护依赖 pepper 保密；
// 升级路线（023 §3.3）：中期 passwordless（邮箱验证码/魔法链接），长期付费层后迁移 Argon2id/高迭代 PBKDF2。
const PASSWORD_HASH_ALGORITHM = "hmac_sha256_v1";
const LEGACY_PBKDF2_ITERATIONS = [100];
const LEGACY_SHA256_RE = /^[a-f0-9]{64}$/i;

function getJwtSecret(c: any): string {
  const secret = getEnv(c, "JWT_SECRET");
  if (!secret) throw new Error("JWT_SECRET 未配置");
  return secret;
}

function getPasswordPepper(c: any): string {
  const pepper = getEnv(c, "PASSWORD_PEPPER") || getEnv(c, "JWT_SECRET");
  if (!pepper || String(pepper).length < 16) {
    throw new Error("PASSWORD_PEPPER 或 JWT_SECRET 未配置");
  }
  return String(pepper);
}

// 数据库存储验证码（替代内存 Map，确保跨 Worker 实例可用）

// ══════════════════════════════════════════════════════════
// 注册流程：提交信息 → 发送验证码 → 验证邮箱 → 完成注册
// ══════════════════════════════════════════════════════════

/** 第一步：提交注册信息，发送验证码 */
authRoute.post("/register", async (c) => {
  try {
    const ip = getClientIp(c);
    if (!(await memoryLimiter.check(`register:${ip}`, 3, 60000)).ok) {
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
      return c.json({ ok: false, message: "用户名需要 2-40 个字符，只允许字母、数字和下划线" }, 400);
    }
    if (password.length < 8) {
      return c.json({ ok: false, message: "密码需要至少 8 个字符" }, 400);
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return c.json({ ok: false, message: "密码必须包含字母和数字" }, 400);
    }
    if (!email || !isValidEmail(email)) {
      return c.json({ ok: false, message: "请输入有效的邮箱地址" }, 400);
    }

    // ★ 并行查询：用户名 + 邮箱 独立查询一次并发完成
    const [[existingUser], [existingEmail]] = await Promise.all([
      db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1),
      db.select({ id: users.id }).from(users).where(and(eq(users.email, email), eq(users.emailVerified, 1))).limit(1),
    ]);
    if (existingUser) { return c.json({ ok: false, message: "用户名已存在" }, 409); }
    if (existingEmail) {
      return c.json({ ok: false, message: "该邮箱已被注册" }, 409);
    }

    // 生成密码 hash
    const passwordHash = await hashPassword(password, getPasswordPepper(c));

    // ★ 045 方案 C 改造：注册只建用户，不自动建租户
    // 消除"噪音租户"——租户应通过 onboarding 显式创建，而非注册附赠。
    // 历史存量用户有租户，无需迁移，逻辑天然兼容。
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, username, email, passwordHash, emailVerified: 0 });

    // 生成验证码并存入数据库（先标记旧码失效，避免 UNIQUE(email,draw_id) WHERE used=0 冲突）
    const code = generateCode();
    const codeHash = await hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.update(emailAccessCodes).set({ used: 1 }).where(and(eq(emailAccessCodes.email, email), eq(emailAccessCodes.drawId, ""), eq(emailAccessCodes.used, 0)));
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId: "",
      codeHash,
      used: 0,
      expiresAt,
    });

    // 邮件发送失败不回滚注册：验证码已经落库，MVP 环境未配置 Resend 时仍可通过测试/人工渠道完成验证。
    const emailEnv = { resendApiKey: getEnv(c, "RESEND_API_KEY") || "", emailFrom: getEnv(c, "EMAIL_FROM") || "" };
    try {
      await sendAccessCode(emailEnv, email, "注册验证", code);
    } catch (err) {
      console.warn("[auth] register sendAccessCode failed:", (err as Error).message);
    }

    return c.json({ ok: true, message: "验证码已发送到邮箱", expiresInSeconds: 600 });
  } catch (err) {
    console.error("[auth] register failed:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, message: "注册失败，请稍后再试" }, 500);
  }
});

/** 第二步：验证邮箱码 */
authRoute.post("/verify-email", async (c) => {
  const ip = getClientIp(c);
  // ★ P0 安全：邮箱验证码试错限流（10 次/15 分钟/IP），防暴力破解。
  // 双层限流与 register/login 一致：内存限流兜底 + DB 级限流（跨 Worker 实例一致，
  // 023 §6"登录失败限流持久化"落地；DB 层为单条原子条件 INSERT，CPU 成本低）。
  if (!(await memoryLimiter.check(`verify-email:${ip}`, 10, 900000)).ok) {
    return c.json({ ok: false, message: "尝试次数过多，请 15 分钟后再试" }, 429);
  }
  const db = getDb(c);
  if (!(await checkDbRateLimit(db, `verify-email:${ip}`, 10, 900000))) {
    return c.json({ ok: false, message: "尝试次数过多，请 15 分钟后再试" }, 429);
  }
  const body = await c.req.json<{ email: string; code: string }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  /**
   * 关键：必须限定 drawId=""（注册码）。
   * 活动参与 OTP 写入真实 drawId；若不加限制，攻击者可用活动邮件中的码完成
   * /verify-email 账号接管（security-reviewer CRITICAL #1，docs/070）。
   */
  const stored = await db
    .select()
    .from(emailAccessCodes)
    .where(
      and(
        eq(emailAccessCodes.email, email),
        eq(emailAccessCodes.drawId, ""),
        eq(emailAccessCodes.used, 0),
      ),
    )
    .orderBy(sql`${emailAccessCodes.createdAt} DESC`)
    .limit(1);
  if (stored.length === 0) return c.json({ ok: false, message: "请先提交注册信息" }, 400);
  const codeRecord = stored[0]!;
  if (new Date() > new Date(codeRecord.expiresAt)) {
    await db.delete(emailAccessCodes).where(eq(emailAccessCodes.id, codeRecord.id));
    return c.json({ ok: false, message: "验证码已过期" }, 400);
  }

  const inputHash = await hashCode(code);
  // 验证码 hash 用常量时间比较，避免前缀短路计时面
  if (!timingSafeEqualHex(inputHash, codeRecord.codeHash)) {
    return c.json({ ok: false, message: "验证码错误" }, 400);
  }

  await db.update(emailAccessCodes).set({ used: 1 }).where(eq(emailAccessCodes.id, codeRecord.id));

  // 优先绑定「尚未验证」的同邮箱用户，避免多行竞态验证到错误账号
  const [pendingUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.emailVerified, 0)))
    .orderBy(sql`${users.createdAt} DESC`)
    .limit(1);
  const [anyUser] = pendingUser
    ? [pendingUser]
    : await db.select().from(users).where(eq(users.email, email)).orderBy(sql`${users.createdAt} DESC`).limit(1);
  const user = anyUser;
  if (!user) return c.json({ ok: false, message: "用户不存在" }, 404);
  if (user.status && user.status !== "active") {
    return c.json({ ok: false, message: "账号已被禁用" }, 403);
  }

  await db.update(users).set({ emailVerified: 1 }).where(eq(users.id, user.id));

  // 获取租户 ID
  const [member] = await db.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).where(eq(tenantMembers.userId, user.id)).limit(1);
  const tenantId = member?.tenantId || "";

  // 签发 JWT（含 email：公开页 open 系 Bearer 免 OTP 依赖，docs/093）
  const jwtSecret = getJwtSecret(c);
  const token = await signJwt(
    { sub: user.id, tenantId, email: user.email },
    jwtSecret,
    SESSION_TOKEN_TTL_SECONDS,
  );

  // needsTenant 与 /login 对齐：方案 C 下新注册用户无租户，前端引导 onboarding
  return c.json({ ok: true, token, tenantId, needsTenant: !member, email: user.email });
});

// ══════════════════════════════════════════════════════════
// 登录
// ══════════════════════════════════════════════════════════

/** 登录（仅已验证邮箱的用户可登录） */
authRoute.post("/login", async (c) => {
  const ip = getClientIp(c);
  try {
  const db = getDb(c);
  // 读取系统配置的登录限流值（闭环：L3 配置 → 登录限流生效）
  const [rlCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "rate_limit_login")).limit(1);
  const loginLimit = Math.min(Math.max(parseInt(rlCfg?.value || "", 10) || 5, 1), 100);
  if (!(await memoryLimiter.check(`login:${ip}`, loginLimit, 60000)).ok) {
    return c.json({ ok: false, message: "登录过于频繁，请稍后再试" }, 429);
  }

  // 数据库级限流：多实例下全局一致
  if (!(await checkDbRateLimit(db, `login:${ip}`, loginLimit, 60000))) {
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
    // 先将该邮箱所有未使用的旧验证码标记为失效（UNIQUE(email, draw_id) WHERE used=0 约束）
    await db.update(emailAccessCodes).set({ used: 1 }).where(and(eq(emailAccessCodes.email, user.email), eq(emailAccessCodes.drawId, ""), eq(emailAccessCodes.used, 0)));
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email: user.email,
      drawId: "",
      codeHash,
      used: 0,
      expiresAt,
    });
    const emailEnv = { resendApiKey: getEnv(c, "RESEND_API_KEY") || "", emailFrom: getEnv(c, "EMAIL_FROM") || "" };
    try {
      await sendAccessCode(emailEnv, user.email, "注册验证", code);
    } catch (err) {
      console.warn("[auth] login sendAccessCode failed:", (err as Error).message);
    }
    return c.json({ ok: false, message: "邮箱未验证，验证码已重新发送", email: user.email, needVerify: true });
  }

  // 查询用户的所有租户（不再 limit(1)）：支持多租户切换
  // 背景：注册会为每个用户创建自己的租户；被其他租户添加为成员后，
  // 用户拥有多个租户 membership。登录只进第一个租户会导致"团队成员无法
  // 访问对方租户"的设计缺陷，因此登录返回全部租户，前端可切换。
  const memberships = await db
    .select({
      tenantId: tenantMembers.tenantId,
      role: tenantMembers.role,
      tenantName: tenants.name,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, user.id));

  // 默认进入第一个租户（或空字符串表示无租户）
  const tenantId = memberships[0]?.tenantId || "";

  const jwtSecret = getJwtSecret(c);
  // email 进 claims：活动页 open 系 verify-join / my-result 与 JWT.email 对齐免 OTP
  const token = await signJwt(
    { sub: user.id, tenantId, email: user.email },
    jwtSecret,
    SESSION_TOKEN_TTL_SECONDS,
  );

  return c.json({
    ok: true,
    token,
    tenantId,
    email: user.email,
    username: user.username,
    needsTenant: memberships.length === 0,
    tenants: memberships.map((m) => ({
      id: m.tenantId,
      name: m.tenantName,
      role: m.role,
    })),
  });
  } catch (err) {
    console.error("[auth] login error:", (err as Error).message);
    return c.json({ ok: false, message: "登录失败，请稍后重试" }, 400);
  }
});

/** 切换当前租户（多租户用户在不同租户间切换上下文）
 *
 * 背景：用户可能属于多个租户（自己的 + 被邀请加入的）。
 * 切换时校验该用户确实是目标租户成员，再签发新的 JWT（新 tenantId）。
 */
authRoute.post("/switch-tenant", requireAuth, async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ tenantId: string }>();
  const targetTenantId = String(body.tenantId || "").trim();
  if (!targetTenantId) return c.json({ ok: false, message: "缺少租户 ID" }, 400);

  // 校验用户是目标租户的活跃成员
  const [membership] = await db
    .select({ tenantId: tenantMembers.tenantId, role: tenantMembers.role })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, targetTenantId)))
    .limit(1);
  if (!membership) return c.json({ ok: false, message: "您不是该租户的成员" }, 403);

  // 签发新 JWT（切换后的租户上下文；保留 email 供公开参与免 OTP）
  const [switchUser] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const jwtSecret = getJwtSecret(c);
  const token = await signJwt(
    { sub: userId, tenantId: targetTenantId, email: switchUser?.email || "" },
    jwtSecret,
    SESSION_TOKEN_TTL_SECONDS,
  );

  return c.json({
    ok: true,
    token,
    tenantId: targetTenantId,
    role: membership.role,
    email: switchUser?.email || "",
  });
});

/**
 * ★ 045 方案 C：显式创建租户（onboarding 引导后的主动创建）。
 * 每个用户允许创建多个租户（多品牌运营），不做一人一租户限制。
 */
authRoute.post("/create-tenant", requireAuth, async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ name: string }>();
  const name = String(body.name || "").trim();
  // 与前端 maxlength=30 对齐：租户名 2-30 字符，拒绝超长/单字符噪音
  if (name.length < 2 || name.length > 30) {
    return c.json({ ok: false, message: "租户名称需要 2-30 个字符" }, 400);
  }

  const tenantId = crypto.randomUUID();
  await withDbTransaction(db, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name });
    await tx.insert(tenantMembers).values({ tenantId, userId, role: "owner" });
  });

  const [ctUser] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const token = await signJwt(
    { sub: userId, tenantId, email: ctUser?.email || "" },
    getJwtSecret(c),
    SESSION_TOKEN_TTL_SECONDS,
  );

  return c.json({ ok: true, tenantId, name, token, email: ctUser?.email || "" });
});

/** 注销 */
authRoute.post("/logout", async (c) => {
  return c.json({ ok: true, message: "已注销" });
});

/**
 * 当前登录用户身份（仅 requireAuth，不要求租户成员）。
 *
 * 用途：
 * - 前端 L3 门禁 resolve（docs/125）：无租户的平台成员也能读到 platformRole
 * - 与 /api/admin/me 分工：admin/me 仍绑租户上下文与用量；本接口只回答「谁 + 是否 L3」
 *
 * platformRole：活跃 platform_members.role；非成员或 disabled → null
 */
authRoute.get("/me", requireAuth, async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const jwtTenantId = (c.get("tenantId") as string) || "";

  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ ok: false, message: "用户不存在" }, 404);
  }

  const [platformMember] = await db
    .select({ role: platformMembers.role, status: platformMembers.status })
    .from(platformMembers)
    .where(eq(platformMembers.userId, userId))
    .limit(1);

  const platformRole =
    platformMember?.status === "active" ? platformMember.role : null;

  return c.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
    },
    tenantId: jwtTenantId || null,
    platformRole,
  });
});

/**
 * cf-auth OAuth 元数据（无 secret）。
 * 前端据此决定是否展示「用 cf-auth 登录」并构造 authorize URL / PKCE。
 */
authRoute.get("/cf-auth/meta", async (c) => {
  const config = resolveCfAuthConfig({
    CF_AUTH_ENABLED: getEnv(c, "CF_AUTH_ENABLED"),
    CF_AUTH_ISSUER: getEnv(c, "CF_AUTH_ISSUER"),
    CF_AUTH_CLIENT_ID: getEnv(c, "CF_AUTH_CLIENT_ID"),
    CF_AUTH_CLIENT_SECRET: getEnv(c, "CF_AUTH_CLIENT_SECRET"),
    CF_AUTH_REDIRECT_URI: getEnv(c, "CF_AUTH_REDIRECT_URI"),
    CF_AUTH_SCOPES: getEnv(c, "CF_AUTH_SCOPES"),
  });
  return c.json({ ok: true, ...publicCfAuthMeta(config) });
});

/**
 * cf-auth 授权码交换 → 业务自签 JWT（docs/059）。
 *
 * 浏览器只拿 code + code_verifier；client_secret 留在服务端。
 * 成功后 JWT 与 requireAuth 格式兼容（HS256 业务自签）。
 */
authRoute.post("/cf-auth/exchange", async (c) => {
  try {
    const ip = getClientIp(c);
    const db = getDb(c);
    if (!(await checkDbRateLimit(db, `cf-auth-exchange:${ip}`, 30, 60000))) {
      return c.json({ ok: false, message: "请求过于频繁" }, 429);
    }

    const config = resolveCfAuthConfig({
      CF_AUTH_ENABLED: getEnv(c, "CF_AUTH_ENABLED"),
      CF_AUTH_ISSUER: getEnv(c, "CF_AUTH_ISSUER"),
      CF_AUTH_CLIENT_ID: getEnv(c, "CF_AUTH_CLIENT_ID"),
      CF_AUTH_CLIENT_SECRET: getEnv(c, "CF_AUTH_CLIENT_SECRET"),
      CF_AUTH_REDIRECT_URI: getEnv(c, "CF_AUTH_REDIRECT_URI"),
      CF_AUTH_SCOPES: getEnv(c, "CF_AUTH_SCOPES"),
    });
    if (!config.enabled) {
      return c.json({ ok: false, message: "cf-auth 未启用或配置不完整" }, 503);
    }

    const body = await c.req.json<{
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
    }>();
    if (!body?.code || !body?.codeVerifier) {
      return c.json({ ok: false, message: "缺少 code 或 codeVerifier" }, 400);
    }

    /**
     * redirect_uri 只允许服务端配置值（忽略或校验客户端传入）。
     * 防止恶意客户端用宽松 IdP 登记面兑换任意 redirect（HIGH #5）。
     */
    const clientRedirect = body.redirectUri != null ? String(body.redirectUri).trim() : "";
    if (clientRedirect && clientRedirect !== config.redirectUri) {
      return c.json({ ok: false, message: "redirect_uri 与配置不一致" }, 400);
    }

    const jwtSecret = getEnv(c, "JWT_SECRET");
    if (!jwtSecret) {
      return c.json({ ok: false, message: "JWT_SECRET 未配置" }, 500);
    }

    // 生产路径必须 provision：JWT.sub = 本地 users.id，create-tenant 才能工作（docs/062）
    const result = await completeCfAuthCodeExchange(
      config,
      {
        code: body.code,
        codeVerifier: body.codeVerifier,
        // 固定为配置 redirect，不透传客户端任意 URI
        redirectUri: config.redirectUri,
      },
      jwtSecret,
      fetch,
      async (profile) => {
        const p = await provisionIdpUser(db, {
          provider: IDP_PROVIDER_CF_AUTH,
          idpSub: String(profile.sub || ""),
          email: String(profile.email || profile.preferred_username || ""),
          displayName: String(profile.name || profile.preferred_username || ""),
          emailVerified: profile.email_verified !== false,
        });
        return {
          userId: p.userId,
          email: p.email,
          tenantId: p.tenantId,
          tenantRole: p.tenantRole,
          needsTenant: p.needsTenant,
        };
      },
    );
    if (!result.ok) {
      const status = (result.status >= 400 && result.status < 600 ? result.status : 502) as 400 | 401 | 403 | 429 | 500 | 502 | 503;
      // 不向客户端回传 IdP body 切片（detail），避免配置/内部错误侦察
      return c.json({ ok: false, message: result.message }, status);
    }
    return c.json({
      ok: true,
      token: result.token,
      email: result.email,
      /** 本地 users.id（与 JWT.sub 一致） */
      sub: result.sub,
      idpSub: result.idpSub,
      tenantId: result.tenantId,
      needsTenant: result.needsTenant,
    });
  } catch (err) {
    console.error("[cf-auth/exchange]", err instanceof Error ? err.message : err);
    return c.json({ ok: false, message: "cf-auth 认证失败" }, 401);
  }
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
    const computed = await hmacPassword(password, salt, pepper);
    return timingSafeEqualHex(computed, hashHex);
  }

  if (isLegacySha256Hash(stored)) {
    const legacy = await legacySha256PasswordHash(password);
    return timingSafeEqualString(legacy, stored);
  }

  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = hexToBytes(saltHex);
  if (!salt || !/^[a-f0-9]{64}$/i.test(hashHex)) return false;

  for (const iterations of LEGACY_PBKDF2_ITERATIONS) {
    const computed = await legacyPbkdf2PasswordHash(password, salt, iterations);
    if (timingSafeEqualHex(computed, hashHex)) return true;
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
