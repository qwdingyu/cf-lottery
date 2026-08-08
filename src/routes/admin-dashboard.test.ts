/**
 * 库存预警：dashboard 端点直付秒杀卡密不足检测（docs/153 P0-1）
 *
 * 验收标准：
 * 1. 直付秒杀（paymentRequired=true）且可用卡密 ≤ 5 → lowStockCount > 0
 * 2. 直付秒杀且可用卡密 = 0 → criticalStockCount > 0
 * 3. 非直付秒杀（enabled=false / paymentRequired=false）→ 不产生预警
 * 4. 未配置码奖品（prizeType != 'code'）→ 不产生预警
 * 5. 多租户隔离：其他租户的库存不影响本租户
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
  systemConfig,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-dashboard-stock-secret-0123456789ab";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
  JWT_SECRET,
};
const TENANT_A = "tenant-stock-a";
const TENANT_B = "tenant-stock-b";
const OWNER_A = "user-stock-a";
const OWNER_B = "user-stock-b";
const PRIZE_A = "prize-stock-a";
const PRIZE_B = "prize-stock-b";

/** 直付秒杀 promotionConfig */
function flashSaleConfig(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    flashSale: {
      enabled: true,
      paymentRequired: true,
      priceCents: 990,
      currency: "cny",
      title: "测试商品",
      stockLimit: 100,
      maxPerUser: 1,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  ({ client, db } = await getTestDb());
  // systemConfig 是全局 key-value（非租户级），只插入一次，避免多测试重复插入冲突
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
  await db.insert(tenants).values({ id: tenantId, name: `Stock Test ${tenantId}` });
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

/**
 * 创建测试用的码奖品 + 可用卡密
 */
async function seedCodePrize(
  tenantId: string,
  prizeId: string,
  prizeName: string,
  availableCount: number,
) {
  await db.insert(prizes).values({
    id: prizeId,
    tenantId,
    name: prizeName,
    prizeType: "code",
    active: 1,
    totalCount: availableCount,
    usedCount: 0,
  });
  if (availableCount > 0) {
    const codes = Array.from({ length: availableCount }, (_, i) => ({
      id: `code-${prizeId}-${i}`,
      tenantId,
      prizeId,
      code: `CODE-${prizeId}-${i}`,
      status: "available" as const,
    }));
    await db.insert(prizeCodes).values(codes);
  }
}

/**
 * 创建直付秒杀活动并关联码奖品
 */
async function seedFlashDraw(
  tenantId: string,
  drawId: string,
  drawTitle: string,
  prizeId: string,
  promotionConfig: string,
) {
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId,
    publicSlug: drawId,
    title: drawTitle,
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "flash_sale",
    resultMode: "instant",
    startAt: new Date(Date.now() - 86400000).toISOString(),
    endAt: new Date(Date.now() + 86400000).toISOString(),
    promotionConfig,
  });
  await db.insert(lotteryPrizeTiers).values({
    id: `tier-${drawId}`,
    tenantId,
    drawId,
    prizeId,
    tierName: "中奖",
    winnerCount: 1,
    sortOrder: 100,
    weight: 100,
  });
}

describe("Dashboard 库存预警", () => {
  it("可用卡密为 0 → criticalStockCount = 1", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "测试码奖品", 0);
    await seedFlashDraw(TENANT_A, "draw-critical", "卡密售罄活动", PRIZE_A, flashSaleConfig());

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(1);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(1);
    expect(body.stockWarnings[0].availableCount).toBe(0);
    expect(body.stockWarnings[0].drawTitle).toBe("卡密售罄活动");
  });

  it("可用卡密为 3（≤5）→ lowStockCount = 1", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "测试码奖品", 3);
    await seedFlashDraw(TENANT_A, "draw-low", "库存偏低活动", PRIZE_A, flashSaleConfig());

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.lowStockCount).toBe(1);
    expect(body.criticalStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(1);
    expect(body.stockWarnings[0].availableCount).toBe(3);
  });

  it("可用卡密充足（10）→ 不产生预警计数", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "测试码奖品", 10);
    await seedFlashDraw(TENANT_A, "draw-ok", "库存充足活动", PRIZE_A, flashSaleConfig());

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(0);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(1);
    expect(body.stockWarnings[0].availableCount).toBe(10);
  });

  it("非直付秒杀（paymentRequired=false）→ 不产生预警", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "测试码奖品", 0);
    await seedFlashDraw(TENANT_A, "draw-nonpay", "展示壳活动", PRIZE_A, flashSaleConfig({ paymentRequired: false }));

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(0);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(0);
  });

  it("未启用秒杀（enabled=false）→ 不产生预警", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "测试码奖品", 0);
    await seedFlashDraw(TENANT_A, "draw-noflash", "非秒杀活动", PRIZE_A, JSON.stringify({}));

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(0);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(0);
  });

  it("非码奖品（prizeType=physical）→ 不产生预警", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await db.insert(prizes).values({
      id: PRIZE_A,
      tenantId: TENANT_A,
      name: "实物奖品",
      prizeType: "physical",
      active: 1,
      totalCount: 10,
      usedCount: 0,
    });
    await seedFlashDraw(TENANT_A, "draw-physical", "实物奖品活动", PRIZE_A, flashSaleConfig());

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(0);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(0);
  });

  it("多租户隔离：A 的库存不足不影响 B", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "A奖品", 0);
    await seedFlashDraw(TENANT_A, "draw-a", "A活动", PRIZE_A, flashSaleConfig());

    await seedTenant(TENANT_B, OWNER_B, "stockb", "b@test.com");
    await seedCodePrize(TENANT_B, PRIZE_B, "B奖品", 10);
    await seedFlashDraw(TENANT_B, "draw-b", "B活动", PRIZE_B, flashSaleConfig());

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_B, TENANT_B),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(0);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(1);
    expect(body.stockWarnings[0].availableCount).toBe(10);
  });

  it("draft 状态的活动不触发预警", async () => {
    const app = createTestApp();
    await seedTenant(TENANT_A, OWNER_A, "stocka", "a@test.com");
    await seedCodePrize(TENANT_A, PRIZE_A, "测试码奖品", 0);

    await db.insert(lotteryDraws).values({
      id: "draw-draft",
      tenantId: TENANT_A,
      publicSlug: "draw-draft",
      title: "草稿活动",
      status: "draft",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "flash_sale",
      resultMode: "instant",
      startAt: new Date(Date.now() - 86400000).toISOString(),
      endAt: new Date(Date.now() + 86400000).toISOString(),
      promotionConfig: flashSaleConfig(),
    });
    await db.insert(lotteryPrizeTiers).values({
      id: "tier-draft",
      tenantId: TENANT_A,
      drawId: "draw-draft",
      prizeId: PRIZE_A,
      tierName: "中奖",
      winnerCount: 1,
      sortOrder: 100,
      weight: 100,
    });

    const res = await app.request("/api/admin/dashboard", {
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    const body = await res.json() as any;
    expect(body.criticalStockCount).toBe(0);
    expect(body.lowStockCount).toBe(0);
    expect(body.stockWarnings).toHaveLength(0);
  });
});