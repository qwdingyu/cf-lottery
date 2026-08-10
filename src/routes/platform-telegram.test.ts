/**
 * Telegram Bot 入站路由测试（docs/170）。
 *
 * 这组测试与 platform-qq.test.ts 共用同一套业务逻辑（handleInboundPlatformEvent），
 * 差异在于：
 * - Telegram 通过 ?secret= 鉴权（不支持自定义请求头）
 * - Telegram 消息结构不同（update.message.chat.id / update.message.from.id）
 * - 平台类型为 "telegram"，身份类型为 "telegram"
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { platformTelegramRoute } from "./platform-telegram";
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
  shareRecords,
  tenants,
} from "../db/schema";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { and, eq } from "drizzle-orm";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

const TENANT_ID = "tenant-platform-telegram";
const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
};
const INBOUND_SECRET = "tg-inbound-secret";

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/platform/telegram", platformTelegramRoute);
  return app;
}

/**
 * 构造 Telegram webhook update 对象。
 * 结构参考：https://core.telegram.org/bots/api#update
 */
function telegramUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1000001,
    message: {
      message_id: 42,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: -1001234567890,
        type: "supergroup",
        title: "测试群",
      },
      from: {
        id: 998877,
        is_bot: false,
        first_name: "测试用户",
        username: "testuser",
      },
      text: "/帮助",
      ...overrides,
    },
  };
}

async function seedTarget(builtinCommandsJson = "{}") {
  await db.insert(tenants).values({ id: TENANT_ID, name: "Telegram 群助手测试租户" });
  await db.insert(platformTargets).values({
    id: "pt-tg-1",
    tenantId: TENANT_ID,
    platform: "telegram",
    targetId: "-1001234567890",
    targetName: "测试群",
    activeDrawId: "draw-tg-1",
    activePublicSlug: "tg-lottery",
    assistantEnabled: 1,
    adapterDeploymentMode: "tenant_hosted",
    adapterProvider: "",
    adapterConfigJson: JSON.stringify({ botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" }),
    inboundSecretHash: await hashPlatformInboundSecret(INBOUND_SECRET),
    builtinCommandsJson,
  });
}

async function seedCheckinDraw(status = "open") {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: "draw-tg-1",
    tenantId: TENANT_ID,
    title: "Telegram 签到活动",
    publicSlug: "tg-lottery",
    status,
    activityKind: "checkin",
    participationMode: "open",
    experienceType: "submit",
    resultMode: "manual",
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
  });
}

async function seedViralDraw(viralEnabled = true, leaderboardEnabled: boolean | undefined = undefined) {
  const now = new Date();
  await db.insert(lotteryDraws).values({
    id: "draw-tg-1",
    tenantId: TENANT_ID,
    title: "Telegram 裂变抽奖",
    publicSlug: "tg-lottery",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "submit",
    resultMode: "manual",
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
    promotionConfig: JSON.stringify({
      viral: {
        enabled: viralEnabled,
        extraEntriesPerInvite: 1,
        maxExtraEntries: 10,
        ...(leaderboardEnabled === undefined ? {} : { leaderboardEnabled }),
      },
    }),
  });
}

async function seedInstantDraw() {
  const now = new Date();
  const prizeId = "prize-tg-instant";
  await db.insert(lotteryDraws).values({
    id: "draw-tg-1",
    tenantId: TENANT_ID,
    title: "Telegram 即时抽奖",
    publicSlug: "tg-lottery",
    status: "open",
    activityKind: "lottery",
    participationMode: "open",
    experienceType: "wheel",
    resultMode: "instant",
    maxSpinsPerEntry: 2,
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
    promotionConfig: "{}",
  });
  await db.insert(prizes).values({
    id: prizeId,
    tenantId: TENANT_ID,
    name: "Telegram 卡密奖品",
    prizeType: "code",
    totalCount: 2,
    active: 1,
  });
  await db.insert(lotteryPrizeTiers).values({
    id: "tier-tg-instant",
    tenantId: TENANT_ID,
    drawId: "draw-tg-1",
    prizeId,
    tierName: "一等奖",
    winnerCount: 2,
    weight: 100,
    sortOrder: 1,
  });
  await db.insert(prizeCodes).values([
    {
      id: "code-tg-1",
      tenantId: TENANT_ID,
      prizeId,
      code: "TG-CODE-1",
      secret: "SECRET-1",
      status: "available",
    },
    {
      id: "code-tg-2",
      tenantId: TENANT_ID,
      prizeId,
      code: "TG-CODE-2",
      secret: "SECRET-2",
      status: "available",
    },
  ]);
}

async function seedLeaderboardEntry(id: string, identityValue: string, displayName: string, joinedCount: number) {
  await db.insert(lotteryEntries).values({
    id,
    tenantId: TENANT_ID,
    drawId: "draw-tg-1",
    identityType: "telegram",
    identityValue,
    displayName,
    joinedAt: new Date().toISOString(),
  });
  await db.insert(shareRecords).values({
    id: `share-${id}`,
    tenantId: TENANT_ID,
    drawId: "draw-tg-1",
    sharerEntryId: id,
    shareCode: `code-${id}`,
    joinedCount,
  });
}

beforeAll(async () => {
  ({ client, db } = await getTestDb());
});

beforeEach(async () => {
  await clearTestData(client);
});

describe("POST /api/platform/telegram/message", () => {
  it("缺少 secret 参数返回 401", async () => {
    await seedTarget();
    const app = createTestApp();
    const res = await app.request("/api/platform/telegram/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate()),
    }, TEST_ENV);

    expect(res.status).toBe(401);
  });

  it("非消息更新（如 callback_query）直接忽略", async () => {
    const app = createTestApp();
    const res = await app.request("/api/platform/telegram/message?secret=xxx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: 1000002,
        callback_query: {
          id: "cb-1",
          from: { id: 12345, first_name: "User" },
          data: "spin",
        },
      }),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reason?: string };
    expect(body.handled).toBe(false);
    expect(body.reason).toBe("非消息更新");
  });

  it("未绑定目标返回 404，不进入业务写入", async () => {
    const app = createTestApp();
    const res = await app.request("/api/platform/telegram/message?secret=xxx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/签到" })),
    }, TEST_ENV);

    expect(res.status).toBe(404);
  });

  it("无效入站密钥返回 401", async () => {
    await seedTarget();
    const app = createTestApp();
    const res = await app.request("/api/platform/telegram/message?secret=wrong-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate()),
    }, TEST_ENV);

    expect(res.status).toBe(401);
  });

  it("已绑定目标返回当前启用的内置命令帮助", async () => {
    await seedTarget(JSON.stringify({ spinEnabled: false }));
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate()),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("/签到");
    expect(body.reply).not.toContain("/抽奖");
    expect(body.reply).toContain("/我的奖品");
  });

  it("已关闭的内置命令返回关闭提示", async () => {
    await seedTarget(JSON.stringify({ shareEnabled: false }));
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/分享" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("未启用 /分享");
  });

  it("/签到 使用 Telegram 身份创建参与记录并记录群来源事件", async () => {
    await seedTarget();
    await seedCheckinDraw();
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/签到" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("签到成功");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, "draw-tg-1"),
        eq(lotteryEntries.identityType, "telegram"),
      ));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.identityValue).toContain("998877");
    expect(entries[0]?.displayName).toBe("测试用户");

    const events = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT_ID),
        eq(activityEvents.drawId, "draw-tg-1"),
        eq(activityEvents.eventType, "participation_completed"),
        eq(activityEvents.source, "telegram_group"),
        eq(activityEvents.medium, "platform_command"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0]?.entryId).toBe(entries[0]?.id);
  });

  it("/签到 同一天重复调用不重复创建参与记录", async () => {
    await seedTarget();
    await seedCheckinDraw();
    const app = createTestApp();
    const request = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
      body: JSON.stringify(telegramUpdate({ text: "/签到" })),
    };

    const first = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, request, TEST_ENV);
    expect(first.status).toBe(200);
    const second = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, request, TEST_ENV);
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { reply?: string };
    expect(secondBody.reply).toContain("已参与");

    const entries = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, "draw-tg-1")));
    expect(entries).toHaveLength(1);
  });

  it("/签到 绑定活动未开启时返回业务失败提示", async () => {
    await seedTarget();
    await seedCheckinDraw("draft");
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/签到" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { reply?: string };
    expect(body.reply).toContain("活动未开启");
  });

  it("/分享 在开启裂变时用 Telegram 身份创建参与记录和专属分享码", async () => {
    await seedTarget();
    await seedViralDraw(true);
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/分享" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("/lottery/tg-lottery?ref=");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, "draw-tg-1"),
        eq(lotteryEntries.identityType, "telegram"),
      ));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.displayName).toBe("测试用户");

    const shares = await db
      .select()
      .from(shareRecords)
      .where(and(
        eq(shareRecords.tenantId, TENANT_ID),
        eq(shareRecords.drawId, "draw-tg-1"),
        eq(shareRecords.sharerEntryId, entries[0]!.id),
      ));
    expect(shares).toHaveLength(1);
    expect(body.reply).toContain(shares[0]!.shareCode);

    const events = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, TENANT_ID),
        eq(activityEvents.drawId, "draw-tg-1"),
        eq(activityEvents.eventType, "share_created"),
        eq(activityEvents.source, "telegram_group"),
        eq(activityEvents.medium, "platform_command"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0]?.entryId).toBe(entries[0]?.id);
    expect(events[0]?.refCode).toBe(shares[0]?.shareCode);
  });

  it("/分享 重复调用复用同一个分享码，不重复创建 shareRecords", async () => {
    await seedTarget();
    await seedViralDraw(true);
    const app = createTestApp();
    const request = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
      body: JSON.stringify(telegramUpdate({ text: "/分享" })),
    };

    const first = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, request, TEST_ENV);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { reply?: string };
    const second = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, request, TEST_ENV);
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { reply?: string };

    expect(secondBody.reply).toBe(firstBody.reply);
    const shares = await db
      .select()
      .from(shareRecords)
      .where(and(eq(shareRecords.tenantId, TENANT_ID), eq(shareRecords.drawId, "draw-tg-1")));
    expect(shares).toHaveLength(1);
  });

  it("/分享 在活动未开启裂变时不创建参与记录和分享码", async () => {
    await seedTarget();
    await seedViralDraw(false);
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/分享" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("未开启裂变分享");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, TENANT_ID), eq(lotteryEntries.drawId, "draw-tg-1")));
    expect(entries).toHaveLength(0);

    const shares = await db
      .select()
      .from(shareRecords)
      .where(and(eq(shareRecords.tenantId, TENANT_ID), eq(shareRecords.drawId, "draw-tg-1")));
    expect(shares).toHaveLength(0);
  });

  it("/排行榜 按现有裂变邀请数展示 Top5 和我的真实排名", async () => {
    await seedTarget();
    await seedViralDraw(true);
    await seedLeaderboardEntry("entry-a", "100001", "冠军用户", 8);
    await seedLeaderboardEntry("entry-me", "998877", "测试用户", 5);
    await seedLeaderboardEntry("entry-c", "100003", "第三名", 4);
    await seedLeaderboardEntry("entry-d", "100004", "第四名", 3);
    await seedLeaderboardEntry("entry-e", "100005", "第五名", 2);
    await seedLeaderboardEntry("entry-f", "100006", "第六名", 1);

    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/排行榜" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("邀请排行榜 Top5");
    expect(body.reply).toContain("1. 冠军用户 邀请8人");
    expect(body.reply).toContain("2. 测试用户 邀请5人");
    expect(body.reply).toContain("我的排名：第2名，邀请5人");
    expect(body.reply).not.toContain("第六名");
  });

  it("/排行榜 未参与用户只看榜不自动创建 Telegram 参与记录", async () => {
    await seedTarget();
    await seedViralDraw(true);
    await seedLeaderboardEntry("entry-a", "100001", "冠军用户", 3);

    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/排行榜", from: { id: 222333, first_name: "路人" } })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("你还未参与本活动");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, "draw-tg-1"),
        eq(lotteryEntries.identityValue, "222333"),
      ));
    expect(entries).toHaveLength(0);
  });

  it("/排行榜 在裂变排行榜关闭时返回配置提示", async () => {
    await seedTarget();
    await seedViralDraw(true, false);
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/排行榜" })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("未开启裂变排行榜");
  });

  it("/抽奖 直接用 Telegram 身份参与并即时抽奖，群内不泄露卡密", async () => {
    await seedTarget();
    await seedInstantDraw();
    const app = createTestApp();
    const res = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/抽奖", message_id: 9001 })),
    }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("恭喜你抽中了");
    expect(body.reply).not.toContain("TG-CODE-1");
    expect(body.reply).not.toContain("SECRET-1");
    // 卡密奖品不再在群内展示"群内泄露"提示，而是改为私聊发送
    expect(body.reply).toContain("卡密已私聊发送");
    // 由于测试环境没有真实 Telegram Bot API 服务，私聊发送会失败，回复中应包含降级提示
    expect(body.reply).toContain("私聊发送失败");

    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, "draw-tg-1"),
        eq(lotteryEntries.identityType, "telegram"),
        eq(lotteryEntries.identityValue, "998877"),
      ));
    expect(entries).toHaveLength(1);

    const winners = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.tenantId, TENANT_ID), eq(lotteryWinners.drawId, "draw-tg-1")));
    expect(winners).toHaveLength(1);

    // P1-1 审计：私聊发送失败应记录到 platformDeliveries
    const deliveries = await db
      .select()
      .from(platformDeliveries)
      .where(and(
        eq(platformDeliveries.tenantId, TENANT_ID),
        eq(platformDeliveries.platformTargetId, "pt-tg-1"),
        eq(platformDeliveries.eventType, "private_message"),
        eq(platformDeliveries.status, "failed"),
      ));
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].lastError).toContain("私聊发送失败");
  });

  it("/抽奖 同一消息回放不重复扣次，新消息可继续抽", async () => {
    await seedTarget();
    await seedInstantDraw();
    const app = createTestApp();
    const request = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
      body: JSON.stringify(telegramUpdate({ text: "/抽奖", message_id: 9101 })),
    };

    const first = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, request, TEST_ENV);
    expect(first.status).toBe(200);
    const replay = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, request, TEST_ENV);
    expect(replay.status).toBe(200);

    let spins = await db
      .select()
      .from(lotterySpins)
      .where(and(eq(lotterySpins.tenantId, TENANT_ID), eq(lotterySpins.drawId, "draw-tg-1")));
    expect(spins).toHaveLength(1);

    await db
      .update(lotteryEntries)
      .set({ spinsLeft: 1, spinsTotalGranted: 2 })
      .where(and(
        eq(lotteryEntries.tenantId, TENANT_ID),
        eq(lotteryEntries.drawId, "draw-tg-1"),
        eq(lotteryEntries.identityType, "telegram"),
        eq(lotteryEntries.identityValue, "998877"),
      ));

    const secondMessage = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/抽奖", message_id: 9102 })),
    }, TEST_ENV);
    expect(secondMessage.status).toBe(200);

    spins = await db
      .select()
      .from(lotterySpins)
      .where(and(eq(lotterySpins.tenantId, TENANT_ID), eq(lotterySpins.drawId, "draw-tg-1")));
    expect(spins).toHaveLength(2);
  });

  it("/我的奖品 只展示奖品摘要，不在群内展示卡密", async () => {
    await seedTarget();
    await seedInstantDraw();
    const app = createTestApp();
    const spinRes = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/抽奖", message_id: 9201 })),
    }, TEST_ENV);
    expect(spinRes.status).toBe(200);

    const prizeRes = await app.request(`/api/platform/telegram/message?secret=${INBOUND_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramUpdate({ text: "/我的奖品", message_id: 9202 })),
    }, TEST_ENV);
    expect(prizeRes.status).toBe(200);
    const body = await prizeRes.json() as { handled?: boolean; reply?: string };
    expect(body.handled).toBe(true);
    expect(body.reply).toContain("Telegram 卡密奖品");
    expect(body.reply).toContain("群内不展示");
    expect(body.reply).not.toContain("TG-CODE-1");
    expect(body.reply).not.toContain("SECRET-1");
  });
});
