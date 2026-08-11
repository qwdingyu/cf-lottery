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
import { tenants, users, tenantMembers, lotteryDraws, lotteryEntries, platformTargets, platformDeliveries, systemConfig } from "../db/schema";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { getActivePlatformTarget } from "../services/platform/targets";
import { executeBuiltinPlatformCommand } from "../services/platform/commands";
import { todayStr } from "../services/platform/checkin-reward";
import { handleInboundPlatformEvent } from "../services/platform/inbound";
import { isEncryptedPlatformSecret, PLATFORM_SECRET_PLACEHOLDER } from "../services/platform/adapter-config";
import { and, eq } from "drizzle-orm";

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

function previousDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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

  it("并发创建不同群时按套餐群数上限只落库一个", async () => {
    const app = await createApp();
    const makeCreateRequest = (targetId: string) => app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId, targetName: `并发群 ${targetId}`, activeDrawId: DRAW_ID }),
    });

    // free 套餐默认最多 1 个群。两个不同 targetId 的并发创建如果只在事务外 COUNT，
    // 会出现两个请求都读到 0 并最终超发；事务内复查应保证最终只有一个成功。
    const responses = await Promise.all([
      makeCreateRequest("race-group-a"),
      makeCreateRequest("race-group-b"),
    ]);
    const bodies = await Promise.all(responses.map((res) => res.json() as Promise<Record<string, unknown>>));
    expect(bodies.filter((body) => body.ok === true)).toHaveLength(1);
    expect(bodies.filter((body) => body.ok === false)).toHaveLength(1);

    const rows = await db
      .select({ id: platformTargets.id })
      .from(platformTargets)
      .where(eq(platformTargets.tenantId, TENANT_ID));
    expect(rows).toHaveLength(1);
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

  it("创建 Telegram 平台目标时加密保存 botToken，详情只返回脱敏占位符", async () => {
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
    const id = (data.item as Record<string, unknown>).id as string;
    const [row] = await db
      .select({ json: platformTargets.adapterConfigJson })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    const stored = JSON.parse(row?.json || "{}") as Record<string, string>;
    expect(isEncryptedPlatformSecret(stored.botToken || "")).toBe(true);
    expect(stored.botToken).not.toContain("ABC-DEF");

    const detailRes = await app.request(`/api/admin/platform-targets/${id}`, {
      headers: { ...authHeaders() },
    });
    const detail = await detailRes.json() as Record<string, unknown>;
    const item = detail.item as Record<string, unknown>;
    const publicCfg = JSON.parse(String(item.adapterConfigJson || "{}")) as Record<string, string>;
    expect(publicCfg.botToken).toBe(PLATFORM_SECRET_PLACEHOLDER);
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

  it("QQ NapCat token 加密保存且测试发送时作为 Authorization 使用", async () => {
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
    expect(data.ok).toBe(true);
    const id = (data.item as Record<string, unknown>).id as string;
    const [row] = await db
      .select({ json: platformTargets.adapterConfigJson })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    const stored = JSON.parse(row?.json || "{}") as Record<string, string>;
    expect(isEncryptedPlatformSecret(stored.token || "")).toBe(true);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { message_id: 777 } }), { status: 200 }),
    );
    const testRes = await app.request(`/api/admin/platform-targets/${id}/test-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text: "token 测试" }),
    });
    expect(testRes.status).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0]!;
    expect((requestInit?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
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

  it("手动输入 botId 被忽略（docs/177 方案升级：botId 为入站 self_id 自动写入的只读字段）", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "777777",
        targetName: "botId 忽略测试",
        activeDrawId: DRAW_ID,
        adapterConfig: { baseUrl: "http://127.0.0.1:3000", botId: "123456789" },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const id = (data.item as Record<string, unknown>).id as string;
    const [row] = await db.select({ json: platformTargets.adapterConfigJson }).from(platformTargets).where(eq(platformTargets.id, id)).limit(1);
    const cfg = JSON.parse(row?.json || "{}");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:3000");
    expect(cfg.botId).toBeUndefined(); // 手工传入的 botId 不应被存储
  });

  it("更新 baseUrl 时保留入站自动写入的 botId（botId 是只读字段，不随编辑覆盖）", async () => {
    const app = await createApp();
    // 用 DB 直接写入一个含 botId 的 target（模拟入站已写入 botId 的场景）
    const targetId = "botid-patch-test";
    const targetRowId = "pt-botid-patch";
    await db.insert(platformTargets).values({
      id: targetRowId,
      tenantId: TENANT_ID,
      platform: "qq",
      targetId,
      targetName: "botId 保留测试",
      activeDrawId: DRAW_ID,
      activePublicSlug: "test-slug",
      assistantEnabled: 1,
      adapterDeploymentMode: "tenant_hosted",
      adapterProvider: "napcat",
      adapterConfigJson: JSON.stringify({ baseUrl: "http://old.example:3000", botId: "888111222" }),
      inboundSecretHash: "test-hash",
      builtinCommandsJson: "{}",
    });
    // 直接用预定义的 targetRowId，无需从列表查找
    const id = targetRowId;

    // PATCH 更新 baseUrl
    const updateRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ adapterConfig: { baseUrl: "http://new.example:3000" } }),
    });
    expect(updateRes.status).toBe(200);

    // 验证 botId 未被覆盖丢失
    const [row] = await db.select({ json: platformTargets.adapterConfigJson }).from(platformTargets).where(eq(platformTargets.id, id)).limit(1);
    const cfg = JSON.parse(row?.json || "{}");
    expect(cfg.baseUrl).toBe("http://new.example:3000");
    expect(cfg.botId).toBe("888111222");
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

  /**
   * 端到端闭环验证：admin API 持久化 → targets.ts 读取 → commands.ts 执行。
   * 使用真实 admin API 创建 target，再通过 getActivePlatformTarget 和 executeBuiltinPlatformCommand
   * 验证完整数据流，不依赖任何 mock 或模拟对象。
   */
  it("端到端闭环：admin API 创建 grantSpinCount → getActivePlatformTarget 读取 → /签到 执行 → spinsLeft 增加", async () => {
    const app = await createApp();
    // 创建独立抽奖活动，确保时间窗口有效（seedBase 的 startAt===endAt 会立即过期）
    const e2eDrawId = crypto.randomUUID();
    const e2eSlug = "e2e-closed-loop-slug";
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: e2eDrawId,
      tenantId: TENANT_ID,
      title: "闭环验证活动",
      status: "open",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      activityKind: "lottery",
      drawTrigger: "manual",
      allocationPolicy: "random",
      publicSlug: e2eSlug,
      startAt: new Date(now.getTime() - 3600_000).toISOString(),
      endAt: new Date(now.getTime() + 86400_000 * 7).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    // Step 1: 通过 admin API 创建 target，配置 dailyCheckinPolicy.grantSpinCount = 3
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "e2e-999",
        targetName: "闭环验证群",
        activeDrawId: e2eDrawId,
        checkinEnabled: true,
        dailyCheckinPolicy: { grantSpinCount: 3 },
      }),
    });
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as Record<string, unknown>;
    expect(createData.ok).toBe(true);

    // Step 2: 通过 getActivePlatformTarget 读取 target（生产真实路径：inbound.ts → handleInboundPlatformEvent）
    const binding = await getActivePlatformTarget(db, { platform: "qq", targetId: "e2e-999" });
    expect(binding).not.toBeNull();
    expect(binding!.builtinCommands.dailyCheckinPolicy).toEqual({ grantSpinCount: 3 });

    // Step 3: 执行 /签到 命令，使用 getActivePlatformTarget 返回的 builtinCommands
    const checkinResult = await executeBuiltinPlatformCommand(db, {
      tenantId: TENANT_ID,
      platformTargetId: binding!.id,
      drawId: e2eDrawId,
      publicSlug: e2eSlug,
      command: "checkin",
      builtinCommands: binding!.builtinCommands,
      user: { identityType: "qq", identityValue: "e2e_user_001", displayName: "闭环测试用户" },
      source: { platform: "qq", groupId: "e2e-999", messageId: "msg-001" },
    });
    expect(checkinResult.handled).toBe(true);
    // 奖励提示：签到成功，获得 3 次抽奖机会
    expect(checkinResult.reply).toContain("获得 3 次抽奖机会");

    // Step 4: 验证 spinsLeft 增加了 grantSpinCount(3)（初始 0 + 3 = 3）
    const [entry] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.identityValue, "e2e_user_001")))
      .limit(1);
    expect(entry).not.toBeUndefined();
    expect(Number(entry!.spinsLeft ?? 0)).toBe(3);
  });

it("端到端闭环：rewardConfig linear 模式 → /签到 连续签到 → checkinStreak 和 spinsLeft 递增", async () => {
    const app = await createApp();
    const e2eDrawId2 = crypto.randomUUID();
    const e2eSlug2 = "e2e-streak-slug";
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: e2eDrawId2,
      tenantId: TENANT_ID,
      title: "连续签到验证活动",
      status: "open",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      activityKind: "lottery",
      drawTrigger: "manual",
      allocationPolicy: "random",
      publicSlug: e2eSlug2,
      startAt: new Date(now.getTime() - 3600_000).toISOString(),
      endAt: new Date(now.getTime() + 86400_000 * 7).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    // Step 1: 通过 admin API 创建 target，配置 rewardConfig linear 模式
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "e2e-streak-888",
        targetName: "连续签到验证群",
        activeDrawId: e2eDrawId2,
        checkinEnabled: true,
        dailyCheckinPolicy: {
          rewardConfig: { mode: "linear", baseRange: { min: 1, max: 1 }, increment: 2, cap: 10 },
        },
      }),
    });
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as Record<string, unknown>;
    expect(createData.ok).toBe(true);

    // Step 2: 读取 target
    const binding = await getActivePlatformTarget(db, { platform: "qq", targetId: "e2e-streak-888" });
    expect(binding).not.toBeNull();
    expect(binding!.builtinCommands.dailyCheckinPolicy?.rewardConfig?.mode).toBe("linear");

    // Step 3: 第 1 次签到（首次，连续天数=0，奖励=base=1）
    const checkin1 = await executeBuiltinPlatformCommand(db, {
      tenantId: TENANT_ID,
      platformTargetId: binding!.id,
      drawId: e2eDrawId2,
      publicSlug: e2eSlug2,
      command: "checkin",
      builtinCommands: binding!.builtinCommands,
      user: { identityType: "qq", identityValue: "e2e_streak_user", displayName: "连续签到用户" },
      source: { platform: "qq", groupId: "e2e-streak-888", messageId: "msg-streak-1" },
    });
    expect(checkin1.handled).toBe(true);
    expect(checkin1.reply).toContain("获得 1 次抽奖机会");

    // 验证 checkinStreak=1, spinsLeft=1
    let [entry1] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft, checkinStreak: lotteryEntries.checkinStreak })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.identityValue, "e2e_streak_user")))
      .limit(1);
    expect(entry1).not.toBeUndefined();
    expect(Number(entry1!.spinsLeft ?? 0)).toBe(1);
    expect(entry1!.checkinStreak).toBe(1);

    // 修改 lastCheckinDate 为昨天（模拟连续签到，避免日期限制）
    const yesterday = previousDateStr(todayStr());
    await db
      .update(lotteryEntries)
      .set({ lastCheckinDate: yesterday })
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.identityValue, "e2e_streak_user")));

    // Step 4: 第 2 次签到（连续，streak=1→2，奖励=base+1*2=3）
    const checkin2 = await executeBuiltinPlatformCommand(db, {
      tenantId: TENANT_ID,
      platformTargetId: binding!.id,
      drawId: e2eDrawId2,
      publicSlug: e2eSlug2,
      command: "checkin",
      builtinCommands: binding!.builtinCommands,
      user: { identityType: "qq", identityValue: "e2e_streak_user", displayName: "连续签到用户" },
      source: { platform: "qq", groupId: "e2e-streak-888", messageId: "msg-streak-2" },
    });
    expect(checkin2.handled).toBe(true);
    // 第 2 天 = 1 + (2-1)*2 = 3
    expect(checkin2.reply).toContain("获得 3 次抽奖机会");

    // 验证 checkinStreak=2, spinsLeft=1+3=4
    let [entry2] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft, checkinStreak: lotteryEntries.checkinStreak })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.identityValue, "e2e_streak_user")))
      .limit(1);
    expect(Number(entry2!.spinsLeft ?? 0)).toBe(4);
    expect(entry2!.checkinStreak).toBe(2);
  });
  it("创建时保存 purchaseConfig（秒杀购买闭环，docs/171 §断层B）", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "131313",
        targetName: "秒杀购买群",
        activeDrawId: DRAW_ID,
        flashEnabled: true,
        purchaseConfig: { url: "https://example.com/flash", label: "🔥 限时秒杀 ¥9.90" },
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
    expect(cmds.purchaseConfig).toEqual({ url: "https://example.com/flash", label: "🔥 限时秒杀 ¥9.90" });
    expect(cmds.flashEnabled).toBe(true);
  });

  it("purchaseConfig.url 为空字符串时省略 purchaseConfig", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "141414",
        targetName: "空购买链接群",
        activeDrawId: DRAW_ID,
        purchaseConfig: { url: "   ", label: "立即购买" },
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
    expect(cmds.purchaseConfig).toBeUndefined();
  });

  it("purchaseConfig.label 为空时使用默认文案「立即购买」", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "151515",
        targetName: "无文案秒杀群",
        activeDrawId: DRAW_ID,
        purchaseConfig: { url: "https://example.com/buy", label: "" },
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
    expect(cmds.purchaseConfig).toEqual({ url: "https://example.com/buy", label: "立即购买" });
  });

  it("更新时保存 purchaseConfig（覆盖原值）", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "161616",
        targetName: "更新秒杀群",
        activeDrawId: DRAW_ID,
        purchaseConfig: { url: "https://old.example.com", label: "旧链接" },
      }),
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
          purchaseConfig: { url: "https://new.example.com/flash", label: "🔥 新版秒杀" },
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
    expect(cmds.purchaseConfig).toEqual({ url: "https://new.example.com/flash", label: "🔥 新版秒杀" });
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

  it("编辑入站密钥：少于 6 位被拒，6 位及以上允许", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "999999", targetName: "密钥长度校验", activeDrawId: DRAW_ID }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    // 5 位：拒绝
    const tooShort = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ inboundSecret: "12345" }),
    });
    expect(tooShort.status).toBe(400);

    // 6 位：允许
    const okLen = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ inboundSecret: "123456" }),
    });
    expect(okLen.status).toBe(200);
    const [afterOk] = await db
      .select({ inboundSecretHash: platformTargets.inboundSecretHash })
      .from(platformTargets)
      .where(eq(platformTargets.id, id))
      .limit(1);
    expect(afterOk?.inboundSecretHash).toBe(await hashPlatformInboundSecret("123456"));
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

  it("Telegram 测试发送使用 botToken 调用 Bot API 并记录投递审计", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        platform: "telegram",
        targetId: "-1009988776655",
        targetName: "Telegram 联调群",
        activeDrawId: DRAW_ID,
        adapterConfig: { botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" },
      }),
    });
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 54321 } }), { status: 200 }),
    );
    const res = await app.request(`/api/admin/platform-targets/${id}/test-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text: "Telegram 测试消息" }),
    });
    const data = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(data.providerMessageId).toBe("54321");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage");
    expect(JSON.parse(String(requestInit?.body || "{}"))).toMatchObject({
      chat_id: "-1009988776655",
      text: "Telegram 测试消息",
    });

    const deliveries = await db
      .select()
      .from(platformDeliveries)
      .where(eq(platformDeliveries.platformTargetId, id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("sent");
    expect(deliveries[0]?.platform).toBe("telegram");
  });

  it("Telegram 测试发送缺少 botToken 时返回明确错误且不发起外部请求", async () => {
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        platform: "telegram",
        targetId: "-1001122334455",
        targetName: "未配置 Telegram 群",
        activeDrawId: DRAW_ID,
      }),
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
    expect(String(data.message || "")).toContain("botToken");
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

  it("社群功能全局关闭时创建返回 403", async () => {
    // 关闭社群功能
    await db.insert(systemConfig).values({ key: "community_feature_enabled", value: "false" });
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "g-403", targetName: "被禁群", activeDrawId: DRAW_ID }),
    });
    expect(res.status).toBe(403);
    const data = await res.json() as Record<string, unknown>;
    expect(data.message).toContain("社群功能已被平台运营者关闭");
  });

  it("社群功能全局关闭时更新返回 403", async () => {
    // 先创建一条绑定（社群功能默认开启）
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "g-update-403", targetName: "待更新群", activeDrawId: DRAW_ID }),
    });
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as Record<string, unknown>;
    const id = (createData.item as Record<string, unknown>).id as string;

    // 关闭社群功能
    await db.insert(systemConfig).values({ key: "community_feature_enabled", value: "false" });

    // 更新应被拒绝
    const updateRes = await app.request(`/api/admin/platform-targets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetName: "无权限改名" }),
    });
    expect(updateRes.status).toBe(403);
    const data = await updateRes.json() as Record<string, unknown>;
    expect(data.message).toContain("社群功能已被平台运营者关闭");
  });

  it("社群功能关闭后 GET 列表仍可读（只读模式）", async () => {
    // 创建一条绑定
    const app = await createApp();
    await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ targetId: "g-readonly", targetName: "只读测试群", activeDrawId: DRAW_ID }),
    });
    // 关闭社群功能
    await db.insert(systemConfig).values({ key: "community_feature_enabled", value: "false" });
    // 列表仍可读
    const listRes = await app.request("/api/admin/platform-targets", { headers: { ...authHeaders() } });
    expect(listRes.status).toBe(200);
    const data = await listRes.json() as Record<string, unknown>;
    expect(data.items).toBeDefined();
  });

  it("社群功能关闭后 handleInboundPlatformEvent 不响应命令（业务层闭环）", async () => {
    // 创建一条绑定（社群功能默认开启）
    const app = await createApp();
    const createRes = await app.request("/api/admin/platform-targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        targetId: "g-inbound-403",
        targetName: "入站闭环测试群",
        activeDrawId: DRAW_ID,
        checkinEnabled: true,
        dailyCheckinPolicy: { grantSpinCount: 3 },
      }),
    });
    expect(createRes.status).toBe(200);

    // 获取绑定对象
    const binding = await getActivePlatformTarget(db, { platform: "qq", targetId: "g-inbound-403" });
    expect(binding).not.toBeNull();

    // 关闭社群功能
    await db.insert(systemConfig).values({ key: "community_feature_enabled", value: "false" });

    // 通过 handleInboundPlatformEvent 执行 /签到 命令（模拟真实入站消息处理链路）
    const result = await handleInboundPlatformEvent(db, {
      platform: "qq",
      sourceId: "g-inbound-403",
      userId: "inbound_user_001",
      eventType: "message",
      text: "/签到",
      messageId: "msg-inbound-001",
      senderDisplayName: "入站闭环测试用户",
      raw: {},
    }, binding);

    // 断言：返回阻止回复，且命令未被执行
    expect(result).not.toBeNull();
    expect(result!.handled).toBe(true);
    expect(result!.reply).toContain("社群功能已被平台运营者暂停");

    // 验证 spinsLeft 未被增加（命令未被真正执行）
    const [entry] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.identityValue, "inbound_user_001")))
      .limit(1);
    expect(entry).toBeUndefined();
  });

  it("未登录时返回 401", async () => {
    const app = await createApp();
    const res = await app.request("/api/admin/platform-targets");
    expect(res.status).toBe(401);
  });
});
