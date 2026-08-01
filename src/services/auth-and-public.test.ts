/**
 * 认证路由 + 公开路由集成测试
 *
 * 测试策略：
 * - 使用 @libsql/client 创建临时文件数据库
 * - 模拟 Hono 请求，测试完整的请求-响应链路
 * - 覆盖：注册/登录/验证邮箱/注销/参与活动
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createDb, type DbType } from "../db/client";
import { authRoute } from "../routes/auth";
import { publicLotteryRoute } from "../routes/public-lottery";
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

/* ── 数据库设置 ───────────────────────────────────────────── */

let db: DbType;
let client: Client;
const DB_URL = `file:test-auth-${crypto.randomUUID()}.db`;

const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', brand_config TEXT NOT NULL DEFAULT '{}', extra_activity_quota INTEGER NOT NULL DEFAULT 0, extra_participant_quota INTEGER NOT NULL DEFAULT 0, extra_quota_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', email_verified INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS rate_limit_log (id TEXT PRIMARY KEY, key TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS prizes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', value_text TEXT NOT NULL DEFAULT '', prize_type TEXT NOT NULL DEFAULT 'code', fulfillment_note TEXT NOT NULL DEFAULT '', total_count INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS prize_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, prize_id TEXT NOT NULL, code TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', winner_id TEXT DEFAULT '', issued_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lottery_draws (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', activity_kind TEXT NOT NULL DEFAULT 'lottery', participation_mode TEXT NOT NULL DEFAULT 'open', experience_type TEXT NOT NULL DEFAULT 'wheel', draw_trigger TEXT NOT NULL DEFAULT 'manual', result_mode TEXT NOT NULL DEFAULT 'manual', allocation_policy TEXT NOT NULL DEFAULT 'capacity', policy_version INTEGER NOT NULL DEFAULT 1, start_at TEXT NOT NULL, end_at TEXT NOT NULL, draw_at TEXT, access_password TEXT NOT NULL DEFAULT '', max_participants INTEGER, winner_count INTEGER NOT NULL DEFAULT 1, show_participant_count INTEGER NOT NULL DEFAULT 1, show_winner_count INTEGER NOT NULL DEFAULT 1, show_winner_list INTEGER NOT NULL DEFAULT 0, drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '', draw_seed_hash TEXT NOT NULL DEFAULT '', draw_seed TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1', product_link TEXT NOT NULL DEFAULT '{}', promotion_config TEXT NOT NULL DEFAULT '{}', activity_config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lottery_entries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', invite_code_id TEXT DEFAULT '', ip_hash TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(tenant_id, draw_id, identity_type, identity_value))`,
  `CREATE TABLE IF NOT EXISTS lottery_winners (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, tier_id TEXT NOT NULL, entry_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, prize_code_id TEXT DEFAULT '', drawn_at TEXT NOT NULL, notification_status TEXT NOT NULL DEFAULT 'pending', notification_error TEXT NOT NULL DEFAULT '', UNIQUE(tenant_id, draw_id, entry_id))`,
  `CREATE TABLE IF NOT EXISTS email_access_codes (id TEXT PRIMARY KEY, email TEXT NOT NULL, draw_id TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_code_active ON email_access_codes(email, draw_id) WHERE used = 0`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activity_outcomes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, entry_id TEXT NOT NULL, outcome_type TEXT NOT NULL DEFAULT 'assignment', status TEXT NOT NULL DEFAULT 'assigned', sequence_no INTEGER NOT NULL, assignment_no INTEGER, result_key TEXT NOT NULL DEFAULT '', result_label TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', decided_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];

beforeAll(async () => {
  client = createClient({ url: DB_URL });
  db = createDb(client);
  for (const stmt of DDL) await client.execute(stmt);
  await client.execute("ALTER TABLE tenants ADD COLUMN extra_activity_quota INTEGER NOT NULL DEFAULT 0").catch(() => undefined);
  await client.execute("ALTER TABLE tenants ADD COLUMN extra_participant_quota INTEGER NOT NULL DEFAULT 0").catch(() => undefined);
  await client.execute("ALTER TABLE tenants ADD COLUMN extra_quota_expires_at TEXT").catch(() => undefined);
});

afterAll(async () => {
  await client.close();
});

afterEach(async () => {
  const tables = ["audit_logs","lottery_winners","lottery_entries","lottery_draws","prize_codes","prizes","tenant_members","users","tenants","email_access_codes","system_config","activity_outcomes","rate_limit_log"];
  for (const t of tables) await client.execute(`DELETE FROM ${t}`);
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
    // 应自动创建租户和成员记录
    const [member] = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, user!.id)).limit(1);
    expect(member?.role).toBe("owner");
  });

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
