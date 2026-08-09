/**
 * 管理端平台目标 CRUD 测试（docs/167 Phase 1）
 *
 * 覆盖：创建/列表/更新/删除/重置密钥/重复群号/未登录 401
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt } from "../middleware/auth";
import { clearTestData, getTestDb } from "../test-setup";
import { tenants, users, tenantMembers, lotteryDraws } from "../db/schema";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];
let token = "";

const JWT_SECRET = "test-platform-secret-0123456789ab";
process.env.JWT_SECRET = JWT_SECRET;
const TENANT_ID = "tenant-platform-api";
const OWNER_ID = "user-platform-api";
const DRAW_ID = "draw-platform-api-1";

async function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/admin", adminLotteryRoute);
  return app;
}

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

async function seedBase() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "平台测试租户" });
  await db.insert(users).values({
    id: OWNER_ID,
    email: "platform@test.com",
    username: "platform",
    passwordHash: "x",
  });
  await db.insert(tenantMembers).values({
    tenantId: TENANT_ID,
    userId: OWNER_ID,
    role: "owner",
  });
  const now = new Date().toISOString();
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    title: "平台测试活动",
    status: "open",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    activityKind: "lottery",
    drawTrigger: "manual",
    allocationPolicy: "random",
    publicSlug: "platform-test-slug",
    startAt: now,
    endAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  ({ client, db } = await getTestDb());
  token = await signJwt({ sub: OWNER_ID, tenantId: TENANT_ID }, JWT_SECRET, 3600);
  await seedBase();
});

afterEach(async () => {
  await clearTestData(client);
  await seedBase();
});

describe("platform-targets CRUD", () => {
  it("创建平台目标并返回入站密钥", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "123456789",
        targetName: "测试群",
        activeDrawId: DRAW_ID,
        checkinEnabled: true,
        spinEnabled: true,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(String(data.inboundSecret || "")).toMatch(/^pin_/);
  });

  it("创建后列表中有该条目", async () => {
    const app = await createApp();
    await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "123456", targetName: "群1", activeDrawId: DRAW_ID }),
    });
    const res = await app.request("/api/admin/platform-targets", {
      headers: { ...authHeaders() },
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect((data.items as Array<unknown>).length).toBe(1);
  });

  it("重复群号返回错误", async () => {
    const app = await createApp();
    await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "111111", targetName: "唯一群", activeDrawId: DRAW_ID }),
    });
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "111111", targetName: "重复群", activeDrawId: DRAW_ID }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("已绑定");
  });

  it("缺少 targetId 时返回错误", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetName: "无群号", activeDrawId: DRAW_ID }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("targetId");
  });

  it("绑定不存在的活动返回错误", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "555555", targetName: "非法活动", activeDrawId: "non-existent" }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("活动不存在");
  });

  it("更新成功", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "222222", targetName: "原名称", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    const updateRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetName: "新名称", assistantEnabled: false }),
    });
    expect(updateRes.status).toBe(200);

    const getRes = await app.request(`/api/admin/platform-targets/${id}`, {
      headers: { ...authHeaders() },
    });
    const getData = await getRes.json() as Record<string, unknown>;
    expect((getData.item as Record<string, unknown>).targetName).toBe("新名称");
    expect((getData.item as Record<string, unknown>).assistantEnabled).toBe(0);
  });

  it("删除成功", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "333333", targetName: "待删除", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    const delRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "DELETE",
      headers: { ...authHeaders() },
    });
    expect(delRes.status).toBe(200);

    const listRes = await app.request("/api/admin/platform-targets", {
      headers: { ...authHeaders() },
    });
    const listData = await listRes.json() as Record<string, unknown>;
    expect((listData.items as Array<unknown>).length).toBe(0);
  });

  it("重置入站密钥", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "444444", targetName: "密钥测试", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;
    const originalSecret = String(createData.inboundSecret || "");

    const resetRes = await app.request(`/api/admin/platform-targets/${id}/reset-secret`, {
      method: "POST",
      headers: { ...authHeaders() },
    });
    const resetData = await resetRes.json() as Record<string, unknown>;
    expect(resetData.ok).toBe(true);
    const newSecret = String(resetData.inboundSecret || "");
    expect(newSecret).toMatch(/^pin_/);
    expect(newSecret).not.toBe(originalSecret);
  });

  it("未登录时返回 401", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets");
    expect(res.status).toBe(401);
  });
});
