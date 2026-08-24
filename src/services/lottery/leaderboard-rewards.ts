/**
 * 排行榜奖励发放（docs/218 模式三）
 *
 * 根据活动裂变配置的 leaderboardRewards，在活动结束后按邀请人数排名发放 spins 奖励。
 * 与里程碑阶梯互补：里程碑是过程奖励（每个 requireCount 到达即发），排行榜奖励是结果奖励（活动结束按名次发）。
 *
 * P0 修复（2026-08 审查）：
 * - 旧实现按「单条 share_record 行」取 TopN 并逐行发放，CAS 幂等键是每行的 leaderboardRewardedAt；
 *   同一分享者多条 shareCode 时（系统显式支持：aggregateViralInviteCounts 按 sharer SUM、penalty 多码反查），
 *   同一条记录在 rankMap 中重复命中同一名次 → 同名次奖励被发放多次（超发）。
 * - 修复：先按 sharerEntryId 聚合 joinedCount（与公开榜 aggregateViralInviteCounts 同一口径），
 *   每个分享者只发放一次；幂等标记写入该分享者的【全部】share_record 行（任一行为空即视为未发放）。
 * - 同票 tie-break 与公开榜「先到先得」一致：邀请数降序，同票按该分享者最早分享时间（created_at 升序）。
 * - 契约对齐（docs/114 + publish-check）：viral.enabled 必须为真；leaderboardEnabled 仅显式 false 关闭（缺省开启）。
 * - 发放受 maxSpinsPerEntry 总顶约束（granted ≤ maxSpins 不变量），超出部分按实际可发额度裁剪并留审计。
 */
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { eq, and, sql } from "drizzle-orm";
import { shareRecords, lotteryEntries, lotteryDraws } from "../../db/schema";
import { recordSpinLog } from "./spins-log";
import { grantBonusCoupon } from "./reward-exits";
import { isViralLeaderboardEnabled, compareViralLeaderboard, type ViralWeightConfig } from "./viral-weight";

/** 排行榜奖励配置项（viral.leaderboardRewards 数组元素） */
export type LeaderboardRewardConfig = {
  rank: number;
  rewardType: "bonus_spin" | "bonus_coupon";
  /** bonus_spin 时为发放次数；bonus_coupon 时为发放张数 */
  rewardValue: number;
  /** bonus_coupon 时可选的优惠券标签（匹配 coupon_codes.label），为空则发任意可用券 */
  couponLabel?: string;
};

/**
 * 排行榜奖励名次上限（与前端表单 growth-config parseLeaderboardRewardsText 的 rank≤100 一致）。
 * grantLeaderboardRewards 按 max(rank) 作为 topN 查询分享记录，若 API 直调配置超大 rank，
 * 会触发超大排名查询与批量发放（性能隐患），因此归一化阶段直接剔除超限项。
 */
export const MAX_LEADERBOARD_RANK = 100;

/**
 * 归一化排行榜奖励配置，过滤无效项（rank<1 或 >MAX_LEADERBOARD_RANK / 非法 rewardType /
 * rewardValue<1 全部剔除）。grantLeaderboardRewards 与 publish-check 共用同一函数，
 * 避免「发布预检说有奖励、实际发放为零」的校验与执行偏差。空输入或全无效 → 返回空数组。
 *
 * 支持两种奖励类型：
 * - bonus_spin：发放抽奖次数（与旧行为兼容）
 * - bonus_coupon：发放优惠券（可选 couponLabel 指定券标签）
 */
export function normalizeLeaderboardRewards(raw: unknown): LeaderboardRewardConfig[] {
  if (!Array.isArray(raw)) return [];
  const rewards: LeaderboardRewardConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const rank = Math.floor(Number(r.rank) || 0);
    const rewardValue = Math.floor(Number(r.rewardValue) || 0);
    const rewardType = r.rewardType === "bonus_coupon" ? "bonus_coupon" : "bonus_spin";
    // 上限与前端表单一致（growth-config.ts）：rank 1..100、rewardValue 1..1000。
    // 与 publish-check 共用，防止 API 直写超大 rewardValue 推爆 granted（P2 审查项）。
    if (rank >= 1 && rank <= MAX_LEADERBOARD_RANK && rewardValue >= 1 && rewardValue <= 1000) {
      const entry: LeaderboardRewardConfig = { rank, rewardType, rewardValue };
      // bonus_coupon 可选标签：匹配 coupon_codes.label 精确发券
      if (rewardType === "bonus_coupon" && typeof r.couponLabel === "string" && r.couponLabel.trim()) {
        entry.couponLabel = r.couponLabel.trim();
      }
      rewards.push(entry);
    }
  }
  return rewards;
}

/** 排行榜奖励发放结果 */
export type GrantLeaderboardResult = {
  granted: number;
  skipped: number;
  details: Array<{
    rank: number;
    entryId: string;
    rewardType: "bonus_spin" | "bonus_coupon";
    rewardValue: number;
    status: "granted" | "skipped";
  }>;
};

/** 单个分享者的事务内判定结果（事务外据此累加报告，见 R-9 注释） */
type GrantVerdict = { status: "granted" | "skipped"; rewardType: "bonus_spin" | "bonus_coupon"; rewardValue: number };

/**
 * 分享者聚合信息：邀请总人数 + 最早分享时间（同票先到先得）+ 名下全部 share_record id（幂等标记目标）。
 */
type SharerAggregate = {
  invited: number;
  firstSharedAt: string;
  recordIds: string[];
};

/**
 * 发放排行榜奖励。
 *
 * 流程：
 * 1. 解析 draw.promotionConfig.viral.leaderboardRewards；空 → 直接返回。
 *    viral.enabled 必须为真、leaderboardEnabled 显式 false 时关闭（缺省开启）。
 * 2. 按 sharerEntryId 聚合全部 share_records（SUM joinedCount，joined=0 不参与排名），
 *    邀请数降序、同票最早分享时间升序，取前 N 名（N=最高 rank）。
 * 3. 对每个分享者按名次发放一次 spins（受 maxSpinsPerEntry 总顶裁剪）；
 *    事务内 CAS：该分享者名下任一 share_record 的 leaderboardRewardedAt 为空 → 全部标记 + 发放；
 *    并发下已被标记 → 跳过（幂等）。
 * 4. 写 spins_log（reason: "viral"，refId: "leaderboard:{rank}" 或 "leaderboard:{rank}:capped"）。
 *
 * @param db 数据库实例
 * @param draw 活动对象（需含 tenantId, id, promotionConfig, maxSpinsPerEntry）
 */
export async function grantLeaderboardRewards(
  db: DbType,
  draw: typeof lotteryDraws.$inferSelect,
): Promise<GrantLeaderboardResult> {
  const result: GrantLeaderboardResult = { granted: 0, skipped: 0, details: [] };

  // 1. 解析配置（与 publish-check 同源 normalize，杜绝「预检说有、发放为零」偏差）
  let pc: Record<string, unknown> | null = null;
  try {
    pc = JSON.parse(draw.promotionConfig || "{}") as Record<string, unknown>;
  } catch { /* 非法 JSON 视为未配置 */ }

  const viral = pc?.viral as (ViralWeightConfig & Record<string, unknown>) | undefined;
  // 契约（docs/114 + publish-check）：enabled 必须严格为真；leaderboardEnabled 仅在显式 false
  // 时关闭，缺省视为开启。判定必须走 viral-weight 单一入口（docs/255 P2-4）——此处曾手写
  // 同一条件，与公共实现分叉后「排行榜页可见、奖励却不发」这类偏差无法被类型系统发现。
  if (!isViralLeaderboardEnabled(viral)) {
    return result;
  }

  const rawRewards = viral?.leaderboardRewards;
  if (!rawRewards || !Array.isArray(rawRewards) || rawRewards.length === 0) {
    return result;
  }
  const rewards = normalizeLeaderboardRewards(rawRewards);
  if (rewards.length === 0) return result;

  // 取最高 rank 作为 TOP N
  const topN = Math.max(...rewards.map((r) => r.rank));

  // 2. 读取全部分享记录并按分享者聚合（与公开榜 aggregateViralInviteCounts 同一 SUM 口径）
  const shareRows = await db
    .select({
      id: shareRecords.id,
      sharerEntryId: shareRecords.sharerEntryId,
      joinedCount: shareRecords.joinedCount,
      createdAt: shareRecords.createdAt,
    })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, draw.tenantId),
      eq(shareRecords.drawId, draw.id),
    ));

  const bySharer = new Map<string, SharerAggregate>();
  for (const row of shareRows) {
    const id = String(row?.sharerEntryId || "").trim();
    if (!id) continue;
    const invited = Math.max(0, Math.floor(Number(row.joinedCount) || 0));
    // 仅统计有效分享者（至少拉到 1 人）：joined_count=0 的分享记录不参与排名，
    // 否则有效分享者不足 TOP N 时，无票分享者会被补位白拿排行榜奖励（docs/218 模式三）。
    if (invited < 1) continue;
    const cur = bySharer.get(id) || { invited: 0, firstSharedAt: "", recordIds: [] as string[] };
    cur.invited += invited;
    if (!cur.firstSharedAt || (row.createdAt && row.createdAt < cur.firstSharedAt)) {
      cur.firstSharedAt = row.createdAt || "";
    }
    cur.recordIds.push(row.id);
    bySharer.set(id, cur);
  }

  // 3. 名次：邀请人数降序；同票 tie-break 走 compareViralLeaderboard（P0 修复 2026-08-23）
  // 与公开榜（viral-weight.ts buildViralLeaderboardRanking）使用同一比较函数，
  // 确保「用户看到的排名」和「实际获得的奖励」一致：先到先得（firstSharedAt 升序）。
  const ranked = [...bySharer.entries()]
    .sort((a, b) => compareViralLeaderboard(
      a[1].invited, b[1].invited,
      a[1].firstSharedAt, b[1].firstSharedAt,
      a[0], b[0],
    ))
    .slice(0, topN);

  // 4. 逐名次发放（每个分享者只发一次；事务内对该分享者全部记录 CAS 标记防并发重复发放）
  const maxSpins = Math.max(0, Math.floor(Number(draw.maxSpinsPerEntry || 0)));
  const nowIso = new Date().toISOString();

  for (let i = 0; i < ranked.length; i++) {
    const [sharerEntryId] = ranked[i]!;
    const rank = i + 1;
    const rewardCfg = rewards.find((r) => r.rank === rank);
    if (!rewardCfg) {
      result.skipped++;
      result.details.push({ rank, entryId: sharerEntryId, rewardType: "bonus_spin", rewardValue: 0, status: "skipped" });
      continue;
    }

    // 事务内：先查该分享者名下是否已有任何记录被标记（幂等），无则全部标记 + 发放。
    //
    // 报告口径（docs/255 §十七 R-9）：回调只返回本次判定，granted/skipped/details
    // 一律在事务**外**累加。cf-core 的 withDbTransaction 在 SQLITE_BUSY/LOCKED 时
    // 整体重跑回调（src/db/client.ts retries=5），若在回调内 result.granted++，
    // 重跑会把同一个分享者计两次（第一次 granted、重跑因已标记 skipped），
    // 后台看到的发放条数多于真实发放——draw-execution.ts:238-245 的「F2 修复」同类陷阱。
    const verdict = await withDbTransaction(db, async (tx): Promise<GrantVerdict> => {
      // 重新读取该分享者的记录（事务内快照最新，防止并发下读到旧标记状态）
      const records = await tx
        .select({
          id: shareRecords.id,
          leaderboardRewardedAt: shareRecords.leaderboardRewardedAt,
          leaderboardRewardedCount: shareRecords.leaderboardRewardedCount,
        })
        .from(shareRecords)
        .where(and(
          eq(shareRecords.tenantId, draw.tenantId),
          eq(shareRecords.drawId, draw.id),
          eq(shareRecords.sharerEntryId, sharerEntryId),
        ));
      if (records.length === 0) {
        return { status: "skipped", rewardType: rewardCfg.rewardType, rewardValue: rewardCfg.rewardValue };
      }
      // 任一记录已标记 → 该分享者已发放过，跳过（幂等）
      if (records.some((r) => String(r.leaderboardRewardedAt || "") !== "")) {
        return { status: "skipped", rewardType: rewardCfg.rewardType, rewardValue: rewardCfg.rewardValue };
      }

      // CAS：全部记录 leaderboardRewardedAt 仍为空才标记；rowsAffected 必须等于记录数
      const marked = await tx
        .update(shareRecords)
        .set({ leaderboardRewardedAt: nowIso })
        .where(and(
          eq(shareRecords.tenantId, draw.tenantId),
          eq(shareRecords.drawId, draw.id),
          eq(shareRecords.sharerEntryId, sharerEntryId),
          sql`${shareRecords.leaderboardRewardedAt} = ''`,
        ));
      if ((marked.rowsAffected ?? 0) !== records.length) {
        // 并发下部分记录已被其他请求标记 → 放弃本次（防重复发放）
        return { status: "skipped", rewardType: rewardCfg.rewardType, rewardValue: rewardCfg.rewardValue };
      }

      // 读取分享者 entry（含当前 granted，用于 maxSpins 裁剪与审计）
      const [entry] = await tx
        .select({
          id: lotteryEntries.id,
          identityValue: lotteryEntries.identityValue,
          spinsLeft: lotteryEntries.spinsLeft,
          spinsTotalGranted: lotteryEntries.spinsTotalGranted,
        })
        .from(lotteryEntries)
        .where(and(
          eq(lotteryEntries.id, sharerEntryId),
          eq(lotteryEntries.tenantId, draw.tenantId),
          eq(lotteryEntries.drawId, draw.id),
        ))
        .limit(1);
      if (!entry) {
        // entry 不存在（已删除）→ 不发放，但记录已标记；状态 skipped 提示运营
        return { status: "skipped", rewardType: rewardCfg.rewardType, rewardValue: rewardCfg.rewardValue };
      }

      // ——— 按 rewardType 分发到不同出口 ———
      if (rewardCfg.rewardType === "bonus_coupon") {
        // 优惠券发放：通过 grantBonusCoupon 从码池 CAS 取券，与 referral-rewards-engine 同出口。
        // 幂等键 leaderboard:rank:{rank} 保证同一排名不会重复发券。
        //
        // docs/270 P1 修复（码池不足不再丢券）：
        // - leaderboardRewardedCount 跨触发持久化"已发张数"，本次只发差额 remaining；
        // - 未发满（码池不足/收件人缺失）→ 回滚 leaderboardRewardedAt 标记，
        //   下次触发按差额续发，直至发满 rewardValue 张；
        // - 已累计发满（rewardedCount >= rewardValue）→ 保持标记，本次跳过。
        // 与 referral 引擎 bonus_coupon 的"码池不足保持可重试"语义对齐，
        // 避免旧行为"标记已写、缺额永久丢失"。
        const rewardedCount = Math.max(0, Math.floor(Number(records[0]?.leaderboardRewardedCount ?? 0)));
        const remaining = Math.max(0, rewardCfg.rewardValue - rewardedCount);
        if (remaining <= 0) {
          // 累计已发满（极端：并发下另一请求刚完成）→ 保持标记跳过
          return { status: "skipped", rewardType: "bonus_coupon", rewardValue: 0 };
        }
        const issuedCount = await grantBonusCoupon(
          tx,
          draw.tenantId,
          draw.id,
          entry.id,
          rewardCfg.couponLabel,
          `leaderboard:${rank}`,
          remaining,
          "viral",
        );
        const nextCount = rewardedCount + issuedCount;
        if (issuedCount > 0) {
          // 持久化已发张数（全部记录同步写，保证下次读取一致）
          await tx
            .update(shareRecords)
            .set({ leaderboardRewardedCount: nextCount })
            .where(and(
              eq(shareRecords.tenantId, draw.tenantId),
              eq(shareRecords.drawId, draw.id),
              eq(shareRecords.sharerEntryId, sharerEntryId),
            ));
          // 记录流水日志（delta=发券张数，reason=viral，refId 含 :coupon 后缀区分）
          const [snap] = await tx
            .select({ spinsLeft: lotteryEntries.spinsLeft })
            .from(lotteryEntries)
            .where(eq(lotteryEntries.id, entry.id))
            .limit(1);
          await recordSpinLog(tx, {
            tenantId: draw.tenantId,
            entryId: entry.id,
            userId: entry.identityValue || entry.id,
            delta: issuedCount,
            balanceAfter: Math.max(0, Number(snap?.spinsLeft ?? 0)),
            reason: "viral",
            refId: `leaderboard:${rank}:coupon`,
          });
        }
        if (nextCount >= rewardCfg.rewardValue) {
          // 已累计发满 → 保持标记（完成），后续触发幂等跳过
          return { status: "granted", rewardType: "bonus_coupon", rewardValue: issuedCount };
        }
        // 未发满（码池不足/收件人缺失）→ 回滚标记，下次触发按差额续发。
        // 事务内回滚：并发其他事务看到标记被清空后可重新抢占；
        // rewardedCount 已持久化，续发只发差额，不会超发。
        await tx
          .update(shareRecords)
          .set({ leaderboardRewardedAt: "" })
          .where(and(
            eq(shareRecords.tenantId, draw.tenantId),
            eq(shareRecords.drawId, draw.id),
            eq(shareRecords.sharerEntryId, sharerEntryId),
          ));
        return { status: issuedCount > 0 ? "granted" : "skipped", rewardType: "bonus_coupon", rewardValue: issuedCount };
      }

      // bonus_spin 路径（与旧行为完全兼容）
      // maxSpins 总顶裁剪（P0 防 API 直写超大 rewardValue 把 granted 推爆）：
      // granted ≤ maxSpinsPerEntry 不变量；超出部分按实际可发额度发放，refId 留 capped 审计。
      const granted = Math.max(0, Math.floor(Number(entry.spinsTotalGranted || 0)));
      const room = maxSpins >= 1 ? Math.max(0, maxSpins - granted) : rewardCfg.rewardValue;
      const actual = Math.max(0, Math.min(rewardCfg.rewardValue, room));
      const capped = actual < rewardCfg.rewardValue;

      if (actual > 0) {
        // P4 修复（docs/271）：bonus_spin 补充显式 CAS 乐观锁。
        // WHERE 带 spinsTotalGranted=granted 条件——并发下另一个事务若已修改该列
        // （如路径[1] grantViralSpinsToSharer 同时触发），rowsAffected=0 跳过本次发放。
        // 当前 SQLite 单写事务串行化下触发概率极低，但为未来迁移分布式 DB（Turso 多副本）
        // 做防御性准备，与 grantBonusSpin 的 CAS 模式对齐。
        const updateResult = await tx
          .update(lotteryEntries)
          .set({
            spinsLeft: sql`${lotteryEntries.spinsLeft} + ${actual}`,
            spinsTotalGranted: sql`${lotteryEntries.spinsTotalGranted} + ${actual}`,
          })
          .where(and(
            eq(lotteryEntries.id, entry.id),
            eq(lotteryEntries.tenantId, draw.tenantId),
            eq(lotteryEntries.drawId, draw.id),
            eq(lotteryEntries.spinsTotalGranted, granted),
          ));
        if ((updateResult.rowsAffected ?? 0) === 0) {
          // CAS 冲突：spinsTotalGranted 已被并发修改，放弃本次发放（防超发）。
          // ⚠️ 必须回滚 leaderboardRewardedAt 标记（与 bonus_coupon 路径一致，docs/270 P1）：
          // 标记在行 231-239 已写入，若不回滚，下次触发时行 226 的幂等检查会误判
          // "已发放"而跳过，导致该分享者的 bonus_spin 奖励永久丢失（标记已写、spins 未发）。
          // 回滚后下次触发重新计算 room/actual，不会超发（maxSpins 总顶仍约束）。
          await tx
            .update(shareRecords)
            .set({ leaderboardRewardedAt: "" })
            .where(and(
              eq(shareRecords.tenantId, draw.tenantId),
              eq(shareRecords.drawId, draw.id),
              eq(shareRecords.sharerEntryId, sharerEntryId),
            ));
          return { status: "skipped", rewardType: "bonus_spin" as const, rewardValue: 0 };
        }

        // 事务内重新读取更新后的余额，用于审计快照（与 spin-execution 同标准）
        const [updatedEntry] = await tx
          .select({ spinsLeft: lotteryEntries.spinsLeft })
          .from(lotteryEntries)
          .where(eq(lotteryEntries.id, entry.id))
          .limit(1);

        // 记录 spins 流水日志（reason=viral，refId=leaderboard:{rank}，裁剪时追加 :capped 供对账）
        await recordSpinLog(tx, {
          tenantId: draw.tenantId,
          entryId: entry.id,
          userId: entry.identityValue || entry.id,
          delta: actual,
          balanceAfter: Math.max(0, Number(updatedEntry?.spinsLeft ?? 0)),
          reason: "viral",
          refId: capped ? `leaderboard:${rank}:capped` : `leaderboard:${rank}`,
        });
      }

      return { status: "granted", rewardType: "bonus_spin", rewardValue: actual };
    });

    if (verdict.status === "granted") result.granted++;
    else result.skipped++;
    result.details.push({
      rank,
      entryId: sharerEntryId,
      rewardType: verdict.rewardType,
      rewardValue: verdict.rewardValue,
      status: verdict.status,
    });
  }

  return result;
}
