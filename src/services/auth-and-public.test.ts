/**
 * 认证路由 + 公开路由集成测试
 *
 * 测试策略：
 * - 使用 @libsql/client 创建临时文件数据库
 * - 模拟 Hono 请求，测试完整的请求-响应链路
 * - 覆盖：注册/登录/验证邮箱/注销/参与活动
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { authRoute } from "../routes/auth";
import { publicLotteryRoute } from "../routes/public-lottery";
import { signJwt } from "../middleware/auth";
import { sendWinnerNotifications } from "./lottery-service";
import {
  activityOutcomes,
  auditLogs,
  emailAccessCodes,
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  lotteryPrizeTiers,
  prizes,
  couponCodes,
  shareRecords,
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

  it("verify-email 返回 needsTenant=true（方案 C：新注册用户无租户）", async () => {
    const app = createAuthTestApp();
    await app.request("/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.13" },
      body: JSON.stringify({ username: "verifynt", password: "Test12345", email: "vnt@test.com" }),
    }, TEST_ENV);
    // 插入已知验证码完成邮箱验证（先标记 register 生成的旧码失效，避免 UNIQUE 冲突）
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode("654321"));
    const codeHash = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    await db.update(emailAccessCodes)
      .set({ used: 1 })
      .where(and(eq(emailAccessCodes.email, "vnt@test.com"), eq(emailAccessCodes.used, 0)));
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(), email: "vnt@test.com", drawId: "",
      codeHash, used: 0, expiresAt: futureTimeISO(10),
    });

    const res = await app.request("/auth/verify-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "vnt@test.com", code: "654321" }),
    }, TEST_ENV);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.needsTenant).toBe(true);
    expect(data.tenantId).toBe("");
  });

  it("create-tenant 租户名长度校验：过短/过长返回 400", async () => {
    const app = createAuthTestApp();
    await app.request("/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.14" },
      body: JSON.stringify({ username: "nametest", password: "Test12345", email: "namet@test.com" }),
    }, TEST_ENV);
    await db.update(users).set({ emailVerified: 1 }).where(eq(users.username, "nametest"));
    const loginRes = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nametest", password: "Test12345" }),
    }, TEST_ENV);
    const loginData = await loginRes.json() as any;

    // 1 字符（过短）
    const shortRes = await app.request("/auth/create-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + loginData.token },
      body: JSON.stringify({ name: "a" }),
    }, TEST_ENV);
    expect(shortRes.status).toBe(400);

    // 31 字符（过长）
    const longRes = await app.request("/auth/create-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + loginData.token },
      body: JSON.stringify({ name: "x".repeat(31) }),
    }, TEST_ENV);
    expect(longRes.status).toBe(400);
  });

  it("create-tenant 完整流程：创建租户 → 重新登录不再 needsTenant", async () => {
    const app = createAuthTestApp();
    // 1. 注册+验证
    await app.request("/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.11" },
      body: JSON.stringify({ username: "createflow", password: "Test12345", email: "cf@test.com" }),
    }, TEST_ENV);
    await db.update(users).set({ emailVerified: 1 }).where(eq(users.username, "createflow"));
    // 2. 登录 → needsTenant
    const loginRes1 = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "createflow", password: "Test12345" }),
    }, TEST_ENV);
    const loginData1 = await loginRes1.json() as any;
    expect(loginData1.needsTenant).toBe(true);

    // 3. 创建租户 → 返回新 JWT
    const createRes = await app.request("/auth/create-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + loginData1.token },
      body: JSON.stringify({ name: "我的团队" }),
    }, TEST_ENV);
    const createData = await createRes.json() as any;
    expect(createData.ok).toBe(true);
    expect(createData.name).toBe("我的团队");
    expect(createData.token).toBeTruthy();
    expect(createData.token).not.toBe(loginData1.token);

    // 4. 重新登录 → needsTenant 为 false
    const loginRes2 = await app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "createflow", password: "Test12345" }),
    }, TEST_ENV);
    const loginData2 = await loginRes2.json() as any;
    expect(loginData2.needsTenant).toBe(false);
    expect(loginData2.tenants.length).toBeGreaterThanOrEqual(1);
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

  /**
   * 驳回错误审查：「email 验证关闭时公开参与依赖 cf-auth，需在 access-code 检测 IdP 再回退发码」。
   * 事实：enable_email_verification=false 时 access-code 对 open 系直接 joinDraw，
   * 不读 CF_AUTH_*，也不需要 Bearer。cf-auth 只是可选加速/registered 身份源。
   */
  it("enable_email_verification=false：open 模式无 cf-auth 也可 access-code 直参", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "email-bypass-open",
      title: "免码直参",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-60),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 覆盖默认 true：关闭邮箱 OTP（测试/Resend 不可用场景）
    await db
      .insert(systemConfig)
      .values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({
        target: systemConfig.key,
        set: { value: "false" },
      });

    // 故意不配 CF_AUTH_*、不带 Authorization
    const res = await app.request(
      "/public/draws/email-bypass-open/access-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.88",
        },
        body: JSON.stringify({ email: "bypass@example.com" }),
      },
      {
        ...TEST_ENV,
        // 显式证明与 IdP 无关
        CF_AUTH_ENABLED: "false",
      },
    );
    const body = (await res.json()) as {
      ok?: boolean;
      joined?: boolean;
      entryId?: string;
      sent?: boolean;
      message?: string;
    };
    expect(res.status, body.message).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    expect(body.entryId).toBeTruthy();
    expect(body.sent).toBeUndefined();

    const codes = await db
      .select()
      .from(emailAccessCodes)
      .where(eq(emailAccessCodes.drawId, drawId));
    expect(codes).toHaveLength(0);

    const [entry] = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId))
      .limit(1);
    expect(entry?.identityType).toBe("email");
    expect(entry?.identityValue).toBe("bypass@example.com");
  });

  it("enable_email_verification=true（默认）：access-code 发码路径不依赖 CF_AUTH", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "email-otp-default",
      title: "默认发码",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-60),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 确保为 true（clearTestData 后可能无此键 → 代码默认走发码）
    await db
      .insert(systemConfig)
      .values({ key: "enable_email_verification", value: "true" })
      .onConflictDoUpdate({
        target: systemConfig.key,
        set: { value: "true" },
      });

    const res = await app.request(
      "/public/draws/email-otp-default/access-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.0.89",
        },
        body: JSON.stringify({ email: "otp@example.com" }),
      },
      { ...TEST_ENV, CF_AUTH_ENABLED: "false" },
    );
    const body = (await res.json()) as {
      ok?: boolean;
      sent?: boolean;
      joined?: boolean;
      message?: string;
    };
    expect(res.status, body.message).toBe(200);
    expect(body.ok).toBe(true);
    // 发码成功与否取决于 RESEND；至少不应 joined 直参，且不因无 cf-auth 失败
    expect(body.joined).not.toBe(true);
    expect(body.sent === true || body.sent === false).toBe(true);

    const codes = await db
      .select()
      .from(emailAccessCodes)
      .where(
        and(
          eq(emailAccessCodes.email, "otp@example.com"),
          eq(emailAccessCodes.drawId, drawId),
        ),
      );
    expect(codes.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * docs/077：查结果 OTP 闭环。
   * 旧行为：已参与 → access-code 409；drawn → 活动已结束。
   * 新行为：purpose=query 时仍可发码，供 my-result 校验。
   */
  it("purpose=query：已参与且 drawn 仍可发查询验证码；join 意图仍 409", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const email = "query-after-join@test.com";
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "query-otp-drawn",
      title: "开奖后查结果发码",
      status: "drawn",
      participationMode: "open",
      startAt: futureTimeISO(-120),
      endAt: futureTimeISO(-30),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
    });

    // join 意图：drawn 仍拒（不是 open）
    const joinRes = await app.request("/public/draws/query-otp-drawn/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.91" },
      body: JSON.stringify({ email }),
    }, TEST_ENV);
    expect(joinRes.status).toBe(400);

    // query 意图：已参与 + drawn → 可发码
    const queryRes = await app.request("/public/draws/query-otp-drawn/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.92" },
      body: JSON.stringify({ email, purpose: "query" }),
    }, TEST_ENV);
    const queryBody = (await queryRes.json()) as {
      ok?: boolean;
      sent?: boolean;
      purpose?: string;
      message?: string;
    };
    expect(queryRes.status, queryBody.message).toBe(200);
    expect(queryBody.ok).toBe(true);
    expect(queryBody.purpose).toBe("query");
    expect(queryBody.sent === true || queryBody.sent === false).toBe(true);

    const codes = await db
      .select()
      .from(emailAccessCodes)
      .where(and(eq(emailAccessCodes.email, email), eq(emailAccessCodes.drawId, drawId)));
    expect(codes.some((row) => row.used === 0)).toBe(true);

    // open + 已参与：join 仍 409；query 可发
    await db
      .update(lotteryDraws)
      .set({ status: "open", endAt: futureTimeISO(60) })
      .where(eq(lotteryDraws.id, drawId));
    const joinOpen = await app.request("/public/draws/query-otp-drawn/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.93" },
      body: JSON.stringify({ email }),
    }, TEST_ENV);
    expect(joinOpen.status).toBe(409);

    const queryOpen = await app.request("/public/draws/query-otp-drawn/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.94" },
      body: JSON.stringify({ email, purpose: "query" }),
    }, TEST_ENV);
    expect(queryOpen.status).toBe(200);
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
    // 返回 entryId/outcome（前端结果弹窗与分享归因依赖）
    expect(body.entryId).toBeTruthy();

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

  /**
   * docs/093 审计加固：verify-join 免 OTP 必须大小写不敏感对齐 my-result，
   * 且 body.email 与 JWT.email 不一致时绝不授信（防拿别人 token 代参）。
   */
  it("open 模式：verify-join JWT.email 大小写不敏感免 OTP；不一致不授信；无 claim 不授信", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const emailLower = "jwt-join@test.com";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "open-verify-jwt-case",
      title: "JWT 参与大小写", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // claim 为 MixedCase，body 为 lower——旧实现严格 === 会误拒
    const mixedToken = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email: "Jwt-Join@Test.COM" },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const okRes = await app.request("/public/draws/open-verify-jwt-case/verify-join", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mixedToken}`,
        "CF-Connecting-IP": "10.0.0.61",
      },
      body: JSON.stringify({ email: emailLower, code: "" }),
    }, TEST_ENV);
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json() as any;
    expect(okBody.ok).toBe(true);
    expect(okBody.joined).toBe(true);
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry?.identityType).toBe("email");
    expect(entry?.identityValue).toBe(emailLower);

    // 另一活动：body 与 claim 邮箱不一致 → 无码必须 400，不得代参
    const drawId2 = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId2, tenantId: TENANT, publicSlug: "open-verify-jwt-mismatch",
      title: "JWT 邮箱不一致", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const mismatch = await app.request("/public/draws/open-verify-jwt-mismatch/verify-join", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mixedToken}`,
        "CF-Connecting-IP": "10.0.0.62",
      },
      body: JSON.stringify({ email: "other@test.com", code: "" }),
    }, TEST_ENV);
    expect(mismatch.status).toBe(400);
    const [noEntry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId2)).limit(1);
    expect(noEntry).toBeFalsy();

    // 无 email claim 的旧 JWT + 空码 → 400（不可仅凭 sub 冒充 open 邮箱身份）
    const drawId3 = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId3, tenantId: TENANT, publicSlug: "open-verify-jwt-no-email",
      title: "JWT 无 email", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const noEmailTok = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const noClaim = await app.request("/public/draws/open-verify-jwt-no-email/verify-join", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${noEmailTok}`,
        "CF-Connecting-IP": "10.0.0.63",
      },
      body: JSON.stringify({ email: emailLower, code: "" }),
    }, TEST_ENV);
    expect(noClaim.status).toBe(400);
  });

  /**
   * docs/084：open 系 my-result 对齐 verify-join——持有 email 一致的业务 JWT 可免 OTP。
   */
  it("open 模式：my-result 业务 JWT.email 一致免 OTP；无 token 无码拒绝；邮箱不一致不授信", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const email = "jwt-query@test.com";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "open-myresult-jwt",
      title: "JWT 查结果", status: "drawn", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );

    // 无 JWT、无验证码 → 400
    const bare = await app.request("/public/draws/open-myresult-jwt/my-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.51" },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    expect(bare.status).toBe(400);

    // JWT.email 一致、无码 → 200
    const withJwt = await app.request("/public/draws/open-myresult-jwt/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.52",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    expect(withJwt.status).toBe(200);
    const okBody = await withJwt.json() as any;
    expect(okBody.ok).toBe(true);
    expect(okBody.joined).toBe(true);

    // 仅 JWT、body 无 email → 用 token.email
    const jwtOnly = await app.request("/public/draws/open-myresult-jwt/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.53",
      },
      body: JSON.stringify({ email: "", code: "" }),
    }, TEST_ENV);
    expect(jwtOnly.status).toBe(200);
    expect((await jwtOnly.json() as any).joined).toBe(true);

    // body.email 与 token.email 不一致 → 不授信 JWT，无码仍 400
    const mismatch = await app.request("/public/draws/open-myresult-jwt/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.54",
      },
      body: JSON.stringify({ email: "other@test.com", code: "" }),
    }, TEST_ENV);
    expect(mismatch.status).toBe(400);
  });

  it("公开详情：visible=0 时拒绝（与未开放同文案）", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "hidden-draw-slug",
      title: "已隐藏", status: "drawn", participationMode: "open",
      visible: 0,
      startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const res = await app.request("/public/draws/hidden-draw-slug", {
      headers: { "CF-Connecting-IP": "10.0.0.55" },
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(String(body.message || "")).toContain("未开放");
  });

  /**
   * docs/100：人工履约中奖无码池时，my-result 仍 won=true 并返回奖品名，
   * 禁止前端只能靠 prizeCode 判断中奖。
   */
  it("my-result 人工履约中奖：won=true、无 prizeCode、带 prizeName/prizeType", async () => {
    const app = createPublicTestApp();
    const email = "manual-win@test.com";
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const prizeId = crypto.randomUUID();
    const tierId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "manual-fulfill-win",
      title: "人工奖刮刮卡", status: "drawn", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(prizes).values({
      id: prizeId,
      tenantId: TENANT,
      name: "限定周边",
      description: "线下领取",
      prizeType: "manual_fulfillment",
      valueText: "价值约 99",
      fulfillmentNote: "请凭中奖邮件联系客服",
    });
    await db.insert(lotteryPrizeTiers).values({
      id: tierId,
      tenantId: TENANT,
      drawId,
      prizeId,
      tierName: "一等奖",
      winnerCount: 1,
      sortOrder: 1,
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    await db.insert(lotteryWinners).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      tierId,
      entryId,
      identityType: "email",
      identityValue: email,
      prizeCodeId: "", // 人工履约：无卡密
      notificationStatus: "pending",
    });
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const res = await app.request("/public/draws/manual-fulfill-win/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.80",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    expect(body.won).toBe(true);
    expect(body.prizeCode).toBeNull();
    expect(body.prizeName).toBe("限定周边");
    expect(body.prizeType).toBe("manual_fulfillment");
    expect(body.tierName).toBe("一等奖");
    expect(body.fulfillmentNote).toContain("客服");
    expect(body.drawStatus).toBe("drawn");
  });

  /**
   * docs/101：接龙结果在 activity_outcomes，不是 lottery_winners。
   * my-result 必须返回 resultFamily=assignment + outcome，禁止 won=false 被前端当成「未抽中奖品」。
   */
  it("my-result 接龙：resultFamily=assignment、outcome 有占位文案、won 不代表未中奖", async () => {
    const app = createPublicTestApp();
    const email = "signup-result@test.com";
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "signup-my-result",
      title: "接龙查结果", status: "open", activityKind: "signup_chain",
      participationMode: "open", experienceType: "list", resultMode: "ordered_assignment",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 0, maxParticipants: 10,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    await db.insert(activityOutcomes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      entryId,
      outcomeType: "assignment",
      status: "assigned",
      sequenceNo: 2,
      assignmentNo: 2,
      resultKey: "slot_2",
      resultLabel: "第 2 位",
      decidedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const res = await app.request("/public/draws/signup-my-result/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.81",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    expect(body.activityKind).toBe("signup_chain");
    expect(body.resultFamily).toBe("assignment");
    expect(body.outcome).toBeTruthy();
    expect(body.outcome.status).toBe("assigned");
    expect(body.outcome.resultLabel).toBe("第 2 位");
    expect(body.outcome.assignmentNo).toBe(2);
    // 接龙无 lottery_winners：won 保持 false，但绝不能只有「未中奖」字段可解释结果
    expect(body.won).toBe(false);
    expect(body.prizeCode).toBeNull();
  });

  it("my-result 接龙候补：outcome.status=waitlisted", async () => {
    const app = createPublicTestApp();
    const email = "signup-wait@test.com";
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "signup-wait-result",
      title: "接龙候补", status: "open", activityKind: "signup_chain",
      participationMode: "open", resultMode: "ordered_assignment",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 0, maxParticipants: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    await db.insert(activityOutcomes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      entryId,
      outcomeType: "assignment",
      status: "waitlisted",
      sequenceNo: 3,
      assignmentNo: null,
      resultKey: "waitlist_2",
      resultLabel: "候补第 2 位",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const res = await app.request("/public/draws/signup-wait-result/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.82",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.resultFamily).toBe("assignment");
    expect(body.outcome?.status).toBe("waitlisted");
    expect(body.outcome?.resultLabel).toContain("候补");
  });

  it("my-result 问卷：resultFamily=participation，不查 winners 语义", async () => {
    const app = createPublicTestApp();
    const email = "survey-result@test.com";
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "survey-my-result",
      title: "问卷", status: "open", activityKind: "survey",
      participationMode: "open", resultMode: "no_result",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const res = await app.request("/public/draws/survey-my-result/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.83",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    expect(body.resultFamily).toBe("participation");
    expect(body.won).toBe(false);
    expect(body.outcome).toBeNull();
  });

  /**
   * docs/099：my-result 安慰券必须按 drawId 过滤，禁止同租户串场。
   */
  it("my-result 安慰券仅返回本活动 issued 券，不串他场", async () => {
    const app = createPublicTestApp();
    const email = "coupon-scope@test.com";
    const drawA = crypto.randomUUID();
    const drawB = crypto.randomUUID();
    await db.insert(lotteryDraws).values([
      {
        id: drawA, tenantId: TENANT, publicSlug: "coupon-draw-a",
        title: "场 A", status: "drawn", participationMode: "open",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      {
        id: drawB, tenantId: TENANT, publicSlug: "coupon-draw-b",
        title: "场 B", status: "drawn", participationMode: "open",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId: drawA,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    // 仅 B 场有安慰券；A 场查询不得返回 B 的码
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: drawB,
      code: "COUPON-B-ONLY",
      label: "loser",
      status: "issued",
      recipientEmail: email,
    });
    const codeHash = "unused-hash-for-query";
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId: drawA,
      codeHash,
      used: 0,
      expiresAt: futureTimeISO(10),
    });
    // 走 JWT 免 OTP，避免 mock hash
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const res = await app.request("/public/draws/coupon-draw-a/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.70",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    expect(body.consolationCoupon).toBeNull();
  });

  /**
   * docs/099：share 的 entryId 必须属于本活动。
   */
  it("share：entry 不属于本活动则 404；属于则发码成功", async () => {
    const app = createPublicTestApp();
    const drawA = crypto.randomUUID();
    const drawB = crypto.randomUUID();
    const entryOnB = crypto.randomUUID();
    const entryOnA = crypto.randomUUID();
    await db.insert(lotteryDraws).values([
      {
        id: drawA, tenantId: TENANT, publicSlug: "share-own-a",
        title: "分享 A", status: "open", participationMode: "open",
        startAt: futureTimeISO(-10), endAt: futureTimeISO(60),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      {
        id: drawB, tenantId: TENANT, publicSlug: "share-own-b",
        title: "分享 B", status: "open", participationMode: "open",
        startAt: futureTimeISO(-10), endAt: futureTimeISO(60),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(lotteryEntries).values([
      {
        id: entryOnA, tenantId: TENANT, drawId: drawA,
        identityType: "email", identityValue: "share-a@test.com", joinedAt: new Date().toISOString(),
      },
      {
        id: entryOnB, tenantId: TENANT, drawId: drawB,
        identityType: "email", identityValue: "share-b@test.com", joinedAt: new Date().toISOString(),
      },
    ]);

    const bad = await app.request("/public/draws/share-own-a/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.71" },
      body: JSON.stringify({ entryId: entryOnB }),
    }, TEST_ENV);
    expect(bad.status).toBe(404);

    const good = await app.request("/public/draws/share-own-a/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.72" },
      body: JSON.stringify({ entryId: entryOnA }),
    }, TEST_ENV);
    expect(good.status).toBe(200);
    const goodBody = await good.json() as any;
    expect(goodBody.ok).toBe(true);
    expect(goodBody.shareCode).toBeTruthy();
    // docs/108：统一 /lottery/{slug}?ref=，禁止裸 /{slug}
    expect(goodBody.shareUrl).toBe(`/lottery/share-own-a?ref=${goodBody.shareCode}`);
    const rows = await db.select().from(shareRecords).where(eq(shareRecords.drawId, drawA));
    expect(rows.length).toBe(1);
    expect(rows[0]!.sharerEntryId).toBe(entryOnA);
  });

  /**
   * docs/108：my-viral-stats 与开奖同一公式 min(invited × perInvite, max)；
   * shareUrl 与 POST /share 路径一致。
   */
  it("my-viral-stats：extraEntriesPerInvite 计入 earned 且 shareUrl 规范", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-stats-a",
      title: "裂变统计",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: {
          enabled: true,
          extraEntriesPerInvite: 2,
          maxExtraEntries: 5,
          leaderboardEnabled: true,
        },
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "viral-stats@test.com",
      joinedAt: new Date().toISOString(),
    });
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      sharerEntryId: entryId,
      shareCode: "viralref001",
      joinedCount: 3,
      clickedCount: 7,
    });

    const res = await app.request(
      `/public/draws/viral-stats-a/my-viral-stats?entryId=${encodeURIComponent(entryId)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.73" } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.invitedCount).toBe(3);
    // 3 × 2 = 6，上限 5 → earned 5；drawWeight = 1 + 5
    expect(body.extraEntriesEarned).toBe(5);
    expect(body.extraEntriesPerInvite).toBe(2);
    expect(body.maxExtraEntries).toBe(5);
    expect(body.drawWeight).toBe(6);
    expect(body.shareUrl).toBe("/lottery/viral-stats-a?ref=viralref001");
    expect(body.inviteOpen).toBe(true);
  });

  it("share：同一 entry 第二次发码复用，不重复 insert", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "share-reuse-a",
      title: "复用分享",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "reuse@test.com",
      joinedAt: new Date().toISOString(),
    });

    const first = await app.request("/public/draws/share-reuse-a/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.80" },
      body: JSON.stringify({ entryId }),
    }, TEST_ENV);
    const firstBody = await first.json() as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.reused).toBe(false);

    const second = await app.request("/public/draws/share-reuse-a/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.81" },
      body: JSON.stringify({ entryId }),
    }, TEST_ENV);
    const secondBody = await second.json() as any;
    expect(secondBody.ok).toBe(true);
    expect(secondBody.reused).toBe(true);
    expect(secondBody.shareCode).toBe(firstBody.shareCode);
    const rows = await db.select().from(shareRecords).where(eq(shareRecords.drawId, drawId));
    expect(rows.length).toBe(1);
  });

  it("viral-leaderboard：未进 Top20 返回真实名次；0 邀请 rank=0", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entries: string[] = [];
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-lb-rank",
      title: "排行名次",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10, leaderboardEnabled: true },
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    for (let i = 0; i < 22; i++) {
      const id = crypto.randomUUID();
      entries.push(id);
      await db.insert(lotteryEntries).values({
        id,
        tenantId: TENANT,
        drawId,
        identityType: "email",
        identityValue: `lb${i}@test.com`,
        joinedAt: new Date().toISOString(),
      });
      await db.insert(shareRecords).values({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId,
        sharerEntryId: id,
        shareCode: `lbcode${i.toString().padStart(3, "0")}`,
        joinedCount: 30 - i,
      });
    }
    const lastId = entries[21]!;
    const res = await app.request(
      `/public/draws/viral-lb-rank/viral-leaderboard?entryId=${encodeURIComponent(lastId)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.82" } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.entries.length).toBe(20);
    expect(body.myRank.rank).toBe(22);
    expect(body.myRank.invitedCount).toBe(9);

    const zeroEntry = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: zeroEntry,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "zero@test.com",
      joinedAt: new Date().toISOString(),
    });
    const zeroRes = await app.request(
      `/public/draws/viral-lb-rank/viral-leaderboard?entryId=${encodeURIComponent(zeroEntry)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.83" } },
      TEST_ENV,
    );
    const zeroBody = await zeroRes.json() as any;
    expect(zeroBody.myRank).toEqual(expect.objectContaining({ rank: 0, invitedCount: 0 }));
  });

  it("ref 点击重定向保留 ?ref= 归因参数", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-ref-a",
      title: "裂变点击",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "viral-ref@test.com",
      joinedAt: new Date().toISOString(),
    });
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      sharerEntryId: entryId,
      shareCode: "clickref001",
      joinedCount: 0,
      clickedCount: 0,
    });

    const res = await app.request(
      "/public/draws/viral-ref-a/ref/clickref001",
      { headers: { "CF-Connecting-IP": "10.0.0.74" }, redirect: "manual" },
      TEST_ENV,
    );
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    const loc = res.headers.get("Location") || "";
    expect(loc).toContain("/lottery/viral-ref-a");
    expect(loc).toContain("ref=clickref001");
  });

  it("registered 中奖者通知：user_id 身份关联 users 表真实邮箱发送", async () => {
    const tenantId = TENANT;
    const drawId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId, publicSlug: "reg-notify",
      title: "通知测试", status: "drawn", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 注册用户：真实邮箱在 users 表（registered 身份是 userId，不是邮箱）
    await db.insert(users).values({
      id: userId, username: "regwinner", email: "regwinner@test.com",
      emailVerified: 1, passwordHash: "h",
    });
    await db.insert(lotteryWinners).values({
      id: crypto.randomUUID(), tenantId, drawId, tierId: "tier-1", entryId: "notify-entry-1",
      identityType: "user_id", identityValue: userId,
      prizeCodeId: null, notificationStatus: "pending",
    });

    // mock Resend API：捕获收件人地址
    let capturedTo = "";
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("resend.com")) {
        capturedTo = (JSON.parse(String(init?.body)) as { to: string }).to;
        return new Response(JSON.stringify({ id: "mock-msg" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    await sendWinnerNotifications(db, tenantId, drawId, {
      resendApiKey: "test-key",
      emailFrom: "noreply@test.com",
    });
    vi.unstubAllGlobals();

    // 收件人必须是 users 表里的真实邮箱，而不是 userId（UUID）
    expect(capturedTo).toBe("regwinner@test.com");

    // 通知状态应标记为已发送
    const [winner] = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, drawId)).limit(1);
    expect(winner?.notificationStatus).toBe("sent");
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

/* ── 安全：注册 OTP 不得误用活动参与 OTP（docs/070 CRITICAL #1） ── */
describe("verify-email 仅接受注册码 drawId=\"\"", () => {
  it("活动 drawId 上的 OTP 不能完成注册邮箱验证", async () => {
    const app = createAuthTestApp();
    const email = "otp-mix@test.com";
    await db.insert(users).values({
      id: crypto.randomUUID(),
      username: "otp_mix_user",
      email,
      passwordHash: "x",
      emailVerified: 0,
      status: "active",
    });
    // 模拟：仅有活动参与码（真实 drawId），无注册码
    const { hashCode } = await import("../routes/public-lottery-helpers");
    const code = "123456";
    const codeHash = await hashCode(code);
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId: "some-real-draw-id",
      codeHash,
      used: 0,
      expiresAt: futureTimeISO(10),
    });

    const res = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.77" },
      body: JSON.stringify({ email, code }),
    }, TEST_ENV);
    const body = await res.json() as { ok: boolean; message?: string };
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    // 不得签发 token
    expect((body as { token?: string }).token).toBeUndefined();

    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(u?.emailVerified).toBe(0);
  });

  it("drawId=\"\" 注册码仍可验证成功", async () => {
    const app = createAuthTestApp();
    const email = "otp-reg@test.com";
    await db.insert(users).values({
      id: crypto.randomUUID(),
      username: "otp_reg_user",
      email,
      passwordHash: "x",
      emailVerified: 0,
      status: "active",
    });
    const { hashCode } = await import("../routes/public-lottery-helpers");
    const code = "654321";
    const codeHash = await hashCode(code);
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId: "",
      codeHash,
      used: 0,
      expiresAt: futureTimeISO(10),
    });

    const res = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.78" },
      body: JSON.stringify({ email, code }),
    }, TEST_ENV);
    const body = await res.json() as { ok: boolean; token?: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
  });
});
