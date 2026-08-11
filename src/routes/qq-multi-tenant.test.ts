/**
 * QQ 群助手多租户隔离端到端测试（非常重要）。
 *
 * 验证两个租户各自绑定不同 QQ 群时，消息/签到/抽奖/卡密严格隔离：
 * - 向群 A 发命令 → 只影响租户 A 的数据
 * - 向群 B 发命令 → 只影响租户 B 的数据
 * - 出站私聊消息按 tenantId 入队，不串租户
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { platformQQRoute } from "./platform-qq";
import { clearTestData, getTestDb } from "../test-setup";
import {
  activityEvents,
  lotteryDraws,
  lotteryEntries,
  lotteryPrizeTiers,
  lotterySpins,
  lotteryWinners,
  platformDeliveries,
  platformTargets,
  prizeCodes,
  prizes,
  tenants,
} from "../db/schema";
import { hashPlatformInboundSecret, generatePlatformInboundSecret } from "../services/platform/security";
import { and, eq, inArray, count } from "drizzle-orm";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

// ── 两个租户 ──
const TENANT_A = "tenant-qq-mt-a";
const TENANT_B = "tenant-qq-mt-b";
const GROUP_A = "111111";
const GROUP_B = "222222";
const DRAW_A = "draw-mt-a";
const DRAW_B = "draw-mt-b";
const SECRET_A = "secret-a";
const SECRET_B = "secret-b";

// 全局 mock fetch：防止测试中真实出站请求（NapCat / Telegram / Resend 等）
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
};

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/platform/qq", platformQQRoute);
  return app;
}

function qqMessage(groupId: string, userId: number, text: string, messageId = 1) {
  return {
    message_type: "group",
    group_id: Number(groupId),
    user_id: userId,
    message_id: messageId,
    self_id: 888888,
    message: [{ type: "text", data: { text } }],
    sender: { nickname: "测试用户" },
  };
}

/** 为一个租户创建 QQ 群绑定 + 活动 + 奖品 + 卡密 */
async function seedTenant(
  tenantId: string,
  groupId: string,
  drawId: string,
  inboundSecret: string,
  prizeCodesCount: number,
) {
  // 租户
  await db.insert(tenants).values({ id: tenantId, name: `QQ 隔离测试租户 ${groupId}` });

  // 活动（即时抽奖）
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: drawId,
    tenantId,
    title: `租户 ${groupId} 活动`,
    publicSlug: `slug-${groupId}`,
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    maxSpinsPerEntry: 5,
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
    promotionConfig: "{}",
  });

  // 奖品
  const prizeId = `prize-${groupId}`;
  await db.insert(prizes).values({
    id: prizeId,
    tenantId,
    name: `奖品 ${groupId}`,
    prizeType: "code",
    totalCount: prizeCodesCount,
    active: 1,
  });

  // 奖档
  await db.insert(lotteryPrizeTiers).values({
    id: `tier-${groupId}`,
    tenantId,
    drawId,
    prizeId,
    tierName: "一等奖",
    winnerCount: prizeCodesCount,
    weight: 100,
    sortOrder: 1,
  });

  // 卡密
  const codes = Array.from({ length: prizeCodesCount }, (_, i) => ({
    id: `code-${groupId}-${i + 1}`,
    tenantId,
    prizeId,
    code: `CODE-${groupId}-${i + 1}`,
    secret: `SECRET-${groupId}-${i + 1}`,
    status: "available" as const,
  }));
  await db.insert(prizeCodes).values(codes);

  // QQ 群绑定
  await db.insert(platformTargets).values({
    id: `pt-${groupId}`,
    tenantId,
    platform: "qq",
    targetId: groupId,
    targetName: `测试群 ${groupId}`,
    activeDrawId: drawId,
    activePublicSlug: `slug-${groupId}`,
    assistantEnabled: 1,
    adapterDeploymentMode: "tenant_hosted",
    adapterProvider: "napcat",
    adapterConfigJson: JSON.stringify({ baseUrl: "http://tenant.example:3000" }),
    inboundSecretHash: await hashPlatformInboundSecret(inboundSecret),
    builtinCommandsJson: JSON.stringify({
      checkinEnabled: true,
      shareEnabled: true,
      leaderboardEnabled: true,
      spinEnabled: true,
      myPrizeEnabled: true,
      cardCodeEnabled: true,
      bindEnabled: true,
    }),
  });
}

// ── 测试开始 ──
describe("QQ 群助手多租户隔离", () => {
  beforeAll(async () => {
    ({ client, db } = await getTestDb());
  });

  beforeEach(async () => {
    await clearTestData(client);
    // 建立两个租户，各绑一个群
    await seedTenant(TENANT_A, GROUP_A, DRAW_A, SECRET_A, 2);
    await seedTenant(TENANT_B, GROUP_B, DRAW_B, SECRET_B, 2);
  });

  it("GROUP_A 消息只影响租户 A，不触发租户 B", async () => {
    const app = createTestApp();
    // 向群 A 发 /签到
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET_A}`,
      },
      body: JSON.stringify(qqMessage(GROUP_A, 1001, "/签到")),
    }, TEST_ENV);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.reply).toContain("签到成功");

    // 租户 A 应有签到记录（entry + spins_log）
    const [entryA] = await db
      .select({ id: lotteryEntries.id, tenantId: lotteryEntries.tenantId })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.tenantId, TENANT_A))
      .limit(1);
    expect(entryA).toBeDefined();
    expect(entryA!.tenantId).toBe(TENANT_A);

    // 租户 B 应无任何记录
    const entriesB = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.tenantId, TENANT_B));
    expect(entriesB.length).toBe(0);

    // 活动事件也应按租户隔离
    const eventsA = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(eq(activityEvents.tenantId, TENANT_A));
    expect(eventsA.length).toBeGreaterThan(0);
    const eventsB = await db
      .select({ id: activityEvents.id })
      .from(activityEvents)
      .where(eq(activityEvents.tenantId, TENANT_B));
    expect(eventsB.length).toBe(0);
  });

  it("GROUP_B 消息只影响租户 B，不触发租户 A", async () => {
    const app = createTestApp();
    // 向群 B 发 /签到
    const res = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET_B}`,
      },
      body: JSON.stringify(qqMessage(GROUP_B, 2001, "/签到")),
    }, TEST_ENV);
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.reply).toContain("签到成功");

    // 租户 B 应有签到记录
    const [entryB] = await db
      .select({ id: lotteryEntries.id, tenantId: lotteryEntries.tenantId })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.tenantId, TENANT_B))
      .limit(1);
    expect(entryB).toBeDefined();
    expect(entryB!.tenantId).toBe(TENANT_B);

    // 租户 A 应无任何记录
    const entriesA = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.tenantId, TENANT_A));
    expect(entriesA.length).toBe(0);
  });

  it("/抽奖 中奖记录按租户隔离，卡密不串", async () => {
    const app = createTestApp();
    // 两个群各自先签到（创建 entry）
    const signIn = async (groupId: string, userId: string, secret: string) => {
      await app.request("/api/platform/qq/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(qqMessage(groupId, userId, "/签到")),
      }, TEST_ENV);
    };
    await signIn(GROUP_A, 1001, SECRET_A);
    await signIn(GROUP_B, 2001, SECRET_B);

    // 群 A 抽奖
    const spinA = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify(qqMessage(GROUP_A, 1001, "/抽奖", 100)),
    }, TEST_ENV);
    expect(spinA.status).toBe(200);
    const spinABody = await spinA.json() as Record<string, unknown>;
    // 群 A 中奖记录应在租户 A 下
    const winnersA = await db
      .select({ id: lotteryWinners.id, tenantId: lotteryWinners.tenantId })
      .from(lotteryWinners)
      .where(eq(lotteryWinners.tenantId, TENANT_A));
    // 群 B 应无中奖
    const winnersB = await db
      .select({ id: lotteryWinners.id })
      .from(lotteryWinners)
      .where(eq(lotteryWinners.tenantId, TENANT_B));
    // 至少有一个中奖（2 个卡密，weight=100，必中）
    expect(winnersA.length).toBeGreaterThanOrEqual(1);
    expect(winnersB.length).toBe(0);

    // 卡密发放 tenantId 正确
    const issuedCodesA = await db
      .select({ id: prizeCodes.id, tenantId: prizeCodes.tenantId })
      .from(prizeCodes)
      .where(and(eq(prizeCodes.tenantId, TENANT_A), eq(prizeCodes.status, "issued")));
    const issuedCodesB = await db
      .select({ id: prizeCodes.id })
      .from(prizeCodes)
      .where(and(eq(prizeCodes.tenantId, TENANT_B), eq(prizeCodes.status, "issued")));
    expect(issuedCodesA.length).toBeGreaterThanOrEqual(1);
    expect(issuedCodesB.length).toBe(0);

    // 私聊消息入队（platform_deliveries）按租户隔离
    const deliveriesA = await db
      .select({ id: platformDeliveries.id, tenantId: platformDeliveries.tenantId })
      .from(platformDeliveries)
      .where(eq(platformDeliveries.tenantId, TENANT_A));
    const deliveriesB = await db
      .select({ id: platformDeliveries.id })
      .from(platformDeliveries)
      .where(eq(platformDeliveries.tenantId, TENANT_B));
    // 中奖后应有私聊消息入队（卡密私发）
    expect(deliveriesA.length).toBeGreaterThanOrEqual(1);
    expect(deliveriesB.length).toBe(0);
  });

  it("活动事件（activityEvents）严格按租户隔离", async () => {
    const app = createTestApp();
    // 群 A 签到
    await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify(qqMessage(GROUP_A, 1001, "/签到")),
    }, TEST_ENV);
    // 群 B 签到
    await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_B}` },
      body: JSON.stringify(qqMessage(GROUP_B, 2001, "/签到")),
    }, TEST_ENV);

    // activityEvents 按 tenantId 严格隔离
    const eventsA = await db
      .select({ id: activityEvents.id, tenantId: activityEvents.tenantId })
      .from(activityEvents)
      .where(eq(activityEvents.tenantId, TENANT_A));
    const eventsB = await db
      .select({ id: activityEvents.id, tenantId: activityEvents.tenantId })
      .from(activityEvents)
      .where(eq(activityEvents.tenantId, TENANT_B));

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    // 所有事件的 tenantId 都正确
    expect(eventsA.every(e => e.tenantId === TENANT_A)).toBe(true);
    expect(eventsB.every(e => e.tenantId === TENANT_B)).toBe(true);
  });

  it("错误密钥/未绑定群不泄露任何信息", async () => {
    const app = createTestApp();
    // 错误密钥 → 403
    const wrongKey = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify(qqMessage(GROUP_A, 1001, "/签到")),
    }, TEST_ENV);
    expect(wrongKey.status).toBe(403);

    // 未绑定群 → 404
    const unknownGroup = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify(qqMessage("999999", 1001, "/签到")),
    }, TEST_ENV);
    expect(unknownGroup.status).toBe(404);

    // 两个租户都不应有任何记录
    const entriesA = await db.select({ id: lotteryEntries.id }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, TENANT_A));
    const entriesB = await db.select({ id: lotteryEntries.id }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, TENANT_B));
    expect(entriesA.length).toBe(0);
    expect(entriesB.length).toBe(0);
  });
});