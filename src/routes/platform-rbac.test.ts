/**
 * 平台/租户三层权限回归测试。
 *
 * 这组测试锁住 024/026 基线里最容易造成灾难的部分：
 * - /api/admin/* 只能是租户后台，不能混入平台能力。
 * - /api/platform/* 必须查 platform_members，不能只凭普通登录态。
 * - viewer 只能读租户后台，不能执行写操作。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createDb, type DbType } from "../db/client";
import { systemConfigRoute } from "./system-config";
import { platformSystemConfigRoute } from "./platform-system-config";
import { platformRedemptionCodesRoute } from "./platform-redemption-codes";
import { platformRoute } from "./platform";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt } from "../middleware/auth";
import { lotteryDraws, platformAuditLogs, platformMembers, redemptionCodes, systemConfig, tenantMembers, tenants, users } from "../db/schema";
import { eq } from "drizzle-orm";

let client: Client;
let db: DbType;

const JWT_SECRET = "test-platform-rbac-secret-0123456789abcdef";
const TENANT_ID = "tenant-rbac";
const OWNER_ID = "user-owner";
const VIEWER_ID = "user-viewer";
const PLATFORM_ID = "user-platform-owner";
const INVITEE_ID = "user-invitee";
const DB_URL = `file:test-platform-rbac-${crypto.randomUUID()}.db`;

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', brand_config TEXT NOT NULL DEFAULT '{}', extra_activity_quota INTEGER NOT NULL DEFAULT 0, extra_participant_quota INTEGER NOT NULL DEFAULT 0, extra_quota_expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', email_verified INTEGER NOT NULL DEFAULT 0, password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS platform_members (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS platform_audit_logs (id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, actor_role TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', tenant_id TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS lottery_draws (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, public_slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', activity_kind TEXT NOT NULL DEFAULT 'lottery', participation_mode TEXT NOT NULL DEFAULT 'open', experience_type TEXT NOT NULL DEFAULT 'wheel', draw_trigger TEXT NOT NULL DEFAULT 'manual', result_mode TEXT NOT NULL DEFAULT 'manual', allocation_policy TEXT NOT NULL DEFAULT 'capacity', policy_version INTEGER NOT NULL DEFAULT 1, start_at TEXT NOT NULL DEFAULT '', end_at TEXT NOT NULL DEFAULT '', draw_at TEXT, access_password TEXT NOT NULL DEFAULT '', max_participants INTEGER, winner_count INTEGER NOT NULL DEFAULT 1, show_participant_count INTEGER NOT NULL DEFAULT 1, show_winner_count INTEGER NOT NULL DEFAULT 1, show_winner_list INTEGER NOT NULL DEFAULT 0, drawn_at TEXT, failure_reason TEXT NOT NULL DEFAULT '', draw_seed_hash TEXT NOT NULL DEFAULT '', draw_seed TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT 'uniform_v1', product_link TEXT NOT NULL DEFAULT '{}', promotion_config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS lottery_roster_members (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT NOT NULL, identity_type TEXT NOT NULL DEFAULT 'email', identity_value TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(tenant_id, draw_id, identity_type, identity_value))`,
  `CREATE TABLE IF NOT EXISTS webhook_configs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]', signing_secret TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, webhook_config_id TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}', signature TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, response_status INTEGER, response_body TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, UNIQUE(webhook_config_id, event_id))`,
  `CREATE TABLE IF NOT EXISTS coupon_codes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, draw_id TEXT, code TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', recipient_email TEXT, redeemed_at TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(tenant_id, code))`,
  `CREATE TABLE IF NOT EXISTS redemption_codes (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, plan TEXT NOT NULL DEFAULT 'custom', activity_quota INTEGER NOT NULL DEFAULT 0, participant_quota INTEGER NOT NULL DEFAULT 0, duration_days INTEGER NOT NULL DEFAULT 30, max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS redemption_records (id TEXT PRIMARY KEY, code_id TEXT NOT NULL, code TEXT NOT NULL, tenant_id TEXT NOT NULL, tenant_name TEXT NOT NULL DEFAULT '', activity_quota_granted INTEGER NOT NULL DEFAULT 0, participant_quota_granted INTEGER NOT NULL DEFAULT 0, duration_days_granted INTEGER NOT NULL DEFAULT 30, expires_at TEXT, redeemed_at TEXT NOT NULL DEFAULT (datetime('now')))`,
];

beforeAll(async () => {
  client = createClient({ url: DB_URL });
  db = createDb(client);
  for (const stmt of DDL) await client.execute(stmt);
});

afterAll(async () => {
  await client.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of ["platform_audit_logs", "redemption_records", "redemption_codes", "coupon_codes", "webhook_deliveries", "webhook_configs", "lottery_roster_members", "lottery_draws", "system_config", "platform_members", "tenant_members", "users", "tenants"]) {
    await client.execute(`DELETE FROM ${table}`);
  }
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/admin", adminLotteryRoute);
  app.route("/api/system-config", systemConfigRoute);
  app.route("/api/platform/system-config", platformSystemConfigRoute);
  app.route("/api/platform/redemption-codes", platformRedemptionCodesRoute);
  app.route("/api/platform", platformRoute);
  return app;
}

async function authHeader(userId: string, tenantId = TENANT_ID) {
  const token = await signJwt({ sub: userId, tenantId }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

async function seedUsers() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "RBAC 测试租户" });
  await db.insert(users).values([
    { id: OWNER_ID, username: "owner", email: "owner@test.com", emailVerified: 1, passwordHash: "hash" },
    { id: VIEWER_ID, username: "viewer", email: "viewer@test.com", emailVerified: 1, passwordHash: "hash" },
    { id: PLATFORM_ID, username: "platform", email: "platform@test.com", emailVerified: 1, passwordHash: "hash" },
    { id: INVITEE_ID, username: "invitee", email: "invitee@test.com", emailVerified: 1, passwordHash: "hash" },
  ]);
  await db.insert(tenantMembers).values([
    { tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" },
    { tenantId: TENANT_ID, userId: VIEWER_ID, role: "viewer" },
  ]);
}

describe("RBAC-lite 路由分层", () => {
  it("租户管理员不能访问平台系统配置", async () => {
    await seedUsers();
    const app = createTestApp();

    const res = await app.request("/api/platform/system-config", {
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);

    expect(res.status).toBe(403);
  });

  it("平台 owner 可以读取并更新系统配置", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_owner" });
    const app = createTestApp();

    const readRes = await app.request("/api/platform/system-config", {
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(readRes.status).toBe(200);

    const writeRes = await app.request("/api/platform/system-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ key: "platform_name", value: "RBAC 平台" }),
    }, TEST_ENV);
    expect(writeRes.status).toBe(200);

    const auditRes = await app.request("/api/platform/audit-logs?limit=bad&action=platform.system_config.update", {
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(auditRes.status).toBe(200);
    const auditPayload = await auditRes.json() as { logs: Array<{ action: string; targetId: string }> };
    expect(auditPayload.logs).toHaveLength(1);
    expect(auditPayload.logs[0]).toMatchObject({
      action: "platform.system_config.update",
      targetId: "platform_name",
    });
  });

  it("旧 admin 平台入口不再提供系统配置和发码能力", async () => {
    await seedUsers();
    const app = createTestApp();

    const configRes = await app.request("/api/admin/system-config", {
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);
    expect(configRes.status).toBe(404);

    const batchRes = await app.request("/api/admin/redemption-codes/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ count: 1, activityQuota: 1, participantQuota: 0, durationDays: 30 }),
    }, TEST_ENV);
    expect(batchRes.status).toBe(404);
  });

  it("公开系统配置只走白名单接口，不需要平台权限也不泄漏管理项", async () => {
    const app = createTestApp();
    await db.insert(systemConfig).values([
      { key: "platform_name", value: "公开平台名" },
      { key: "email_from_name", value: "内部发件名" },
    ]);

    const res = await app.request("/api/system-config/system-config", {}, TEST_ENV);

    expect(res.status).toBe(200);
    const payload = await res.json() as { config: Record<string, string | undefined> };
    expect(payload.config.platform_name).toBe("公开平台名");
    expect(payload.config.email_from_name).toBeUndefined();
  });

  it("viewer 可以读取租户后台，但不能执行写操作", async () => {
    await seedUsers();
    const app = createTestApp();

    const readRes = await app.request("/api/admin/me", {
      headers: await authHeader(VIEWER_ID),
    }, TEST_ENV);
    expect(readRes.status).toBe(200);

    const writeRes = await app.request("/api/admin/draws", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(VIEWER_ID)) },
      body: JSON.stringify({ title: "viewer 不应创建活动" }),
    }, TEST_ENV);
    expect(writeRes.status).toBe(403);
  });

  it("租户后台列表遇到非法分页参数时使用安全默认值", async () => {
    await seedUsers();
    const app = createTestApp();
    const now = new Date().toISOString();
    await db.insert(lotteryDraws).values([
      { id: "draw-page-1", tenantId: TENANT_ID, publicSlug: "draw-page-1", title: "分页活动 1", status: "draft", startAt: now, endAt: now },
      { id: "draw-page-2", tenantId: TENANT_ID, publicSlug: "draw-page-2", title: "分页活动 2", status: "draft", startAt: now, endAt: now },
    ]);

    const res = await app.request("/api/admin/draws?limit=bad&offset=-10", {
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const payload = await res.json() as { draws: Array<{ id: string }>; total: number };
    expect(payload.draws).toHaveLength(2);
    expect(payload.total).toBe(2);
  });

  it("租户 owner 仍可通过 /api/admin/members 添加已有用户为团队成员", async () => {
    await seedUsers();
    await db.update(tenants).set({ plan: "pro" }).where(eq(tenants.id, TENANT_ID));
    const app = createTestApp();

    const addRes = await app.request("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ username: "invitee", role: "admin" }),
    }, TEST_ENV);
    expect(addRes.status).toBe(200);

    const listRes = await app.request("/api/admin/members", {
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);
    expect(listRes.status).toBe(200);
    const payload = await listRes.json() as { members: Array<{ userId: string; role: string }> };
    expect(payload.members.some((member) => member.userId === INVITEE_ID && member.role === "admin")).toBe(true);
  });

  it("租户成员角色只能使用基线角色，不能写入 operator/member 等历史同义词", async () => {
    await seedUsers();
    const app = createTestApp();

    const invalidRoleRes = await app.request(`/api/admin/members/${VIEWER_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ role: "operator" }),
    }, TEST_ENV);
    expect(invalidRoleRes.status).toBe(400);

    const selfDemoteRes = await app.request(`/api/admin/members/${OWNER_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ role: "viewer" }),
    }, TEST_ENV);
    expect(selfDemoteRes.status).toBe(400);
  });

  it("名单导入重复项只计入 skipped，不静默吞掉导入结果", async () => {
    await seedUsers();
    const app = createTestApp();
    const now = new Date().toISOString();
    await client.execute({
      sql: "INSERT INTO lottery_draws (id, tenant_id, public_slug, title, status, start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)",
      args: ["draw-roster", TENANT_ID, "draw-roster", "名单导入", now, now, now, now],
    });

    const res = await app.request("/api/admin/draws/draw-roster/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({
        members: [
          { email: "same@example.com", name: "A" },
          { email: " SAME@example.com ", name: "B" },
        ],
      }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const payload = await res.json() as { imported: number; skipped: number };
    expect(payload).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("优惠券导入重复码只计入 skipped，不误报全部成功", async () => {
    await seedUsers();
    const app = createTestApp();

    const res = await app.request("/api/admin/coupons/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ codes: ["COUPON-1", "COUPON-1"] }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const payload = await res.json() as { imported: number; skipped: number };
    expect(payload).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("平台发码只走 /api/platform/redemption-codes，生成结果可落库追溯", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_operator" });
    const app = createTestApp();

    const res = await app.request("/api/platform/redemption-codes/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ count: 2, activityQuota: 3, participantQuota: 100, durationDays: 30, note: "test" }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const payload = await res.json() as { codes: string[]; count: number };
    expect(payload.count).toBe(2);
    expect(payload.codes).toHaveLength(2);
    expect(payload.codes[0]).toMatch(/^LUCKY-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const rows = await db.select().from(redemptionCodes).where(eq(redemptionCodes.createdBy, PLATFORM_ID));
    expect(rows).toHaveLength(2);

    const [audit] = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.actorUserId, PLATFORM_ID)).limit(1);
    expect(audit?.action).toBe("platform.redemption_codes.batch_create");
    expect(audit?.targetType).toBe("redemption_code_batch");
  });

  it("平台 owner/operator 可手动重试 Webhook 投递且写入平台审计", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_operator" });
    const app = createTestApp();

    // 手动重试会发起真实外部请求；测试中必须 mock fetch，避免网络依赖和不可控副作用。
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await client.execute({
      sql: "INSERT INTO webhook_configs (id, tenant_id, url, events, signing_secret) VALUES (?, ?, ?, ?, ?)",
      args: ["webhook-1", TENANT_ID, "https://example.com/hook", "[\"draw.completed\"]", "secret"],
    });
    await client.execute({
      sql: "INSERT INTO webhook_deliveries (id, tenant_id, webhook_config_id, event_id, event_type, url, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["delivery-1", TENANT_ID, "webhook-1", "evt-1", "draw.completed", "https://example.com/hook", "{\"ok\":true}", "failed"],
    });

    const res = await app.request("/api/platform/webhook-deliveries/delivery-1/retry", {
      method: "POST",
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const delivery = await client.execute("SELECT status, attempt_count FROM webhook_deliveries WHERE id = 'delivery-1'");
    expect(delivery.rows[0]?.status).toBe("sent");
    expect(Number(delivery.rows[0]?.attempt_count)).toBe(1);

    const [audit] = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "platform.webhook_delivery.retry")).limit(1);
    expect(audit?.tenantId).toBe(TENANT_ID);
    expect(audit?.targetId).toBe("delivery-1");
  });

  it("租户侧兑换入口保留在 /api/admin/redemption-codes/redeem，并用 CAS 防止重复使用", async () => {
    await seedUsers();
    const app = createTestApp();
    const now = new Date().toISOString();

    await db.insert(redemptionCodes).values({
      id: "code-once",
      code: "LUCKY-ABCD-EFGH-2345",
      plan: "custom",
      activityQuota: 2,
      participantQuota: 50,
      durationDays: 30,
      maxUses: 1,
      usedCount: 0,
      status: "active",
      note: "once",
      createdBy: PLATFORM_ID,
      createdAt: now,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      updatedAt: now,
    });

    const first = await app.request("/api/admin/redemption-codes/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ code: "lucky-abcd-efgh-2345" }),
    }, TEST_ENV);
    expect(first.status).toBe(200);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, TENANT_ID));
    expect(tenant.extraActivityQuota).toBe(2);
    expect(tenant.extraParticipantQuota).toBe(50);

    const second = await app.request("/api/admin/redemption-codes/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader(OWNER_ID)) },
      body: JSON.stringify({ code: "LUCKY-ABCD-EFGH-2345" }),
    }, TEST_ENV);
    expect(second.status).toBe(400);
  });
});
