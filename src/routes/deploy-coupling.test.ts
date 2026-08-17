/**
 * 部署耦合风险验证（2026-08-17）
 *
 * 生产版旧前端（8e64bad）创建 claim 活动时因 claim 默认 resultMode=instant，
 * 会按 schedule.resultMode === 'instant' 传 maxSpinsPerEntry=1。
 * 若新后端对非 lottery 传 maxSpins 严格拒绝，则「新后端 + 旧前端」组合下
 * claim 活动创建会 400 —— 部署过渡期灾难。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt } from "../middleware/auth";
import { tenants, users, tenantMembers } from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-deploy-coupling-001";
const TENANT = "tenant-coupling-t";
const OWNER = "user-coupling-t";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

afterEach(async () => {
  await clearTestData(client);
});

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/admin", adminLotteryRoute);
  return app;
}

async function seedTenant() {
  await db.insert(tenants).values({ id: TENANT, name: "Coupling Test Tenant" });
  await db.insert(users).values({
    id: OWNER, username: "coupling", email: "coupling@test.com", emailVerified: 1, passwordHash: "hash",
  });
  await db.insert(tenantMembers).values({ tenantId: TENANT, userId: OWNER, role: "owner" });
}

async function authHeader() {
  const token = await signJwt({ sub: OWNER, tenantId: TENANT }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

describe("部署耦合风险（旧前端 claim 创建）", () => {
  it("旧前端模拟：claim + maxSpinsPerEntry=1 创建必须成功（当前严格拒绝会 400 → 灾难）", async () => {
    await seedTenant();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };

    // 完全复刻旧前端（8e64bad）创建 claim 活动的请求体
    const res = await app.request("/api/admin/draws", {
      method: "POST", headers,
      body: JSON.stringify({
        title: "旧前端创建资料领取",
        activityKind: "claim",
        participationMode: "open",
        experienceType: "reveal",
        resultMode: "instant",
        drawTrigger: "manual",
        maxSpinsPerEntry: 1, // 旧前端因 schedule.resultMode === 'instant' 必传
        startAt: new Date(Date.now() - 60000).toISOString(),
        endAt: new Date(Date.now() + 3600000).toISOString(),
        winnerCount: 0,
      }),
    }, TEST_ENV);

    // 期望 200：claim 创建不受 maxSpins 影响（createDraw 对非 lottery 强制 0）
    // 当前实现（严格拒绝）返回 400 → 部署过渡期 claim 创建全挂
    expect(res.status).toBe(200);
  });

  it("旧前端模拟：claim 编辑（PATCH 带 maxSpinsPerEntry=1）必须成功", async () => {
    await seedTenant();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };

    // 创建 claim 草稿（不带 maxSpins，新前端行为）
    const createRes = await app.request("/api/admin/draws", {
      method: "POST", headers,
      body: JSON.stringify({
        title: "编辑模拟",
        activityKind: "claim",
        participationMode: "open",
        experienceType: "reveal",
        resultMode: "instant",
        drawTrigger: "manual",
        startAt: new Date(Date.now() - 60000).toISOString(),
        endAt: new Date(Date.now() + 3600000).toISOString(),
        winnerCount: 0,
      }),
    }, TEST_ENV);
    expect(createRes.status).toBe(200);
    const { id } = await createRes.json() as { id: string };

    // 旧前端编辑 claim：完整 payload 含 maxSpinsPerEntry=1
    const patchRes = await app.request(`/api/admin/draws/${id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ title: "改标题", maxSpinsPerEntry: 1 }),
    }, TEST_ENV);

    expect(patchRes.status).toBe(200);
  });
});
