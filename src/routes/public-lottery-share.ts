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
import { eq, and, inArray, desc } from "drizzle-orm";
import { recordActivityEvent } from "../services/lottery-service";
import {
  maskIdentity,
  tryParseJson,
  hashEventValue,
} from "./public-lottery-helpers";
import {
  aggregateViralInviteCounts,
  aggregateFirstSharedAt,
  buildPublicSharePath,
  buildViralLeaderboardRanking,
  computeViralExtraEntries,
  isViralEnabled,
  isViralLeaderboardEnabled,
  normalizeViralWeightNumbers,
  type ViralWeightConfig,
} from "../services/lottery/viral-weight";
// 里程碑进度（docs/259 D2 ②）：两层激励共用一个进度面。
// buildMilestoneProgress 零引擎依赖；defs 合法性仍走发放侧同一入口 normalizeReferralRewardDefs，
// 保证「前台展示的档位」与「运行时会发的档位」永远是同一集合。
import { buildMilestoneProgress, parseGrantedRewardIds } from "../services/lottery/referral-milestones";
import { normalizeReferralRewardDefs } from "../services/lottery/referral-rewards-engine";

export function setupPublicShareRoutes(route: Hono<AppEnv>) {
/** 接龙模式：公开参与列表（按参与时间排序） */
route.get("/draws/:slug/signup-list", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, activityKind: lotteryDraws.activityKind })
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
    .where(and(eq(lotteryEntries.drawId, draw.id), eq(lotteryEntries.tenantId, draw.tenantId)))
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
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, promotionConfig: lotteryDraws.promotionConfig })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 解析裂变配置：门禁与 isViralLeaderboardEnabled 单一真相（docs/114）
  const pc = tryParseJson(draw.promotionConfig) as { viral?: ViralWeightConfig } | undefined;
  const viral = pc?.viral;
  if (!isViralLeaderboardEnabled(viral)) {
    return fail(c, "该活动未开启裂变排行榜", 400);
  }

  // 查询所有分享记录，按分享者聚合邀请人数（多码 SUM，与开奖一致）
  const shareRows = await db
    .select({
      sharerEntryId: shareRecords.sharerEntryId,
      joinedCount: shareRecords.joinedCount,
      createdAt: shareRecords.createdAt,
      leaderboardRewardedAt: shareRecords.leaderboardRewardedAt,
    })
    .from(shareRecords)
    .where(and(eq(shareRecords.drawId, draw.id), eq(shareRecords.tenantId, draw.tenantId)));

  const aggMap = aggregateViralInviteCounts(shareRows);
  const firstSharedAtMap = aggregateFirstSharedAt(shareRows);

  // 排行榜奖励状态聚合：同一分享者多条 shareCode，任一行 leaderboardRewardedAt 非空即视为已发放
  const rewardedMap = new Map<string, string>();
  for (const row of shareRows) {
    const id = String(row?.sharerEntryId || "").trim();
    if (!id) continue;
    const ts = String(row?.leaderboardRewardedAt || "").trim();
    if (!ts) continue;
    const existing = rewardedMap.get(id);
    // 取最新标记时间（展示用，非排序依据）
    if (!existing || ts > existing) rewardedMap.set(id, ts);
  }

  // 全量排名再截 Top20；myRank 在全量上算，未进榜也是真实名次（docs/109）
  const ranking = buildViralLeaderboardRanking(aggMap, { entryId, topN: 20, firstSharedAtMap });
  if (ranking.entries.length === 0 && !ranking.myRank) {
    return ok(c, { entries: [], myRank: null });
  }

  // 查询参与者身份信息（脱敏展示）— 含我的 entry（即使 0 邀请也要可展示）
  const entryIds = new Set(ranking.entries.map((e) => e.entryId));
  if (entryId) entryIds.add(entryId);
  const identityMap = new Map<string, string>();
  if (entryIds.size > 0) {
    const entryRows = await db
      .select({
        id: lotteryEntries.id,
        identityValue: lotteryEntries.identityValue,
        displayName: lotteryEntries.displayName,
      })
      .from(lotteryEntries)
      .where(and(
        inArray(lotteryEntries.id, Array.from(entryIds)),
        eq(lotteryEntries.tenantId, draw.tenantId),
      ));
    for (const e of entryRows) {
      identityMap.set(e.id, e.displayName || maskIdentity(e.identityValue));
    }
  }

  const leaderboard = ranking.entries.map((row) => ({
    rank: row.rank,
    displayName: identityMap.get(row.entryId) || "***",
    invitedCount: row.invitedCount,
    /** 供前端高亮「是我」：勿仅靠 rank 相等（并列风险） */
    entryId: row.entryId,
    /** 排行榜奖励是否已发放（leaderboardRewardedAt 非空即视为已发） */
    rewarded: rewardedMap.has(row.entryId),
  }));

  return ok(c, {
    entries: leaderboard,
    myRank: ranking.myRank
      ? {
          rank: ranking.myRank.rank,
          invitedCount: ranking.myRank.invitedCount,
          displayName: identityMap.get(entryId) || undefined,
        }
      : null,
  });
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
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      status: lotteryDraws.status,
      promotionConfig: lotteryDraws.promotionConfig,
    })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 与 viral-leaderboard / 开奖 / 发布预检同一判定入口（docs/255 P2-4）：
  // 严格 === true，字符串 "true" 等脏配置一律按未开启，避免各端状态自相矛盾。
  const pc = tryParseJson(draw.promotionConfig) as
    { viral?: ViralWeightConfig; referralRewardDefs?: unknown } | undefined;
  const viral = pc?.viral;
  const viralEnabled = isViralEnabled(viral);
  // 两层激励互补（docs/259 D2）：基础层 viral、里程碑层 referralRewardDefs，任一开启即有进度可看。
  // 修复前只看 viral 开关，导致「只配里程碑」的活动能发奖却查不到进度（前台 400，进度面空白）。
  const rewardDefs = normalizeReferralRewardDefs(pc?.referralRewardDefs);
  if (!viralEnabled && rewardDefs.length === 0) {
    return fail(c, "该活动未开启裂变", 400);
  }

  // entry 必须属于本活动：防任意 UUID 窥探他人裂变数据
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, entryId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.tenantId, draw.tenantId),
    ))
    .limit(1);
  if (!entry) return fail(c, "参与记录不存在或不属于本活动", 404);

  // 查询该参与者的分享记录（按创建时间降序：与 POST /share 复用「最新码」一致，docs/112）
  // docs/255 P2-10：补 tenantId 过滤，防跨租户同 drawId 时读到他人分享记录
  const myShares = await db
    .select()
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, draw.tenantId),
      eq(shareRecords.drawId, draw.id),
      eq(shareRecords.sharerEntryId, entryId),
    ))
    .orderBy(desc(shareRecords.createdAt));

  // 聚合统计：额外次数与开奖 performDraw 同一公式（invited × perInvite 封顶）
  const totalClicked = myShares.reduce((s, r) => s + r.clickedCount, 0);
  const totalJoined = myShares.reduce((s, r) => s + r.joinedCount, 0);
  // 基础层数值：viral 未开启时归零，不能用 normalizeViralWeightNumbers 的默认值（1/10）冒充配置，
  // 否则「只配里程碑」的活动会对外承诺一个并不存在的每邀请加次。
  const { extraEntriesPerInvite, maxExtraEntries } = viralEnabled
    ? normalizeViralWeightNumbers(viral)
    : { extraEntriesPerInvite: 0, maxExtraEntries: 0 };
  const extraEntriesEarned = viralEnabled
    ? computeViralExtraEntries(totalJoined, extraEntriesPerInvite, maxExtraEntries)
    : 0;
  // 开奖袋中总票数（含基础 1），便于前端展示「相当于 N 次机会」
  const drawWeight = 1 + extraEntriesEarned;

  // 里程碑层进度：已发放标记散落在该分享者名下各条 share_record，合并后判定
  const milestoneProgress = buildMilestoneProgress({
    defs: rewardDefs,
    totalJoined,
    marks: myShares.flatMap((r) => parseGrantedRewardIds(r.rewardMilestonesGranted)),
  });

  // 最新一条（已 orderBy desc）作为默认链接，与 POST /share 复用策略对齐
  const latestShare = myShares.length > 0 ? myShares[0] : null;
  const shareCode = latestShare?.shareCode || "";
  const shareUrl = shareCode ? buildPublicSharePath(slug, shareCode) : "";

  // 终态活动：仍可看历史统计，但前端应弱化「继续邀请」主 CTA
  const drawStatus = String(draw.status || "");
  const inviteOpen = !["drawn", "cancelled", "closed"].includes(drawStatus.toLowerCase());

  return ok(c, {
    shareCode,
    shareUrl,
    clickedCount: totalClicked,
    invitedCount: totalJoined,
    extraEntriesEarned,
    extraEntriesPerInvite,
    maxExtraEntries,
    drawWeight,
    drawStatus,
    inviteOpen,
    // ── 以下为 docs/259 D2 ② 新增（纯追加，既有字段语义不变）──
    viralEnabled,
    milestones: milestoneProgress.milestones,
    nextMilestone: milestoneProgress.nextMilestone,
    milestonesUnlocked: milestoneProgress.unlockedCount,
    milestonesGranted: milestoneProgress.grantedCount,
  });
});

/**
 * 生成或复用分享码（参与者分享活动链接）。
 * 同一 entry 已有 share 时复用最新码，避免每次复制都 insert 污染 joined 归因链路。
 */
route.post("/draws/:slug/share", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ entryId: string }>();
  const entryId = String(body.entryId || "").trim();
  if (!entryId) return fail(c, "缺少参与记录 ID", 400);

  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      status: lotteryDraws.status,
      promotionConfig: lotteryDraws.promotionConfig,
    })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // entry 必须属于本活动：否则任意 UUID 可污染 share_records / 裂变归因（docs/099）
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, entryId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.tenantId, draw.tenantId),
    ))
    .limit(1);
  if (!entry) return fail(c, "参与记录不存在或不属于本活动", 404);

  // 已有码：复用最新一条（主链接稳定；历史多码的 joined 仍在 stats 里 SUM）
  // 纵深防御：同时限定 tenantId + drawId + sharerEntryId，防止跨租户复用分享码
  const existing = await db
    .select({ shareCode: shareRecords.shareCode })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, draw.tenantId),
      eq(shareRecords.drawId, draw.id),
      eq(shareRecords.sharerEntryId, entryId),
    ))
    .orderBy(desc(shareRecords.createdAt))
    .limit(1);
  if (existing.length > 0) {
    const latest = existing[0]!;
    return ok(c, {
      shareCode: latest.shareCode,
      shareUrl: buildPublicSharePath(slug, latest.shareCode),
      reused: true,
    });
  }

  const shareCode = crypto.randomUUID().slice(0, 12);
  await db.insert(shareRecords).values({
    id: crypto.randomUUID(),
    tenantId: draw.tenantId,
    drawId: draw.id,
    sharerEntryId: entryId,
    shareCode,
  });

  // 统一 /lottery/{slug}?ref=，与前端 router 及 my-viral-stats 一致（docs/108）
  return ok(c, {
    shareCode,
    shareUrl: buildPublicSharePath(slug, shareCode),
    reused: false,
  });
});

/**
 * 通过分享链接打开活动（记录点击）。
 * 重定向必须保留 ?ref=，否则好友打开后参与无法归因到分享者。
 */
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

  // 落到公开活动页并保留 ref，供 join 写入 attributed_join
  const target = buildPublicSharePath(slug, shareCode) || `/lottery/${encodeURIComponent(slug)}`;
  return c.redirect(target);
});
}
