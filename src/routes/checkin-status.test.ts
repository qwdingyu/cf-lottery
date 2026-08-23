/**
 * 签到状态查询 API 集成测试（docs/268）
 *
 * 用真实 SQLite 数据库覆盖 checkin-status 路由的完整代码路径：
 * - 活动查找 + 类型校验
 * - 身份识别（query.email）
 * - 月份解析与边界
 * - 签到记录查询 + 日期去重
 * - streak / maxStreak / monthlyCount / signedToday 计算
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import type { Client } from "@libsql/client";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import {
  lotteryDraws,
  lotteryEntries,
  tenants,
} from "../db/schema";
import { clearTestData, getTestDb } from "../test-setup";
import { publicLotteryRoute } from "./public-lottery";
import { todayStr } from "../lib/date-utils";

let client: Client;
let db: DbType;

const TENANT_ID = "tenant-checkin-api";
const DRAW_ID = "draw-checkin-api";
const EMAIL = "checkin-api@example.com";

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
  app.route("/api/public", publicLotteryRoute);
  return app;
}

async function seedCheckinActivity() {
  await db.insert(tenants).values({ id: TENANT_ID, name: "checkin-api-test" });
  await db.insert(lotteryDraws).values({
    id: DRAW_ID,
    tenantId: TENANT_ID,
    publicSlug: "checkin-api-slug",
    title: "签到测试活动",
    status: "open",
    activityKind: "checkin",
    participationMode: "open",
    experienceType: "checkin",
    resultMode: "instant",
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
  });
}

/** 插入一条签到 entry（模拟 joinDraw 创建的记录） */
async function insertCheckinEntry(dateStr: string, streak: number) {
  const identityValue = `${EMAIL}:${dateStr}`;
  await db.insert(lotteryEntries).values({
    id: `entry-${dateStr}`,
    tenantId: TENANT_ID,
    drawId: DRAW_ID,
    identityType: "email",
    identityValue,
    displayName: "tester",
    joinedAt: `${dateStr}T10:00:00Z`,
    lastCheckinDate: dateStr,
    checkinStreak: streak,
  });
}

describe("checkin-status API 集成测试", () => {
  it("返回正确的签到日期列表和 streak", async () => {
    await seedCheckinActivity();
    const today = todayStr();
    await insertCheckinEntry(today, 3);
    await insertCheckinEntry("2026-08-22", 2);
    await insertCheckinEntry("2026-08-21", 1);

    const app = createTestApp();
    const res = await app.request(
      `/api/public/draws/checkin-api-slug/checkin-status?email=${EMAIL}`
    );
    expect(res.status).toBe(200);
    const body: Record<string, unknown> = await res.json();
    // ok(c, data) 返回 { ok: true, ...data }，数据平铺
    expect(body.ok).toBe(true);
    expect(body.signedDates).toContain(today);
    expect(body.signedDates).toContain("2026-08-22");
    expect(body.signedDates).toContain("2026-08-21");
    expect(body.currentStreak).toBe(3);
    expect(body.signedToday).toBe(true);
    expect(body.monthlyCount).toBe(3);
  });

  it("非签到活动返回 400", async () => {
    await db.insert(tenants).values({ id: TENANT_ID, name: "test" });
    await db.insert(lotteryDraws).values({
      id: DRAW_ID,
      tenantId: TENANT_ID,
      publicSlug: "lottery-slug",
      title: "抽奖活动",
      status: "open",
      activityKind: "lottery",
      participationMode: "open",
      experienceType: "wheel",
      resultMode: "instant",
      startAt: new Date(Date.now() - 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const app = createTestApp();
    const res = await app.request(
      `/api/public/draws/lottery-slug/checkin-status?email=${EMAIL}`
    );
    expect(res.status).toBe(400);
    const body: Record<string, unknown> = await res.json();
    expect(body.ok).toBe(false);
  });

  it("活动不存在返回 404", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/public/draws/nonexistent-slug/checkin-status?email=test@test.com"
    );
    expect(res.status).toBe(404);
  });

  it("无身份信息返回 401", async () => {
    await seedCheckinActivity();
    const app = createTestApp();
    const res = await app.request("/api/public/draws/checkin-api-slug/checkin-status");
    expect(res.status).toBe(401);
  });

  it("无效月份格式回退到当前月", async () => {
    await seedCheckinActivity();
    const today = todayStr();
    await insertCheckinEntry(today, 1);

    const app = createTestApp();
    const res = await app.request(
      `/api/public/draws/checkin-api-slug/checkin-status?email=${EMAIL}&month=invalid`
    );
    expect(res.status).toBe(200);
    const body: Record<string, unknown> = await res.json();
    // ok(c, data) 平铺返回，无效月份回退到当前月仍能查到今日签到
    expect(body.signedDates).toContain(today);
  });

  it("查询历史月份返回空数据", async () => {
    await seedCheckinActivity();
    const today = todayStr();
    await insertCheckinEntry(today, 1);

    const app = createTestApp();
    const res = await app.request(
      `/api/public/draws/checkin-api-slug/checkin-status?email=${EMAIL}&month=2025-01`
    );
    expect(res.status).toBe(200);
    const body: Record<string, unknown> = await res.json();
    expect(body.signedDates).toHaveLength(0);
    expect(body.monthlyCount).toBe(0);
    expect(body.signedToday).toBe(false);
  });

  it("UNIQUE 约束防止同日重复签到", async () => {
    await seedCheckinActivity();
    const today = todayStr();
    await insertCheckinEntry(today, 1);
    // 同一 identity_value 应触发 UNIQUE 约束
    await expect(
      db.insert(lotteryEntries).values({
        id: `entry-${today}-dup`,
        tenantId: TENANT_ID,
        drawId: DRAW_ID,
        identityType: "email",
        identityValue: `${EMAIL}:${today}`,
        displayName: "tester",
        joinedAt: `${today}T14:00:00Z`,
        lastCheckinDate: today,
        checkinStreak: 1,
      })
    ).rejects.toThrow();
  });

  it("maxStreak 取所有 entry 中的最大值", async () => {
    await seedCheckinActivity();
    const today = todayStr();
    await insertCheckinEntry(today, 5);
    await insertCheckinEntry("2026-08-22", 3);
    await insertCheckinEntry("2026-08-21", 15);

    const app = createTestApp();
    const res = await app.request(
      `/api/public/draws/checkin-api-slug/checkin-status?email=${EMAIL}`
    );
    expect(res.status).toBe(200);
    const body: Record<string, unknown> = await res.json();
    expect(body.maxStreak).toBe(15);
  });
});

describe("nextStreakAfterCheckin 核心逻辑", () => {
  it("覆盖首次/连续/断签/同日四个分支", async () => {
    const { nextStreakAfterCheckin } = await import("../services/platform/checkin-reward");
    expect(nextStreakAfterCheckin(null, 0, "2026-08-23")).toBe(1);
    expect(nextStreakAfterCheckin("2026-08-22", 5, "2026-08-23")).toBe(6);
    expect(nextStreakAfterCheckin("2026-08-20", 5, "2026-08-23")).toBe(1);
    expect(nextStreakAfterCheckin("2026-08-23", 5, "2026-08-23")).toBe(1);
  });
});
