/**
 * 公开参与路由 — 接龙列表 / 裂变排行 / 分享码
 *
 * 从 public-lottery.ts 按域挂载；主文件保留详情、验证码、参与、查结果。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getClientIp } from "../lib/platform";
import { getDb, ok, fail } from "../lib/http";
import {
  lotteryDraws,
  lotteryEntries,
  shareRecords,
} from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { recordActivityEvent } from "../services/lottery-service";
import {
  maskIdentity,
  tryParseJson,
  hashEventValue,
} from "./public-lottery-helpers";

export function setupPublicShareRoutes(route: Hono<AppEnv>) {
/** 接龙模式：公开参与列表（按参与时间排序） */
route.get("/draws/:slug/signup-list", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");

  const [draw] = await db
    .select({ id: lotteryDraws.id, activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "signup_chain") return fail(c, "该活动不是接龙模式", 400);

  const entries = await db
    .select({
      identityValue: lotteryEntries.identityValue,
      joinedAt: lotteryEntries.joinedAt,
    })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, draw.id))
    .orderBy(lotteryEntries.joinedAt)
    .limit(200);  // 公开 API 上限，防止数据炸弹

  // 脱敏展示邮箱
  const masked = entries.map((e, i) => ({
    order: i + 1,
    identity: maskIdentity(e.identityValue),
    joinedAt: e.joinedAt,
  }));

  return ok(c, { entries: masked, total: entries.length });
});

// ═════════════════════════════════════════════════════════
// 裂变排行榜（公开，按邀请人数降序，脱敏展示）
// ═════════════════════════════════════════════════════════

route.get("/draws/:slug/viral-leaderboard", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const entryId = c.req.query("entryId") || "";

  const [draw] = await db
    .select({ id: lotteryDraws.id, promotionConfig: lotteryDraws.promotionConfig })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 解析裂变配置，判断是否开启排行榜
  const pc = tryParseJson(draw.promotionConfig) as any;
  const viral = pc?.viral;
  if (!viral?.enabled || !viral?.leaderboardEnabled) {
    return fail(c, "该活动未开启裂变排行榜", 400);
  }

  // 查询所有分享记录，按分享者聚合邀请人数
  const shareRows = await db
    .select({
      sharerEntryId: shareRecords.sharerEntryId,
      joinedCount: shareRecords.joinedCount,
    })
    .from(shareRecords)
    .where(eq(shareRecords.drawId, draw.id));

  // 按 sharerEntryId 聚合 SUM(joinedCount)
  const aggMap = new Map<string, number>();
  for (const row of shareRows) {
    aggMap.set(row.sharerEntryId, (aggMap.get(row.sharerEntryId) || 0) + row.joinedCount);
  }
  if (aggMap.size === 0) {
    return ok(c, { entries: [], myRank: null });
  }

  // 查询参与者身份信息（脱敏展示）
  const entryIds = Array.from(aggMap.keys());
  const entryRows = await db
    .select({ id: lotteryEntries.id, identityValue: lotteryEntries.identityValue, displayName: lotteryEntries.displayName })
    .from(lotteryEntries)
    .where(inArray(lotteryEntries.id, entryIds));

  const identityMap = new Map<string, string>();
  for (const e of entryRows) {
    identityMap.set(e.id, e.displayName || maskIdentity(e.identityValue));
  }

  // 构建排行榜（按邀请人数降序，Top 20）
  const sorted = Array.from(aggMap.entries())
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const leaderboard = sorted.map(([sharerEntryId, count], index) => ({
    rank: index + 1,
    displayName: identityMap.get(sharerEntryId) || "***",
    invitedCount: count,
  }));

  // 查询"我"的排名
  let myRank: { rank: number; invitedCount: number } | null = null;
  if (entryId) {
    const myCount = aggMap.get(entryId) || 0;
    if (myCount > 0) {
      const rankIndex = sorted.findIndex(([id]) => id === entryId);
      if (rankIndex >= 0) {
        myRank = { rank: rankIndex + 1, invitedCount: myCount };
      } else {
        myRank = { rank: sorted.length + 1, invitedCount: myCount };
      }
    }
  }

  return ok(c, { entries: leaderboard, myRank });
});

// ═════════════════════════════════════════════════════════
// 我的裂变数据（公开，需要 entryId 查询自己的分享统计）
// ═════════════════════════════════════════════════════════

route.get("/draws/:slug/my-viral-stats", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const entryId = c.req.query("entryId") || "";
  if (!entryId) return fail(c, "缺少参与记录 ID", 400);

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, promotionConfig: lotteryDraws.promotionConfig })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const pc = tryParseJson(draw.promotionConfig) as any;
  const viral = pc?.viral;
  if (!viral?.enabled) {
    return fail(c, "该活动未开启裂变", 400);
  }

  // 查询该参与者的分享记录
  const myShares = await db
    .select()
    .from(shareRecords)
    .where(and(eq(shareRecords.drawId, draw.id), eq(shareRecords.sharerEntryId, entryId)));

  // 聚合统计
  const totalClicked = myShares.reduce((s, r) => s + r.clickedCount, 0);
  const totalJoined = myShares.reduce((s, r) => s + r.joinedCount, 0);
  const extraEntriesPerInvite = viral?.extraEntriesPerInvite ?? 1;
  const maxExtraEntries = viral?.maxExtraEntries ?? 10;
  const extraEntriesEarned = Math.min(totalJoined, maxExtraEntries);

  // 取最新一条分享码作为默认链接
  const latestShare = myShares.length > 0 ? myShares[myShares.length - 1] : null;
  const shareCode = latestShare?.shareCode || "";
  const shareUrl = shareCode ? `/${slug}?ref=${shareCode}` : "";

  return ok(c, {
    shareCode,
    shareUrl,
    clickedCount: totalClicked,
    invitedCount: totalJoined,
    extraEntriesEarned,
    extraEntriesPerInvite,
    maxExtraEntries,
  });
});

/** 生成分享码（参与者分享活动链接） */
route.post("/draws/:slug/share", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ entryId: string }>();
  if (!body.entryId) return fail(c, "缺少参与记录 ID", 400);

  const [draw] = await db.select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId }).from(lotteryDraws).where(eq(lotteryDraws.publicSlug, slug)).limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const shareCode = crypto.randomUUID().slice(0, 12);
  await db.insert(shareRecords).values({
    id: crypto.randomUUID(),
    tenantId: draw.tenantId,
    drawId: draw.id,
    sharerEntryId: body.entryId,
    shareCode,
  });

  return ok(c, { shareCode, shareUrl: `/lottery/${slug}?ref=${shareCode}` });
});

/** 通过分享链接打开活动（记录点击） */
route.get("/draws/:slug/ref/:shareCode", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const shareCode = c.req.param("shareCode");

  const [share] = await db.select().from(shareRecords).where(eq(shareRecords.shareCode, shareCode)).limit(1);
  if (share) {
    await db.update(shareRecords).set({ clickedCount: share.clickedCount + 1 }).where(eq(shareRecords.id, share.id));
    await recordActivityEvent(db, {
      tenantId: share.tenantId,
      drawId: share.drawId,
      eventType: "share_click",
      refCode: shareCode,
      ipHash: await hashEventValue(getClientIp(c) || ""),
      userAgent: c.req.header("User-Agent") || "",
    });
  }

  return c.redirect(`/${slug}`);
});
}
