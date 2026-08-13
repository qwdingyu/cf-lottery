/**
 * 奖品码生命周期测试（任务 4c）：
 * - POST /prizes/:prizeId/codes/:codeId/revoke 运营作废端点
 * - expireExpiredPrizeCodes 卡密过期维护函数
 *
 * 作废状态机（docs/111 §7.3）：
 * - available → revoked：安全
 * - issued 且 paymentOrderId 为空（抽奖/instant 发放未支付）→ revoked：安全
 * - issued 且 paymentOrderId 非空（直付已发卡）→ 拒绝（提示走退款）
 * - redeemed → 拒绝（已核销消费）
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { clearTestData, getTestDb } from "../test-setup";
import { signJwt } from "../middleware/auth";
import { adminLotteryRoute } from "./admin-lottery";
import { auditLogs, prizes, prizeCodes, tenants, tenantMembers, users } from "../db/schema";
import { expireExpiredPrizeCodes } from "../services/payment/payment-service";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-admin-prize-lifecycle-secret-0123456789";
const TENANT_A = "tenant-prize-lifecycle-a";
const TENANT_B = "tenant-prize-lifecycle-b";
const OWNER_A = "user-prize-lifecycle-a";
const OWNER_B = "user-prize-lifecycle-b";
const PRIZE_ID = "prize-lifecycle";

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

async function seedTenant(tenantId: string, ownerId: string, username: string, email: string) {
  await db.insert(tenants).values({ id: tenantId, name: `Lifecycle ${tenantId}` });
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

/** 建奖品（幂等：同一租户只插一次）+ 插入一个指定状态的码，返回码 id */
async function seedCode(tenantId: string, overrides: Partial<typeof prizeCodes.$inferInsert> = {}): Promise<string> {
  const codeId = crypto.randomUUID();
  const [existingPrize] = await db
    .select({ id: prizes.id })
    .from(prizes)
    .where(and(eq(prizes.id, PRIZE_ID), eq(prizes.tenantId, tenantId)))
    .limit(1);
  if (!existingPrize) {
    await db.insert(prizes).values({
      id: PRIZE_ID,
      tenantId,
      name: "生命周期奖品",
      prizeType: "code",
      active: 1,
    });
  }
  await db.insert(prizeCodes).values({
    id: codeId,
    tenantId,
    prizeId: PRIZE_ID,
    code: `LIFE-${codeId.slice(0, 8)}`,
    secret: "SEC",
    status: "available",
    ...overrides,
  });
  return codeId;
}

describe("POST /prizes/:prizeId/codes/:codeId/revoke", () => {
  it("available 码作废成功，且写租户审计", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    const codeId = await seedCode(TENANT_A);
    const app = createTestApp();

    const res = await app.request(`/api/admin/prizes/${PRIZE_ID}/codes/${codeId}/revoke`, {
      method: "POST",
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect((await res.json()) as { revoked: boolean }).toMatchObject({ revoked: true });

    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("revoked");

    const audits = await db.select().from(auditLogs).where(and(
      eq(auditLogs.tenantId, TENANT_A),
      eq(auditLogs.action, "prize.code.revoke"),
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(codeId);
  });

  it("issued 且 paymentOrderId 为空（抽奖/instant 发放未支付）作废成功", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    const codeId = await seedCode(TENANT_A, {
      status: "issued",
      winnerId: "winner-entry-1",
      paymentOrderId: null,
      issuedAt: new Date().toISOString(),
    });
    const app = createTestApp();

    const res = await app.request(`/api/admin/prizes/${PRIZE_ID}/codes/${codeId}/revoke`, {
      method: "POST",
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    expect(res.status).toBe(200);

    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("revoked");
    // 审计保留 winnerId
    expect(code?.winnerId).toBe("winner-entry-1");
  });

  it("issued 且 paymentOrderId 非空（直付已发卡）拒绝，提示走退款", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    const codeId = await seedCode(TENANT_A, {
      status: "issued",
      winnerId: "winner-entry-1",
      paymentOrderId: "order-paid-1",
      issuedAt: new Date().toISOString(),
    });
    const app = createTestApp();

    const res = await app.request(`/api/admin/prizes/${PRIZE_ID}/codes/${codeId}/revoke`, {
      method: "POST",
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    expect(res.status).toBe(409);
    const body = await res.json() as { message?: string };
    expect(body.message).toContain("退款");

    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("issued");
  });

  it("redeemed 码拒绝作废", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    const codeId = await seedCode(TENANT_A, {
      status: "redeemed",
      winnerId: "winner-entry-1",
      paymentOrderId: "order-paid-1",
      issuedAt: new Date().toISOString(),
    });
    const app = createTestApp();

    const res = await app.request(`/api/admin/prizes/${PRIZE_ID}/codes/${codeId}/revoke`, {
      method: "POST",
      headers: await authHeader(OWNER_A, TENANT_A),
    }, TEST_ENV);
    expect(res.status).toBe(409);

    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("redeemed");
  });

  it("跨租户拒绝：B 租户不能作废 A 租户的码", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    await seedTenant(TENANT_B, OWNER_B, "life-b", "b@test.com");
    const codeId = await seedCode(TENANT_A);
    const app = createTestApp();

    const res = await app.request(`/api/admin/prizes/${PRIZE_ID}/codes/${codeId}/revoke`, {
      method: "POST",
      headers: await authHeader(OWNER_B, TENANT_B),
    }, TEST_ENV);
    expect(res.status).toBe(404);

    const [code] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, codeId));
    expect(code?.status).toBe("available");
  });
});

describe("expireExpiredPrizeCodes 卡密过期维护", () => {
  it("把 expiresAt 已过的 available/issued 码标记为 expired，未来过期/无过期时间的码不动", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    const now = Date.now();
    const past = new Date(now - 3600_000).toISOString();
    const future = new Date(now + 3600_000).toISOString();

    const pastAvailableId = await seedCode(TENANT_A, { expiresAt: past });
    const pastIssuedId = await seedCode(TENANT_A, { status: "issued", expiresAt: past });
    const futureAvailableId = await seedCode(TENANT_A, { expiresAt: future });
    const noExpiryId = await seedCode(TENANT_A, { expiresAt: null });
    // 已核销的不应被改写
    const pastRedeemedId = await seedCode(TENANT_A, { status: "redeemed", expiresAt: past });

    const processed = await expireExpiredPrizeCodes(db, 500);
    expect(processed).toBe(2);

    const [pastAvailable] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, pastAvailableId));
    expect(pastAvailable?.status).toBe("expired");
    const [pastIssued] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, pastIssuedId));
    expect(pastIssued?.status).toBe("expired");
    const [futureAvailable] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, futureAvailableId));
    expect(futureAvailable?.status).toBe("available");
    const [noExpiry] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, noExpiryId));
    expect(noExpiry?.status).toBe("available");
    const [pastRedeemed] = await db.select().from(prizeCodes).where(eq(prizeCodes.id, pastRedeemedId));
    expect(pastRedeemed?.status).toBe("redeemed");
  });

  it("limit 生效：超过 limit 的过期码本批不处理", async () => {
    await seedTenant(TENANT_A, OWNER_A, "life-a", "a@test.com");
    const past = new Date(Date.now() - 3600_000).toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await seedCode(TENANT_A, { expiresAt: past }));
    }
    // 与 seedCode 的可用码混淆：只处理前 2 条（limit=2）
    const processed = await expireExpiredPrizeCodes(db, 2);
    expect(processed).toBe(2);

    const remaining = await db
      .select({ id: prizeCodes.id })
      .from(prizeCodes)
      .where(and(
        eq(prizeCodes.tenantId, TENANT_A),
        eq(prizeCodes.prizeId, PRIZE_ID),
        eq(prizeCodes.status, "available"),
      ));
    expect(remaining).toHaveLength(1);
  });
});
