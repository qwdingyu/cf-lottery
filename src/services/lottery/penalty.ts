/**
 * 处罚域 — 波及名单计算（docs/111 §2 + §5 阶段二 + docs/114 §3）
 *
 * 退群处罚的连锁波及：本人 + 邀请人 + 被邀请者。
 * 抽取为独立模块：纯查询、无副作用，可独立测试，不与路由/Webhook 耦合。
 *
 * 为什么需要这个模块？
 * - shareRecords 只存储聚合计数（joinedCount），不存储每个被邀请者的 entryId 明细。
 *   因此"退群者邀请了谁"必须通过 activityEvents.refCode 反向查询。
 * - 波及名单计算是"退群→处罚"的核心逻辑，放在路由层会使 /events 端点过重，
 *   放在服务层可独立测试、独立优化（未来可加缓存、加索引）。
 *
 * 安全边界：
 * - 纯查询，不修改任何数据（不写库、不调用 webhook）。
 * - 被邀请者查询有 .limit(500) 安全上限，防止单次查询返回海量数据。
 *   500 的上限基于：单个分享者不可能在正常活动规模下邀请超过 500 人。
 *   如果活动规模超过 500 人/分享者，P2 优化时考虑分批查询。
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
 * 三步查询（按依赖顺序，不能并行）：
 * 1. 定位退群者 entryId：lotteryEntries 按 identityValue 查。
 * 2. 找邀请人：退群者的 attributed_join 事件 → refCode → shareRecords.sharerEntryId。
 *    如果没有 attributed_join 事件（有机参与，非邀请进入），inviterEntryId = null。
 * 3. 找被邀请者：退群者作为 sharerEntryId 的 shareRecords → shareCode 列表
 *    → activityEvents WHERE refCode IN (shareCodes) AND eventType='attributed_join'。
 *    过滤掉退群者本人（共享同一 shareCode 的极端情况防御）。
 *
 * 为什么用 activityEvents 而不是 shareRecords 查被邀请者？
 * shareRecords.joinedCount 是聚合计数器，不存每个被邀请者的 entryId。
 * activityEvents 的 attributed_join 事件每条记录一个 entryId 和一个 refCode，
 * 通过 refCode 可以反查到所有使用该分享码参与的人。refIdx 索引保证查询性能。
 *
 * @returns null 如果退群者在该活动中没有参与记录（不应处罚）
 */
export async function computePenaltyTargets(
  db: DbType,
  tenantId: string,
  drawId: string,
  leaverIdentityValue: string,
): Promise<PenaltyTargets | null> {
  // 步骤 1：定位退群者的参与记录。
  // 按 identityValue 查 lotteryEntries，同一 draw 同一 identity 只有一个 entry（UNIQUE 约束保证）。
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, tenantId),
      eq(lotteryEntries.drawId, drawId),
      eq(lotteryEntries.identityValue, leaverIdentityValue),
    ))
    .limit(1);

  if (!entry) return null;  // 退群者未参与此活动，无处罚对象

  const leaverEntryId = entry.id;

  // 步骤 2：查找「谁邀请了退群者」。
  //
  // 如果退群者是通过分享链接进入的，参与时 attributed_join 事件会记录 refCode。
  // 从 refCode 反查 shareRecords（shareCode = refCode）→ sharerEntryId。
  //
  // 为什么 refCode 可能为空？用户可能通过直接链接（无 ?ref=）或有机搜索进入，
  // 此时没有归因事件，inviterEntryId = null。
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

  // 步骤 3：查找「退群者邀请了谁」。
  //
  // 退群者作为分享者，在 shareRecords 中有自己的分享码（shareCode）。
  // 每一个分享码可能被多个被邀请者使用（通过 ?ref=shareCode 进入）。
  // 通过 activityEvents 反查所有使用这些 shareCode 的 attributed_join 事件，
  // 得到被邀请者的 entryId 列表。
  //
  // 注意：同一个 shareCode 可能被退群者自己使用（自邀请防御在 recordAttributedJoin 中处理，
  // 但 activityEvents 中仍可能残留自邀请记录，所以加 leaverEntryId 过滤）。
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
      .limit(500);  // 安全上限：单个退群者的被邀请者不应超过活动规模

    for (const row of inviteeRows) {
      if (row.entryId && row.entryId !== leaverEntryId) {
        invitedEntryIds.push(row.entryId);
      }
    }
  }

  return { leaverEntryId, inviterEntryId, invitedEntryIds };
}