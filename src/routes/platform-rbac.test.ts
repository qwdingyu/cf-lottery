/**
 * 平台/租户三层权限回归测试。
 *
 * 这组测试锁住 024/026 基线里最容易造成灾难的部分：
 * - /api/admin/* 只能是租户后台，不能混入平台能力。
 * - /api/platform/* 必须查 platform_members，不能只凭普通登录态。
 * - viewer 只能读租户后台，不能执行写操作。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { systemConfigRoute } from "./system-config";
import { platformSystemConfigRoute } from "./platform-system-config";
import { platformRedemptionCodesRoute } from "./platform-redemption-codes";
import { platformRoute } from "./platform";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt, verifyJwt } from "../middleware/auth";
import { lotteryDraws, adminAuditLogs, emailDeliveries, platformMembers, redemptionCodes, systemConfig, tenantMembers, tenants, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

const JWT_SECRET = "test-platform-rbac-secret-0123456789abcdef";
const TENANT_ID = "tenant-rbac";
const OWNER_ID = "user-owner";
const VIEWER_ID = "user-viewer";
const PLATFORM_ID = "user-platform-owner";
const INVITEE_ID = "user-invitee";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearTestData(client);
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

    const [audit] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, PLATFORM_ID)).limit(1);
    expect(audit?.action).toBe("platform.redemption_codes.batch_create");
    expect(audit?.targetType).toBe("redemption_code_batch");
  });

  it("平台可禁用 active 兑换码，非 active 返回 409，并写平台审计", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_operator" });
    const app = createTestApp();
    const now = new Date().toISOString();
    const activeId = "rc-disable-active";
    const usedId = "rc-disable-used";
    await db.insert(redemptionCodes).values([
      {
        id: activeId,
        code: "LUCKY-TEST-AAAA-0001",
        plan: "custom",
        activityQuota: 1,
        participantQuota: 10,
        durationDays: 30,
        status: "active",
        createdBy: PLATFORM_ID,
        createdAt: now,
        expiresAt: now,
        updatedAt: now,
      },
      {
        id: usedId,
        code: "LUCKY-TEST-BBBB-0002",
        plan: "custom",
        activityQuota: 1,
        participantQuota: 10,
        durationDays: 30,
        status: "used",
        usedCount: 1,
        createdBy: PLATFORM_ID,
        createdAt: now,
        expiresAt: now,
        updatedAt: now,
      },
    ]);

    const okRes = await app.request(`/api/platform/redemption-codes/${activeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ status: "disabled" }),
    }, TEST_ENV);
    expect(okRes.status).toBe(200);

    const [activeRow] = await db.select().from(redemptionCodes).where(eq(redemptionCodes.id, activeId)).limit(1);
    expect(activeRow?.status).toBe("disabled");

    const conflict = await app.request(`/api/platform/redemption-codes/${usedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ status: "disabled" }),
    }, TEST_ENV);
    expect(conflict.status).toBe(409);

    const audits = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "platform.redemption_codes.disable"));
    expect(audits.some((a) => a.targetId === activeId)).toBe(true);
  });

  it("平台成员更新会拒绝非法角色字段，避免静默忽略错误权限参数", async () => {
    await seedUsers();
    await db.insert(platformMembers).values([
      { userId: PLATFORM_ID, role: "platform_owner" },
      { userId: INVITEE_ID, role: "platform_operator" },
    ]);
    const app = createTestApp();

    const res = await app.request(`/api/platform/members/${INVITEE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ role: "", status: "disabled" }),
    }, TEST_ENV);

    expect(res.status).toBe(400);
    const [member] = await db.select().from(platformMembers).where(eq(platformMembers.userId, INVITEE_ID)).limit(1);
    expect(member.status).toBe("active");
    expect(member.role).toBe("platform_operator");
  });

  it("平台 owner 可调整租户套餐/状态/额外额度，且额度按追加累计并写入平台审计", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_owner" });
    const app = createTestApp();
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

    const first = await app.request(`/api/platform/tenants/${TENANT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({
        plan: "pro",
        status: "suspended",
        extraActivityQuota: 3,
        extraParticipantQuota: 100,
        extraQuotaExpiresAt: expiresAt,
      }),
    }, TEST_ENV);
    expect(first.status).toBe(200);

    const second = await app.request(`/api/platform/tenants/${TENANT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ extraActivityQuota: 2, extraParticipantQuota: 50 }),
    }, TEST_ENV);
    expect(second.status).toBe(200);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, TENANT_ID)).limit(1);
    expect(tenant).toMatchObject({
      plan: "pro",
      status: "suspended",
      extraActivityQuota: 5,
      extraParticipantQuota: 150,
      extraQuotaExpiresAt: expiresAt,
    });

    const audits = await db
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.action, "platform.tenant.update"));
    expect(audits).toHaveLength(2);
    expect(audits[0]?.tenantId).toBe(TENANT_ID);
    expect(audits[0]?.targetType).toBe("tenant");
  });

  it("平台 operator/support 不能调整租户套餐和额度", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_operator" });
    const app = createTestApp();

    const res = await app.request(`/api/platform/tenants/${TENANT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
      body: JSON.stringify({ plan: "pro", extraActivityQuota: 1 }),
    }, TEST_ENV);

    expect(res.status).toBe(403);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, TENANT_ID)).limit(1);
    expect(tenant.plan).toBe("free");
    expect(tenant.extraActivityQuota).toBe(0);
  });

  it("平台 support 读取审计/用量/投递必须指定租户，不传返回空（docs/129 §五）", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_support" });
    const app = createTestApp();

    // 不传 tenantId → 返回空（而非全部租户数据，最小权限）
    const res = await app.request("/api/platform/audit-logs", {
      headers: { ...(await authHeader(PLATFORM_ID)) },
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { logs?: unknown[] }).logs).toEqual([]);

    const usageRes = await app.request("/api/platform/usage-snapshots", {
      headers: { ...(await authHeader(PLATFORM_ID)) },
    }, TEST_ENV);
    expect(((await usageRes.json()) as { snapshots?: unknown[] }).snapshots).toEqual([]);

    const deliveryRes = await app.request("/api/platform/webhook-deliveries", {
      headers: { ...(await authHeader(PLATFORM_ID)) },
    }, TEST_ENV);
    expect(((await deliveryRes.json()) as { deliveries?: unknown[] }).deliveries).toEqual([]);

    const emailDeliveryRes = await app.request("/api/platform/email-deliveries", {
      headers: { ...(await authHeader(PLATFORM_ID)) },
    }, TEST_ENV);
    expect(((await emailDeliveryRes.json()) as { deliveries?: unknown[] }).deliveries).toEqual([]);

    // 传 tenantId → 允许查看该租户（指定租户只读）
    const scopedRes = await app.request(`/api/platform/audit-logs?tenantId=${TENANT_ID}`, {
      headers: { ...(await authHeader(PLATFORM_ID)) },
    }, TEST_ENV);
    expect(scopedRes.status).toBe(200);
  });

  it("平台租户调整会拒绝非法套餐、状态、额度和日期", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_owner" });
    const app = createTestApp();

    const invalidCases = [
      { plan: "vip" },
      { status: "paused" },
      { extraActivityQuota: -1 },
      { extraActivityQuota: 0 },
      { extraActivityQuota: "5" },
      { extraParticipantQuota: 1_000_001 },
      { extraActivityQuota: 1.5 },
      { extraQuotaExpiresAt: "not-a-date" },
      {},
    ];

    for (const body of invalidCases) {
      const res = await app.request(`/api/platform/tenants/${TENANT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(await authHeader(PLATFORM_ID)) },
        body: JSON.stringify(body),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    }

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, TENANT_ID)).limit(1);
    expect(tenant).toMatchObject({ plan: "free", status: "active", extraActivityQuota: 0, extraParticipantQuota: 0 });
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

    const [audit] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "platform.webhook_delivery.retry")).limit(1);
    expect(audit?.tenantId).toBe(TENANT_ID);
    expect(audit?.targetId).toBe("delivery-1");
  });

  it("平台 owner/operator 可查看并重试邮件投递且写入平台审计", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_operator" });
    const app = createTestApp();

    await db.insert(emailDeliveries).values({
      id: "email-delivery-1",
      tenantId: TENANT_ID,
      drawId: "draw-email-rbac",
      sourceType: "draw_reminder",
      sourceId: "draw-email-rbac:user@test.com",
      recipientEmail: "user@test.com",
      template: "draw_reminder",
      templateDataJson: JSON.stringify({ drawName: "邮件投递测试", shareUrl: "slug", reminderText: "60 分钟" }),
      status: "failed",
      attemptCount: 1,
      lastError: "previous fail",
    });

    const listRes = await app.request(`/api/platform/email-deliveries?tenantId=${TENANT_ID}&status=failed`, {
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { deliveries: Array<{ id: string; recipientEmail: string }> };
    expect(listBody.deliveries).toHaveLength(1);
    expect(listBody.deliveries[0]).toMatchObject({ id: "email-delivery-1", recipientEmail: "user@test.com" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "mail-rbac-1" }), { status: 200 }));
    const retryRes = await app.request("/api/platform/email-deliveries/email-delivery-1/retry", {
      method: "POST",
      headers: await authHeader(PLATFORM_ID),
    }, { ...TEST_ENV, RESEND_API_KEY: "test-key", EMAIL_FROM: "noreply@test.com" });
    expect(retryRes.status).toBe(200);

    const [delivery] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, "email-delivery-1")).limit(1);
    expect(delivery?.status).toBe("sent");
    expect(delivery?.providerMessageId).toBe("mail-rbac-1");

    const [audit] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "platform.email_delivery.retry")).limit(1);
    expect(audit?.tenantId).toBe(TENANT_ID);
    expect(audit?.targetId).toBe("email-delivery-1");
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

describe("L3→L2 模拟登录路径（impersonate）", () => {
  it("平台 owner 可模拟登录：token 携带 impersonated 声明、sub 为目标租户 owner，可访问 L2 后台", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_owner" });
    const app = createTestApp();

    const res = await app.request(`/api/platform/tenants/${TENANT_ID}/impersonate`, {
      method: "POST",
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const data = await res.json() as { token: string; tenantId: string; userId: string };
    expect(data.tenantId).toBe(TENANT_ID);
    expect(data.userId).toBe(OWNER_ID);

    // 模拟 token 声明校验：impersonated=true、sub=租户 owner、tenantId=目标租户
    const claims = await verifyJwt(data.token, JWT_SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.impersonated).toBe(true);
    expect(claims!.sub).toBe(OWNER_ID);
    expect(claims!.tenantId).toBe(TENANT_ID);

    // 模拟 token 可访问 L2 后台（以租户 owner 身份）
    const meRes = await app.request("/api/admin/me", {
      headers: { Authorization: `Bearer ${data.token}` },
    }, TEST_ENV);
    expect(meRes.status).toBe(200);
  });

  it("平台 operator 不能模拟登录（403）", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_operator" });
    const app = createTestApp();

    const res = await app.request(`/api/platform/tenants/${TENANT_ID}/impersonate`, {
      method: "POST",
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("租户管理员（非平台成员）不能模拟登录（403）", async () => {
    await seedUsers();
    const app = createTestApp();

    const res = await app.request(`/api/platform/tenants/${TENANT_ID}/impersonate`, {
      method: "POST",
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("无 owner 成员的租户返回 404（拒绝模拟）", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_owner" });
    await db.insert(tenants).values({ id: "tenant-no-owner", name: "无 owner 租户" });
    const app = createTestApp();

    const res = await app.request("/api/platform/tenants/tenant-no-owner/impersonate", {
      method: "POST",
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("模拟登录写入平台审计日志（高风险操作留痕）", async () => {
    await seedUsers();
    await db.insert(platformMembers).values({ userId: PLATFORM_ID, role: "platform_owner" });
    const app = createTestApp();

    await app.request(`/api/platform/tenants/${TENANT_ID}/impersonate`, {
      method: "POST",
      headers: await authHeader(PLATFORM_ID),
    }, TEST_ENV);

    const logs = await db
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.action, "platform.tenant.impersonate"));
    expect(logs.length).toBe(1);
    expect(logs[0]!.actorUserId).toBe(PLATFORM_ID);
    expect(logs[0]!.tenantId).toBe(TENANT_ID);
  });
});
