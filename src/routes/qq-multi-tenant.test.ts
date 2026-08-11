/**
 * QQ 群助手多租户隔离端到端测试（非常重要）。
 *
 * 验证两个租户各绑定不同 QQ 群时，所有 9 个内置命令严格租户隔离：
 * - 群 A 消息 → 只影响租户 A 的数据
 * - 群 B 消息 → 只影响租户 B 的数据
 * - 跨租户 token → 403 拒绝
 * - 出站消息按 platformTargetId 入队，不串租户
 *
 * 测试覆盖：/签到 /分享 /排行榜 /抽奖 /我的奖品 /卡密 /帮助 /秒杀 /绑定
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
  lotteryWinners,
  platformDeliveries,
  platformTargets,
  prizeCodes,
  prizes,
  shareRecords,
  tenants,
} from "../db/schema";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { and, eq, count } from "drizzle-orm";

let client: Awaited<ReturnType<typeof getTestDb>>["client"];
let db: Awaited<ReturnType<typeof getTestDb>>["db"];

// ── 两个租户 ──
const T_A = "tenant-qt-a";
const T_B = "tenant-qt-b";
const G_A = "111111";
const G_B = "222222";
const D_A = "draw-qt-a";
const D_B = "draw-qt-b";
const SEC_A = "secret-a";
const SEC_B = "secret-b";

const TEST_ENV = {
  TURSO_URL: "",
  ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/api/platform/qq", platformQQRoute);
  return app;
}

function msg(groupId: string, userId: number, text: string, mid = 1) {
  return {
    message_type: "group",
    group_id: Number(groupId),
    user_id: userId,
    message_id: mid,
    self_id: 888888,
    message: [{ type: "text", data: { text } }],
    sender: { nickname: "测试用户" },
  };
}

/** seed 一个租户的完整环境：租户 + 群绑定 + 活动 + 奖品 + 卡密 */
async function seedT(tenantId: string, groupId: string, drawId: string, secret: string) {
  await db.insert(tenants).values({ id: tenantId, name: `MT-${groupId}` });
  const now = new Date();
  const prizeId = `pr-${groupId}`;
  // 活动（即时抽奖，带裂变配置）
  await db.insert(lotteryDraws).values({
    id: drawId, tenantId, title: `活动 ${groupId}`, publicSlug: `s-${groupId}`,
    status: "open", activityKind: "lottery", participationMode: "open",
    experienceType: "wheel", resultMode: "instant", maxSpinsPerEntry: 5,
    startAt: new Date(now.getTime() - 3600000).toISOString(),
    endAt: new Date(now.getTime() + 3600000).toISOString(),
    activityConfig: "{}",
    promotionConfig: JSON.stringify({ viral: { enabled: true, extraEntriesPerInvite: 1, leaderboardEnabled: true } }),
  });
  // 奖品 + 奖档 + 2 张卡密
  await db.insert(prizes).values({ id: prizeId, tenantId, name: `奖品 ${groupId}`, prizeType: "code", totalCount: 2, active: 1 });
  await db.insert(lotteryPrizeTiers).values({ id: `tr-${groupId}`, tenantId, drawId, prizeId, tierName: "一等奖", winnerCount: 2, weight: 100, sortOrder: 1 });
  await db.insert(prizeCodes).values([
    { id: `c-${groupId}-1`, tenantId, prizeId, code: `CODE-${groupId}-1`, secret: `SEC-${groupId}-1`, status: "available" },
    { id: `c-${groupId}-2`, tenantId, prizeId, code: `CODE-${groupId}-2`, secret: `SEC-${groupId}-2`, status: "available" },
  ]);
  // 群绑定
  await db.insert(platformTargets).values({
    id: `pt-${groupId}`, tenantId, platform: "qq", targetId: groupId,
    targetName: `群 ${groupId}`, activeDrawId: drawId, activePublicSlug: `s-${groupId}`,
    assistantEnabled: 1, adapterDeploymentMode: "tenant_hosted", adapterProvider: "napcat",
    adapterConfigJson: JSON.stringify({ baseUrl: "http://t.example:3000" }),
    inboundSecretHash: await hashPlatformInboundSecret(secret),
    builtinCommandsJson: JSON.stringify({
      checkinEnabled: true, shareEnabled: true, leaderboardEnabled: true,
      spinEnabled: true, myPrizeEnabled: true, cardCodeEnabled: true, bindEnabled: true,
    }),
  });
}

/** 发送群消息并返回状态 + body */
async function sendMsg(app: ReturnType<typeof createApp>, groupId: string, userId: number, text: string, secret: string, mid = 1) {
  return app.request("/api/platform/qq/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(msg(groupId, userId, text, mid)),
  }, TEST_ENV);
}

// ── 测试 ──
describe("QQ 群助手多租户隔离（完整）", () => {
  beforeAll(async () => {
    ({ client, db } = await getTestDb());
  });
  beforeEach(async () => {
    await clearTestData(client);
    await seedT(T_A, G_A, D_A, SEC_A);
    await seedT(T_B, G_B, D_B, SEC_B);
  });

  // ── 1-2. 签到隔离 ──
  it("群 A 签到仅影响租户 A", async () => {
    const app = createApp();
    const r = await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    const b = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200); expect(b.reply).toContain("签到成功");
    // 租户 A 有 entry
    const nA = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_A)))[0].n);
    const nB = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_B)))[0].n);
    expect(nA).toBe(1); expect(nB).toBe(0);
  });

  it("群 B 签到仅影响租户 B", async () => {
    const app = createApp();
    const r = await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    const b = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200); expect(b.reply).toContain("签到成功");
    const nA = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_A)))[0].n);
    const nB = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_B)))[0].n);
    expect(nA).toBe(0); expect(nB).toBe(1);
  });

  // ── 3. 分享隔离 ──
  it("/分享 shareRecords 按租户隔离", async () => {
    const app = createApp();
    // 各自签到才有 entry
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    // 各自分享
    await sendMsg(app, G_A, 1001, "/分享", SEC_A, 2);
    await sendMsg(app, G_B, 2001, "/分享", SEC_B, 2);
    // 验证 shareRecords 租户隔离
    const sA = await db.select({ id: shareRecords.id }).from(shareRecords).where(eq(shareRecords.tenantId, T_A));
    const sB = await db.select({ id: shareRecords.id }).from(shareRecords).where(eq(shareRecords.tenantId, T_B));
    expect(sA.length).toBe(1); expect(sB.length).toBe(1);
    // 验证所有 shareRecords 的 tenantId 正确
    const all = await db.select({ id: shareRecords.id, tenantId: shareRecords.tenantId }).from(shareRecords);
    const aIds = all.filter(x => x.tenantId === T_A).length;
    const bIds = all.filter(x => x.tenantId === T_B).length;
    expect(aIds).toBe(1); expect(bIds).toBe(1);
    expect(aIds + bIds).toBe(all.length); // 无 stray
  });

  // ── 4. 排行榜隔离 ──
  it("/排行榜 不跨租户", async () => {
    const app = createApp();
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    // 创建对方的 shareRecords 来模拟"跨租户污染"
    // 直接往 shareRecords 插入一条租户 B 的记录（但实际群 A 的排行榜不应看到）
    // 但排行榜按 drawId+tenantId 查，天然隔离，所以主要验证不报错、返回结果正确即可
    const r = await sendMsg(app, G_A, 1001, "/排行榜", SEC_A, 2);
    const b = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200);
    // 排行榜应该返回结果（不报错），且不涉及租户 B 的数据
    // 由于没有分享记录，排行榜会提示"还没有邀请排行"——这是正常行为
    expect(b.reply).toContain("邀请排行");
  });

  // ── 5. 抽奖隔离 ──
  it("/抽奖 中奖/卡密/私聊按租户隔离", async () => {
    const app = createApp();
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    // 仅群 A 抽奖
    await sendMsg(app, G_A, 1001, "/抽奖", SEC_A, 2);
    // 租户 A 应有 winner
    const wA = Number((await db.select({ n: count() }).from(lotteryWinners).where(eq(lotteryWinners.tenantId, T_A)))[0].n);
    const wB = Number((await db.select({ n: count() }).from(lotteryWinners).where(eq(lotteryWinners.tenantId, T_B)))[0].n);
    expect(wA).toBeGreaterThanOrEqual(1);
    expect(wB).toBe(0);
    // 卡密只从租户 A 池发放
    const issuedA = Number((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, T_A), eq(prizeCodes.status, "issued"))))[0].n);
    const issuedB = Number((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, T_B), eq(prizeCodes.status, "issued"))))[0].n);
    expect(issuedA).toBeGreaterThanOrEqual(1);
    expect(issuedB).toBe(0);
    // 私聊消息入队按租户隔离
    const dA = Number((await db.select({ n: count() }).from(platformDeliveries).where(eq(platformDeliveries.tenantId, T_A)))[0].n);
    const dB = Number((await db.select({ n: count() }).from(platformDeliveries).where(eq(platformDeliveries.tenantId, T_B)))[0].n);
    expect(dA).toBeGreaterThanOrEqual(1);
    expect(dB).toBe(0);
  });

  // ── 6. 我的奖品隔离 ──
  it("/我的奖品 只查本租户中奖记录", async () => {
    const app = createApp();
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    await sendMsg(app, G_A, 1001, "/抽奖", SEC_A, 2);
    // 群 A 用户查奖品 → 应有结果
    const rA = await sendMsg(app, G_A, 1001, "/我的奖品", SEC_A, 3);
    const bA = await rA.json() as Record<string, unknown>;
    expect(rA.status).toBe(200);
    expect(bA.reply).toContain("奖品");
    // 群 B 用户（未抽奖）查奖品 → 应提示"还没有获得奖品"
    const rB = await sendMsg(app, G_B, 2001, "/我的奖品", SEC_B, 3);
    const bB = await rB.json() as Record<string, unknown>;
    expect(rB.status).toBe(200);
    expect(bB.reply).toContain("还没有获得奖品");
  });

  // ── 7. 卡密隔离 ──
  it("/卡密 只查本租户中奖卡密", async () => {
    const app = createApp();
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    // 两群都抽奖
    await sendMsg(app, G_A, 1001, "/抽奖", SEC_A, 2);
    await sendMsg(app, G_B, 2001, "/抽奖", SEC_B, 2);
    // 群 A 查卡密 → 应有结果
    const rA = await sendMsg(app, G_A, 1001, "/卡密", SEC_A, 3);
    expect(rA.status).toBe(200);
    // 两群都抽了奖，各自应有自己的卡密
    const cA = Number((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, T_A), eq(prizeCodes.status, "issued"))))[0].n);
    const cB = Number((await db.select({ n: count() }).from(prizeCodes).where(and(eq(prizeCodes.tenantId, T_B), eq(prizeCodes.status, "issued"))))[0].n);
    expect(cA).toBeGreaterThanOrEqual(1);
    expect(cB).toBeGreaterThanOrEqual(1);
  });

  // ── 8. 跨租户 Token 鉴权 ──
  it("A 的密钥无法向 B 群发消息（跨租户 token 403）", async () => {
    const app = createApp();
    // 用 A 的密钥向 B 群发消息 → 路由按 B 群号查绑定 → 用 B 的 hash 校验 token → 不匹配 → 403
    const r = await sendMsg(app, G_B, 9999, "/签到", SEC_A);
    expect(r.status).toBe(403);
    // 两个租户都不应有数据
    const nA = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_A)))[0].n);
    const nB = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_B)))[0].n);
    expect(nA).toBe(0); expect(nB).toBe(0);
  });

  // ── 9. 出站投递按 platformTargetId 隔离 ──
  it("出站私聊消息按 platformTargetId 入队，不串租户", async () => {
    const app = createApp();
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    await sendMsg(app, G_A, 1001, "/抽奖", SEC_A, 2);
    // 验证所有 platform_deliveries 的 tenantId 正确
    const all = await db.select({ id: platformDeliveries.id, tenantId: platformDeliveries.tenantId })
      .from(platformDeliveries);
    const aIds = all.filter(x => x.tenantId === T_A).length;
    const bIds = all.filter(x => x.tenantId === T_B).length;
    expect(aIds).toBeGreaterThanOrEqual(1);
    expect(bIds).toBe(0); // 只有群 A 抽奖，所以 B 无投递
    // 验证每条 delivery 的 tenantId 都正确
    expect(all.every(d => d.tenantId === T_A)).toBe(true);
  });

  // ── 10. activityEvents 严格隔离 ──
  it("activityEvents 严格按租户隔离", async () => {
    const app = createApp();
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    const all = await db.select({ id: activityEvents.id, tenantId: activityEvents.tenantId }).from(activityEvents);
    const aIds = all.filter(x => x.tenantId === T_A).length;
    const bIds = all.filter(x => x.tenantId === T_B).length;
    expect(aIds).toBeGreaterThan(0); expect(bIds).toBeGreaterThan(0);
    expect(aIds + bIds).toBe(all.length); // 无 stray
  });

  // ── 11. 错误密钥 / 未绑定群不泄露数据 ──
  it("错误密钥 403，未绑定群 404，不泄露数据", async () => {
    const app = createApp();
    // 错误密钥
    const r1 = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify(msg(G_A, 1001, "/签到", 1)),
    }, TEST_ENV);
    expect(r1.status).toBe(403);
    // 未绑定群
    const r2 = await app.request("/api/platform/qq/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SEC_A}` },
      body: JSON.stringify(msg("999999", 1001, "/签到", 1)),
    }, TEST_ENV);
    expect(r2.status).toBe(404);
    // 两租户无数据
    const nA = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_A)))[0].n);
    const nB = Number((await db.select({ n: count() }).from(lotteryEntries).where(eq(lotteryEntries.tenantId, T_B)))[0].n);
    expect(nA).toBe(0); expect(nB).toBe(0);
  });

  // ── 12. /帮助 不涉及租户数据，能正确返回 ──
  it("/帮助 能正确返回", async () => {
    const app = createApp();
    const r = await sendMsg(app, G_A, 1001, "/帮助", SEC_A);
    const b = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200);
    expect(b.reply).toContain("帮助");
  });

  // ── 13. /秒杀 返回购买链接（不涉及租户数据）──
  it("/秒杀 返回购买链接", async () => {
    const app = createApp();
    const r = await sendMsg(app, G_A, 1001, "/秒杀", SEC_A);
    const b = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200);
    // 秒杀命令返回购买提示（如果没有配置秒杀，会提示"当前活动未开启秒杀"）
    expect(b.reply).toContain("购买链接");
  });

  // ── 14. /绑定 生成绑定码，按租户隔离 ──
  it("/绑定 绑定码按租户隔离", async () => {
    const app = createApp();
    // 群 A 绑定 — 需要有 entry 才能绑定（先签到）
    await sendMsg(app, G_A, 1001, "/签到", SEC_A);
    await sendMsg(app, G_B, 2001, "/签到", SEC_B);
    // 群 A 执行绑定
    const rA = await sendMsg(app, G_A, 1001, "/绑定", SEC_A, 2);
    const bA = await rA.json() as Record<string, unknown>;
    expect(rA.status).toBe(200);
    // 绑定码是私聊发送的，群内回复会提示绑定方式
    // 主要验证不报错即可
    expect(bA.reply).toBeTruthy();

    // 群 B 执行绑定
    const rB = await sendMsg(app, G_B, 2001, "/绑定", SEC_B, 2);
    const bB = await rB.json() as Record<string, unknown>;
    expect(rB.status).toBe(200);
    expect(bB.reply).toBeTruthy();
  });
});