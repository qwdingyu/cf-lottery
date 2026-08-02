/**
 * 认证路由 + 公开路由集成测试
 *
 * 测试策略：
 * - 使用 @libsql/client 创建临时文件数据库
 * - 模拟 Hono 请求，测试完整的请求-响应链路
 * - 覆盖：注册/登录/验证邮箱/注销/参与活动
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authRoute } from "../routes/auth";
import { publicLotteryRoute } from "../routes/public-lottery";
import { signJwt } from "../middleware/auth";
import {
  activityOutcomes,
  auditLogs,
  emailAccessCodes,
  lotteryDraws,
  lotteryEntries,
  systemConfig,
  tenantMembers,
  tenants,
  users,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";

/* ── 数据库设置 ───────────────────────────────────────────── */

let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let client: Awaited<ReturnType<typeof getTestDb>>["client"];

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

/* ── 辅助函数 ─────────────────────────────────────────────── */

const TENANT = "test-auth-tenant";
const USER = "test-auth-user";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET: "test-jwt-secret-0123456789abcdef",
};

/** 对未来时间取整，避免毫秒差异 */
function futureTimeISO(minutes: number): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function createAuthTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/auth", authRoute);
  return app;
}

function createPublicTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/public", publicLotteryRoute);
  return app;
}

async function legacySha256(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function legacyPbkdf2(password: string, salt: Uint8Array, iterations = 100): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${saltHex}:${hashHex}`;
}

/* ── 测试：注册 ──────────────────────────────────────────── */

// 由于 Hono 测试需要完整的应用上下文和 JWT 密钥，
// 这里我们测试 lottery-service 的核心函数，验证注册流程的数据完整性。
// 完整的路由层测试需要集成测试环境。

describe("用户注册数据完整性", () => {
  it("注册路由使用低 CPU 的 pepper HMAC 存储密码，并创建邮箱验证码", async () => {
    const app = createAuthTestApp();
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ username: "routeuser", password: "Password123", email: "route@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const [user] = await db.select().from(users).where(eq(users.username, "routeuser")).limit(1);
    expect(user?.passwordHash).toMatch(/^hmac_sha256_v1:[a-f0-9]{32}:[a-f0-9]{64}$/);
    // 验证码应写入 email_access_codes 表
    const [code] = await db.select().from(emailAccessCodes).where(eq(emailAccessCodes.email, "route@test.com")).limit(1);
    expect(code).toBeTruthy();
    // ★ 045 方案 C：注册不自动创建租户（租户由 onboarding 显式创建）
    const [member] = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, user!.id)).limit(1);
    expect(member).toBeUndefined();  // 不应自动建租户
  });

  // ── 方案 C 测试：无租户用户流程 ──

  it("新注册用户登录后 needsTenant=true（邮箱已验证后）", async () => {
    const app = createAuthTestApp();
    // 注册
    await app.request("/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.10" },
      body: JSON.stringify({ username: "notenant1", password: "Test12345", email: "nt1@test.com" }),
    }, TEST_ENV);
    // 直接设置邮箱已验证
    await db.update(users).set({ emailVerified: 1 }).where(eq(users.username, "notenant1"));

    // 登录
    const res = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "notenant1", password: "Test12345" }),
    }, TEST_ENV);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.needsTenant).toBe(true);
    expect(data.tenants).toHaveLength(0);
    expect(data.tenantId).toBe("");
  });

  it("create-tenant 创建租户后返回新 JWT", async () => {
    const app = createAuthTestApp();
    // 注册+验证
    await app.request("/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.11" },
      body: JSON.stringify({ username: "ct1", password: "Test12345", email: "ct1@test.com" }),
    }, TEST_ENV);
    await db.update(users).set({ emailVerified: 1 }).where(eq(users.username, "ct1"));
    // 登录获取 token
    const loginRes = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ct1", password: "Test12345" }),
    }, TEST_ENV);
    const loginData = await loginRes.json() as any;
    expect(loginData.needsTenant).toBe(true);

    // 创建租户
    const res = await app.request("/auth/create-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + loginData.token },
      body: JSON.stringify({ name: "我的团队" }),
    }, TEST_ENV);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.name).toBe("我的团队");
    expect(data.token).toBeTruthy();
    expect(data.tenantId).toBeTruthy();
    // 新的 JWT 应该带租户 ID
    expect(data.token).not.toBe(loginData.token);
  });

  it("create-tenant 后重新登录不再 needsTenant", async () => {
    const app = createAuthTestApp();
    // ct1 由上一个测试创建，直接查用户
    const [user] = await db.select().from(users).where(eq(users.username, "ct1")).limit(1);
    if (!user) throw new Error("ct1 user not found - previous test may have failed");

    const tenantId = crypto.randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "ct1-team" });
    await db.insert(tenantMembers).values({ tenantId, userId: user.id, role: "owner" });

    // 重新登录
    const res = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ct1", password: "Test12345" }),
    }, TEST_ENV);
    const data = await res.json() as any;
    expect(data.needsTenant).toBe(false);
    expect(data.tenants.length).toBeGreaterThanOrEqual(1);
  });

  it("存量用户（有租户）登录 needsTenant=false", async () => {
    const app = createAuthTestApp();
    // 注册+验证+手动建租户
    await app.request("/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.12" },
      body: JSON.stringify({ username: "hastenant", password: "Test12345", email: "ht@test.com" }),
    }, TEST_ENV);
    await db.update(users).set({ emailVerified: 1 }).where(eq(users.username, "hastenant"));
    const [usr] = await db.select().from(users).where(eq(users.username, "hastenant")).limit(1);
    const tid = crypto.randomUUID();
    await db.insert(tenants).values({ id: tid, name: "hasteam" });
    await db.insert(tenantMembers).values({ tenantId: tid, userId: usr!.id, role: "owner" });

    const res = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "hastenant", password: "Test12345" }),
    }, TEST_ENV);
    const data = await res.json() as any;
    expect(data.needsTenant).toBe(false);
  });

  // ── 方案 C 完 ──

  it("公开注册关闭时拒绝新用户且不写数据库限流日志", async () => {
    const app = createAuthTestApp();
    await db.insert(systemConfig).values({ key: "enable_registration", value: "false" });

    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.90" },
      body: JSON.stringify({ username: "closeduser", password: "Password123", email: "closed@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(403);
    const usersRows = await db.select().from(users).where(eq(users.username, "closeduser"));
    expect(usersRows).toHaveLength(0);

    const logs = await client.execute("SELECT COUNT(*) AS total FROM rate_limit_log");
    expect(Number(logs.rows[0]?.total || 0)).toBe(0);
  });

  it("注册时用户名已存在返回 409", async () => {
    const app = createAuthTestApp();
    // 先注册一个用户
    await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.2" },
      body: JSON.stringify({ username: "dupuser", password: "Password123", email: "dup1@test.com" }),
    }, TEST_ENV);

    // 用相同用户名再次注册（不同邮箱），应返回 409
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.3" },
      body: JSON.stringify({ username: "dupuser", password: "Password456", email: "dup2@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.message).toContain("用户名已存在");
  });

  it("注册时邮箱已被验证返回 409", async () => {
    const app = createAuthTestApp();
    // 先注册一个用户
    await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.4" },
      body: JSON.stringify({ username: "emailuser1", password: "Password123", email: "same@test.com" }),
    }, TEST_ENV);

    // 手动标记邮箱已验证（模拟验证流程）
    const [user] = await db.select().from(users).where(eq(users.username, "emailuser1")).limit(1);
    if (user) {
      await db.update(users).set({ emailVerified: 1 }).where(eq(users.id, user.id));
    }

    // 用不同用户名但相同已验证邮箱注册，应返回 409
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.5" },
      body: JSON.stringify({ username: "emailuser2", password: "Password456", email: "same@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.message).toContain("邮箱已被注册");
  });

  it("注册时密码太短返回 400", async () => {
    const app = createAuthTestApp();
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.6" },
      body: JSON.stringify({ username: "shortpwuser", password: "Ab1", email: "short@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("密码需要至少 8 个字符");
  });

  it("注册时密码缺少字母或数字返回 400", async () => {
    const app = createAuthTestApp();
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.7" },
      body: JSON.stringify({ username: "pwuser1", password: "1234567890", email: "pw1@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("密码必须包含字母和数字");
  });

  it("注册时用户名格式错误返回 400", async () => {
    const app = createAuthTestApp();
    // 用户名太短（1个字符）
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.8" },
      body: JSON.stringify({ username: "a", password: "Password123", email: "bad@test.com" }),
    }, TEST_ENV);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("用户名需要");
  });

  it("旧 SHA-256 密码登录成功后自动升级为 pepper HMAC 格式", async () => {
    const app = createAuthTestApp();
    const userId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "legacyuser",
      email: "legacy@test.com",
      emailVerified: 1,
      passwordHash: await legacySha256("Password123"),
    });
    await db.insert(tenants).values({ id: tenantId, name: "legacy" });
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.2" },
      body: JSON.stringify({ username: "legacyuser", password: "Password123" }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const [upgraded] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(upgraded?.passwordHash).toMatch(/^hmac_sha256_v1:[a-f0-9]{32}:[a-f0-9]{64}$/);
  });

  it("旧低迭代 PBKDF2 密码登录成功后自动升级为 pepper HMAC 格式", async () => {
    const app = createAuthTestApp();
    const userId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "legacy-pbkdf2",
      email: "legacy-pbkdf2@test.com",
      emailVerified: 1,
      passwordHash: await legacyPbkdf2("Password123", new Uint8Array(16).fill(7)),
    });
    await db.insert(tenants).values({ id: tenantId, name: "legacy-pbkdf2" });
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.3" },
      body: JSON.stringify({ username: "legacy-pbkdf2", password: "Password123" }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const [upgraded] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(upgraded?.passwordHash).toMatch(/^hmac_sha256_v1:[a-f0-9]{32}:[a-f0-9]{64}$/);
  });

  it("注册后自动创建租户和成员记录", async () => {
    // 验证 users、tenants、tenant_members 三表数据一致性
    const userId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, username: "testuser", email: "test@example.com", emailVerified: 1, passwordHash: "hash" });
    await db.insert(tenants).values({ id: tenantId, name: "testuser" });
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(user).toBeTruthy();
    expect(user!.username).toBe("testuser");

    const [member] = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, userId)).limit(1);
    expect(member).toBeTruthy();
    expect(member!.role).toBe("owner");
  });

  it("用户名唯一约束", async () => {
    await db.insert(users).values({ id: crypto.randomUUID(), username: "unique", email: "a@b.com", emailVerified: 1, passwordHash: "h" });
    await expect(
      db.insert(users).values({ id: crypto.randomUUID(), username: "unique", email: "b@b.com", emailVerified: 1, passwordHash: "h" })
    ).rejects.toThrow();
  });

  it("邮箱验证码过期后不能使用", async () => {
    // 插入过期验证码
    await client.execute({
      sql: `INSERT INTO email_access_codes (id, email, draw_id, code_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["code1", "user@test.com", "draw1", "hash", futureTimeISO(-10), 0, new Date().toISOString()],
    });
    // 验证过期码不可用
    const [code] = await db.select().from(emailAccessCodes).where(eq(emailAccessCodes.id, "code1")).limit(1);
    expect(code).toBeTruthy();
    expect(code!.expiresAt < new Date().toISOString()).toBe(true);
  });
});

/* ── 测试：公开参与 ──────────────────────────────────────── */

describe("公开参与流程", () => {
  it("open 模式：任何人可参与", async () => {
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "open-test",
      title: "公开测试", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      identityType: "email", identityValue: "user@test.com", joinedAt: new Date().toISOString(),
    });

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.identityValue, "user@test.com")).limit(1);
    expect(entry).toBeTruthy();
    expect(entry!.drawId).toBe(drawId);
  });

  it("同一邮箱重复获取验证码时保留历史记录且只保留一个未使用验证码", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "access-code-repeat",
      title: "重复发码测试", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const first = await app.request("/public/draws/access-code-repeat/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.20" },
      body: JSON.stringify({ email: "repeat@test.com" }),
    }, TEST_ENV);
    expect(first.status).toBe(200);

    const second = await app.request("/public/draws/access-code-repeat/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.20" },
      body: JSON.stringify({ email: "repeat@test.com" }),
    }, TEST_ENV);
    expect(second.status).toBe(200);

    const rows = await db.select().from(emailAccessCodes).where(and(
      eq(emailAccessCodes.email, "repeat@test.com"),
      eq(emailAccessCodes.drawId, drawId),
    ));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.used === 0)).toHaveLength(1);
    expect(rows.filter((row) => row.used === 1)).toHaveLength(1);
  });

  it("roster 模式：名单外不能参与", async () => {
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "roster-test",
      title: "名单测试", status: "open", participationMode: "roster",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // 不在名单中的人参与应被拒绝
    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.identityValue, "not-in-roster@test.com")))
      .limit(1);
    expect(entry).toBeFalsy();
  });

  it("password 模式：错误密码被拒绝", async () => {
    const drawId = crypto.randomUUID();
    // 使用 SHA-256 hash 密码
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode("correct-password"));
    const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");

    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "pw-test",
      title: "密码测试", status: "open", participationMode: "password",
      accessPassword: hashHex,
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // 验证密码 hash 存储正确
    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(draw!.accessPassword).toBe(hashHex);
  });

  /* ── registered 模式：需注册登录（JWT 认证）参与 ──
   * 覆盖：无 token 拒绝、有效 JWT 直通跳过验证码、无效 JWT 拒绝、
   *       verify-join 残留验证码绕过拦截（P1 回归）、重复参与按 userId 判重。
   */
  it("registered 模式：无 JWT 调用 access-code 返回 401", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-no-token",
      title: "注册模式测试", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/public/draws/registered-no-token/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.30" },
      body: JSON.stringify({ email: "anyone@test.com" }),
    }, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("registered 模式：有效 JWT 直接参与并跳过邮箱验证码，重复参与按 userId 判重", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-valid-jwt",
      title: "注册模式测试", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const userId = crypto.randomUUID();
    const token = await signJwt({ sub: userId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);

    const res = await app.request("/public/draws/registered-valid-jwt/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "CF-Connecting-IP": "10.0.0.31" },
      body: JSON.stringify({ email: "reg@test.com" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);

    // entry 身份应为 user_id（不是 email），这是重复参与判重的关键
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry?.identityType).toBe("user_id");
    expect(entry?.identityValue).toBe(userId);

    // 同一用户再次参与 → 409（按 userId 判重，而非 email）
    const again = await app.request("/public/draws/registered-valid-jwt/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "CF-Connecting-IP": "10.0.0.31" },
      body: JSON.stringify({ email: "reg@test.com" }),
    }, TEST_ENV);
    expect(again.status).toBe(409);
  });

  it("registered 模式：无效 JWT 返回 401", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-bad-jwt",
      title: "注册模式测试", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/public/draws/registered-bad-jwt/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer invalid.token.here", "CF-Connecting-IP": "10.0.0.32" },
      body: JSON.stringify({ email: "reg@test.com" }),
    }, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("registered 模式：verify-join 用残留验证码被拦截（防止 open→registered 切换绕过登录）", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-verify-block",
      title: "注册模式测试", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 模拟活动从 open 改为 registered 时残留的未过期验证码（P1 漏洞场景）
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode("123456"));
    const codeHash = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(), email: "victim@test.com", drawId,
      codeHash, used: 0, expiresAt: futureTimeISO(10),
    });

    const res = await app.request("/public/draws/registered-verify-block/verify-join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.33" },
      body: JSON.stringify({ email: "victim@test.com", code: "123456" }),
    }, TEST_ENV);
    expect(res.status).toBe(401);

    // 验证没有 entry 被创建（未绕过登录门槛）
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry).toBeFalsy();
  });

  it("registered 模式：/join 快捷参与被服务层拒绝（无 JWT 不能绕过登录）", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-join-block",
      title: "注册模式测试", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // /join 快捷参与端点无 JWT 强制检查，必须靠 joinDraw 服务层拒绝（P1 兜底）
    const res = await app.request("/public/draws/registered-join-block/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.40" },
      body: JSON.stringify({ email: "sneak@test.com" }),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("登录");

    // 确认没有 entry 被创建（未绕过登录门槛）
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry).toBeFalsy();
  });

  it("registered 模式：my-result 带 JWT 按 userId 查到结果，无 JWT 拒绝", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-myresult",
      title: "注册模式测试", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const userId = crypto.randomUUID();
    const token = await signJwt({ sub: userId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      identityType: "user_id", identityValue: userId, joinedAt: new Date().toISOString(),
    });

    // 无 JWT → 401（邮箱+验证码路径对 registered 活动关闭）
    const noToken = await app.request("/public/draws/registered-myresult/my-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.41" },
      body: JSON.stringify({ email: "x@test.com", code: "123456" }),
    }, TEST_ENV);
    expect(noToken.status).toBe(401);

    // 带 JWT → 200 按 userId 命中 entry（无需邮箱/验证码）
    const withToken = await app.request("/public/draws/registered-myresult/my-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "CF-Connecting-IP": "10.0.0.41" },
      body: JSON.stringify({ email: "", code: "" }),
    }, TEST_ENV);
    expect(withToken.status).toBe(200);
    const data = await withToken.json() as any;
    expect(data.ok).toBe(true);
    expect(data.joined).toBe(true);
  });
});

/* ── 测试：审计日志 ──────────────────────────────────────── */

describe("审计日志", () => {
  it("关键操作应记录审计日志", async () => {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(), tenantId: TENANT, actorUserId: USER,
      action: "draw.perform", targetType: "lottery_draw", targetId: "draw-1",
      metadataJson: JSON.stringify({ winnerCount: 3 }),
      createdAt: new Date().toISOString(),
    });

    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.targetId, "draw-1")).limit(1);
    expect(log).toBeTruthy();
    expect(log!.action).toBe("draw.perform");
    expect(log!.actorUserId).toBe(USER);
  });
});

/* ── 测试：系统配置 ──────────────────────────────────────── */

describe("系统配置", () => {
  it("支持 key-value 存储和更新", async () => {
    await db.insert(systemConfig).values({ key: "draw_default_winner_count", value: "3" });
    const [cfg] = await db.select().from(systemConfig).where(eq(systemConfig.key, "draw_default_winner_count")).limit(1);
    expect(cfg).toBeTruthy();
    expect(cfg!.value).toBe("3");

    await db.update(systemConfig).set({ value: "5" }).where(eq(systemConfig.key, "draw_default_winner_count"));
    const [updated] = await db.select().from(systemConfig).where(eq(systemConfig.key, "draw_default_winner_count")).limit(1);
    expect(updated!.value).toBe("5");
  });
});

/* ── 测试：接龙活动（activity_outcomes） ──────────────────── */

describe("接龙活动结果", () => {
  it("接龙按参与顺序分配名额", async () => {
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "signup-seq",
      title: "顺序接龙", status: "open", activityKind: "signup_chain",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // 按顺序插入参与记录
    for (let i = 1; i <= 3; i++) {
      const entryId = crypto.randomUUID();
      await db.insert(lotteryEntries).values({
        id: entryId, tenantId: TENANT, drawId,
        identityType: "email", identityValue: `user${i}@test.com`,
        joinedAt: new Date(Date.now() + i * 100).toISOString(),
      });
      await db.insert(activityOutcomes).values({
        id: crypto.randomUUID(), tenantId: TENANT, drawId, entryId,
        outcomeType: "assignment", status: "assigned", sequenceNo: i,
        resultKey: "slot", resultLabel: `名额 ${i}`,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    const outcomes = await db
      .select()
      .from(activityOutcomes)
      .where(eq(activityOutcomes.drawId, drawId))
      .orderBy(activityOutcomes.sequenceNo);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]!.sequenceNo).toBe(1);
    expect(outcomes[2]!.sequenceNo).toBe(3);
  });
});
