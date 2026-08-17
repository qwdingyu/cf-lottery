/**
 * 管理端核心业务集成测试
 *
 * 覆盖 admin-lottery-prizes.ts（prize CRUD / 码池导入生成查询导出删除）和
 * admin-lottery-draw-ops.ts（中奖名单/候选池/审核/名单导入/邀请码）的
 * 核心业务场景，重点关注多租户隔离、状态机约束、边界校验。
 *
 * 本文件不追求单函数 100% 覆盖，而是死磕整体业务流的正确性。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { adminLotteryRoute } from "./admin-lottery";
import { signJwt } from "../middleware/auth";
import {
  tenants,
  users,
  tenantMembers,
  lotteryDraws,
  prizes,
  prizeCodes,
  lotteryPrizeTiers,
  lotteryEntries,
  lotteryWinners,
  lotteryRosterMembers,
  lotteryInviteCodes,
  activityOutcomes,
  platformTargets,
  platformDeliveries,
  systemConfig,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-admin-core-secret-0123456789ab";
const TENANT_A = "tenant-core-a";
const TENANT_B = "tenant-core-b";
const OWNER_A = "user-core-a";
const OWNER_B = "user-core-b";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};

beforeAll(async () => {
  ({ client, db } = await getTestDb());
  await db.insert(systemConfig).values({
    key: "enabled_activity_kinds",
    value: "lottery",
  });
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

async function seedTenant(tenantId: string, ownerId: string, username: string, email: string) {
  await db.insert(tenants).values({ id: tenantId, name: `Core Test ${tenantId}` });
  await db.insert(users).values({
    id: ownerId,
    username,
    email,
    emailVerified: 1,
    passwordHash: "hash",
  });
  await db.insert(tenantMembers).values({ tenantId, userId: ownerId, role: "owner" });
}

async function authHeader(ownerId: string, tenantId: string) {
  const token = await signJwt({ sub: ownerId, tenantId }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

// ============================================================
// Prize CRUD — 核心业务：奖品创建/编辑/多租户隔离
// ============================================================
describe("PR: Prize CRUD (admin-lottery-prizes.ts)", () => {
  describe("创建奖品", () => {
    it("创建后返回 id，且本租户能查到", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const createRes = await app.request("/api/admin/prizes", {
        method: "POST", headers,
        body: JSON.stringify({ name: "测试奖品", prizeType: "code" }),
      }, TEST_ENV);
      expect(createRes.status).toBe(200);
      const createBody = await createRes.json() as { id: string };
      expect(createBody.id).toBeTruthy();

      // 本租户能查到
      const listRes = await app.request("/api/admin/prizes", { headers }, TEST_ENV);
      const listBody = await listRes.json() as { prizes: Array<{ id: string; name: string }> };
      expect(listBody.prizes).toHaveLength(1);
      expect(listBody.prizes[0]?.name).toBe("测试奖品");
    });

    it("多租户隔离：A 创建的奖品 B 看不到", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      await seedTenant(TENANT_B, OWNER_B, "core-b", "b@test.com");
      const app = createTestApp();
      const headersA = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      await app.request("/api/admin/prizes", {
        method: "POST", headers: headersA,
        body: JSON.stringify({ name: "A的奖品", prizeType: "code" }),
      }, TEST_ENV);

      // B 查不到 A 的奖品
      const headersB = { ...(await authHeader(OWNER_B, TENANT_B)) };
      const listRes = await app.request("/api/admin/prizes", { headers: headersB }, TEST_ENV);
      const listBody = await listRes.json() as { prizes: Array<{ id: string }> };
      expect(listBody.prizes).toHaveLength(0);
    });
  });

  describe("编辑奖品", () => {
    it("修改名称、描述、active 状态", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const createRes = await app.request("/api/admin/prizes", {
        method: "POST", headers,
        body: JSON.stringify({ name: "原名称", prizeType: "code" }),
      }, TEST_ENV);
      const prizeId = ((await createRes.json()) as { id: string }).id;

      const editRes = await app.request(`/api/admin/prizes/${prizeId}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ name: "新名称", active: 0 }),
      }, TEST_ENV);
      expect(editRes.status).toBe(200);

      const [row] = await db.select().from(prizes).where(eq(prizes.id, prizeId));
      expect(row?.name).toBe("新名称");
      expect(row?.active).toBe(0);
    });

    it("空名称拒绝", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const createRes = await app.request("/api/admin/prizes", {
        method: "POST", headers,
        body: JSON.stringify({ name: "原名称", prizeType: "code" }),
      }, TEST_ENV);
      const prizeId = ((await createRes.json()) as { id: string }).id;

      const editRes = await app.request(`/api/admin/prizes/${prizeId}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ name: "  " }),
      }, TEST_ENV);
      expect(editRes.status).toBe(400);
    });

    it("不存在的奖品返回 404", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const editRes = await app.request("/api/admin/prizes/non-existent", {
        method: "PATCH", headers,
        body: JSON.stringify({ name: "新名称" }),
      }, TEST_ENV);
      expect(editRes.status).toBe(404);
    });
  });

  describe("docs/225 P0：奖品列表扩展（ids 回填 / 分页检索 / 直付占用 / 多租户隔离）", () => {
    async function seedPrizes(count: number, tenantId = TENANT_A) {
      const ids: string[] = [];
      const base = Date.now();
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID();
        // createdAt 递减：ids[0] 最新（desc 排最前），ids[count-1] 最旧（排最后，不在第一页）
        await db.insert(prizes).values({
          id, tenantId, name: `奖品-${i}`, prizeType: "code",
          description: "", imageUrl: "", valueText: `价值-${i}`, fulfillmentNote: "",
          totalCount: 0, usedCount: 0, active: 1,
          createdAt: new Date(base - i).toISOString(),
        });
        ids.push(id);
      }
      return ids;
    }

    it("51+ 奖品：默认只返回第一页（分页），第 51 个可通过搜索选中", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const ids = await seedPrizes(55);
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      // 默认第一页只返回 50 个（分页生效）
      const listRes = await app.request("/api/admin/prizes", { headers }, TEST_ENV);
      const listBody = await listRes.json() as { prizes: Array<{ id: string }>; total: number };
      expect(listBody.prizes).toHaveLength(50);
      expect(listBody.total).toBe(55);

      // 第 51 个（奖品-54）通过搜索可选中（旧实现第 51 个奖品永远无法被选择）
      const searchRes = await app.request("/api/admin/prizes?search=%E5%A5%96%E5%93%81-54", { headers }, TEST_ENV);
      const searchBody = await searchRes.json() as { prizes: Array<{ id: string; name: string }> };
      expect(searchBody.prizes.some((p) => p.id === ids[54])).toBe(true);
    });

    it("ids 回填：按 ID 获取已绑定奖品，包含停用奖品", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const [activeId, inactiveId] = await seedPrizes(2);
      // 停用第二个奖品
      await db.update(prizes).set({ active: 0 }).where(eq(prizes.id, inactiveId));
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/prizes?ids=${activeId},${inactiveId}`, { headers }, TEST_ENV);
      const body = await res.json() as { prizes: Array<{ id: string; active: number }> };
      expect(body.prizes).toHaveLength(2);
      expect(body.prizes.find((p) => p.id === inactiveId)?.active).toBe(0); // 停用奖品也能回填
    });

    it("ids 回填严格限制为最多 10 个，且不能与普通筛选混用", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const ids = await seedPrizes(11);
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const tooMany = await app.request(`/api/admin/prizes?ids=${ids.join(",")}`, { headers }, TEST_ENV);
      expect(tooMany.status).toBe(400);

      const mixed = await app.request(`/api/admin/prizes?ids=${ids[0]}&active=1`, { headers }, TEST_ENV);
      expect(mixed.status).toBe(400);
    });

    it("普通奖品目录默认保留启用和停用奖品；选择器显式 active=1", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const [activeId, inactiveId] = await seedPrizes(2);
      await db.update(prizes).set({ active: 0 }).where(eq(prizes.id, inactiveId));
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const catalog = await app.request("/api/admin/prizes", { headers }, TEST_ENV);
      const catalogBody = await catalog.json() as { prizes: Array<{ id: string }> };
      expect(catalogBody.prizes.map((p) => p.id)).toEqual(expect.arrayContaining([activeId, inactiveId]));

      const picker = await app.request("/api/admin/prizes?active=1", { headers }, TEST_ENV);
      const pickerBody = await picker.json() as { prizes: Array<{ id: string }> };
      expect(pickerBody.prizes.map((p) => p.id)).toContain(activeId);
      expect(pickerBody.prizes.map((p) => p.id)).not.toContain(inactiveId);
    });

    it("库存只在显式请求时返回，人工履约库存必须为 null", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const manualPrizeId = crypto.randomUUID();
      await db.insert(prizes).values({
        id: manualPrizeId, tenantId: TENANT_A, name: "人工奖", prizeType: "manual_fulfillment",
        description: "", imageUrl: "", valueText: "", fulfillmentNote: "",
        totalCount: 0, usedCount: 0, active: 1,
      });
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const catalog = await app.request("/api/admin/prizes", { headers }, TEST_ENV);
      const catalogBody = await catalog.json() as { prizes: Array<{ id: string; availableCount?: number | null }> };
      expect(catalogBody.prizes.find((p) => p.id === manualPrizeId)?.availableCount).toBeUndefined();

      const picker = await app.request("/api/admin/prizes?includeAvailability=1", { headers }, TEST_ENV);
      const pickerBody = await picker.json() as { prizes: Array<{ id: string; availableCount?: number | null }> };
      expect(pickerBody.prizes.find((p) => p.id === manualPrizeId)?.availableCount).toBeNull();
    });

    it("直付选择器：只返回卡密奖品，并标记其他进行中活动占用的码池", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      // 卡密奖品（未被占用）
      const codePrizeId = crypto.randomUUID();
      await db.insert(prizes).values({
        id: codePrizeId, tenantId: TENANT_A, name: "卡密奖", prizeType: "code",
        description: "", imageUrl: "", valueText: "10元", fulfillmentNote: "",
        totalCount: 0, usedCount: 0, active: 1,
      });
      // 人工履约奖品
      const manualPrizeId = crypto.randomUUID();
      await db.insert(prizes).values({
        id: manualPrizeId, tenantId: TENANT_A, name: "人工奖", prizeType: "manual_fulfillment",
        description: "", imageUrl: "", valueText: "", fulfillmentNote: "",
        totalCount: 0, usedCount: 0, active: 1,
      });
      // 进行中活动占用卡密奖品
      const drawId = crypto.randomUUID();
      await db.insert(lotteryDraws).values({
        id: drawId, tenantId: TENANT_A, publicSlug: `occupy-${drawId.slice(0, 8)}`, title: "占用活动",
        status: "open", activityKind: "claim", participationMode: "open",
        experienceType: "flash_sale", resultMode: "instant",
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
        winnerCount: 1, showParticipantCount: 1, showWinnerCount: 1, showWinnerList: 0, visible: 1,
        activityConfig: "{}", promotionConfig: "{}",
      });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_A, drawId, prizeId: codePrizeId,
        tierName: "一等奖", winnerCount: 1, sortOrder: 1, weight: 100,
      });

      const res = await app.request("/api/admin/prizes?prizeType=code&includeAvailability=1&directSaleDrawId=new", { headers }, TEST_ENV);
      const body = await res.json() as { prizes: Array<{ id: string; directSaleConflict: boolean; availableCount: number | null }> };
      // 卡密奖品被占用 → 选择器提前标记；发布预检仍是最终权威。
      const occupied = body.prizes.find((p) => p.id === codePrizeId);
      expect(occupied?.directSaleConflict).toBe(true);
      expect(occupied?.availableCount).toBe(0);
      // 人工履约奖品不在卡密候选（prizeType=code 过滤）
      expect(body.prizes.some((p) => p.id === manualPrizeId)).toBe(false);
    });

    it("编辑当前直付活动时不把自身已绑定的码池误判为冲突", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const prizeId = crypto.randomUUID();
      const drawId = crypto.randomUUID();
      await db.insert(prizes).values({
        id: prizeId, tenantId: TENANT_A, name: "独立卡密奖", prizeType: "code",
        description: "", imageUrl: "", valueText: "10元", fulfillmentNote: "",
        totalCount: 0, usedCount: 0, active: 1,
      });
      await db.insert(lotteryDraws).values({
        id: drawId, tenantId: TENANT_A, publicSlug: `self-${drawId.slice(0, 8)}`, title: "当前活动",
        status: "open", activityKind: "claim", participationMode: "open",
        experienceType: "flash_sale", resultMode: "instant",
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
        winnerCount: 1, showParticipantCount: 1, showWinnerCount: 1, showWinnerList: 0, visible: 1,
        activityConfig: "{}", promotionConfig: "{}",
      });
      await db.insert(lotteryPrizeTiers).values({
        id: crypto.randomUUID(), tenantId: TENANT_A, drawId, prizeId,
        tierName: "一等奖", winnerCount: 1, sortOrder: 1, weight: 100,
      });
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/prizes?prizeType=code&directSaleDrawId=${drawId}`, { headers }, TEST_ENV);
      const body = await res.json() as { prizes: Array<{ id: string; directSaleConflict: boolean }> };
      expect(body.prizes.find((p) => p.id === prizeId)?.directSaleConflict).toBe(false);
    });

    it("多租户隔离：A 租户 ids 查不到 B 租户奖品", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      await seedTenant(TENANT_B, OWNER_B, "core-b", "b@test.com");
      const app = createTestApp();
      const headersA = await authHeader(OWNER_A, TENANT_A);
      const headersB = await authHeader(OWNER_B, TENANT_B);

      // B 创建奖品
      const createRes = await app.request("/api/admin/prizes", {
        method: "POST", headers: headersB,
        body: JSON.stringify({ name: "B的奖品", prizeType: "code" }),
      }, TEST_ENV);
      const { id: bPrizeId } = await createRes.json() as { id: string };

      // A 用 B 的奖品 id 查询 → 查不到（租户隔离）
      const res = await app.request(`/api/admin/prizes?ids=${bPrizeId}`, { headers: headersA }, TEST_ENV);
      const body = await res.json() as { prizes: Array<{ id: string }> };
      expect(body.prizes).toHaveLength(0);
    });
  });
});

describe("活动发布出站闭环", () => {
  it("发布活动后会写入 draw.published 平台投递队列", async () => {
    await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
    const app = createTestApp();
    const drawId = crypto.randomUUID();
    const now = new Date();
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT_A,
      publicSlug: `publish-${drawId.slice(0, 8)}`,
      title: "发布事件测试",
      status: "draft",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      drawTrigger: "manual",
      resultMode: "manual",
      startAt: new Date(now.getTime() - 60_000).toISOString(),
      endAt: new Date(now.getTime() + 3_600_000).toISOString(),
      winnerCount: 1,
      showParticipantCount: 1,
      showWinnerCount: 1,
      showWinnerList: 0,
      visible: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const prizeId = crypto.randomUUID();
    await db.insert(prizes).values({
      id: prizeId,
      tenantId: TENANT_A,
      name: "发布测试奖品",
      prizeType: "physical",
      active: 1,
      totalCount: 1,
      usedCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await db.insert(lotteryPrizeTiers).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_A,
      drawId,
      prizeId,
      tierName: "一等奖",
      winnerCount: 1,
      sortOrder: 1,
      weight: 100,
    });
    await db.insert(platformTargets).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_A,
      platform: "qq",
      targetId: "123456",
      targetName: "发布测试群",
      activeDrawId: drawId,
      activePublicSlug: `publish-${drawId.slice(0, 8)}`,
      assistantEnabled: 1,
      adapterDeploymentMode: "tenant_hosted",
      adapterProvider: "napcat",
      adapterConfigJson: "{}",
      builtinCommandsJson: "{}",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const res = await app.request(`/api/admin/draws/${drawId}/publish`, {
      method: "POST",
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const deliveries = await db
      .select()
      .from(platformDeliveries)
      .where(and(eq(platformDeliveries.tenantId, TENANT_A), eq(platformDeliveries.eventType, "draw.published")));
    expect(deliveries).toHaveLength(1);
    const payload = JSON.parse(deliveries[0]!.payloadJson) as { renderedMessage: string };
    expect(payload.renderedMessage).toContain("发布事件测试");
  });
});
// ============================================================
// 奖品码池 — 核心业务：导入/生成/查询/导出/删除
// ============================================================
describe("PC: Prize Code Pool (admin-lottery-prizes.ts)", () => {
  let prizeId: string;

  async function seedPrize() {
    await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
    const now = new Date().toISOString();
    prizeId = "prize-pool-test";
    await db.insert(prizes).values({
      id: prizeId,
      tenantId: TENANT_A,
      name: "码池测试奖品",
      prizeType: "code",
      active: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  describe("导入码", () => {
    it("导入成功，码池可查", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const importRes = await app.request(`/api/admin/prizes/${prizeId}/codes/import`, {
        method: "POST", headers,
        body: JSON.stringify({ codes: [{ code: "CODE001", secret: "SEC001" }, { code: "CODE002" }] }),
      }, TEST_ENV);
      expect(importRes.status).toBe(200);
      expect(((await importRes.json()) as { imported: number }).imported).toBe(2);

      const rows = await db.select().from(prizeCodes).where(and(
        eq(prizeCodes.tenantId, TENANT_A),
        eq(prizeCodes.prizeId, prizeId),
      ));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.code).sort()).toEqual(["CODE001", "CODE002"]);
    });

    it("空码列表拒绝", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/prizes/${prizeId}/codes/import`, {
        method: "POST", headers,
        body: JSON.stringify({ codes: [] }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    });

    it("不存在的奖品返回 400", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request("/api/admin/prizes/non-existent/codes/import", {
        method: "POST", headers,
        body: JSON.stringify({ codes: [{ code: "X" }] }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
      const body = await res.json() as { message?: string };
      expect(body.message).toContain("奖品不存在");
    });
  });

  describe("生成码", () => {
    it("生成指定数量，排除易混淆字符", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const genRes = await app.request(`/api/admin/prizes/${prizeId}/codes/generate`, {
        method: "POST", headers,
        body: JSON.stringify({ count: 5, prefix: "PRE", codeLength: 6, secretLength: 4 }),
      }, TEST_ENV);
      expect(genRes.status).toBe(200);
      expect(((await genRes.json()) as { generated: number }).generated).toBe(5);

      const rows = await db.select().from(prizeCodes).where(and(
        eq(prizeCodes.tenantId, TENANT_A),
        eq(prizeCodes.prizeId, prizeId),
      ));
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        // 前缀 + 排除易混淆字符 0/O/1/I/l
        expect(row.code).toMatch(/^PRE[A-HJKMNP-Z2-9]{6}$/);
        expect(row.secret).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
      }
    });
  });
describe("查询码池", () => {
    it("按状态筛选、统计，支持码文本搜索", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();

      await db.insert(prizeCodes).values([
        { id: "pc-avail-1", tenantId: TENANT_A, prizeId, code: "AAA", status: "available", createdAt: now },
        { id: "pc-issued-1", tenantId: TENANT_A, prizeId, code: "BBB", status: "issued", createdAt: now },
        { id: "pc-avail-2", tenantId: TENANT_A, prizeId, code: "CCC", status: "available", createdAt: now },
      ]);

      const allRes = await app.request(`/api/admin/prizes/${prizeId}/codes`, { headers }, TEST_ENV);
      const allBody = await allRes.json() as { codes: Array<{ code: string }>; total: number; totalAvailable: number; totalIssued: number };
      expect(allBody.total).toBe(3);
      expect(allBody.totalAvailable).toBe(2);
      expect(allBody.totalIssued).toBe(1);

      const availRes = await app.request(`/api/admin/prizes/${prizeId}/codes?status=available`, { headers }, TEST_ENV);
      const availBody = await availRes.json() as { codes: Array<{ code: string }> };
      expect(availBody.codes).toHaveLength(2);

      const searchRes = await app.request(`/api/admin/prizes/${prizeId}/codes?search=BB`, { headers }, TEST_ENV);
      const searchBody = await searchRes.json() as { codes: Array<{ code: string }> };
      expect(searchBody.codes).toHaveLength(1);
      expect(searchBody.codes[0]?.code).toBe("BBB");
    });
  });

  describe("导出 CSV", () => {
    it("导出内容包含表头、码值、状态中文", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();

      await db.insert(prizeCodes).values([
        { id: "pc-exp-1", tenantId: TENANT_A, prizeId, code: "EXPORT1", secret: "S1", status: "available", createdAt: now },
        { id: "pc-exp-2", tenantId: TENANT_A, prizeId, code: "EXPORT2", secret: "S2", status: "issued", createdAt: now },
      ]);

      const res = await app.request(`/api/admin/prizes/${prizeId}/codes/export`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("卡密,密钥,状态,备注");
      expect(text).toContain("EXPORT1");
      expect(text).toContain("EXPORT2");
      expect(text).toContain("可用");
      expect(text).toContain("已发放");
    });

    it("按状态筛选导出", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();

      await db.insert(prizeCodes).values([
        { id: "pc-exp-3", tenantId: TENANT_A, prizeId, code: "EXP3", secret: "S3", status: "available", createdAt: now },
        { id: "pc-exp-4", tenantId: TENANT_A, prizeId, code: "EXP4", secret: "S4", status: "issued", createdAt: now },
      ]);

      const res = await app.request(`/api/admin/prizes/${prizeId}/codes/export?status=issued`, { headers }, TEST_ENV);
      const text = await res.text();
      expect(text).toContain("EXP4");
      expect(text).not.toContain("EXP3");
    });

    it("不存在的奖品返回 404", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request("/api/admin/prizes/non-existent/codes/export", { headers }, TEST_ENV);
      expect(res.status).toBe(404);
    });
  });

  describe("删除单个码", () => {
    it("available 状态可删", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();
      await db.insert(prizeCodes).values({
        id: "pc-del-1", tenantId: TENANT_A, prizeId, code: "DEL1", status: "available", createdAt: now,
      });

      const res = await app.request("/api/admin/prizes/codes/pc-del-1", { method: "DELETE", headers }, TEST_ENV);
      expect(res.status).toBe(200);

      const remaining = await db.select().from(prizeCodes).where(eq(prizeCodes.id, "pc-del-1"));
      expect(remaining).toHaveLength(0);
    });

    it("issued 状态拒绝删除", async () => {
      await seedPrize();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();
      await db.insert(prizeCodes).values({
        id: "pc-del-2", tenantId: TENANT_A, prizeId, code: "DEL2", status: "issued", createdAt: now,
      });

      const res = await app.request("/api/admin/prizes/codes/pc-del-2", { method: "DELETE", headers }, TEST_ENV);
      expect(res.status).toBe(404);
    });

    it("不存在的码返回 404", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request("/api/admin/prizes/codes/non-existent", { method: "DELETE", headers }, TEST_ENV);
      expect(res.status).toBe(404);
    });
  });
});
// ============================================================
// Draw Operations — 核心业务：中奖名单/候选池/审核/名单导入/邀请码
// ============================================================
describe("DP: Draw Operations (admin-lottery-draw-ops.ts)", () => {
  const DRAW_ID = "draw-ops-test";
  const ENTRY_ID_A = "entry-ops-a";
  const ENTRY_ID_B = "entry-ops-b";
  const PRIZE_ID = "prize-ops";
  const TIER_ID = "tier-ops";
  const WINNER_ID = "winner-ops";

  async function seedDraw() {
    await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
    await seedTenant(TENANT_B, OWNER_B, "core-b", "b@test.com");
    const now = new Date().toISOString();

    await db.insert(lotteryDraws).values([{
      id: DRAW_ID,
      tenantId: TENANT_A,
      publicSlug: "draw-ops-test",
      title: "运营测试活动",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "scheduled",
      startAt: now,
      endAt: now,
    }, {
      id: "draw-ops-other",
      tenantId: TENANT_B,
      publicSlug: "draw-ops-other",
      title: "B的活动",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "scheduled",
      startAt: now,
      endAt: now,
    }]);

    await db.insert(prizes).values({
      id: PRIZE_ID, tenantId: TENANT_A, name: "测试中奖奖品", prizeType: "code", active: 1, createdAt: now, updatedAt: now,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: TIER_ID, tenantId: TENANT_A, drawId: DRAW_ID, prizeId: PRIZE_ID,
      tierName: "一等奖", winnerCount: 1, sortOrder: 1, weight: 100,
    });
    await db.insert(lotteryEntries).values([
      { id: ENTRY_ID_A, tenantId: TENANT_A, drawId: DRAW_ID, identityType: "email", identityValue: "winner@test.com", paymentStatus: "none" },
      { id: ENTRY_ID_B, tenantId: TENANT_A, drawId: DRAW_ID, identityType: "email", identityValue: "entrant@test.com", paymentStatus: "none" },
    ]);
    await db.insert(lotteryWinners).values({
      id: WINNER_ID, tenantId: TENANT_A, drawId: DRAW_ID, entryId: ENTRY_ID_A,
      tierId: TIER_ID, identityType: "email", identityValue: "winner@test.com",
    });

    // B 的独立数据，用于隔离验证
    await db.insert(lotteryEntries).values({
      id: "entry-b-1", tenantId: TENANT_B, drawId: "draw-ops-other",
      identityType: "email", identityValue: "b@test.com", paymentStatus: "none",
    });
    await db.insert(lotteryWinners).values({
      id: "winner-b-1", tenantId: TENANT_B, drawId: "draw-ops-other",
      entryId: "entry-b-1", tierId: "tier-b",
      identityType: "email", identityValue: "b@test.com",
    });
  }

  describe("中奖名单", () => {
    it("返回本活动的中奖者，不包含其他租户", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/draws/${DRAW_ID}/winners`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { winners: Array<{ id: string; identityValue: string }> };
      expect(body.winners.some((w) => w.identityValue === "b@test.com")).toBe(false);
      expect(body.winners.some((w) => w.identityValue === "winner@test.com")).toBe(true);
    });
  });

  describe("候选池", () => {
    it("返回本活动的参与者", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/draws/${DRAW_ID}/entries`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<{ id: string }> };
      expect(body.entries.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("统一导出", () => {
    it("活动列表导出复用 active 虚拟筛并防 CSV 公式注入", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();
      await db.insert(lotteryDraws).values([
        {
          id: "export-active-open",
          tenantId: TENANT_A,
          publicSlug: "export-active-open",
          title: "=HYPERLINK(\"https://bad.example\")",
          status: "open",
          activityKind: "lottery",
          participationMode: "open",
          experienceType: "wheel",
          resultMode: "scheduled",
          startAt: now,
          endAt: now,
        },
        {
          id: "export-active-drawn",
          tenantId: TENANT_A,
          publicSlug: "export-active-drawn",
          title: "已结束活动",
          status: "drawn",
          activityKind: "lottery",
          participationMode: "open",
          experienceType: "wheel",
          resultMode: "scheduled",
          startAt: now,
          endAt: now,
        },
      ]);

      const res = await app.request("/api/admin/draws/export?status=active", { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.clone().arrayBuffer());
      expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      const text = await res.text();
      expect(text).toContain("'=HYPERLINK");
      expect(text).not.toContain("已结束活动");
    });

    it("活动列表导出超过单批上限时拒绝，要求运营分批", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);
      const now = new Date().toISOString();
      await db.insert(lotteryDraws).values([
        {
          id: "export-limit-1",
          tenantId: TENANT_A,
          publicSlug: "export-limit-1",
          title: "导出 1",
          status: "open",
          activityKind: "lottery",
          participationMode: "open",
          experienceType: "wheel",
          resultMode: "scheduled",
          startAt: now,
          endAt: now,
        },
        {
          id: "export-limit-2",
          tenantId: TENANT_A,
          publicSlug: "export-limit-2",
          title: "导出 2",
          status: "open",
          activityKind: "lottery",
          participationMode: "open",
          experienceType: "wheel",
          resultMode: "scheduled",
          startAt: now,
          endAt: now,
        },
      ]);

      const res = await app.request("/api/admin/draws/export?status=active&limit=1", { headers }, TEST_ENV);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("分批导出");
    });

    it("按活动导出中奖名单走后端完整数据且保持租户隔离", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/draws/${DRAW_ID}/export?scope=winners`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("中奖者,奖品,档位,履约类型,卡密,中奖时间,邮件状态");
      expect(text).toContain("winner@test.com");
      expect(text).toContain("测试中奖奖品");
      expect(text).not.toContain("b@test.com");
    });

    it("按活动导出参与名单支持 limit/offset 分批", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/draws/${DRAW_ID}/export?scope=entries&limit=1`, { headers }, TEST_ENV);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("offset/limit");

      const pageRes = await app.request(`/api/admin/draws/${DRAW_ID}/export?scope=entries&limit=1&offset=1`, { headers }, TEST_ENV);
      expect(pageRes.status).toBe(200);
      const pageText = await pageRes.text();
      expect(pageText).toContain("参与者,参与时间");
    });

    it("scope=all 按整份 CSV 总行数限制，避免多个分区叠加撑爆导出", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = await authHeader(OWNER_A, TENANT_A);

      const res = await app.request(`/api/admin/draws/${DRAW_ID}/export?scope=all&limit=2`, { headers }, TEST_ENV);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("单次导出超过 2 行");
    });
  });

  describe("大表查询计划", () => {
    it("参与名单导出查询使用 tenant+draw+joined_at 索引", async () => {
      const plan = await client.execute({
        sql: "EXPLAIN QUERY PLAN SELECT * FROM lottery_entries WHERE tenant_id = ? AND draw_id = ? ORDER BY joined_at LIMIT 100",
        args: [TENANT_A, DRAW_ID],
      });
      const detail = plan.rows.map((row) => String(row.detail || "")).join("\n");
      expect(detail).toContain("idx_entries_tenant_draw_joined");
      expect(detail).not.toContain("SCAN lottery_entries");
    });

    it("中奖名单导出查询使用 tenant+draw+drawn_at 索引", async () => {
      const plan = await client.execute({
        sql: "EXPLAIN QUERY PLAN SELECT * FROM lottery_winners WHERE tenant_id = ? AND draw_id = ? ORDER BY drawn_at DESC LIMIT 100",
        args: [TENANT_A, DRAW_ID],
      });
      const detail = plan.rows.map((row) => String(row.detail || "")).join("\n");
      expect(detail).toContain("idx_winners_draw");
      expect(detail).not.toContain("SCAN lottery_winners");
    });
  });
describe("审核申请", () => {
    const APPROVAL_DRAW_ID = "draw-approval";
    const APP_ENTRY_ID = "entry-approval";

    async function seedApprovalDraw() {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const now = new Date().toISOString();
      await db.insert(lotteryDraws).values({
        id: APPROVAL_DRAW_ID,
        tenantId: TENANT_A,
        publicSlug: "draw-approval",
        title: "审批活动",
        status: "open",
        activityKind: "approval",
        participationMode: "open",
        experienceType: "submit",
        resultMode: "manual",
        startAt: now,
        endAt: now,
      });
      await db.insert(lotteryEntries).values({
        id: APP_ENTRY_ID,
        tenantId: TENANT_A,
        drawId: APPROVAL_DRAW_ID,
        identityType: "email",
        identityValue: "applicant@test.com",
        paymentStatus: "none",
      });
    }

    it("批准申请写入 outcome", async () => {
      await seedApprovalDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${APPROVAL_DRAW_ID}/review`, {
        method: "POST", headers,
        body: JSON.stringify({ entryId: APP_ENTRY_ID, decision: "approved" }),
      }, TEST_ENV);
      expect(res.status).toBe(200);

      const [outcome] = await db.select()
        .from(activityOutcomes)
        .where(and(eq(activityOutcomes.drawId, APPROVAL_DRAW_ID), eq(activityOutcomes.entryId, APP_ENTRY_ID)));
      expect(outcome).toBeTruthy();
      expect(outcome?.status).toBe("approved");
    });

    it("拒绝申请写入 outcome", async () => {
      await seedApprovalDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${APPROVAL_DRAW_ID}/review`, {
        method: "POST", headers,
        body: JSON.stringify({ entryId: APP_ENTRY_ID, decision: "rejected", reason: "资料不全" }),
      }, TEST_ENV);
      expect(res.status).toBe(200);

      const [outcome] = await db.select()
        .from(activityOutcomes)
        .where(and(eq(activityOutcomes.drawId, APPROVAL_DRAW_ID), eq(activityOutcomes.entryId, APP_ENTRY_ID)));
      expect(outcome?.status).toBe("rejected");
    });

    it("缺少 entryId / decision 拒绝", async () => {
      await seedApprovalDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${APPROVAL_DRAW_ID}/review`, {
        method: "POST", headers,
        body: JSON.stringify({ entryId: "", decision: "" }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    });

    it("非 approval 活动拒绝", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${DRAW_ID}/review`, {
        method: "POST", headers,
        body: JSON.stringify({ entryId: ENTRY_ID_A, decision: "approved" }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    });
  });
describe("导入名单 (roster)", () => {
    const ROSTER_DRAW_ID = "draw-roster";

    async function seedRosterDraw() {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const now = new Date().toISOString();
      await db.insert(lotteryDraws).values({
        id: ROSTER_DRAW_ID,
        tenantId: TENANT_A,
        publicSlug: "draw-roster",
        title: "名单导入测试",
        status: "draft",
        activityKind: "lottery",
        participationMode: "roster",
        experienceType: "submit",
        resultMode: "manual",
        startAt: now,
        endAt: now,
      });
    }

    it("导入成员成功", async () => {
      await seedRosterDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers,
        body: JSON.stringify({ members: [
          { email: "alice@test.com", name: "Alice" },
          { email: "bob@test.com", name: "Bob" },
        ] }),
      }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { imported: number; skipped: number };
      expect(body.imported).toBe(2);
      expect(body.skipped).toBe(0);

      const rows = await db.select().from(lotteryRosterMembers)
        .where(eq(lotteryRosterMembers.drawId, ROSTER_DRAW_ID));
      expect(rows).toHaveLength(2);
    });

    it("重复邮箱跳过不报错", async () => {
      await seedRosterDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers,
        body: JSON.stringify({ members: [{ email: "alice@test.com" }] }),
      }, TEST_ENV);

      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers,
        body: JSON.stringify({ members: [{ email: "alice@test.com" }, { email: "carol@test.com" }] }),
      }, TEST_ENV);
      const body = await res.json() as { imported: number; skipped: number };
      expect(body.imported).toBe(1);
      expect(body.skipped).toBe(1);
    });

    it("非草稿状态拒绝导入", async () => {
      await seedRosterDraw();
      await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, ROSTER_DRAW_ID));
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers,
        body: JSON.stringify({ members: [{ email: "dave@test.com" }] }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    });

    it("空成员列表拒绝", async () => {
      await seedRosterDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers,
        body: JSON.stringify({ members: [] }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    });

    it("查询名单成员（GET）返回已导入成员", async () => {
      await seedRosterDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      // 先导入 2 个成员
      await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers,
        body: JSON.stringify({ members: [
          { email: "alice@test.com", name: "Alice" },
          { email: "bob@test.com", name: "Bob" },
        ] }),
      }, TEST_ENV);

      // GET 查询
      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { members: Array<{ identityValue: string; displayName: string }>; totalCount: number };
      expect(body.totalCount).toBe(2);
      expect(body.members).toHaveLength(2);
      // 邮箱以原文返回（内部调 lower case 存储，读回一致）
      expect(body.members.map((m) => m.identityValue).sort()).toEqual(["alice@test.com", "bob@test.com"]);
      expect(body.members.find((m) => m.identityValue === "alice@test.com")?.displayName).toBe("Alice");
    });

    it("查询名单成员（GET）空名单返回空数组", async () => {
      await seedRosterDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { members: unknown[]; totalCount: number };
      expect(body.totalCount).toBe(0);
      expect(body.members).toHaveLength(0);
    });

    it("查询名单成员（GET）跨租户隔离", async () => {
      await seedRosterDraw();
      // 导入成员到 A 租户
      const app = createTestApp();
      const headersA = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };
      await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, {
        method: "POST", headers: headersA,
        body: JSON.stringify({ members: [{ email: "alice@test.com" }] }),
      }, TEST_ENV);

      // B 租户查询 A 的活动 → 404（租户隔离）
      await seedTenant(TENANT_B, OWNER_B, "core-b", "b@test.com");
      const headersB = { "Content-Type": "application/json", ...(await authHeader(OWNER_B, TENANT_B)) };
      const res = await app.request(`/api/admin/draws/${ROSTER_DRAW_ID}/roster`, { headers: headersB }, TEST_ENV);
      expect(res.status).toBe(404);
    });
  });

  describe("生成邀请码", () => {
    const INVITE_DRAW_ID = "draw-invite";

    async function seedInviteDraw() {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const now = new Date().toISOString();
      await db.insert(lotteryDraws).values({
        id: INVITE_DRAW_ID,
        tenantId: TENANT_A,
        publicSlug: "draw-invite",
        title: "邀请码测试",
        status: "draft",
        activityKind: "lottery",
        participationMode: "invite_code",
        experienceType: "submit",
        resultMode: "manual",
        startAt: now,
        endAt: now,
      });
    }

    it("生成指定数量的邀请码", async () => {
      await seedInviteDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, {
        method: "POST", headers,
        body: JSON.stringify({ count: 3, maxUses: 5 }),
      }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { codes: string[]; count: number };
      expect(body.count).toBe(3);
      expect(body.codes).toHaveLength(3);
      body.codes.forEach((code) => {
        expect(code).toMatch(/^[A-Z0-9]{8}$/);
      });

      const rows = await db.select().from(lotteryInviteCodes)
        .where(eq(lotteryInviteCodes.drawId, INVITE_DRAW_ID));
      expect(rows).toHaveLength(3);
      rows.forEach((row) => {
        expect(row.maxUses).toBe(5);
      });
    });

    it("非草稿状态拒绝生成", async () => {
      await seedInviteDraw();
      await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, INVITE_DRAW_ID));
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, {
        method: "POST", headers,
        body: JSON.stringify({ count: 1 }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    });

    it("查询邀请码（GET）返回已生成的邀请码", async () => {
      await seedInviteDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      // 先 POST 生成 3 个邀请码
      await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, {
        method: "POST", headers,
        body: JSON.stringify({ count: 3, maxUses: 5 }),
      }, TEST_ENV);

      // GET 查询
      const res = await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { codes: Array<{ code: string; maxUses: number; usedCount: number; active: number }>; totalCount: number };
      expect(body.totalCount).toBe(3);
      expect(body.codes).toHaveLength(3);
      body.codes.forEach((code) => {
        expect(code.code).toMatch(/^[A-Z0-9]{8}$/);
        expect(code.maxUses).toBe(5);
        expect(code.usedCount).toBe(0);
        expect(code.active).toBe(1);
      });
    });

    it("查询邀请码（GET）无邀请码时返回空数组", async () => {
      await seedInviteDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      const res = await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, { headers }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { codes: unknown[]; totalCount: number };
      expect(body.totalCount).toBe(0);
      expect(body.codes).toHaveLength(0);
    });

    it("查询邀请码（GET）跨租户隔离", async () => {
      await seedInviteDraw();
      const app = createTestApp();
      const headersA = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };
      await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, {
        method: "POST", headers: headersA,
        body: JSON.stringify({ count: 2 }),
      }, TEST_ENV);

      // B 租户查询 A 的活动 → 404
      await seedTenant(TENANT_B, OWNER_B, "core-b", "b@test.com");
      const headersB = { "Content-Type": "application/json", ...(await authHeader(OWNER_B, TENANT_B)) };
      const res = await app.request(`/api/admin/draws/${INVITE_DRAW_ID}/invite-codes`, { headers: headersB }, TEST_ENV);
      expect(res.status).toBe(404);
    });

    it("排行榜奖励发放：非 instant 模式 → 400 拒绝（delayed/manual 由开奖自动发放）", async () => {
      await seedDraw();
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

      // seedDraw 的 DRAW_ID 是 resultMode=scheduled
      const res = await app.request(`/api/admin/draws/${DRAW_ID}/leaderboard-rewards`, {
        method: "POST", headers,
      }, TEST_ENV);
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toContain("自动发放");
    });

    it("排行榜奖励发放：instant 未到结束时间 → 400 拒绝（防过早发放锁排名快照）", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const future = new Date(Date.now() + 7 * 86400_000).toISOString();
      await db.insert(lotteryDraws).values({
        id: "draw-lb-early", tenantId: TENANT_A, title: "未结束的instant", publicSlug: "lb-early",
        status: "open", activityKind: "lottery", participationMode: "open",
        experienceType: "wheel", resultMode: "instant",
        startAt: new Date().toISOString(), endAt: future,
        promotionConfig: JSON.stringify({ viral: { enabled: true, leaderboardEnabled: true, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] } }),
      });
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };
      const res = await app.request(`/api/admin/draws/draw-lb-early/leaderboard-rewards`, {
        method: "POST", headers,
      }, TEST_ENV);
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toContain("未到结束时间");
    });

    it("排行榜奖励发放：instant 已到结束时间 → 200 发放成功", async () => {
      await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
      const past = new Date(Date.now() - 86400_000).toISOString();
      await db.insert(lotteryDraws).values({
        id: "draw-lb-done", tenantId: TENANT_A, title: "已结束的instant", publicSlug: "lb-done",
        status: "open", activityKind: "lottery", participationMode: "open",
        experienceType: "wheel", resultMode: "instant",
        startAt: new Date(Date.now() - 2 * 86400_000).toISOString(), endAt: past,
        promotionConfig: JSON.stringify({ viral: { enabled: true, leaderboardEnabled: true, leaderboardRewards: [{ rank: 1, rewardType: "bonus_spin", rewardValue: 3 }] } }),
      });
      const app = createTestApp();
      const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };
      const res = await app.request(`/api/admin/draws/draw-lb-done/leaderboard-rewards`, {
        method: "POST", headers,
      }, TEST_ENV);
      expect(res.status).toBe(200);
      const body = await res.json() as { granted?: number; skipped?: number };
      expect(body.granted).toBe(0); // 无有效分享者 → 0 发放（幂等安全）
      expect(body.skipped).toBe(0);
    });
  });
});

describe("活动复制", () => {
  const COPY_DRAW = "draw-copy-src";
  const COPY_PRIZE = "prize-copy";

  afterEach(async () => {
    await clearTestData(client);
  });

  async function seedCopyDraw() {
    await seedTenant(TENANT_A, OWNER_A, "copy-owner", "copy@test.com");
    await db.insert(lotteryDraws).values({
      id: COPY_DRAW, tenantId: TENANT_A, title: "原始活动", publicSlug: "copy-src",
      status: "open", activityKind: "lottery", participationMode: "open",
      experienceType: "wheel", resultMode: "manual", drawTrigger: "manual",
      maxParticipants: 100, startAt: "2025-01-01T00:00:00Z", endAt: "2025-12-31T00:00:00Z",
      activityConfig: JSON.stringify({ prizeImage: "https://example.com/img.png" }),
      promotionConfig: JSON.stringify({ viral: { enabled: true } }),
    });
    await db.insert(prizes).values({
      id: COPY_PRIZE, tenantId: TENANT_A, name: "原始奖品", prizeType: "code", totalCount: 10, active: 1,
    });
    await db.insert(lotteryPrizeTiers).values({
      id: "tier-copy", tenantId: TENANT_A, drawId: COPY_DRAW, prizeId: COPY_PRIZE,
      tierName: "一等奖", winnerCount: 3, weight: 100, sortOrder: 1,
    });
  }

  it("复制活动后数据完整（标题/配置/奖品/奖档均复制，ID 不同）", async () => {
    await seedCopyDraw();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

    const res = await app.request(`/api/admin/draws/${COPY_DRAW}/copy`, {
      method: "POST", headers,
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    const newDrawId = data.id as string;
    expect(newDrawId).toBeTruthy();
    expect(newDrawId).not.toBe(COPY_DRAW);

    // 验证新活动数据完整
    const [newDraw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, newDrawId)).limit(1);
    expect(newDraw).toBeDefined();
    expect(newDraw!.title).toBe("原始活动（副本）");
    expect(newDraw!.tenantId).toBe(TENANT_A);
    expect(newDraw!.status).toBe("draft");
    expect(newDraw!.activityKind).toBe("lottery");
    expect(newDraw!.participationMode).toBe("open");
    expect(newDraw!.activityConfig).toBe(JSON.stringify({ prizeImage: "https://example.com/img.png" }));
  });
});

// P0/P1 修复（2026-08 审查）：PATCH 编辑语义——JSON 键级 merge、accessPassword 三态、detail 脱敏
describe("活动编辑 PATCH 语义", () => {
  async function seedDraftDraw(opts: { accessPassword?: string; activityConfig?: string; promotionConfig?: string } = {}) {
    await seedTenant(TENANT_A, OWNER_A, "core-a", "a@test.com");
    const drawId = crypto.randomUUID();
    const now = new Date();
    const { hashAccessPassword } = await import("../services/lottery/utils");
    await db.insert(lotteryDraws).values({
      id: drawId,
      tenantId: TENANT_A,
      publicSlug: `patch-${drawId.slice(0, 8)}`,
      title: "PATCH 测试",
      status: "draft",
      activityKind: "lottery",
      participationMode: "password",
      experienceType: "wheel",
      drawTrigger: "manual",
      resultMode: "manual",
      startAt: new Date(now.getTime() - 60_000).toISOString(),
      endAt: new Date(now.getTime() + 3_600_000).toISOString(),
      winnerCount: 1,
      showParticipantCount: 1,
      showWinnerCount: 1,
      showWinnerList: 0,
      visible: 1,
      accessPassword: opts.accessPassword ? await hashAccessPassword(opts.accessPassword) : "",
      activityConfig: opts.activityConfig ?? "{}",
      promotionConfig: opts.promotionConfig ?? "{}",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return drawId;
  }

  it("P0 回归：PATCH 传空 accessPassword 不清空已有密码（编辑任意字段不再移除访问门禁）", async () => {
    const drawId = await seedDraftDraw({ accessPassword: "secret123" });
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

    const res = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ title: "改了标题", accessPassword: "" }), // 编辑表单恒发空串
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(draw!.title).toBe("改了标题");
    expect(draw!.accessPassword).not.toBe(""); // 密码保留
  });

  it("PATCH accessPassword=null 显式清空密码；非空则重新哈希设置", async () => {
    const drawId = await seedDraftDraw({ accessPassword: "oldpass" });
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

    // 非空 → 更新（哈希带盐，用 verify 校验而非直接比对）
    const res1 = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ accessPassword: "newpass" }),
    }, TEST_ENV);
    expect(res1.status).toBe(200);
    const { verifyAccessPassword } = await import("../services/lottery/utils");
    const [afterSet] = await db.select({ pwd: lotteryDraws.accessPassword }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(await verifyAccessPassword("newpass", afterSet!.pwd)).toBe(true);
    expect(await verifyAccessPassword("oldpass", afterSet!.pwd)).toBe(false);

    // null → 清空
    const res2 = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ accessPassword: null }),
    }, TEST_ENV);
    expect(res2.status).toBe(200);
    const [afterClear] = await db.select({ pwd: lotteryDraws.accessPassword }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(afterClear!.pwd).toBe("");
  });

  it("P1 回归：activityConfig 顶层键级 merge——未知键（operational/prizeImage）编辑后保留", async () => {
    const drawId = await seedDraftDraw({
      activityConfig: JSON.stringify({
        version: 1,
        kind: "lottery",
        operational: { joinIpLimitPerMinute: 5 },
        prizeImage: "https://example.com/img.png",
        loserReward: { enabled: true, couponLabel: "安慰奖" },
      }),
    });
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

    // 编辑表单重建整包（只含 loserReward）→ merge 后 operational/prizeImage 必须保留
    const res = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({
        activityConfig: { version: 1, kind: "lottery", loserReward: { enabled: false, couponLabel: "" } },
      }),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    const merged = JSON.parse(draw!.activityConfig) as Record<string, unknown>;
    expect(merged.loserReward).toEqual({ enabled: false, couponLabel: "" }); // 新值覆盖
    expect((merged.operational as Record<string, unknown>).joinIpLimitPerMinute).toBe(5); // 未知键保留
    expect(merged.prizeImage).toBe("https://example.com/img.png"); // 未知键保留
    expect(merged.version).toBe(1);
  });

  it("P1 回归：promotionConfig merge 保留未回填块（flashSale 等）", async () => {
    const drawId = await seedDraftDraw({
      promotionConfig: JSON.stringify({ flashSale: { enabled: true, stockLimit: 100 } }),
    });
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

    const res = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ promotionConfig: { viral: { enabled: true } } }),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    const merged = JSON.parse(draw!.promotionConfig) as Record<string, unknown>;
    expect((merged.viral as Record<string, unknown>).enabled).toBe(true);
    expect((merged.flashSale as Record<string, unknown>).enabled).toBe(true); // 旧块保留
  });

  it("P0 回归：detail 返回 hasAccessPassword 布尔，不泄露密码哈希", async () => {
    const drawId = await seedDraftDraw({ accessPassword: "secret123" });
    const app = createTestApp();
    const headers = await authHeader(OWNER_A, TENANT_A);

    const res = await app.request(`/api/admin/draws/${drawId}`, { headers }, TEST_ENV);
    expect(res.status).toBe(200);
    const data = await res.json() as { draw: Record<string, unknown> };
    expect(data.draw.hasAccessPassword).toBe(true);
    expect(data.draw.accessPassword).toBeUndefined(); // 不回传哈希
  });

  it("docs/223：零参与的进行中（open）活动允许修正结构与展示字段", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = await authHeader(OWNER_A, TENANT_A);
    // 本组夹具不配置奖项，不能通过 publish 门禁；直接构造 open 状态来隔离 PATCH 规则。
    await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, drawId));

    const res = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({
        title: "进行中改标题",
        showWinnerList: 1,
        experienceType: "slot",
        winnerCount: 2,
      }),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [draw] = await db.select({ title: lotteryDraws.title, showWinnerList: lotteryDraws.showWinnerList, status: lotteryDraws.status }).from(lotteryDraws).where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(draw!.title).toBe("进行中改标题");
    expect(draw!.showWinnerList).toBe(1);
    expect(draw!.status).toBe("open"); // 编辑不改变活动状态
  });

  it("docs/223：已有参与事实的进行中活动拒改破坏性字段", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = await authHeader(OWNER_A, TENANT_A);
    await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, drawId));
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_A,
      drawId,
      identityType: "email",
      identityValue: "already-joined@example.com",
    });

    for (const key of ["activityKind", "participationMode", "experienceType", "resultMode", "allocationPolicy", "maxParticipants"]) {
      const body: Record<string, unknown> = key === "activityKind"
        ? { activityKind: "claim" }
        : key === "participationMode"
          ? { participationMode: "registered" }
          : key === "experienceType"
            ? { experienceType: "list" }
            : key === "resultMode"
              ? { resultMode: "instant" }
              : key === "maxParticipants"
                ? { maxParticipants: 5 }
                : { allocationPolicy: "waitlist" };
      const res = await app.request(`/api/admin/draws/${drawId}`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      }, TEST_ENV);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain("不可修改");
    }
  });

  it("docs/223：已有参与事实的进行中活动结束时间只能延长、不能缩短", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = await authHeader(OWNER_A, TENANT_A);
    await db.update(lotteryDraws).set({ status: "open" }).where(eq(lotteryDraws.id, drawId));
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_A,
      drawId,
      identityType: "email",
      identityValue: "time-locked@example.com",
    });

    // 缩短 → 拒绝
    const shorter = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ endAt: new Date(Date.now() + 600_000).toISOString() }), // 原 endAt 是 now+1h
    }, TEST_ENV);
    expect(shorter.status).toBe(400);
    expect((await shorter.json() as { error: string }).error).toContain("只能延长");

    // 延长 → 通过
    const longer = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ endAt: new Date(Date.now() + 7_200_000).toISOString() }),
    }, TEST_ENV);
    expect(longer.status).toBe(200);
  });

  it("docs/223：whenDrawn 只允许切可见性，取消的活动不可编辑", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = await authHeader(OWNER_A, TENANT_A);
    // 取消（draft → cancelled）
    const cancel = await app.request(`/api/admin/draws/${drawId}/cancel`, { method: "POST", headers }, TEST_ENV);
    expect(cancel.status).toBe(200);

    const res = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ title: "不能改" }),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("不可编辑");
  });

  it("安全回归：PATCH 拒绝无效时间，且不会污染数据库", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };
    const [before] = await db.select({ endAt: lotteryDraws.endAt }).from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId)).limit(1);

    for (const endAt of ["", "not-a-valid-date"]) {
      const res = await app.request(`/api/admin/draws/${drawId}`, {
        method: "PATCH", headers, body: JSON.stringify({ endAt }),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    }

    const invalidStart = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers, body: JSON.stringify({ startAt: "invalid" }),
    }, TEST_ENV);
    expect(invalidStart.status).toBe(400);

    const [after] = await db.select({ endAt: lotteryDraws.endAt }).from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(after?.endAt).toBe(before?.endAt);
  });

  it("安全回归：PATCH drawAt=null 清空开奖时间，非法开奖时间拒绝", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };
    await db.update(lotteryDraws).set({
      drawAt: new Date(Date.now() + 7_200_000).toISOString(),
    }).where(eq(lotteryDraws.id, drawId));

    const clear = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers, body: JSON.stringify({ drawAt: null }),
    }, TEST_ENV);
    expect(clear.status).toBe(200);

    const [cleared] = await db.select({ drawAt: lotteryDraws.drawAt }).from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId)).limit(1);
    expect(cleared?.drawAt).toBeNull();

    const invalid = await app.request(`/api/admin/draws/${drawId}`, {
      method: "PATCH", headers, body: JSON.stringify({ drawAt: "invalid" }),
    }, TEST_ENV);
    expect(invalid.status).toBe(400);
  });

  it("安全回归：PATCH 拒绝非法枚举和 winnerCount 脏值", async () => {
    const drawId = await seedDraftDraw();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader(OWNER_A, TENANT_A)) };

    for (const body of [
      { activityKind: "not-a-kind" },
      { resultMode: "not-a-mode" },
      { winnerCount: "NaN" },
      { winnerCount: "abc" },
      { winnerCount: 0 },
    ]) {
      const res = await app.request(`/api/admin/draws/${drawId}`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      }, TEST_ENV);
      expect(res.status).toBe(400);
    }
  });
});
