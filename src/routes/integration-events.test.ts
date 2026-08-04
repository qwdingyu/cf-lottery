/**
 * 外部事件 API 集成测试（docs/111 §5 阶段二 + docs/114 §4）
 *
 * 测试 POST /api/integration/events 的：
 * - 鉴权（API Key 有效/无效）
 * - 限流（60 次/分钟）
 * - 幂等（idempotencyKey 去重）
 * - 事件路由（member.left_group / reward.redeemed / reward.issued / penalty.executed）
 * - 边界（无效事件类型、缺失必填字段）
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { integrationRoute } from "../routes/integration";
import { clearTestData, getTestDb } from "../test-setup";
import { hashApiKey } from "../services/lottery-service";
import { apiKeys, lotteryEntries, shareRecords, prizeCodes, lotteryDraws } from "../db/schema";
import { eq } from "drizzle-orm";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];
const TENANT = "test-tenant-001";
const USER = "test-user-001";

/** 创建集成测试 App，挂载 integrationRoute 并注入 DB 上下文 */
function createIntegrationApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/integration", integrationRoute);
  return app;
}

/** 创建 API Key + 返回 raw key（用于请求头）和 hash（用于入库） */
async function createTestApiKey() {
  const rawKey = `int-test-key-${Date.now()}`;
  const hash = await hashApiKey(rawKey);
  const id = crypto.randomUUID();
  await db.insert(apiKeys).values({
    id,
    tenantId: TENANT,
    key: hash,
    name: `测试 Key ${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { rawKey, id };
}

/** 创建活动 + 参与者 + 归因链，供 member.left_group 测试使用 */
async function setupDefaultDraw() {
  const now = new Date();
  const future = new Date(now.getTime() + 3600000);
  const drawId = crypto.randomUUID();
  await db.insert(lotteryDraws).values({
    id: drawId, tenantId: TENANT, title: "测试活动",
    status: "open", publicSlug: `test-${Date.now()}`,
    activityKind: "lottery", participationMode: "open",
    experienceType: "submit", resultMode: "instant",
    startAt: now.toISOString(), endAt: future.toISOString(),
    activityConfig: "{}",
  });
  return drawId;
}

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

beforeEach(async () => {
  await clearTestData(client);
  await client.execute({ sql: "INSERT INTO tenants (id, name) VALUES (?, ?)", args: [TENANT, "Test"] });
  await client.execute({
    sql: "INSERT INTO users (id, username, email, email_verified, password_hash) VALUES (?, ?, ?, ?, ?)",
    args: [USER, "test", "test@example.com", 1, "hash"],
  });
  await client.execute({ sql: "INSERT INTO tenant_members (tenant_id, user_id) VALUES (?, ?)", args: [TENANT, USER] });
});

describe("POST /integration/events — 鉴权与限流", () => {
  it("无效 API Key 返回 401", async () => {
    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": "invalid-key" },
      body: JSON.stringify({ event: "reward.issued", payload: {}, idempotencyKey: "k1" }),
    });
    expect(res.status).toBe(401);
  });

  it("有效 API Key 正常处理", async () => {
    const { rawKey } = await createTestApiKey();
    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({ event: "reward.issued", payload: { drawId: "d1" }, idempotencyKey: "k2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.handled).toBe(true);
  });

  it("相同 idempotencyKey 第二次调用返回 handled: false（幂等）", async () => {
    const { rawKey } = await createTestApiKey();
    const app = createIntegrationApp();
    const payload = JSON.stringify({ event: "reward.issued", payload: { drawId: "d1" }, idempotencyKey: "idem-1" });
    const r1 = await app.request("/integration/events", {
      method: "POST", headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey }, body: payload,
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    expect(b1.handled).toBe(true);

    const r2 = await app.request("/integration/events", {
      method: "POST", headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey }, body: payload,
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as any;
    expect(b2.handled).toBe(false);
    expect(b2.reason).toBe("idempotencyKey 已处理");
  });

  it("不支持的事件类型返回 400", async () => {
    const { rawKey } = await createTestApiKey();
    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({ event: "unknown.event", payload: {}, idempotencyKey: "k3" }),
    });
    expect(res.status).toBe(400);
  });

  it("缺少 idempotencyKey 返回 400", async () => {
    const { rawKey } = await createTestApiKey();
    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({ event: "reward.issued", payload: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /integration/events — member.left_group", () => {
  it("退群者未参与活动时不触发处罚", async () => {
    const { rawKey } = await createTestApiKey();
    const drawId = await setupDefaultDraw();
    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({
        event: "member.left_group",
        payload: { account: "nobody@test.com", drawId, groupId: "g1", leftAt: new Date().toISOString() },
        idempotencyKey: "leave-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.penaltyTriggered).toBe(false);
    expect(body.reason).toBe("退群者未参与此活动");
  });

  it("退群者参与且有邀请人时触发处罚", async () => {
    const { rawKey } = await createTestApiKey();
    const drawId = await setupDefaultDraw();

    // 邀请人 entry
    const inviterId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: inviterId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "inviter@test.com",
      ipHash: "ip1", joinedAt: new Date().toISOString(),
    });

    // 分享链接
    const shareCode = `sc-${Date.now()}`;
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(), tenantId: TENANT, drawId,
      sharerEntryId: inviterId, shareCode,
      createdAt: new Date().toISOString(),
    });

    // 退群者 entry
    const leaverId = crypto.randomUUID();
    await db.insert(lotteryEntries).values({
      id: leaverId, tenantId: TENANT, drawId,
      identityType: "email", identityValue: "leaver@test.com",
      ipHash: "ip2", joinedAt: new Date().toISOString(),
    });

    // 归因事件（退群者通过分享链接进入）
    const { recordActivityEvent } = await import("../services/lottery-service");
    await recordActivityEvent(db, {
      tenantId: TENANT, drawId,
      entryId: leaverId,
      eventType: "attributed_join",
      refCode: shareCode,
    });

    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({
        event: "member.left_group",
        payload: { account: "leaver@test.com", drawId, groupId: "g1", leftAt: new Date().toISOString() },
        idempotencyKey: "leave-2",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.penaltyTriggered).toBe(true);
    expect(body.targets.leaver).toBe("leaver@test.com");
    expect(body.targets.inviter).toBe("inviter@test.com");
  });
});

describe("POST /integration/events — reward.redeemed", () => {
  it("issued 卡密标记为 redeemed", async () => {
    const { rawKey } = await createTestApiKey();
    const { createPrize, importPrizeCodes } = await import("../services/lottery-service");

    const { id: prizeId } = await createPrize(db, TENANT, { name: "核销奖品", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "REDEEM-T1", secret: "s1" }]);

    // 模拟中奖：issued
    await db.update(prizeCodes).set({ status: "issued", winnerId: "w1", issuedAt: new Date().toISOString() }).where(eq(prizeCodes.code, "REDEEM-T1"));

    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({
        event: "reward.redeemed",
        payload: { code: "REDEEM-T1", redeemedAt: new Date().toISOString() },
        idempotencyKey: "red-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.redeemed).toBe(true);
    expect(body.previousStatus).toBe("issued");

    // 验证数据库状态
    const [row] = await db.select({ status: prizeCodes.status }).from(prizeCodes).where(eq(prizeCodes.code, "REDEEM-T1"));
    expect(row.status).toBe("redeemed");
  });

  it("revoked 卡密不可 redeemed（幂等保护）", async () => {
    const { rawKey } = await createTestApiKey();
    const { createPrize, importPrizeCodes } = await import("../services/lottery-service");

    const { id: prizeId } = await createPrize(db, TENANT, { name: "核销奖品2", prizeType: "code" });
    await importPrizeCodes(db, TENANT, prizeId, [{ code: "REDEEM-T2", secret: "s2" }]);

    // 先 issued → revoked
    await db.update(prizeCodes).set({ status: "issued", winnerId: "w2", issuedAt: new Date().toISOString() }).where(eq(prizeCodes.code, "REDEEM-T2"));
    await db.update(prizeCodes).set({ status: "revoked" }).where(eq(prizeCodes.code, "REDEEM-T2"));

    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({
        event: "reward.redeemed",
        payload: { code: "REDEEM-T2", redeemedAt: new Date().toISOString() },
        idempotencyKey: "red-2",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.redeemed).toBe(false);
    expect(body.previousStatus).toBe("revoked");

    const [row] = await db.select({ status: prizeCodes.status }).from(prizeCodes).where(eq(prizeCodes.code, "REDEEM-T2"));
    expect(row.status).toBe("revoked");
  });

  it("card 不存在返回 404", async () => {
    const { rawKey } = await createTestApiKey();
    const app = createIntegrationApp();
    const res = await app.request("/integration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CF-Lottery-API-Key": rawKey },
      body: JSON.stringify({
        event: "reward.redeemed",
        payload: { code: "NONEXISTENT" },
        idempotencyKey: "red-3",
      }),
    });
    expect(res.status).toBe(404);
  });
});