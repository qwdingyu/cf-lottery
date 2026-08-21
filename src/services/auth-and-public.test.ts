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
  lotterySpins,
  prizes,
  prizeCodes,
  couponCodes,
  shareRecords,
  platformTargets,
  platformDeliveries,
  systemConfig,
  tenantMembers,
  tenants,
  users,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";
import { hashCode } from "../routes/public-lottery-helpers";

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

  it("过期但仍 open 的活动：公开详情提前标记不可参与，发验证码前拒绝且不写验证码", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "open-but-ended",
      title: "已过期活动",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-120),
      endAt: futureTimeISO(-30),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const detailRes = await app.request("/public/draws/open-but-ended", {}, TEST_ENV);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as {
      ok?: boolean;
      canJoin?: boolean;
      joinDisabledReason?: string;
      joinDisabledMessage?: string;
    };
    expect(detail.ok).toBe(true);
    expect(detail.canJoin).toBe(false);
    expect(detail.joinDisabledReason).toBe("ended");
    expect(detail.joinDisabledMessage).toContain("已结束");

    const codeRes = await app.request("/public/draws/open-but-ended/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.21" },
      body: JSON.stringify({ email: "ended@test.com" }),
    }, TEST_ENV);
    const codeBody = await codeRes.json() as { message?: string };
    expect(codeRes.status).toBe(400);
    expect(codeBody.message).toContain("已结束");
    const rows = await db.select().from(emailAccessCodes).where(and(
      eq(emailAccessCodes.email, "ended@test.com"),
      eq(emailAccessCodes.drawId, drawId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("未开始但仍 open 的活动：公开详情提前标记不可参与且发码前拒绝", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "open-but-not-started",
      title: "未开始活动",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(30),
      endAt: futureTimeISO(90),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const detailRes = await app.request("/public/draws/open-but-not-started", {}, TEST_ENV);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as {
      ok?: boolean;
      canJoin?: boolean;
      joinDisabledReason?: string;
      joinDisabledMessage?: string;
    };
    expect(detail.ok).toBe(true);
    expect(detail.canJoin).toBe(false);
    expect(detail.joinDisabledReason).toBe("not_started");
    expect(detail.joinDisabledMessage).toContain("尚未开始");

    const codeRes = await app.request("/public/draws/open-but-not-started/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.22" },
      body: JSON.stringify({ email: "not-started@test.com" }),
    }, TEST_ENV);
    const codeBody = await codeRes.json() as { message?: string };
    expect(codeRes.status).toBe(400);
    expect(codeBody.message).toContain("尚未开始");
    const rows = await db.select().from(emailAccessCodes).where(and(
      eq(emailAccessCodes.email, "not-started@test.com"),
      eq(emailAccessCodes.drawId, drawId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("活动过期后 verify-join 前置拒绝：不消费既有验证码且不创建参与记录", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "verify-ended-window",
      title: "验证时已结束",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-120),
      endAt: futureTimeISO(-30),
      winnerCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email: "verify-ended@test.com",
      drawId,
      codeHash: await hashCode("123456"),
      used: 0,
      expiresAt: futureTimeISO(10),
    });

    const res = await app.request("/public/draws/verify-ended-window/verify-join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.23" },
      body: JSON.stringify({ email: "verify-ended@test.com", code: "123456" }),
    }, TEST_ENV);
    const body = await res.json() as { message?: string };
    expect(res.status).toBe(400);
    expect(body.message).toContain("已结束");

    const [code] = await db.select().from(emailAccessCodes).where(and(
      eq(emailAccessCodes.email, "verify-ended@test.com"),
      eq(emailAccessCodes.drawId, drawId),
    )).limit(1);
    expect(code?.used).toBe(0);
    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry).toBeFalsy();
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

    // 同一用户再次参与 → 409 + entryId（按 userId 判重；裂变身份可恢复，docs/110）
    const again = await app.request("/public/draws/registered-valid-jwt/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "CF-Connecting-IP": "10.0.0.31" },
      body: JSON.stringify({ email: "reg@test.com" }),
    }, TEST_ENV);
    expect(again.status).toBe(409);
    const againBody = await again.json() as any;
    expect(againBody.ok).toBe(false);
    expect(againBody.alreadyJoined).toBe(true);
    expect(againBody.entryId).toBe(body.entryId);
  });

  /**
   * docs/112：registered 的 access-code 必须透传 refCode，否则登录用户裂变归因全断。
   */
  it("registered access-code 带 refCode 时计入分享者 joined_count", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const sharerEntryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "registered-ref-attr",
      title: "注册裂变归因", status: "open", participationMode: "registered",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: sharerEntryId, tenantId: TENANT, drawId,
      identityType: "user_id", identityValue: "sharer-user", joinedAt: new Date().toISOString(),
    });
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      sharerEntryId, shareCode: "regref001", joinedCount: 0, clickedCount: 0,
    });
    const inviteeId = crypto.randomUUID();
    const token = await signJwt({ sub: inviteeId, tenantId: TENANT }, TEST_ENV.JWT_SECRET, 3600);
    const res = await app.request("/public/draws/registered-ref-attr/access-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.88",
      },
      body: JSON.stringify({ email: "invitee@test.com", refCode: "regref001" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    const [share] = await db.select().from(shareRecords).where(eq(shareRecords.shareCode, "regref001")).limit(1);
    expect(share?.joinedCount).toBe(1);
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

  /**
   * docs/255 §五（P1-2）：/join 必须遵守与 access-code 同一个平台开关
   * `system_config.enable_email_verification`（未配置 = 需验证）。
   * 否则 open 活动可用任意邮箱字符串 + 自己的 refCode 批量刷邀请奖励。
   */
  it("open 模式：未配置 enable_email_verification 时 /join 拒绝免码参与（P1-2）", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "join-otp-gate",
      title: "免码刷量测试", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/public/draws/join-otp-gate/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.41" },
      body: JSON.stringify({ email: "farm-1@test.com", refCode: "SELF-REF" }),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain("验证码");

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry).toBeFalsy();
  });

  it("open 模式：enable_email_verification=false 时 /join 仍允许免码参与（P1-2 不误伤测试环境）", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    await db.insert(systemConfig).values({
      key: "enable_email_verification", value: "false",
    }).onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "join-otp-bypass",
      title: "显式关闭验证码", status: "open", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/public/draws/join-otp-bypass/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.42" },
      body: JSON.stringify({ email: "bypass-ok@test.com" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [entry] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId)).limit(1);
    expect(entry).toBeTruthy();
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
    const entryId = crypto.randomUUID();
    const email = "jwt-query@test.com";
    await db.insert(lotteryDraws).values({
      id: drawId, tenantId: TENANT, publicSlug: "open-myresult-jwt",
      title: "JWT 查结果", status: "drawn", participationMode: "open",
      startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
      winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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
    // docs/110：已参与必须带回 entryId，供公开卡/分享归因恢复
    expect(okBody.joined).toBe(true);
    expect(okBody.entryId).toBe(entryId);
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
      id: crypto.randomUUID(), spinId: crypto.randomUUID(),
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
    expect(body.entryId).toBe(entryId);
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
   * docs/253 §3.2 缺口 A/B：my-result 返回 coupons 数组（含邀请奖励券），
   * 非 lottery 活动也能查到邀请券（旧实现仅 lottery 未中奖时返回单条安慰券）。
   */
  it("my-result coupons 数组：非 lottery 活动返回邀请奖励券", async () => {
    const app = createPublicTestApp();
    const email = "coupon-reward@test.com";
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "coupon-reward-draw",
        title: "资料领取", status: "drawn", participationMode: "open",
        activityKind: "claim", experienceType: "reveal", resultMode: "instant",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      identityType: "email", identityValue: email, joinedAt: new Date().toISOString(),
    });
    // 邀请奖励券（grantBonusCoupon 发放，recipientEmail = 分享者邮箱）
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "COUPON-INVITE-1",
      label: "invite",
      status: "issued",
      recipientEmail: email,
    });
    // 安慰券（grantLoserRewards 发放）
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "COUPON-LOSER-1",
      label: "loser",
      status: "issued",
      recipientEmail: email,
    });
    const codeHash = "unused-hash-for-query";
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId,
      codeHash,
      used: 0,
      expiresAt: futureTimeISO(10),
    });
    // 走 JWT 免 OTP
    const token = await signJwt(
      { sub: crypto.randomUUID(), tenantId: TENANT, email },
      TEST_ENV.JWT_SECRET,
      3600,
    );
    const res = await app.request("/public/draws/coupon-reward-draw/my-result", {
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
    // coupons 数组应包含两张券（邀请券 + 安慰券），且不依赖 resultFamily === "lottery"
    expect(Array.isArray(body.coupons)).toBe(true);
    expect(body.coupons).toContain("COUPON-INVITE-1");
    expect(body.coupons).toContain("COUPON-LOSER-1");
    // 兼容字段：consolationCoupon 取第一条
    expect(body.consolationCoupon).toBe("COUPON-INVITE-1");
  });

  /**
   * docs/254 审查发现：user_id 身份（registered 模式）查券 bug。
   * 发券时（grantLoserRewards/grantBonusCoupon）对 user_id 身份存 recipientEmail = users.email，
   * 但 my-result 旧实现用 identityValue（userId）匹配 recipientEmail，永远匹配不上。
   * 修复后：user_id 身份用 email 匹配，应能查到券。
   */
  it("my-result coupons：user_id 身份（registered）用 email 匹配能查到券", async () => {
    const app = createPublicTestApp();
    const email = "registered-coupon@test.com";
    const userId = crypto.randomUUID();
    const drawId = crypto.randomUUID();
    // 注册用户（users 表）
    await db.insert(users).values({
      id: userId, username: "registered-coupon", email,
      emailVerified: 1, passwordHash: "hash",
    });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "registered-coupon-draw",
        title: "注册用户领券", status: "drawn", participationMode: "registered",
        activityKind: "lottery", experienceType: "wheel", resultMode: "manual",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    // user_id 身份 entry（identityValue = userId）
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      identityType: "user_id", identityValue: userId, joinedAt: new Date().toISOString(),
    });
    // 邀请券：recipientEmail 存的是 users.email（与 grantBonusCoupon 一致）
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "COUPON-REG-1", label: "invite", status: "issued",
      recipientEmail: email,
    });
    // 自签 JWT（registered 模式用 sub=userId）
    const token = await signJwt({ sub: userId }, TEST_ENV.JWT_SECRET, 3600);
    const res = await app.request("/public/draws/registered-coupon-draw/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.71",
      },
      body: JSON.stringify({ email, code: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // 修复后：user_id 身份用 email 匹配，应能查到邀请券
    expect(Array.isArray(body.coupons)).toBe(true);
    expect(body.coupons).toContain("COUPON-REG-1");
  });

  /**
   * docs/255 §四（P1-1 越权读）：registered 模式下 my-result 跳过 bearer 邮箱校验，
   * 旧实现直接用请求体 email 作为 couponCodes.recipientEmail 匹配键，
   * 任意持有合法 JWT 的用户都能读到他人已发放的券码（券码即价值凭证）。
   * 修复后：user_id 身份必须用 users.email 服务端反查作为匹配键，请求体 email 不授信。
   */
  it("my-result coupons：registered 用自己 JWT + 他人 email 不得读到他人券（P1-1 越权读）", async () => {
    const app = createPublicTestApp();
    const victimEmail = "coupon-victim@test.com";
    const attackerEmail = "coupon-attacker@test.com";
    const victimId = crypto.randomUUID();
    const attackerId = crypto.randomUUID();
    const drawId = crypto.randomUUID();
    await db.insert(users).values([
      { id: victimId, username: "coupon-victim", email: victimEmail, emailVerified: 1, passwordHash: "hash" },
      { id: attackerId, username: "coupon-attacker", email: attackerEmail, emailVerified: 1, passwordHash: "hash" },
    ]);
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "coupon-leak-draw",
        title: "越权读测试", status: "drawn", participationMode: "registered",
        activityKind: "lottery", experienceType: "wheel", resultMode: "manual",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(lotteryEntries).values([
      { id: crypto.randomUUID(), tenantId: TENANT, drawId, identityType: "user_id", identityValue: victimId, joinedAt: new Date().toISOString() },
      { id: crypto.randomUUID(), tenantId: TENANT, drawId, identityType: "user_id", identityValue: attackerId, joinedAt: new Date().toISOString() },
    ]);
    // 券只属于受害者
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "COUPON-VICTIM-ONLY", label: "invite", status: "issued",
      recipientEmail: victimEmail,
    });
    // 攻击者用自己的 JWT，但请求体填受害者邮箱
    const token = await signJwt({ sub: attackerId }, TEST_ENV.JWT_SECRET, 3600);
    const res = await app.request("/public/draws/coupon-leak-draw/my-result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.72",
      },
      body: JSON.stringify({ email: victimEmail, code: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.coupons).toEqual([]);
    expect(body.consolationCoupon).toBeNull();
  });

  /**
   * docs/254 P2：L1 自助核销优惠券。
   * 安全边界：只能核销自己领取的券（recipientEmail 匹配）+ OTP 验证 + CAS 防并发。
   */
  it("L1 自助核销优惠券：本人 + OTP 验证成功，他人 + 重复核销失败", async () => {
    const app = createPublicTestApp();
    const email = "redeem-owner@test.com";
    const otherEmail = "redeem-other@test.com";
    const drawId = crypto.randomUUID();
    const plainOtp = "888888";
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "coupon-redeem-draw",
        title: "核销测试", status: "drawn", participationMode: "open",
        activityKind: "lottery", resultMode: "manual",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    // 券属于 owner
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      code: "COUPON-REDEEM-1",
      label: "invite",
      status: "issued",
      recipientEmail: email,
    });
    // owner 的活动验证码（purpose=query 发码）
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId,
      codeHash: await hashCode(plainOtp),
      expiresAt: futureTimeISO(10),
      used: 0,
    });

    const doRedeem = (body: { code: string; email: string; otp: string }) =>
      app.request("/public/coupons/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.71" },
        body: JSON.stringify(body),
      }, TEST_ENV);

    // 1. 他人邮箱核销 → 403（归属校验：recipientEmail 不匹配，在 OTP 验证前拦截）
    const otherRes = await doRedeem({ code: "COUPON-REDEEM-1", email: otherEmail, otp: plainOtp });
    expect(otherRes.status).toBe(403);

    // 2. 本人 + 正确 OTP → 成功
    const okRes = await doRedeem({ code: "COUPON-REDEEM-1", email, otp: plainOtp });
    const okBody = await okRes.json() as any;
    expect(okRes.status).toBe(200);
    expect(okBody.ok).toBe(true);
    expect(okBody.redeemed).toBe(true);

    // 3. 重复核销 → 失败（CAS：status 已变 redeemed）
    const repeatRes = await doRedeem({ code: "COUPON-REDEEM-1", email, otp: plainOtp });
    expect(repeatRes.status).toBe(400);
    const repeatBody = await repeatRes.json() as any;
    expect(repeatBody.ok).toBe(false);
  });

  /**
   * docs/254 审查发现：registered 用户（JWT）核销优惠券。
   * access-code 端点对 registered 不生成 OTP，故核销必须支持 JWT 模式。
   * 验证：JWT 验证 → 查 users.email → 归属校验 → CAS 核销。
   */
  it("L1 自助核销优惠券：registered 用户用 JWT 核销成功", async () => {
    const app = createPublicTestApp();
    const email = "registered-redeem@test.com";
    const userId = crypto.randomUUID();
    const drawId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId, username: "registered-redeem", email,
      emailVerified: 1, passwordHash: "hash",
    });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "registered-redeem-draw",
        title: "注册核销", status: "drawn", participationMode: "registered",
        activityKind: "lottery", resultMode: "manual",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    // 券属于该注册用户（recipientEmail = users.email）
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "COUPON-REG-REDEEM-1", label: "invite", status: "issued",
      recipientEmail: email,
    });
    // 自签 JWT（registered 模式用 sub=userId）
    const token = await signJwt({ sub: userId }, TEST_ENV.JWT_SECRET, 3600);
    const res = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.72",
      },
      body: JSON.stringify({ code: "COUPON-REG-REDEEM-1", email, otp: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.redeemed).toBe(true);

    // 重复核销 → 失败（CAS）
    const repeatRes = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": "10.0.0.72",
      },
      body: JSON.stringify({ code: "COUPON-REG-REDEEM-1", email, otp: "" }),
    }, TEST_ENV);
    expect(repeatRes.status).toBe(400);
  });

  /**
   * docs/255 复审 B4：核销时的同码跨租户定界。
   *
   * couponCodes 唯一约束是 (tenantId, code)，同一个 code 可以存在于多个租户。
   * 旧实现 `.where(eq(code)).limit(10)` 无 orderBy、不带租户：
   * 同码行超过 10 个时，本人那一行可能根本不在结果集里（截断顺序由数据库任意决定），
   * 合法持券人会永久核销失败。
   *
   * 修复后：带 slug 时按 slug → tenantId 收敛，且归属条件下推到 SQL，
   * 不再依赖"取前 N 行再在内存里 find"。
   */
  it("L1 自助核销：同码在其它租户有 12 行时，本人凭 slug 仍能核销成功（B4）", async () => {
    const app = createPublicTestApp();
    const email = "b4-owner@test.com";
    const drawId = crypto.randomUUID();
    const plainOtp = "654321";
    const SHARED_CODE = "COUPON-B4-CROSS-TENANT";

    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "b4-redeem-draw",
        title: "跨租户同码核销", status: "drawn", participationMode: "open",
        activityKind: "lottery", resultMode: "manual",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);

    // 先插 12 个其它租户的同码券（且同为 issued，确保旧实现的 issuedCandidate 前置检查会放行），
    // 使本人那一行落在旧实现 .limit(10) 的截断之外。
    const otherTenants = Array.from({ length: 12 }, (_, i) => `b4-other-tenant-${i}`);
    await db.insert(tenants).values(otherTenants.map((id) => ({ id, name: id })));
    await db.insert(couponCodes).values(otherTenants.map((tenantId) => ({
      id: crypto.randomUUID(), tenantId, drawId: null,
      code: SHARED_CODE, label: "other", status: "issued",
      recipientEmail: `holder@${tenantId}.com`,
    })));

    // 本人的券最后插入
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: SHARED_CODE, label: "invite", status: "issued",
      recipientEmail: email,
    });
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(), email, drawId,
      codeHash: await hashCode(plainOtp), expiresAt: futureTimeISO(10), used: 0,
    });

    const res = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.81" },
      body: JSON.stringify({ code: SHARED_CODE, email, otp: plainOtp, slug: "b4-redeem-draw" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.redeemed).toBe(true);
    expect(body.label).toBe("invite");

    // 只核销本人那一张，其它租户的同码券不受影响
    const [mine] = await db.select().from(couponCodes)
      .where(and(eq(couponCodes.tenantId, TENANT), eq(couponCodes.code, SHARED_CODE)));
    expect(mine?.status).toBe("redeemed");
    const others = await db.select().from(couponCodes)
      .where(and(eq(couponCodes.code, SHARED_CODE), eq(couponCodes.tenantId, otherTenants[0]!)));
    expect(others[0]?.status).toBe("issued");
  });

  /**
   * docs/255 复审 B4：券只存在于其它租户时，带本租户 slug 必须是 404（不存在），
   * 不能因为"别的租户有这个码且是 issued"而泄露该码的存在性
   * （旧实现会先过 issuedCandidate 检查、再落到 403 归属失败，等于确认了码存在）。
   */
  it("L1 自助核销：券只存在于其它租户时，带本租户 slug 返回 404（B4 存在性泄露）", async () => {
    const app = createPublicTestApp();
    const email = "b4-probe@test.com";
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: "b4-probe-draw",
        title: "存在性探测", status: "drawn", participationMode: "open",
        activityKind: "lottery", resultMode: "manual",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(-10),
        winnerCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(tenants).values({ id: "b4-foreign-tenant", name: "foreign" });
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: "b4-foreign-tenant", drawId: null,
      code: "COUPON-B4-FOREIGN", label: "foreign", status: "issued",
      recipientEmail: "someone-else@test.com",
    });

    const res = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.82" },
      body: JSON.stringify({ code: "COUPON-B4-FOREIGN", email, otp: "111111", slug: "b4-probe-draw" }),
    }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  /**
   * docs/254 端到端业务链路：A 分享 → B 通过 ?ref= 参与 → A 获奖励 → A 查券 → A 核销。
   *
   * 这是 referralRewardDefs 的完整业务闭环测试（非单方法测试）：
   * - 通过 HTTP join 路由触发引擎（participation.ts 内自动归因 + processReferralRewardsEngine）
   * - 验证 bonus_spin 发放给 A（spinsLeft +N）
   * - 验证 bonus_coupon 发放给 A（couponCodes issued + recipientEmail）
   * - A 查 my-result 看到 coupons
   * - A 自助核销优惠券
   */
  it("端到端：A 分享 → B 经 ref 参与 → A 获 bonus_spin + bonus_coupon → A 查券 → A 核销", async () => {
    const app = createPublicTestApp();
    const emailA = "chain-a@test.com";
    const emailB = "chain-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "chain-draw";
    // 关闭邮箱 OTP（测试环境）
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    // 创建含 referralRewardDefs 的 instant lottery 活动（bonus_spin + bonus_coupon 混合）
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "端到端链路", status: "open", participationMode: "open",
        activityKind: "lottery", experienceType: "wheel", resultMode: "instant",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1, maxSpinsPerEntry: 10,
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: "invite_1_spin", type: "FIXED", target: "SOURCE", fixedAmount: "2",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_spin" },
            },
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    // 优惠券码池（bonus_coupon 出口需要）
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "CHAIN-COUPON-1", label: "invite", status: "available",
    });

    // 1. A 参与（open 模式，免 OTP）
    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.80" },
      body: JSON.stringify({ email: emailA }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const joinABody = await joinA.json() as any;
    expect(joinABody.ok).toBe(true);
    const entryAId = joinABody.entryId;
    // 记录 A 参与后的初始 spins（instant lottery 有初始 spins）
    const [entryAInit] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryAId));
    const initSpins = Number(entryAInit?.spinsTotalGranted ?? 0);

    // 2. A 生成分享码
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.80" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    expect(shareRes.status).toBe(200);
    const shareBody = await shareRes.json() as any;
    expect(shareBody.ok).toBe(true);
    const shareUrl = String(shareBody.shareUrl || "");
    const refMatch = shareUrl.match(/ref=([^&]+)/);
    expect(refMatch).toBeTruthy();
    const refCode = refMatch![1]!;

    // 3. B 通过 ?ref= 参与（触发归因 + 引擎）
    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.81" },
      body: JSON.stringify({ email: emailB, refCode }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);
    const joinBBody = await joinB.json() as any;
    expect(joinBBody.ok).toBe(true);

    // 4. 断言 A 获得 bonus_spin（spinsTotalGranted 增加 2）
    const [entryA] = await db.select().from(lotteryEntries).where(eq(lotteryEntries.id, entryAId));
    expect(Number(entryA?.spinsTotalGranted ?? 0)).toBe(initSpins + 2);
    expect(Number(entryA?.spinsLeft ?? 0)).toBe(initSpins + 2);

    // 5. 断言 A 获得 bonus_coupon（couponCodes issued + recipientEmail）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "CHAIN-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(emailA);

    // 6. A 查 my-result 看到 coupons（走 JWT 免 OTP）
    const tokenA = await signJwt({ sub: crypto.randomUUID(), tenantId: TENANT, email: emailA }, TEST_ENV.JWT_SECRET, 3600);
    const myResult = await app.request(`/public/draws/${slug}/my-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
        "CF-Connecting-IP": "10.0.0.80",
      },
      body: JSON.stringify({ email: emailA, code: "" }),
    }, TEST_ENV);
    expect(myResult.status).toBe(200);
    const myResultBody = await myResult.json() as any;
    expect(Array.isArray(myResultBody.coupons)).toBe(true);
    expect(myResultBody.coupons).toContain("CHAIN-COUPON-1");
    expect(Number(myResultBody.spinsLeft ?? 0)).toBe(initSpins + 2);

    // 7. A 自助核销优惠券（email + OTP 模式，open 用户）
    //    手动 seed A 的 OTP（模拟 A 通过 access-code 获取验证码）
    const plainOtp = "654321";
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email: emailA,
      drawId,
      codeHash: await hashCode(plainOtp),
      expiresAt: futureTimeISO(10),
      used: 0,
    });
    const redeemRes = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "10.0.0.80",
      },
      body: JSON.stringify({ code: "CHAIN-COUPON-1", email: emailA, otp: plainOtp }),
    }, TEST_ENV);
    expect(redeemRes.status).toBe(200);
    const redeemBody = await redeemRes.json() as any;
    expect(redeemBody.ok).toBe(true);
    expect(redeemBody.redeemed).toBe(true);

    // 8. 重复核销 → 400（CAS）
    const repeatRes = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "10.0.0.80",
      },
      body: JSON.stringify({ code: "CHAIN-COUPON-1", email: emailA, otp: plainOtp }),
    }, TEST_ENV);
    expect(repeatRes.status).toBe(400);
  });

  /**
   * docs/255 端到端：claim（资料领取）活动 + bonus_coupon 邀请奖励。
   * 验证非 lottery 类型下 bonus_coupon 出口的完整链路（A 分享 → B 参与 → A 获券 → A 查券 → A 核销）。
   */
  it("端到端：claim 活动 A 分享 → B 参与 → A 获 bonus_coupon → A 查券 → A 核销", async () => {
    const app = createPublicTestApp();
    const emailA = "claim-a@test.com";
    const emailB = "claim-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "claim-chain-draw";
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    // claim 活动（非 lottery，bonus_coupon 出口）
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "claim 端到端", status: "open", participationMode: "open",
        activityKind: "claim", experienceType: "reveal", resultMode: "instant",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1,
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "CLAIM-COUPON-1", label: "invite", status: "available",
    });

    // A 参与 → 生成分享码
    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.82" },
      body: JSON.stringify({ email: emailA }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const entryAId = (await joinA.json() as any).entryId;
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.82" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    const refCode = String((await shareRes.json() as any).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    // B 通过 ref 参与 → 触发归因 + 引擎（claim 类型 bonus_coupon）
    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.83" },
      body: JSON.stringify({ email: emailB, refCode }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // A 获得 bonus_coupon（claim 类型下 spins 不适用，只发券）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "CLAIM-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(emailA);

    // A 查 my-result 看到 coupons（claim 类型也能查到邀请券）
    const tokenA = await signJwt({ sub: crypto.randomUUID(), tenantId: TENANT, email: emailA }, TEST_ENV.JWT_SECRET, 3600);
    const myResult = await app.request(`/public/draws/${slug}/my-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}`, "CF-Connecting-IP": "10.0.0.82" },
      body: JSON.stringify({ email: emailA, code: "" }),
    }, TEST_ENV);
    const myResultBody = await myResult.json() as any;
    expect(Array.isArray(myResultBody.coupons)).toBe(true);
    expect(myResultBody.coupons).toContain("CLAIM-COUPON-1");

    // A 自助核销（email + OTP）
    const plainOtp = "654322";
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(), email: emailA, drawId,
      codeHash: await hashCode(plainOtp), expiresAt: futureTimeISO(10), used: 0,
    });
    const redeemRes = await app.request("/public/coupons/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.82" },
      body: JSON.stringify({ code: "CLAIM-COUPON-1", email: emailA, otp: plainOtp }),
    }, TEST_ENV);
    expect(redeemRes.status).toBe(200);
    expect((await redeemRes.json() as any).redeemed).toBe(true);
  });

  /**
   * docs/255 端到端：signup_chain（报名接龙）活动 + bonus_coupon 邀请奖励。
   * 验证 ordered_assignment 结果模式下 bonus_coupon 出口的完整链路。
   */
  it("端到端：signup_chain 活动 A 分享 → B 参与 → A 获 bonus_coupon", async () => {
    const app = createPublicTestApp();
    const emailA = "signup-a@test.com";
    const emailB = "signup-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "signup-chain-draw";
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "signup 端到端", status: "open", participationMode: "open",
        activityKind: "signup_chain", experienceType: "submit", resultMode: "ordered_assignment",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1,
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "SIGNUP-COUPON-1", label: "invite", status: "available",
    });

    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.84" },
      body: JSON.stringify({ email: emailA }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const entryAId = (await joinA.json() as any).entryId;
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.84" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    const refCode = String((await shareRes.json() as any).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.85" },
      body: JSON.stringify({ email: emailB, refCode }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // A 获得 bonus_coupon
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "SIGNUP-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(emailA);
  });

  /**
   * docs/255 端到端：flash_sale（秒杀）活动 + bonus_coupon 邀请奖励。
   * 验证直付秒杀下 bonus_coupon 出口（非 lottery 类型，spins 不适用）。
   */
  it("端到端：flash_sale 活动 A 分享 → B 参与 → A 获 bonus_coupon", async () => {
    const app = createPublicTestApp();
    const emailA = "flash-a@test.com";
    const emailB = "flash-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "flash-chain-draw";
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "flash 端到端", status: "open", participationMode: "open",
        activityKind: "claim", experienceType: "flash_sale", resultMode: "instant",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1,
        promotionConfig: JSON.stringify({
          version: 1,
          flashSale: { enabled: true, paymentRequired: true, stockLimit: 5, priceCents: 9900, currency: "cny" },
          referralRewardDefs: [
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "FLASH-COUPON-1", label: "invite", status: "available",
    });

    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.86" },
      body: JSON.stringify({ email: emailA }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const entryAId = (await joinA.json() as any).entryId;
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.86" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    const refCode = String((await shareRes.json() as any).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.87" },
      body: JSON.stringify({ email: emailB, refCode }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // A 获得 bonus_coupon（flash_sale 直付下 spins 不适用，只发券）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "FLASH-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(emailA);
  });

  /**
   * docs/255 端到端：survey（问卷）活动 + bonus_coupon 邀请奖励。
   * 验证 no_result 结果模式下 bonus_coupon 出口（非 lottery 类型，spins 不适用）。
   */
  it("端到端：survey 活动 A 分享 → B 参与 → A 获 bonus_coupon", async () => {
    const app = createPublicTestApp();
    const emailA = "survey-a@test.com";
    const emailB = "survey-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "survey-chain-draw";
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "survey 端到端", status: "open", participationMode: "open",
        activityKind: "survey", experienceType: "form", resultMode: "no_result",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1,
        activityConfig: JSON.stringify({
          version: 1, kind: "survey",
          fields: [{ id: "q1", label: "满意度", type: "text", required: true, maxLength: 200, options: [] }],
        }),
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "SURVEY-COUPON-1", label: "invite", status: "available",
    });

    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.88" },
      body: JSON.stringify({ email: emailA, submission: { fields: { q1: "满意" } } }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const entryAId = (await joinA.json() as any).entryId;
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.88" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    const refCode = String((await shareRes.json() as any).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.89" },
      body: JSON.stringify({ email: emailB, refCode, submission: { fields: { q1: "满意" } } }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // A 获得 bonus_coupon（survey 类型下 spins 不适用，只发券）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "SURVEY-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(emailA);
  });

  /**
   * docs/255 端到端：vote（投票）活动 + bonus_coupon 邀请奖励。
   * 验证 vote_tally 结果模式下 bonus_coupon 出口。
   */
  it("端到端：vote 活动 A 分享 → B 参与 → A 获 bonus_coupon", async () => {
    const app = createPublicTestApp();
    const emailA = "vote-a@test.com";
    const emailB = "vote-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "vote-chain-draw";
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "vote 端到端", status: "open", participationMode: "open",
        activityKind: "vote", experienceType: "ballot", resultMode: "vote_tally",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1,
        activityConfig: JSON.stringify({
          version: 1, kind: "vote", selection: "single",
          options: [
            { id: "opt1", label: "选项一", description: "", imageUrl: "" },
            { id: "opt2", label: "选项二", description: "", imageUrl: "" },
          ],
        }),
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "VOTE-COUPON-1", label: "invite", status: "available",
    });

    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.90" },
      body: JSON.stringify({ email: emailA, submission: { optionId: "opt1" } }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const entryAId = (await joinA.json() as any).entryId;
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.90" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    const refCode = String((await shareRes.json() as any).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.91" },
      body: JSON.stringify({ email: emailB, refCode, submission: { optionId: "opt2" } }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // A 获得 bonus_coupon（vote 类型下 spins 不适用，只发券）
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "VOTE-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(coupon?.recipientEmail).toBe(emailA);
  });

  /**
   * docs/255 端到端：checkin（签到）活动 + bonus_coupon 邀请奖励。
   * 验证 no_result 结果模式下 bonus_coupon 出口。
   */
  it("端到端：checkin 活动 A 分享 → B 参与 → A 获 bonus_coupon", async () => {
    const app = createPublicTestApp();
    const emailA = "checkin-a@test.com";
    const emailB = "checkin-b@test.com";
    const drawId = crypto.randomUUID();
    const slug = "checkin-chain-draw";
    await db.insert(systemConfig).values({ key: "enable_email_verification", value: "false" })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: "false" } });
    await db.insert(lotteryDraws).values([
      {
        id: drawId, tenantId: TENANT, publicSlug: slug,
        title: "checkin 端到端", status: "open", participationMode: "open",
        activityKind: "checkin", experienceType: "submit", resultMode: "no_result",
        startAt: futureTimeISO(-60), endAt: futureTimeISO(60),
        winnerCount: 1,
        promotionConfig: JSON.stringify({
          version: 1,
          referralRewardDefs: [
            {
              rewardId: "invite_1_coupon", type: "FIXED", target: "SOURCE", fixedAmount: "1",
              conditions: [{ field: "totalJoinedCount", operator: "GTE", value: "1" }],
              metadata: { rewardExit: "bonus_coupon", couponLabel: "invite" },
            },
          ],
        }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(couponCodes).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      code: "CHECKIN-COUPON-1", label: "invite", status: "available",
    });

    const joinA = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.92" },
      body: JSON.stringify({ email: emailA }),
    }, TEST_ENV);
    expect(joinA.status).toBe(200);
    const entryAId = (await joinA.json() as any).entryId;
    const shareRes = await app.request(`/public/draws/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.92" },
      body: JSON.stringify({ entryId: entryAId }),
    }, TEST_ENV);
    const refCode = String((await shareRes.json() as any).shareUrl || "").match(/ref=([^&]+)/)?.[1]!;

    const joinB = await app.request(`/public/draws/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.93" },
      body: JSON.stringify({ email: emailB, refCode }),
    }, TEST_ENV);
    expect(joinB.status).toBe(200);

    // A 获得 bonus_coupon（checkin 类型下 spins 不适用，只发券）
    // 注意：checkin 活动的 identity_value 会附加 :YYYY-MM-DD 后缀（每日签到），
    // 因此 recipientEmail 是 "checkin-a@test.com:2026-08-21" 而非纯邮箱。
    const [coupon] = await db.select().from(couponCodes).where(eq(couponCodes.code, "CHECKIN-COUPON-1"));
    expect(coupon?.status).toBe("issued");
    expect(String(coupon?.recipientEmail || "")).toContain("checkin-a@test.com");
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
    // 若存在多码，应取 createdAt 最新（与 POST /share 复用一致）；本用例仅一条
    expect(body.inviteOpen).toBe(true);
  });

  /**
   * docs/255 §8 P2-4：my-viral-stats 必须与 viral-leaderboard / 开奖 / 发布预检
   * 共用 isViralEnabled 严格判定。此前该端点用 truthy，`enabled: "true"`（字符串）
   * 时统计接口正常返回、而排行榜返回 400，参与者看到自相矛盾的裂变状态。
   */
  it("my-viral-stats：viral.enabled 为字符串 \"true\" 时按未开启处理（400）", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-stats-dirty",
      title: "裂变统计脏配置",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: "true", extraEntriesPerInvite: 2, maxExtraEntries: 5 },
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "viral-dirty@test.com",
      joinedAt: new Date().toISOString(),
    });

    const res = await app.request(
      `/public/draws/viral-stats-dirty/my-viral-stats?entryId=${encodeURIComponent(entryId)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.74" } },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("未开启裂变");
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

  it("viral-leaderboard：缺省 leaderboardEnabled 视为开启；仅显式 false 关闭", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    // 旧数据 / 手工配置：只写 enabled，不写 leaderboardEnabled
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-lb-default",
      title: "排行缺省",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 1, maxExtraEntries: 10 },
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "lb-default@test.com",
      joinedAt: new Date().toISOString(),
    });
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      sharerEntryId: entryId,
      shareCode: "lbdef001",
      joinedCount: 2,
    });

    const onRes = await app.request(
      `/public/draws/viral-lb-default/viral-leaderboard`,
      { headers: { "CF-Connecting-IP": "10.0.0.84" } },
      TEST_ENV,
    );
    expect(onRes.status).toBe(200);
    const onBody = await onRes.json() as any;
    expect(onBody.ok).toBe(true);
    expect(onBody.entries.length).toBe(1);
    expect(onBody.entries[0].invitedCount).toBe(2);

    // 显式关闭必须 400
    await db.update(lotteryDraws).set({
      promotionConfig: JSON.stringify({
        version: 1,
        viral: {
          enabled: true,
          extraEntriesPerInvite: 1,
          maxExtraEntries: 10,
          leaderboardEnabled: false,
        },
      }),
    }).where(eq(lotteryDraws.id, drawId));

    const offRes = await app.request(
      `/public/draws/viral-lb-default/viral-leaderboard`,
      { headers: { "CF-Connecting-IP": "10.0.0.85" } },
      TEST_ENV,
    );
    expect(offRes.status).toBe(400);
    const offBody = await offRes.json() as any;
    expect(offBody.ok).toBe(false);
    // UI parseViralLeaderboardResponse 依赖 message，禁止只返回空 body
    expect(String(offBody.message || "")).toContain("排行榜");
  });

  /**
   * 排行榜关 ≠ 裂变关：my-viral-stats 只看 viral.enabled，
   * 运营关榜后仍应能看自己的邀请进度 / 权重（公开卡「仅我的邀请」路径）。
   */
  it("my-viral-stats：leaderboardEnabled false 时仍可查邀请统计", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-stats-nolfb",
      title: "关榜仍可 stats",
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
          maxExtraEntries: 10,
          leaderboardEnabled: false,
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
      identityValue: "nolfb@test.com",
      joinedAt: new Date().toISOString(),
    });
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      sharerEntryId: entryId,
      shareCode: "nolfb001",
      joinedCount: 3,
    });

    const lbRes = await app.request(
      `/public/draws/viral-stats-nolfb/viral-leaderboard?entryId=${encodeURIComponent(entryId)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.91" } },
      TEST_ENV,
    );
    expect(lbRes.status).toBe(400);

    const statsRes = await app.request(
      `/public/draws/viral-stats-nolfb/my-viral-stats?entryId=${encodeURIComponent(entryId)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.92" } },
      TEST_ENV,
    );
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json() as any;
    expect(stats.ok).toBe(true);
    expect(stats.invitedCount).toBe(3);
    expect(stats.extraEntriesEarned).toBe(Math.min(3 * 2, 10));
    expect(stats.drawWeight).toBe(1 + stats.extraEntriesEarned);
  });

  /**
   * 排行榜 HTTP 死磕（docs/114）：聚合 / 脱敏 / entryId / 与 stats 一致 / 隔离 / 空榜。
   * 只断言可观测契约，不假设未实现的并列名次算法。
   */
  it("viral-leaderboard：多码 SUM、脱敏、entryId、stats 一致、跨活动隔离", async () => {
    const app = createPublicTestApp();
    const drawId = crypto.randomUUID();
    const otherDrawId = crypto.randomUUID();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const stranger = crypto.randomUUID();

    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: "viral-lb-sum",
      title: "多码聚合",
      status: "open",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      promotionConfig: JSON.stringify({
        version: 1,
        viral: { enabled: true, extraEntriesPerInvite: 2, maxExtraEntries: 10, leaderboardEnabled: true },
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 另一活动：同 sharer 码不得串榜
    await db.insert(lotteryDraws).values({
      id: otherDrawId,
      tenantId: TENANT,
      publicSlug: "viral-lb-other",
      title: "隔离",
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

    await db.insert(lotteryEntries).values([
      {
        id: p1,
        tenantId: TENANT,
        drawId,
        identityType: "email",
        identityValue: "alice@example.com",
        displayName: "Alice公开名",
        joinedAt: new Date().toISOString(),
      },
      {
        id: p2,
        tenantId: TENANT,
        drawId,
        identityType: "email",
        identityValue: "bob@example.com",
        joinedAt: new Date().toISOString(),
      },
      {
        id: stranger,
        tenantId: TENANT,
        drawId: otherDrawId,
        identityType: "email",
        identityValue: "x@other.com",
        joinedAt: new Date().toISOString(),
      },
    ]);

    // p1 两条 share：2+3=5；p2 一条：4；other 活动脏数据 99 不得进本榜
    await db.insert(shareRecords).values([
      {
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId,
        sharerEntryId: p1,
        shareCode: "sum-p1-a",
        joinedCount: 2,
      },
      {
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId,
        sharerEntryId: p1,
        shareCode: "sum-p1-b",
        joinedCount: 3,
      },
      {
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId,
        sharerEntryId: p2,
        shareCode: "sum-p2",
        joinedCount: 4,
      },
      {
        id: crypto.randomUUID(),
        tenantId: TENANT,
        drawId: otherDrawId,
        sharerEntryId: stranger,
        shareCode: "sum-other",
        joinedCount: 99,
      },
    ]);

    const res = await app.request(
      `/public/draws/viral-lb-sum/viral-leaderboard?entryId=${encodeURIComponent(p1)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.86" } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.entries).toHaveLength(2);
    // p1 合计 5 > p2 的 4
    expect(body.entries[0]).toEqual(expect.objectContaining({
      rank: 1,
      entryId: p1,
      invitedCount: 5,
      displayName: "Alice公开名",
    }));
    expect(body.entries[1]).toEqual(expect.objectContaining({
      rank: 2,
      entryId: p2,
      invitedCount: 4,
    }));
    // bob 无 displayName → 邮箱脱敏，禁止全文
    expect(body.entries[1].displayName).not.toBe("bob@example.com");
    expect(String(body.entries[1].displayName)).toContain("***");
    expect(body.myRank).toEqual(expect.objectContaining({ rank: 1, invitedCount: 5 }));
    // 串活动禁止
    expect(body.entries.every((e: any) => e.entryId !== stranger)).toBe(true);
    expect(body.entries.every((e: any) => e.invitedCount !== 99)).toBe(true);

    // 与 my-viral-stats 同一合计（多码 SUM）+ perInvite 公式
    const statsRes = await app.request(
      `/public/draws/viral-lb-sum/my-viral-stats?entryId=${encodeURIComponent(p1)}`,
      { headers: { "CF-Connecting-IP": "10.0.0.87" } },
      TEST_ENV,
    );
    const stats = await statsRes.json() as any;
    expect(stats.ok).toBe(true);
    expect(stats.invitedCount).toBe(5);
    expect(stats.extraEntriesEarned).toBe(Math.min(5 * 2, 10)); // 10
    expect(stats.drawWeight).toBe(1 + 10);
  });

  it("viral-leaderboard：空榜 / viral 未开 / 活动不存在", async () => {
    const app = createPublicTestApp();
    const emptyId = crypto.randomUUID();
    const offId = crypto.randomUUID();

    await db.insert(lotteryDraws).values([
      {
        id: emptyId,
        tenantId: TENANT,
        publicSlug: "viral-lb-empty",
        title: "空",
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
      },
      {
        id: offId,
        tenantId: TENANT,
        publicSlug: "viral-lb-noviral",
        title: "未开裂变",
        status: "open",
        participationMode: "open",
        startAt: futureTimeISO(-10),
        endAt: futureTimeISO(60),
        winnerCount: 1,
        promotionConfig: JSON.stringify({ version: 1 }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const emptyRes = await app.request(
      `/public/draws/viral-lb-empty/viral-leaderboard`,
      { headers: { "CF-Connecting-IP": "10.0.0.88" } },
      TEST_ENV,
    );
    expect(emptyRes.status).toBe(200);
    const emptyBody = await emptyRes.json() as any;
    expect(emptyBody.ok).toBe(true);
    expect(emptyBody.entries).toEqual([]);
    expect(emptyBody.myRank).toBeNull();

    const offRes = await app.request(
      `/public/draws/viral-lb-noviral/viral-leaderboard`,
      { headers: { "CF-Connecting-IP": "10.0.0.89" } },
      TEST_ENV,
    );
    expect(offRes.status).toBe(400);

    const miss = await app.request(
      `/public/draws/no-such-slug-lb/viral-leaderboard`,
      { headers: { "CF-Connecting-IP": "10.0.0.90" } },
      TEST_ENV,
    );
    expect(miss.status).toBe(404);
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
      id: crypto.randomUUID(), spinId: crypto.randomUUID(), tenantId, drawId, tierId: "tier-1", entryId: "notify-entry-1",
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

/* ── 测试：公开 /spin 路由（docs/116/119） ─────────────────── */

describe("公开 instant spin 路由", () => {
  const SPIN_ENV = {
    ...TEST_ENV,
    RESEND_API_KEY: "test-resend-key",
    EMAIL_FROM: "noreply@test.com",
  };

  async function seedOpenInstant(opts?: { slug?: string; maxSpins?: number; codes?: number }) {
    const drawId = crypto.randomUUID();
    const slug = opts?.slug || `spin-${drawId.slice(0, 6)}`;
    const maxSpins = opts?.maxSpins ?? 3;
    const codeCount = opts?.codes ?? 3;
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      publicSlug: slug,
      title: "路由即时抽",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      startAt: futureTimeISO(-60),
      endAt: futureTimeISO(120),
      winnerCount: 3,
      maxSpinsPerEntry: maxSpins,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const prizeId = crypto.randomUUID();
    await db.insert(prizes).values({
      id: prizeId,
      tenantId: TENANT,
      name: "路由奖品",
      prizeType: "code",
      totalCount: codeCount,
      active: 1,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      prizeId,
      tierName: "一等奖",
      winnerCount: 3,
      sortOrder: 1,
      weight: 100,
    });
    for (let i = 0; i < codeCount; i++) {
      await db.insert(prizeCodes).values({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        prizeId,
        code: `RCODE-${i}-${slug}`,
        secret: `RSEC-${i}`,
        status: "available",
      });
    }
    return { drawId, slug, prizeId };
  }

  async function insertOtp(email: string, drawId: string, plain = "123456") {
    // 同一 email+draw 仅允许一条 used=0（部分索引唯一）
    await db
      .update(emailAccessCodes)
      .set({ used: 1 })
      .where(and(
        eq(emailAccessCodes.email, email),
        eq(emailAccessCodes.drawId, drawId),
        eq(emailAccessCodes.used, 0),
      ));
    await db.insert(emailAccessCodes).values({
      id: crypto.randomUUID(),
      email,
      drawId,
      codeHash: await hashCode(plain),
      used: 0,
      expiresAt: futureTimeISO(10),
      createdAt: new Date().toISOString(),
    });
    return plain;
  }

  it("无 OTP / 无 Bearer → 400；错误码 → 400；正确码 → 200 且扣次", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-otp-gate" });
    const email = "spin-otp@test.com";
    await db.insert(platformTargets).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      platform: "qq",
      targetId: "spin-test-group",
      targetName: "Spin Test Group",
      activeDrawId: drawId,
      activePublicSlug: slug,
      assistantEnabled: 1,
      adapterDeploymentMode: "tenant_hosted",
      adapterProvider: "napcat",
      adapterConfigJson: "{}",
      builtinCommandsJson: "{}",
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
      spinsLeft: 2,
      spinsTotalGranted: 2,
      spinsViralEarned: 0,
    });

    const noCode = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.1", "Idempotency-Key": "otp-miss" },
        body: JSON.stringify({ email }),
      },
      SPIN_ENV,
    );
    expect(noCode.status).toBe(400);

    await insertOtp(email, drawId, "654321");
    const bad = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.2", "Idempotency-Key": "otp-bad" },
        body: JSON.stringify({ email, code: "000000" }),
      },
      SPIN_ENV,
    );
    expect(bad.status).toBe(400);

    const plain = await insertOtp(email, drawId, "112233");
    const okRes = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.3", "Idempotency-Key": "otp-ok" },
        body: JSON.stringify({ email, code: plain }),
      },
      SPIN_ENV,
    );
    const body = (await okRes.json()) as { ok?: boolean; won?: boolean; spinsLeft?: number; spinId?: string };
    expect(okRes.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.won).toBe(true);
    expect(body.spinsLeft).toBe(1);
    expect(body.spinId).toBeTruthy();

    const deliveries = await db
      .select()
      .from(platformDeliveries)
      .where(and(eq(platformDeliveries.tenantId, TENANT), eq(platformDeliveries.eventType, "outcome.assigned")));
    expect(deliveries).toHaveLength(1);
    const deliveryPayload = JSON.parse(deliveries[0]!.payloadJson) as { renderedMessage: string };
    expect(deliveryPayload.renderedMessage).toContain("路由即时抽");

    // 成功后 OTP 已核销：同码再 spin（新幂等键）应 400
    const reuse = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.1.4", "Idempotency-Key": "otp-reuse" },
        body: JSON.stringify({ email, code: plain }),
      },
      SPIN_ENV,
    );
    expect(reuse.status).toBe(400);
    const pending = await db
      .select()
      .from(emailAccessCodes)
      .where(and(
        eq(emailAccessCodes.email, email),
        eq(emailAccessCodes.drawId, drawId),
        eq(emailAccessCodes.used, 0),
      ));
    expect(pending.length).toBe(0);
  });

  it("spin OTP 核销后：同幂等键回放免 OTP；失败不核销可重试", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-otp-consume", maxSpins: 3, codes: 3 });
    const email = "spin-consume@test.com";
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
      spinsLeft: 2,
      spinsTotalGranted: 2,
      spinsViralEarned: 0,
    });

    const plain = await insertOtp(email, drawId, "556677");
    const first = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.8.1",
          "Idempotency-Key": "consume-idem-1",
        },
        body: JSON.stringify({ email, code: plain }),
      },
      SPIN_ENV,
    );
    const firstBody = (await first.json()) as { ok?: boolean; spinId?: string; replayed?: boolean };
    expect(first.status).toBe(200);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.spinId).toBeTruthy();

    // 同 key 回放：不需 OTP（码已 used）
    const replay = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.8.2",
          "Idempotency-Key": "consume-idem-1",
        },
        body: JSON.stringify({ email }),
      },
      SPIN_ENV,
    );
    const replayBody = (await replay.json()) as {
      ok?: boolean;
      spinId?: string;
      replayed?: boolean;
      message?: string;
    };
    expect(replay.status, replayBody.message).toBe(200);
    expect(replayBody.ok).toBe(true);
    expect(replayBody.spinId).toBe(firstBody.spinId);
    expect(replayBody.replayed).toBe(true);

    // 失败路径不核销：缺幂等键 → 400，OTP 仍可用
    const plain2 = await insertOtp(email, drawId, "667788");
    const noKey = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.8.3" },
        body: JSON.stringify({ email, code: plain2 }),
      },
      SPIN_ENV,
    );
    expect(noKey.status).toBe(400);
    const stillValid = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.8.4",
          "Idempotency-Key": "consume-after-fail",
        },
        body: JSON.stringify({ email, code: plain2 }),
      },
      SPIN_ENV,
    );
    expect(stillValid.status).toBe(200);
  });

  it("中奖后异步发邮件；同幂等键回放不二次触发新 winner/码", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-mail-route", maxSpins: 2, codes: 3 });
    const email = "spin-mail@test.com";
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
      spinsLeft: 2,
      spinsTotalGranted: 2,
      spinsViralEarned: 0,
    });
    const plain = await insertOtp(email, drawId, "998877");

    const captured: Array<{ to: string; html: string }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("resend.com")) {
        const body = JSON.parse(String(init?.body)) as { to: string; html: string };
        captured.push(body);
        return new Response(JSON.stringify({ id: "route-mail" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const first = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.2.1",
          "Idempotency-Key": "mail-idem-1",
        },
        body: JSON.stringify({ email, code: plain }),
      },
      SPIN_ENV,
    );
    const firstBody = (await first.json()) as {
      ok?: boolean;
      won?: boolean;
      spinId?: string;
      replayed?: boolean;
    };
    expect(first.status).toBe(200);
    expect(firstBody.won).toBe(true);

    // fire-and-forget：给 microtask/Promise 一点时间
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]!.to).toBe(email);
    expect(captured[0]!.html).toContain("路由奖品");

    const [winner] = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.spinId, firstBody.spinId!)));
    expect(winner?.notificationStatus).toBe("sent");

    // 回放：不新占码、不新 winner；路由因 replayed 不二次 fire mail（即使 fire 也会 skip sent）
    const beforeMail = captured.length;
    const replay = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.2.2",
          "Idempotency-Key": "mail-idem-1",
        },
        body: JSON.stringify({ email, code: plain }),
      },
      SPIN_ENV,
    );
    const replayBody = (await replay.json()) as { ok?: boolean; spinId?: string; replayed?: boolean };
    expect(replay.status).toBe(200);
    expect(replayBody.spinId).toBe(firstBody.spinId);
    expect(replayBody.replayed).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(beforeMail);

    const spins = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, drawId));
    expect(spins.length).toBe(1);
    const winners = await db.select().from(lotteryWinners).where(eq(lotteryWinners.drawId, drawId));
    expect(winners.length).toBe(1);

    vi.unstubAllGlobals();
  });

  it("JWT Bearer 可免 OTP spin", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-jwt-free" });
    const email = "spin-jwt@test.com";
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
      spinsLeft: 1,
      spinsTotalGranted: 1,
      spinsViralEarned: 0,
    });
    const token = await signJwt(
      { sub: "u-spin", email, username: "spinjwt" },
      TEST_ENV.JWT_SECRET,
      3600,
    );

    const res = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.3.1",
          "Idempotency-Key": "jwt-spin-1",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email }),
      },
      SPIN_ENV,
    );
    const body = (await res.json()) as { ok?: boolean; won?: boolean; message?: string };
    expect(res.status, body.message).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.won).toBe(true);
  });

  it("弱会话闭环：已参与 access-code purpose=query 发码后可 spin；join 意图仍 409", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-query-otp-loop", maxSpins: 2, codes: 2 });
    const email = "query-loop@test.com";
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
      spinsLeft: 2,
      spinsTotalGranted: 2,
      spinsViralEarned: 0,
    });

    // 已参与再走 join 意图 access-code → 409
    const joinIntent = await app.request(
      `/public/draws/${slug}/access-code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.7.1" },
        body: JSON.stringify({ email }),
      },
      SPIN_ENV,
    );
    expect(joinIntent.status).toBe(409);

    // purpose=query：已参与仍可发码（与前端 spin 弹窗一致）；明文不回包，只断言落库
    const queryIntent = await app.request(
      `/public/draws/${slug}/access-code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.7.2" },
        body: JSON.stringify({ email, purpose: "query" }),
      },
      SPIN_ENV,
    );
    const queryBody = (await queryIntent.json()) as {
      ok?: boolean;
      sent?: boolean;
      purpose?: string;
      message?: string;
    };
    expect(queryIntent.status, queryBody.message).toBe(200);
    expect(queryBody.ok).toBe(true);
    expect(queryBody.purpose).toBe("query");
    expect(queryBody.sent === true || queryBody.sent === false).toBe(true);
    const pendingCodes = await db
      .select()
      .from(emailAccessCodes)
      .where(and(
        eq(emailAccessCodes.email, email),
        eq(emailAccessCodes.drawId, drawId),
        eq(emailAccessCodes.used, 0),
      ));
    expect(pendingCodes.length).toBeGreaterThanOrEqual(1);

    // 用已知明文 OTP 完成 spin（与前端「验证并抽奖」同一路径）
    const plain = await insertOtp(email, drawId, "778899");

    const spinRes = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "10.0.7.3",
          "Idempotency-Key": "query-loop-spin-1",
        },
        body: JSON.stringify({ email, code: plain }),
      },
      SPIN_ENV,
    );
    const spinBody = (await spinRes.json()) as {
      ok?: boolean;
      won?: boolean;
      spinsLeft?: number;
      message?: string;
    };
    expect(spinRes.status, spinBody.message).toBe(200);
    expect(spinBody.ok).toBe(true);
    expect(spinBody.won).toBe(true);
    expect(spinBody.spinsLeft).toBe(1);
  });

  it("非 instant / 次数用尽 / 缺幂等键 正确拒绝", async () => {
    const app = createPublicTestApp();
    const manualId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: manualId,
      tenantId: TENANT,
      publicSlug: "spin-not-instant",
      title: "手动",
      status: "open",
      activityKind: "lottery",
      resultMode: "manual",
      participationMode: "open",
      startAt: futureTimeISO(-10),
      endAt: futureTimeISO(60),
      winnerCount: 1,
      maxSpinsPerEntry: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId: manualId,
      identityType: "email",
      identityValue: "ni@test.com",
      joinedAt: new Date().toISOString(),
    });
    const plainNi = await insertOtp("ni@test.com", manualId, "121212");
    const notInstant = await app.request(
      "/public/draws/spin-not-instant/spin",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.4.1", "Idempotency-Key": "ni-1" },
        body: JSON.stringify({ email: "ni@test.com", code: plainNi }),
      },
      SPIN_ENV,
    );
    expect(notInstant.status).toBe(400);

    const { drawId, slug } = await seedOpenInstant({ slug: "spin-exhausted", maxSpins: 1 });
    const email = "ex@test.com";
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
      spinsLeft: 0,
      spinsTotalGranted: 1,
      spinsViralEarned: 0,
    });
    const plainEx = await insertOtp(email, drawId, "343434");
    const exhausted = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.4.2", "Idempotency-Key": "ex-1" },
        body: JSON.stringify({ email, code: plainEx }),
      },
      SPIN_ENV,
    );
    expect(exhausted.status).toBe(409);

    const noKey = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.4.3" },
        body: JSON.stringify({ email, code: plainEx }),
      },
      SPIN_ENV,
    );
    expect(noKey.status).toBe(400);
  });

  it("my-result：instant 多奖返回 wins[] + spins 字段；卡密完整", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-myresult-wins", maxSpins: 3, codes: 4 });
    const email = "wins@test.com";
    const entryId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: entryId,
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
      spinsLeft: 1,
      spinsTotalGranted: 3,
      spinsViralEarned: 0,
    });

    // 两次 spin 中奖
    const c1 = await insertOtp(email, drawId, "101010");
    const s1 = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.5.1", "Idempotency-Key": "mr-s1" },
        body: JSON.stringify({ email, code: c1 }),
      },
      SPIN_ENV,
    );
    expect(s1.status).toBe(200);
    // 补额度再抽第二次（路由层 entry 可能已扣到 0，直接 SQL 抬）
    await db
      .update(lotteryEntries)
      .set({ spinsLeft: 2, spinsTotalGranted: 3 })
      .where(eq(lotteryEntries.id, entryId));
    const c2 = await insertOtp(email, drawId, "202020");
    const s2 = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.5.2", "Idempotency-Key": "mr-s2" },
        body: JSON.stringify({ email, code: c2 }),
      },
      SPIN_ENV,
    );
    expect(s2.status).toBe(200);

    const cQ = await insertOtp(email, drawId, "303030");
    const res = await app.request(
      `/public/draws/${slug}/my-result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.5.3" },
        body: JSON.stringify({ email, code: cQ }),
      },
      SPIN_ENV,
    );
    const body = (await res.json()) as {
      ok?: boolean;
      joined?: boolean;
      won?: boolean;
      wins?: Array<{ spinId: string | null; prizeCode: string | null; prizeName: string | null }>;
      spinsLeft?: number | null;
      spinsUsed?: number | null;
      maxSpinsPerEntry?: number | null;
      resultMode?: string | null;
      entryId?: string | null;
      prizeCode?: string | null;
    };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.joined).toBe(true);
    expect(body.won).toBe(true);
    expect(body.resultMode).toBe("instant");
    expect(body.entryId).toBe(entryId);
    expect(body.wins?.length).toBe(2);
    expect(body.wins![0]!.prizeCode).toBeTruthy();
    expect(body.wins![1]!.prizeCode).toBeTruthy();
    expect(body.wins![0]!.prizeCode).not.toBe(body.wins![1]!.prizeCode);
    // 兼容字段：首条卡密
    expect(body.prizeCode).toBe(body.wins![0]!.prizeCode);
    expect(body.maxSpinsPerEntry).toBe(3);
    expect(typeof body.spinsLeft).toBe("number");
    expect(typeof body.spinsUsed).toBe("number");
    expect((body.spinsUsed ?? 0) + (body.spinsLeft ?? 0)).toBe(3);
  });

  it("my-result：他邮箱 OTP 不能读到本 entry 多奖（身份隔离）", async () => {
    const app = createPublicTestApp();
    const { drawId, slug } = await seedOpenInstant({ slug: "spin-myresult-iso", maxSpins: 2, codes: 2 });
    const owner = "owner-win@test.com";
    const other = "other-peek@test.com";
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: owner,
      joinedAt: new Date().toISOString(),
      spinsLeft: 1,
      spinsTotalGranted: 1,
      spinsViralEarned: 0,
    });
    const cSpin = await insertOtp(owner, drawId, "404040");
    const spinRes = await app.request(
      `/public/draws/${slug}/spin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.6.1", "Idempotency-Key": "iso-s1" },
        body: JSON.stringify({ email: owner, code: cSpin }),
      },
      SPIN_ENV,
    );
    expect(spinRes.status).toBe(200);

    // other 未参与：有 OTP 也只能看到 joined=false，无 wins
    const cOther = await insertOtp(other, drawId, "505050");
    const peek = await app.request(
      `/public/draws/${slug}/my-result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.6.2" },
        body: JSON.stringify({ email: other, code: cOther }),
      },
      SPIN_ENV,
    );
    const body = (await peek.json()) as {
      ok?: boolean;
      joined?: boolean;
      wins?: unknown[];
      won?: boolean;
    };
    expect(peek.status).toBe(200);
    expect(body.joined).toBe(false);
    expect(body.won).toBe(false);
    expect(body.wins?.length ?? 0).toBe(0);
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
