/**
 * 排行榜奖励发放（docs/218 模式三）
 *
 * 根据活动裂变配置的 leaderboardRewards，在活动结束后按邀请人数排名发放 spins 奖励。
 * 与里程碑阶梯互补：里程碑是过程奖励（每个 requireCount 到达即发），排行榜奖励是结果奖励（活动结束按名次发）。
 * 同事务 CAS 幂等：leaderboard_rewarded_at 空串 → 发放并写入时间戳；非空 → 跳过。
 */
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { eq, and, desc, asc, sql, gte } from "drizzle-orm";
import { shareRecords, lotteryEntries, lotteryDraws } from "../../db/schema";
import { recordSpinLog } from "./spins-log";

/** 排行榜奖励配置项（viral.leaderboardRewards 数组元素） */
export type LeaderboardRewardConfig = {
  rank: number;
  rewardType: "bonus_spin";
  rewardValue: number;
};

/**
 * 排行榜奖励名次上限（与前端表单 growth-config parseLeaderboardRewardsText 的 rank≤100 一致）。
 * grantLeaderboardRewards 按 max(rank) 作为 topN 查询分享记录，若 API 直调配置超大 rank，
 * 会触发超大排名查询与批量发放（性能隐患），因此归一化阶段直接剔除超限项。
 */
export const MAX_LEADERBOARD_RANK = 100;

/**
 * 归一化排行榜奖励配置，过滤无效项（rank<1 或 >MAX_LEADERBOARD_RANK / 非 bonus_spin /
 * rewardValue<1 全部剔除）。grantLeaderboardRewards 与 publish-check 共用同一函数，
 * 避免「发布预检说有奖励、实际发放为零」的校验与执行偏差。空输入或全无效 → 返回空数组。
 */
export function normalizeLeaderboardRewards(raw: unknown): LeaderboardRewardConfig[] {
  if (!Array.isArray(raw)) return [];
  const rewards: LeaderboardRewardConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const rank = Math.floor(Number(r.rank) || 0);
    const rewardValue = Math.floor(Number(r.rewardValue) || 0);
    if (rank >= 1 && rank <= MAX_LEADERBOARD_RANK && r.rewardType === "bonus_spin" && rewardValue >= 1) {
      rewards.push({ rank, rewardType: "bonus_spin", rewardValue });
    }
  }
  return rewards;
}

/** 排行榜奖励发放结果 */
export type GrantLeaderboardResult = {
  granted: number;
  skipped: number;
  details: Array<{ rank: number; entryId: string; rewardValue: number; status: "granted" | "skipped" }>;
};

/**
 * 发放排行榜奖励。
 *
 * 流程：
 * 1. 解析 draw.promotionConfig.viral.leaderboardRewards；空 → 直接返回。
 * 2. 按 joined_count DESC, created_at ASC 取前 N 名 shareRecords（N=最高 rank）。
 * 3. 对每个未发放的 shareRecord 按名次发放 spins → 更新 spins_left/spins_total_granted；
 *    写入 spins_log（reason: "viral", refId: "leaderboard:{rank}"），userId 取 entry.identityValue。
 * 4. CAS 更新 leaderboard_rewarded_at 防止并发重复发放。
 *
 * @param db 数据库实例
 * @param draw 活动对象（需含 tenantId, id, promotionConfig）
 */
export async function grantLeaderboardRewards(
  db: DbType,
  draw: typeof lotteryDraws.$inferSelect,
): Promise<GrantLeaderboardResult> {
  const result: GrantLeaderboardResult = { granted: 0, skipped: 0, details: [] };

  // 1. 解析配置
  let pc: Record<string, unknown> | null = null;
  try {
    pc = JSON.parse(draw.promotionConfig || "{}") as Record<string, unknown>;
  } catch { /* 非法 JSON 视为未配置 */ }

  const viral = pc?.viral as Record<string, unknown> | undefined;
  if (!viral?.leaderboardEnabled) {
    return result;
  }

  const rawRewards = viral.leaderboardRewards;
  if (!rawRewards || !Array.isArray(rawRewards) || rawRewards.length === 0) {
    return result;
  }

  // 归一化排行榜奖励配置，过滤无效项（与 publish-check 共用 normalizeLeaderboardRewards）
  const rewards = normalizeLeaderboardRewards(rawRewards);
  if (rewards.length === 0) return result;

  // 取最高 rank 作为 TOP N
  const topN = Math.max(...rewards.map((r) => r.rank));

  // 2. 按邀请人数降序取前 N 名 shareRecords（含 entry identityValue 用于审计记录）
  const topRecords = await db
    .select({
      id: shareRecords.id,
      sharerEntryId: shareRecords.sharerEntryId,
      joinedCount: shareRecords.joinedCount,
      leaderboardRewardedAt: shareRecords.leaderboardRewardedAt,
      /** 分享者身份标识（email / platform_user_id），用于 spins_log.userId 审计 */
      identityValue: lotteryEntries.identityValue,
    })
    .from(shareRecords)
    .leftJoin(lotteryEntries, and(
      eq(lotteryEntries.id, shareRecords.sharerEntryId),
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
    ))
    .where(and(
      eq(shareRecords.tenantId, draw.tenantId),
      eq(shareRecords.drawId, draw.id),
      // 仅统计有效分享者（至少拉到 1 人）：joined_count=0 的分享记录不参与排名，
      // 否则有效分享者不足 TOP N 时，无票分享者会被补位白拿排行榜奖励（docs/218 模式三）
      gte(shareRecords.joinedCount, 1),
    ))
    // 名次排序：joined_count 降序为主；同票时先分享者优先（created_at 升序，先到先得）。
    // ⚠️ 不能用 desc(created_at)：会把"后分享的人"排到前面，与"先到先得"语义相反。
    .orderBy(desc(shareRecords.joinedCount), asc(shareRecords.createdAt))
    .limit(topN);

  // 构建名次映射：entryId → rank（同票时先到先得）
  const rankMap = new Map<string, number>();
  for (let i = 0; i < topRecords.length; i++) {
    const entryId = topRecords[i]!.sharerEntryId;
    if (!rankMap.has(entryId)) {
      rankMap.set(entryId, i + 1);
    }
  }

  // 3. 按名次发放奖励
  const nowIso = new Date().toISOString();

  for (const record of topRecords) {
    const rank = rankMap.get(record.sharerEntryId) ?? 0;
    const rewardCfg = rewards.find((r) => r.rank === rank);
    if (!rewardCfg) {
      result.skipped++;
      result.details.push({ rank, entryId: record.sharerEntryId, rewardValue: 0, status: "skipped" });
      continue;
    }

    // 已发放过 → 跳过
    if (record.leaderboardRewardedAt) {
      result.skipped++;
      result.details.push({ rank, entryId: record.sharerEntryId, rewardValue: rewardCfg.rewardValue, status: "skipped" });
      continue;
    }

    // 事务内：CAS 更新 leaderboardRewardedAt + 发放 spins
    await withDbTransaction(db, async (tx) => {
      // CAS 更新 leaderboard_rewarded_at（空串 → 非空，幂等）
      const cas = await tx
        .update(shareRecords)
        .set({ leaderboardRewardedAt: nowIso })
        .where(and(
          eq(shareRecords.id, record.id),
          eq(shareRecords.tenantId, draw.tenantId),
          // 仅更新空串（未发放）
          sql`${shareRecords.leaderboardRewardedAt} = ''`,
        ));

      if ((cas.rowsAffected ?? 0) === 0) {
        // 并发下已被其他请求发放 → 跳过
        result.skipped++;
        result.details.push({ rank, entryId: record.sharerEntryId, rewardValue: rewardCfg.rewardValue, status: "skipped" });
        return;
      }

      // 发放 spins 到 entry
      await tx
        .update(lotteryEntries)
        .set({
          spinsLeft: sql`${lotteryEntries.spinsLeft} + ${rewardCfg.rewardValue}`,
          spinsTotalGranted: sql`${lotteryEntries.spinsTotalGranted} + ${rewardCfg.rewardValue}`,
        })
        .where(and(
          eq(lotteryEntries.id, record.sharerEntryId),
          eq(lotteryEntries.tenantId, draw.tenantId),
          eq(lotteryEntries.drawId, draw.id),
        ));

      // 事务内重新读取更新后的余额，用于审计快照
      const [updatedEntry] = await tx
        .select({ spinsLeft: lotteryEntries.spinsLeft })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, record.sharerEntryId))
        .limit(1);

      // 记录 spins 流水日志（reason=viral，refId=leaderboard:{rank}）
      await recordSpinLog(tx, {
        tenantId: draw.tenantId,
        entryId: record.sharerEntryId,
        userId: record.identityValue || record.sharerEntryId,
        delta: rewardCfg.rewardValue,
        balanceAfter: Math.max(0, Number(updatedEntry?.spinsLeft ?? 0)),
        reason: "viral",
        refId: `leaderboard:${rank}`,
      });
    });

    result.granted++;
    result.details.push({ rank, entryId: record.sharerEntryId, rewardValue: rewardCfg.rewardValue, status: "granted" });
  }

  return result;
}