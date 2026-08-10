/**
 * 管理端平台目标 CRUD 测试（docs/167 Phase 1）
 *
 * 覆盖：创建/列表/更新/删除/重置密钥/重复群号/敏感配置拒绝/未登录 401
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt } from "../middleware/auth";
import { clearTestData, getTestDb } from "../test-setup";
import { tenants, users, tenantMembers, lotteryDraws, platformTargets, platformDeliveries } from "../db/schema";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { eq } from "drizzle-orm";

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
  vi.restoreAllMocks();
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
        adapterConfig: { baseUrl: "http://127.0.0.1:3000" },
        checkinEnabled: true,
        spinEnabled: true,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(String(data.inboundSecret || "")).toMatch(/^pin_/);
    const id = (data.item as Record<string, unknown>).id as string;
    const detailRes = await app.request(`/api/admin/platform-targets/${id}`, {
      headers: { ...authHeaders() },
    });
    const detail = await detailRes.json() as Record<string, unknown>;
    const item = detail.item as Record<string, unknown>;
    expect(JSON.parse(String(item.adapterConfigJson || "{}"))).toEqual({ baseUrl: "http://127.0.0.1:3000" });
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

  it("创建 Telegram 平台目标并校验 botToken 格式", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        platform: "telegram",
        targetId: "-1001234567890",
        targetName: "Telegram 群",
        activeDrawId: DRAW_ID,
        adapterConfig: { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(String(data.inboundSecret || "")).toMatch(/^pin_/);
  });

  it("Telegram 目标 botToken 格式无效时返回错误", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        platform: "telegram",
        targetId: "-100999",
        targetName: "Invalid Bot",
        activeDrawId: DRAW_ID,
        adapterConfig: { botToken: "invalid-token-format" },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("botToken");
  });

  it("拒绝保存 NapCat 明文 token", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "666666",
        targetName: "敏感配置测试",
        activeDrawId: DRAW_ID,
        adapterConfig: { baseUrl: "http://127.0.0.1:3000", token: "secret-token" },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("暂不支持保存 NapCat token");
  });

  it("拒绝未注册的平台绑定", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        platform: "discord",
        targetId: "dc-1",
        targetName: "Discord",
        activeDrawId: DRAW_ID,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("qq");
    expect(data.message).toContain("telegram");
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

  it("创建时保存 dailyCheckinPolicy.grantSpinCount（签到奖励闭环，docs/171）", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "888888",
        targetName: "签到奖励群",
        activeDrawId: DRAW_ID,
        checkinEnabled: true,
        dailyCheckinPolicy: { grantSpinCount: 3 },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const id = (data.item as Record<string, unknown>).id as string;
    const [row] = await db
      .select({ builtinCommandsJson: platformTargets.builtinCommandsJson })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    const cmds = JSON.parse(String(row?.builtinCommandsJson || "{}"));
    expect(cmds.dailyCheckinPolicy).toEqual({ grantSpinCount: 3 });
    expect(cmds.checkinEnabled).toBe(true);
  });

  it("grantSpinCount=0 时省略 dailyCheckinPolicy（视为不奖励）", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "999999",
        targetName: "无奖励群",
        activeDrawId: DRAW_ID,
        dailyCheckinPolicy: { grantSpinCount: 0 },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const id = (data.item as Record<string, unknown>).id as string;
    const [row] = await db
      .select({ builtinCommandsJson: platformTargets.builtinCommandsJson })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    const cmds = JSON.parse(String(row?.builtinCommandsJson || "{}"));
    expect(cmds.dailyCheckinPolicy).toBeUndefined();
  });

  it("非法 grantSpinCount 时省略 dailyCheckinPolicy", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "101010",
        targetName: "非法奖励群",
        activeDrawId: DRAW_ID,
        dailyCheckinPolicy: { grantSpinCount: "abc" },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const id = (data.item as Record<string, unknown>).id as string;
    const [row] = await db
      .select({ builtinCommandsJson: platformTargets.builtinCommandsJson })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    const cmds = JSON.parse(String(row?.builtinCommandsJson || "{}"));
    expect(cmds.dailyCheckinPolicy).toBeUndefined();
  });

  it("更新时保存 dailyCheckinPolicy.grantSpinCount", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "121212", targetName: "更新奖励群", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    const updateRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        builtinCommands: {
          checkinEnabled: true,
          spinEnabled: true,
          shareEnabled: true,
          leaderboardEnabled: true,
          myPrizeEnabled: true,
          helpEnabled: true,
          flashEnabled: true,
          dailyCheckinPolicy: { grantSpinCount: 5 },
        },
      }),
    });
    expect(updateRes.status).toBe(200);

    const [row] = await db
      .select({ builtinCommandsJson: platformTargets.builtinCommandsJson })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    const cmds = JSON.parse(String(row?.builtinCommandsJson || "{}"));
    expect(cmds.dailyCheckinPolicy).toEqual({ grantSpinCount: 5 });
  });

  it("编辑时入站密钥留空不更新，填写则覆盖", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "777777", targetName: "密钥编辑", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;
    const [created] = await db
      .select({ inboundSecretHash: platformTargets.inboundSecretHash })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);

    const emptyUpdateRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetName: "密钥编辑-留空", inboundSecret: "" }),
    });
    expect(emptyUpdateRes.status).toBe(200);
    const [afterEmptyUpdate] = await db
      .select({ inboundSecretHash: platformTargets.inboundSecretHash })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    expect(afterEmptyUpdate?.inboundSecretHash).toBe(created?.inboundSecretHash);

    const newSecret = "tenant-input-secret-123";
    const overwriteRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ inboundSecret: newSecret }),
    });
    expect(overwriteRes.status).toBe(200);
    const [afterOverwrite] = await db
      .select({ inboundSecretHash: platformTargets.inboundSecretHash })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    expect(afterOverwrite?.inboundSecretHash).toBe(await hashPlatformInboundSecret(newSecret));
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

  it("测试发送使用租户绑定的适配器 baseUrl 并记录投递审计", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "888888",
        targetName: "联调群",
        activeDrawId: DRAW_ID,
        adapterConfig: { baseUrl: "http://napcat.local:3000" },
      }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { message_id: 12345 } }), { status: 200 }),
    );
    const res = await app.request(`/api/admin/platform-targets/${id}/test-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text: "测试消息" }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.providerMessageId).toBe("12345");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://napcat.local:3000/send_group_msg");
    expect((requestInit?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(requestInit?.body || "{}"))).toEqual({
      group_id: "888888",
      message: "测试消息",
    });

    const deliveries = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.platformTargetId, id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("sent");
    expect(deliveries[0]?.eventType).toBe("platform.test");
    expect(deliveries[0]?.command).toBe("test_message");
  });

  it("测试发送缺少适配器配置时返回明确错误且不发起外部请求", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "999000", targetName: "未配置群", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await app.request(`/api/admin/platform-targets/${id}/test-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(String(data.message || "")).toContain("baseUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("测试发送失败时写入 failed 投递记录", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "999111",
        targetName: "失败群",
        activeDrawId: DRAW_ID,
        adapterConfig: { baseUrl: "http://napcat.local:3000" },
      }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad gateway", { status: 502 }));

    const res = await app.request(`/api/admin/platform-targets/${id}/test-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(502);
    expect(data.ok).toBe(false);

    const deliveries = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.platformTargetId, id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.lastError).toContain("HTTP 502");
  });

  it("未登录时返回 401", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets");
    expect(res.status).toBe(401);
  });
});
