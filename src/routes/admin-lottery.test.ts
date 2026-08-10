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
  });
});
