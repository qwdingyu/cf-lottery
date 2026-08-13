/**
 * 平台消息投递管理端点测试（任务 5）：
 * - GET  /api/platform/platform-deliveries（列表 + 租户/状态/平台过滤，support 只读）
 * - POST /api/platform/platform-deliveries/:id/retry（owner/operator 重试，恢复 pending 后真实投递）
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { clearTestData, getTestDb } from "../test-setup";
import { signJwt } from "../middleware/auth";
import { platformRoute } from "./platform";
import { adminAuditLogs, platformDeliveries, platformMembers, platformTargets, tenants, users } from "../db/schema";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-platform-delivery-admin-secret-0123456789";
const TENANT_A = "tenant-delivery-admin-a";
const TENANT_B = "tenant-delivery-admin-b";
const OWNER_ID = "user-delivery-admin-owner";
const OPERATOR_ID = "user-delivery-admin-operator";
const SUPPORT_ID = "user-delivery-admin-support";
const TARGET_A = "pt-delivery-admin-a";
const TARGET_B = "pt-delivery-admin-b";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTestData(client);
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/platform", platformRoute);
  return app;
}

async function authHeader(userId: string) {
  const token = await signJwt({ sub: userId }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

async function seedUsersAndRoles() {
  await db.insert(users).values([
    { id: OWNER_ID, username: "delivery_owner", email: "do@example.com", emailVerified: 1, passwordHash: "hash" },
    { id: OPERATOR_ID, username: "delivery_operator", email: "dp@example.com", emailVerified: 1, passwordHash: "hash" },
    { id: SUPPORT_ID, username: "delivery_support", email: "ds@example.com", emailVerified: 1, passwordHash: "hash" },
  ]);
  await db.insert(platformMembers).values([
    { userId: OWNER_ID, role: "platform_owner" },
    { userId: OPERATOR_ID, role: "platform_operator" },
    { userId: SUPPORT_ID, role: "platform_support" },
  ]);
}

async function seedTenantsAndTargets() {
  await db.insert(tenants).values([
    { id: TENANT_A, name: "投递租户 A" },
    { id: TENANT_B, name: "投递租户 B" },
  ]);
  await db.insert(platformTargets).values([
    {
      id: TARGET_A,
      tenantId: TENANT_A,
      platform: "qq",
      targetId: "111111",
      targetName: "A 群",
      activeDrawId: "draw-a",
      activePublicSlug: "delivery-a",
      assistantEnabled: 1,
      adapterDeploymentMode: "tenant_hosted",
      adapterProvider: "napcat",
      adapterConfigJson: JSON.stringify({ baseUrl: "http://napcat-a:3000" }),
      builtinCommandsJson: "{}",
    },
    {
      id: TARGET_B,
      tenantId: TENANT_B,
      platform: "qq",
      targetId: "222222",
      targetName: "B 群",
      activeDrawId: "draw-b",
      activePublicSlug: "delivery-b",
      assistantEnabled: 1,
      adapterDeploymentMode: "tenant_hosted",
      adapterProvider: "napcat",
      adapterConfigJson: JSON.stringify({ baseUrl: "http://napcat-b:3000" }),
      builtinCommandsJson: "{}",
    },
  ]);
}

async function seedDelivery(
  id: string,
  tenantId: string,
  platformTargetId: string,
  overrides: Partial<typeof platformDeliveries.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  await db.insert(platformDeliveries).values({
    id,
    tenantId,
    platformTargetId,
    platform: "qq",
    targetId: platformTargetId === TARGET_A ? "111111" : "222222",
    eventId: `pevt_${id}`,
    eventType: "private_message",
    command: "private_message",
    payloadJson: JSON.stringify({
      renderedMessage: "测试私聊消息",
      targetType: "private",
      privateTargetId: "998877",
      groupId: "111111",
    }),
    status: "failed",
    attemptCount: 3,
    providerMessageId: "",
    responseBody: "",
    lastError: "测试失败原因",
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe("GET /api/platform/platform-deliveries", () => {
  it("按 tenantId 过滤：只返回指定租户的投递记录", async () => {
    await seedUsersAndRoles();
    await seedTenantsAndTargets();
    await seedDelivery("dlv-a-1", TENANT_A, TARGET_A);
    await seedDelivery("dlv-b-1", TENANT_B, TARGET_B);
    const app = createTestApp();

    const res = await app.request(`/api/platform/platform-deliveries?tenantId=${TENANT_A}`, {
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { deliveries: Array<{ id: string; tenantId: string; platform: string; status: string; lastError: string }> };
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]).toMatchObject({ id: "dlv-a-1", tenantId: TENANT_A, platform: "qq", status: "failed", lastError: "测试失败原因" });
  });

  it("按 status / platform 过滤生效", async () => {
    await seedUsersAndRoles();
    await seedTenantsAndTargets();
    await seedDelivery("dlv-a-pending", TENANT_A, TARGET_A, { status: "pending", attemptCount: 0, lastError: "" });
    await seedDelivery("dlv-a-failed", TENANT_A, TARGET_A, { status: "failed" });
    const app = createTestApp();

    const statusRes = await app.request(`/api/platform/platform-deliveries?tenantId=${TENANT_A}&status=pending`, {
      headers: await authHeader(OPERATOR_ID),
    }, TEST_ENV);
    const statusBody = await statusRes.json() as { deliveries: Array<{ id: string }> };
    expect(statusBody.deliveries.map((d) => d.id)).toEqual(["dlv-a-pending"]);

    const platformRes = await app.request(`/api/platform/platform-deliveries?tenantId=${TENANT_A}&platform=qq`, {
      headers: await authHeader(OPERATOR_ID),
    }, TEST_ENV);
    const platformBody = await platformRes.json() as { deliveries: Array<{ id: string }> };
    expect(platformBody.deliveries).toHaveLength(2);
  });

  it("support 角色不传 tenantId 时返回空（只读保护）", async () => {
    await seedUsersAndRoles();
    await seedTenantsAndTargets();
    await seedDelivery("dlv-a-1", TENANT_A, TARGET_A);
    const app = createTestApp();

    const res = await app.request("/api/platform/platform-deliveries", {
      headers: await authHeader(SUPPORT_ID),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { deliveries: unknown[] };
    expect(body.deliveries).toEqual([]);
  });
});

describe("POST /api/platform/platform-deliveries/:id/retry", () => {
  it("owner 重试失败投递：恢复 pending 后真实发送成功，并写平台审计", async () => {
    await seedUsersAndRoles();
    await seedTenantsAndTargets();
    await seedDelivery("dlv-retry-1", TENANT_A, TARGET_A);
    const app = createTestApp();

    // mock NapCat /send_private_msg 返回成功
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { message_id: "napcat-msg-1" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/api/platform/platform-deliveries/dlv-retry-1/retry", {
      method: "POST",
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok?: boolean; sent?: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(true);

    const [delivery] = await db.select().from(platformDeliveries).where(eq(platformDeliveries.id, "dlv-retry-1"));
    expect(delivery?.status).toBe("sent");
    expect(delivery?.attemptCount).toBe(4); // 3 次失败 + 本次重试
    expect(delivery?.providerMessageId).toBe("napcat-msg-1");
    // 重试端点先清空 lastError，成功发送后保持为空
    expect(delivery?.lastError).toBe("");

    // 确实调用了 NapCat /send_private_msg
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(callUrl).toContain("/send_private_msg");

    // 平台审计
    const audits = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "platform.platform_delivery.retry"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe("dlv-retry-1");
  });

  it("operator 可重试，support 不可重试（403）", async () => {
    await seedUsersAndRoles();
    await seedTenantsAndTargets();
    await seedDelivery("dlv-retry-2", TENANT_A, TARGET_A);
    const app = createTestApp();

    const supportRes = await app.request("/api/platform/platform-deliveries/dlv-retry-2/retry", {
      method: "POST",
      headers: await authHeader(SUPPORT_ID),
    }, TEST_ENV);
    expect(supportRes.status).toBe(403);

    const operatorRes = await app.request("/api/platform/platform-deliveries/dlv-retry-2/retry", {
      method: "POST",
      headers: await authHeader(OPERATOR_ID),
    }, TEST_ENV);
    expect(operatorRes.status).toBe(200);
  });

  it("已发送（sent）的投递不能重复重试", async () => {
    await seedUsersAndRoles();
    await seedTenantsAndTargets();
    await seedDelivery("dlv-sent-1", TENANT_A, TARGET_A, { status: "sent", attemptCount: 1, providerMessageId: "m1" });
    const app = createTestApp();

    const res = await app.request("/api/platform/platform-deliveries/dlv-sent-1/retry", {
      method: "POST",
      headers: await authHeader(OWNER_ID),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = await res.json() as { message?: string };
    expect(body.message).toContain("已发送");
  });
});
