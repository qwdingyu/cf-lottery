/**
 * 处罚域 — 波及名单计算（docs/111 §2 + §5 阶段二）
 *
 * 退群处罚的连锁波及：本人 + 邀请人 + 被邀请者。
 * 抽取为独立模块：纯查询、无副作用，可独立测试，不与路由/Webook 耦合。
 */
import type { DbType } from "../../db/client";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityEvents,
  lotteryEntries,
  shareRecords,
} from "../../db/schema";

export type PenaltyTargets = {
  /** 退群者本人的参与记录 ID */
  leaverEntryId: string;
  /** 邀请退群者进群的人（如果没有 attributed_join 归因记录则为 null） */
  inviterEntryId: string | null;
  /** 退群者邀请进群的人（通过 shareRecords + activityEvents refCode 反查） */
  invitedEntryIds: string[];
};

/**
 * 根据退群者在活动中的参与身份，查询归因链，计算处罚波及名单。
 *
 * 原理（docs/111 审查修正）：
 * - `shareRecords.joinedCount` 是聚合计数器，不存被邀请者 entryId 明细。
 *   因此"被邀请者"必须通过 `activityEvents.refCode` 反向查询。
 * - 邀请人：退群者的 attributed_join 事件中的 refCode → shareRecords.sharerEntryId
 * - 被邀请者：退群者作为 sharerEntryId 的 shareRecords.shareCode
 *   → activityEvents WHERE refCode = shareCode AND eventType='attributed_join'
 *
 * @returns null 如果退群者在该活动中没有参与记录（不应处罚）
 */
export async function computePenaltyTargets(
  db: DbType,
  tenantId: string,
  drawId: string,
  leaverIdentityValue: string,
): Promise<PenaltyTargets | null> {
  // 1. 定位退群者的参与记录
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, tenantId),
      eq(lotteryEntries.drawId, drawId),
      eq(lotteryEntries.identityValue, leaverIdentityValue),
    ))
    .limit(1);

  if (!entry) return null;

  const leaverEntryId = entry.id;

  // 2. 查找「谁邀请了退群者」
  //   退群者当初参与时如果有 refCode（即通过分享链接进入），
  //   attributed_join 事件中会记录该 refCode。
  //   从 refCode → shareRecords.shareCode → sharerEntryId
  let inviterEntryId: string | null = null;
  const [attrEvent] = await db
    .select({ refCode: activityEvents.refCode })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, leaverEntryId),
      eq(activityEvents.eventType, "attributed_join"),
    ))
    .limit(1);

  if (attrEvent?.refCode) {
    const [share] = await db
      .select({ sharerEntryId: shareRecords.sharerEntryId })
      .from(shareRecords)
      .where(and(
        eq(shareRecords.tenantId, tenantId),
        eq(shareRecords.drawId, drawId),
        eq(shareRecords.shareCode, attrEvent.refCode),
      ))
      .limit(1);
    inviterEntryId = share?.sharerEntryId ?? null;
  }

  // 3. 查找「退群者邀请了谁」
  //   退群者作为分享者的 shareRecords → shareCode 列表
  //   → activityEvents WHERE refCode IN (shareCodes) AND eventType='attributed_join'
  const leaverShares = await db
    .select({ shareCode: shareRecords.shareCode })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, tenantId),
      eq(shareRecords.drawId, drawId),
      eq(shareRecords.sharerEntryId, leaverEntryId),
    ));

  const invitedEntryIds: string[] = [];
  if (leaverShares.length > 0) {
    const shareCodes = leaverShares.map((s) => s.shareCode);
    const inviteeRows = await db
      .select({ entryId: activityEvents.entryId })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.tenantId, tenantId),
        eq(activityEvents.drawId, drawId),
        eq(activityEvents.eventType, "attributed_join"),
        inArray(activityEvents.refCode, shareCodes),
      ))
      .limit(500);  // 安全上限：单个分享者的被邀请者不应超过活动规模

    for (const row of inviteeRows) {
      if (row.entryId && row.entryId !== leaverEntryId) {
        invitedEntryIds.push(row.entryId);
      }
    }
  }

  return { leaverEntryId, inviterEntryId, invitedEntryIds };
}
