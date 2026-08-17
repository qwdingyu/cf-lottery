/**
 * docs/239 方案 C 复核：PATCH 联动绕过 LIVE_SAFE_FIELDS 的问题验证
 *
 * 场景：open + 已有参与记录（hasLifecycleFacts）+ 存量秒杀不一致（stockLimit=6, maxParticipants=200）
 * 运营只改 title → 联动逻辑会把 maxParticipants 改为 6，绕过「进行中活动不可修改参与上限」白名单。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt } from "../middleware/auth";
import { tenants, users, tenantMembers, lotteryDraws, lotteryEntries } from "../db/schema";
import { eq } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-live-linkage-001";
const TENANT = "tenant-live-t";
const OWNER = "user-live-t";

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
  await db.insert(tenants).values({ id: TENANT, name: "Live Linkage Tenant" });
  await db.insert(users).values({
    id: OWNER, username: "live", email: "live@test.com", emailVerified: 1, passwordHash: "hash",
  });
  await db.insert(tenantMembers).values({ tenantId: TENANT, userId: OWNER, role: "owner" });
}

async function authHeader() {
  const token = await signJwt({ sub: OWNER, tenantId: TENANT }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

describe("方案 C 联动 vs LIVE_SAFE_FIELDS（进行中活动）", () => {
  it("open + 已有参与记录 + 存量不一致：PATCH title 不应联动修改 maxParticipants", async () => {
    await seedTenant();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };

    // 构造 open + 秒杀 + 存量不一致（stockLimit=6, maxParticipants=200）+ 一条参与记录
    const drawId = crypto.randomUUID();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT,
      title: "存量秒杀",
      activityKind: "claim",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      drawTrigger: "manual",
      status: "open",
      winnerCount: 0,
      maxParticipants: 200, // 存量不一致
      promotionConfig: JSON.stringify({
        flashSale: { enabled: true, stockLimit: 6, paymentRequired: false },
        destination: { url: "https://shop.example.com/item", title: "买" },
      }),
      startAt: new Date(Date.now() - 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000).toISOString(),
      publicSlug: `slug-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT,
      drawId,
      identityType: "email",
      identityValue: "joined@test.com",
      joinedAt: new Date().toISOString(),
    } as never);

    // 运营只改 title（LIVE_SAFE_FIELDS 允许）
    const res = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers, body: JSON.stringify({ title: "改标题" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [draw] = await db.select({ maxParticipants: lotteryDraws.maxParticipants })
      .from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    // 期望：maxParticipants 保持 200——进行中活动不允许通过联动绕过 LIVE_SAFE_FIELDS 修改参与上限
    // 当前实现（无 !hasLifecycleFacts 守卫）：maxParticipants 被联动改为 6 → 白名单绕过
    expect(draw!.maxParticipants).toBe(200);
  });
});
