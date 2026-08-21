/**
 * docs/082 P2：服务端 batch-delete 契约测试
 * - 活动：可删状态成功 / open 失败 / 审计一条汇总
 * - 码：仅 available
 * - 日志：本租户 ids + 汇总审计
 * - parseBatchDeleteIds 上限与去重
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
  lotterySpins,
  prizes,
  prizeCodes,
  auditLogs,
  systemConfig,
  paymentOrders,
  paymentOrderAttempts,
  paymentOrderItems,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import { clearTestData, getTestDb } from "../test-setup";
import {
  parseBatchDeleteIds,
  isDrawStatusDeletable,
  ADMIN_BATCH_DELETE_MAX,
} from "./admin-lottery-helpers";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: DbType;

const JWT_SECRET = "test-batch-delete-secret-0123456789ab";
const TENANT_ID = "tenant-batch";
const OWNER_ID = "user-batch-owner";

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

async function seedOwner() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "Batch Test" });
  await db.insert(users).values({
    id: OWNER_ID,
    username: "batchowner",
    email: "batch@test.com",
    emailVerified: 1,
    passwordHash: "hash",
  });
  await db.insert(tenantMembers).values({ tenantId: TENANT_ID, userId: OWNER_ID, role: "owner" });
  await db.insert(systemConfig).values({
    key: "enabled_activity_kinds",
    value: "lottery",
  });
}

async function authHeader() {
  const token = await signJwt({ sub: OWNER_ID, tenantId: TENANT_ID }, JWT_SECRET, 3600);
  return { Authorization: `Bearer ${token}` };
}

describe("parseBatchDeleteIds / isDrawStatusDeletable", () => {
  it("去重、去空、拒绝超限", () => {
    expect(parseBatchDeleteIds({ ids: ["a", "a", "  ", "b"] }).ids).toEqual(["a", "b"]);
    expect(parseBatchDeleteIds({ ids: [] }).error).toBeTruthy();
    expect(parseBatchDeleteIds(null).error).toBeTruthy();
    const tooMany = Array.from({ length: ADMIN_BATCH_DELETE_MAX + 1 }, (_, i) => `id-${i}`);
    expect(parseBatchDeleteIds({ ids: tooMany }).error).toMatch(/最多/);
  });

  it("删除策略与前端 describeDrawDeletePolicy 对齐", () => {
    expect(isDrawStatusDeletable("draft")).toBe(true);
    expect(isDrawStatusDeletable("paused")).toBe(true);
    expect(isDrawStatusDeletable("drawn")).toBe(true);
    expect(isDrawStatusDeletable("cancelled")).toBe(true);
    expect(isDrawStatusDeletable("open")).toBe(false);
    expect(isDrawStatusDeletable("drawing")).toBe(false);
  });
});

describe("POST /api/admin/draws/batch-delete", () => {
  it("批量删 draft/cancelled，open 计入 failed，写一条 draw.batch_delete 审计", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const now = new Date().toISOString();

    await db.insert(lotteryDraws).values([
      {
        id: "d-draft",
        tenantId: TENANT_ID,
        publicSlug: "batch-draft",
        title: "草稿",
        status: "draft",
        activityKind: "lottery",
        participationMode: "open",
        startAt: now,
        endAt: now,
        winnerCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "d-open",
        tenantId: TENANT_ID,
        publicSlug: "batch-open",
        title: "进行中",
        status: "open",
        activityKind: "lottery",
        participationMode: "open",
        startAt: now,
        endAt: now,
        winnerCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "d-cancel",
        tenantId: TENANT_ID,
        publicSlug: "batch-cancel",
        title: "已取消",
        status: "cancelled",
        activityKind: "lottery",
        participationMode: "open",
        startAt: now,
        endAt: now,
        winnerCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await app.request(
      "/api/admin/draws/batch-delete",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: ["d-draft", "d-open", "d-cancel", "d-missing"] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deleted: number;
      failed: number;
      deletedIds: string[];
      failedItems: Array<{ id: string; reason: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(2);
    expect(body.failed).toBe(2);
    expect(body.deletedIds.sort()).toEqual(["d-cancel", "d-draft"]);
    expect(body.failedItems.map((f) => f.id).sort()).toEqual(["d-missing", "d-open"]);

    const remaining = await db.select({ id: lotteryDraws.id }).from(lotteryDraws).where(eq(lotteryDraws.tenantId, TENANT_ID));
    expect(remaining.map((r) => r.id)).toEqual(["d-open"]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, TENANT_ID), eq(auditLogs.action, "draw.batch_delete")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe("batch");
  });

  it("force=true 允许删除 open 活动（调试/测试清场），但审计记录 force 标志", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const now = new Date().toISOString();

    await db.insert(lotteryDraws).values([
      {
        id: "f-open",
        tenantId: TENANT_ID,
        publicSlug: "force-open",
        title: "进行中（force测试）",
        status: "open",
        activityKind: "lottery",
        participationMode: "open",
        startAt: now,
        endAt: now,
        winnerCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "f-draft",
        tenantId: TENANT_ID,
        publicSlug: "force-draft",
        title: "草稿（force测试）",
        status: "draft",
        activityKind: "lottery",
        participationMode: "open",
        startAt: now,
        endAt: now,
        winnerCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // force=true → 放行 open（草稿正常删除）
    const res = await app.request(
      "/api/admin/draws/batch-delete",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: ["f-open", "f-draft"], force: true }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: number;
      failed: number;
      deletedIds: string[];
    };
    expect(body.deleted).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.deletedIds.sort()).toEqual(["f-draft", "f-open"]);

    // 审计记录 force 标志
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, TENANT_ID), eq(auditLogs.action, "draw.batch_delete")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadataJson).toContain("force");
  });

  it("级联删除清理 lotterySpins（即时开奖 spin 审计行，docs/241 核查修复）", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const now = new Date().toISOString();

    await db.insert(lotteryDraws).values({
      id: "spin-draw",
      tenantId: TENANT_ID,
      publicSlug: "spin-draw",
      title: "即时开奖活动",
      status: "drawn",
      activityKind: "lottery",
      participationMode: "open",
      startAt: now,
      endAt: now,
      winnerCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(lotterySpins).values({
      id: "spin-1",
      tenantId: TENANT_ID,
      drawId: "spin-draw",
      entryId: "entry-1",
      idempotencyKey: "k-1",
      won: 1,
      createdAt: now,
    });

    const res = await app.request(
      "/api/admin/draws/batch-delete",
      { method: "POST", headers, body: JSON.stringify({ ids: ["spin-draw"] }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    const left = await db.select().from(lotterySpins).where(eq(lotterySpins.drawId, "spin-draw"));
    expect(left).toHaveLength(0); // spins 随活动级联删除，不留孤儿
  });

  it("测试清场：仅含 expired 订单的活动 force=true 可删，订单链清理、活动删除（docs/255 测试清场）", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const now = new Date().toISOString();

    await db.insert(lotteryDraws).values({
      id: "exp-clean",
      tenantId: TENANT_ID,
      publicSlug: "exp-clean",
      title: "秒杀测试残留",
      status: "drawn",
      activityKind: "lottery",
      participationMode: "open",
      startAt: now,
      endAt: now,
      winnerCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(paymentOrders).values({
      id: "order-exp-1",
      tenantId: TENANT_ID,
      drawId: "exp-clean",
      entryId: "entry-exp-1",
      status: "expired",
      amountCents: 990,
      currency: "cny",
      provider: "easypay",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(paymentOrderAttempts).values({
      id: "attempt-exp-1",
      tenantId: TENANT_ID,
      drawId: "exp-clean",
      paymentOrderId: "order-exp-1",
      attemptNo: 1,
      status: "expired",
      provider: "easypay",
      amountCents: 990,
      currency: "cny",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(paymentOrderItems).values({
      id: "item-exp-1",
      tenantId: TENANT_ID,
      drawId: "exp-clean",
      paymentOrderId: "order-exp-1",
      lineNo: 1,
      status: "expired",
      title: "秒杀",
      quantity: 1,
      amountCents: 990,
      currency: "cny",
      createdAt: now,
      updatedAt: now,
    });

    // ① force=false：仍 fail-closed，不删
    const resNoForce = await app.request(
      "/api/admin/draws/batch-delete",
      { method: "POST", headers, body: JSON.stringify({ ids: ["exp-clean"] }) },
      TEST_ENV,
    );
    const bodyNoForce = (await resNoForce.json()) as { deleted: number; failed: number; failedItems: Array<{ id: string; reason: string }> };
    expect(resNoForce.status).toBe(200);
    expect(bodyNoForce.deleted).toBe(0);
    expect(bodyNoForce.failed).toBe(1);
    expect(bodyNoForce.failedItems[0]?.reason).toContain("存在支付订单");

    // ② force=true：全部 expired → 清场成功，订单链 + 活动一并删除
    const resForce = await app.request(
      "/api/admin/draws/batch-delete",
      { method: "POST", headers, body: JSON.stringify({ ids: ["exp-clean"], force: true }) },
      TEST_ENV,
    );
    const bodyForce = (await resForce.json()) as { deleted: number; failed: number };
    expect(resForce.status).toBe(200);
    expect(bodyForce.deleted).toBe(1);
    expect(bodyForce.failed).toBe(0);

    const leftDraw = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, "exp-clean"));
    const leftOrders = await db.select().from(paymentOrders).where(eq(paymentOrders.drawId, "exp-clean"));
    const leftAttempts = await db.select().from(paymentOrderAttempts).where(eq(paymentOrderAttempts.drawId, "exp-clean"));
    const leftItems = await db.select().from(paymentOrderItems).where(eq(paymentOrderItems.drawId, "exp-clean"));
    expect(leftDraw).toHaveLength(0);
    expect(leftOrders).toHaveLength(0);
    expect(leftAttempts).toHaveLength(0);
    expect(leftItems).toHaveLength(0);
  });

  it("测试清场 fail-closed：存在非 expired 订单时 force=true 仍拒绝（有资金痕迹绝不删）", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const now = new Date().toISOString();

    await db.insert(lotteryDraws).values({
      id: "paid-keep",
      tenantId: TENANT_ID,
      publicSlug: "paid-keep",
      title: "有已支付订单的活动",
      status: "drawn",
      activityKind: "lottery",
      participationMode: "open",
      startAt: now,
      endAt: now,
      winnerCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(paymentOrders).values([
      {
        id: "order-paid-1",
        tenantId: TENANT_ID,
        drawId: "paid-keep",
        entryId: "entry-paid-1",
        status: "paid",
        amountCents: 990,
        currency: "cny",
        provider: "easypay",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "order-exp-2",
        tenantId: TENANT_ID,
        drawId: "paid-keep",
        entryId: "entry-paid-2",
        status: "expired",
        amountCents: 990,
        currency: "cny",
        provider: "easypay",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 混合 paid + expired：即使 force=true 也必须拒绝（paymentOrders 承载资金历史）
    const res = await app.request(
      "/api/admin/draws/batch-delete",
      { method: "POST", headers, body: JSON.stringify({ ids: ["paid-keep"], force: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; failed: number; failedItems: Array<{ id: string; reason: string }> };
    expect(body.deleted).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.failedItems[0]?.reason).toContain("存在支付订单");

    // 订单与活动全部保留
    const leftDraw = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, "paid-keep"));
    const leftOrders = await db.select().from(paymentOrders).where(eq(paymentOrders.drawId, "paid-keep"));
    expect(leftDraw).toHaveLength(1);
    expect(leftOrders).toHaveLength(2);
  });
});

describe("POST /api/admin/prizes/codes/batch-delete", () => {
  it("仅删 available，已发放计入 failed", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const now = new Date().toISOString();

    await db.insert(prizes).values({
      id: "prize-1",
      tenantId: TENANT_ID,
      name: "测试奖",
      prizeType: "code_pool",
      active: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(prizeCodes).values([
      {
        id: "code-avail",
        tenantId: TENANT_ID,
        prizeId: "prize-1",
        code: "AVAIL1",
        status: "available",
        createdAt: now,
      },
      {
        id: "code-issued",
        tenantId: TENANT_ID,
        prizeId: "prize-1",
        code: "ISSUED1",
        status: "issued",
        createdAt: now,
      },
    ]);

    const res = await app.request(
      "/api/admin/prizes/codes/batch-delete",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: ["code-avail", "code-issued", "code-gone"] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; failed: number; deletedIds: string[] };
    expect(body.deleted).toBe(1);
    expect(body.failed).toBe(2);
    expect(body.deletedIds).toEqual(["code-avail"]);

    const left = await db.select().from(prizeCodes).where(eq(prizeCodes.tenantId, TENANT_ID));
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe("code-issued");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, TENANT_ID), eq(auditLogs.action, "prize.codes.batch_delete")));
    expect(audits).toHaveLength(1);
  });
});

describe("POST /api/admin/logs/batch-delete", () => {
  it("删除本租户日志并写汇总审计", async () => {
    await seedOwner();
    const app = createTestApp();
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };

    await db.insert(auditLogs).values([
      {
        id: "log-1",
        tenantId: TENANT_ID,
        actorUserId: OWNER_ID,
        action: "draw.create",
        targetType: "lottery_draw",
        targetId: "x",
        metadataJson: "{}",
      },
      {
        id: "log-2",
        tenantId: TENANT_ID,
        actorUserId: OWNER_ID,
        action: "draw.update",
        targetType: "lottery_draw",
        targetId: "y",
        metadataJson: "{}",
      },
    ]);

    const res = await app.request(
      "/api/admin/logs/batch-delete",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: ["log-1", "log-missing"] }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; failed: number };
    expect(body.deleted).toBe(1);
    expect(body.failed).toBe(1);

    const remaining = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, TENANT_ID));
    // log-2 保留 + 一条 logs.batch_delete 汇总
    expect(remaining.some((r) => r.id === "log-2")).toBe(true);
    expect(remaining.some((r) => r.id === "log-1")).toBe(false);
    expect(remaining.some((r) => r.action === "logs.batch_delete")).toBe(true);
  });
});
