/**
 * 奖励出口适配器（docs/250 §3.4）
 *
 * 将 incentive-engine 计算的奖励记录映射到 cf-lottery 已有的奖励基础设施。
 * 每个出口函数只做一件事：执行具体的奖励发放，不涉及配置解析和计算。
 *
 * 设计原则：
 * - 只读参数，不修改 draw/promotionConfig 等配置对象
 * - CAS 乐观锁保护并发安全，失败时静默跳过（不抛异常）
 * - 与现有路径 [1][2][3] 共享同一套奖励出口基础设施
 *   （lotteryEntries.spinsLeft / couponCodes 等），
 *   确保引擎路径的奖励与现有路径的奖励是一致可比的
 */
import type { DbType } from "../../db/client";
import { and, eq, sql } from "drizzle-orm";
import { lotteryEntries, couponCodes, users } from "../../db/schema";
import { recordSpinLog } from "./spins-log";
import { recordActivityEvent } from "./integration";

/**
 * 发放 bonus_spin（额外抽奖次数）给分享者。
 *
 * CAS 乐观锁：条件更新 spinsTotalGranted 未被并发修改时再写入，
 * 与 grantViralSpinsToSharer 的并发保护模式一致。
 * 失败时静默跳过（不抛异常），由调用方 try/catch 容错。
 *
 * @param tx 事务实例
 * @param tenantId 租户 ID
 * @param drawId 活动 ID
 * @param sharerEntryId 分享者 entryId
 * @param amount 发放次数（engine 已计算好的值）
 * @param maxSpins 活动级 maxSpinsPerEntry（总顶约束）
 * @param rewardId 奖励 ID（用于 spins_log.refId 审计）
 */
export async function grantBonusSpin(
  tx: DbType,
  tenantId: string,
  drawId: string,
  sharerEntryId: string,
  amount: number,
  maxSpins: number,
  rewardId: string,
): Promise<boolean> {
  if (amount <= 0) return false;
  // 读取分享者当前 entry 状态
  const [sharer] = await tx
    .select({
      id: lotteryEntries.id,
      identityValue: lotteryEntries.identityValue,
      spinsLeft: lotteryEntries.spinsLeft,
      spinsTotalGranted: lotteryEntries.spinsTotalGranted,
    })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, sharerEntryId),
      eq(lotteryEntries.tenantId, tenantId),
      eq(lotteryEntries.drawId, drawId),
    ))
    .limit(1);
  if (!sharer) return false;

  // maxSpins 总顶裁剪（与 grantViralSpinsToSharer 一致）
  const granted = Math.max(0, Math.floor(Number(sharer.spinsTotalGranted || 0)));
  const room = maxSpins >= 1 ? Math.max(0, maxSpins - granted) : amount;
  const actual = Math.max(0, Math.min(amount, room));
  if (actual <= 0) return false;

  // CAS：spinsTotalGranted 未被并发修改时写入
  const updateResult = await tx
    .update(lotteryEntries)
    .set({
      spinsTotalGranted: sql`${lotteryEntries.spinsTotalGranted} + ${actual}`,
      spinsLeft: sql`${lotteryEntries.spinsLeft} + ${actual}`,
    })
    .where(and(
      eq(lotteryEntries.id, sharer.id),
      eq(lotteryEntries.tenantId, tenantId),
      eq(lotteryEntries.drawId, drawId),
      eq(lotteryEntries.spinsTotalGranted, granted),
    ));
  if ((updateResult.rowsAffected ?? 0) === 0) return false;

  // 写入 spins 流水日志
  await recordSpinLog(tx, {
    tenantId,
    entryId: sharerEntryId,
    userId: sharer.identityValue ?? "",
    delta: actual,
    balanceAfter: Number(sharer.spinsLeft ?? 0) + actual,
    reason: "viral",
    refId: `engine:${rewardId}`,
  });

  return true;
}

/**
 * 发放 bonus_coupon（优惠券码）给分享者。
 *
 * 复用 grantLoserRewards 的 CAS 发券模式：
 * 从 couponCodes 表中取一张 available 的码，CAS 更新为 issued。
 * rowsAffected=0 时表示码已被其他请求占用，跳过本次。
 *
 * @param tx 事务实例
 * @param tenantId 租户 ID
 * @param drawId 活动 ID
 * @param sharerEntryId 分享者 entryId（用于 recipient 追踪）
 * @param couponLabel 优惠券 label（为空时取任意 available 码）
 * @param rewardId 奖励 ID（用于审计）
 */
export async function grantBonusCoupon(
  tx: DbType,
  tenantId: string,
  drawId: string,
  sharerEntryId: string,
  couponLabel: string | undefined,
  rewardId: string,
): Promise<boolean> {
  // 从码池取一张 available 优惠券
  const conditions = [
    eq(couponCodes.tenantId, tenantId),
    eq(couponCodes.status, "available"),
  ];
  if (couponLabel) {
    conditions.push(eq(couponCodes.label, couponLabel));
  }
  const [available] = await tx
    .select({ id: couponCodes.id, code: couponCodes.code })
    .from(couponCodes)
    .where(and(...conditions))
    .orderBy(couponCodes.createdAt)
    .limit(1);
  if (!available) return false;

  // 解析分享者 recipientEmail（docs/252 §2.3 修复）：
  // 与 grantLoserRewards 一致——registered 身份（identity_type=user_id）时
  // identity_value 是 userId（UUID），需关联 users.email 才能拿到真实邮箱；
  // email 身份直接用 identity_value。否则 recipientEmail 落库成 UUID，
  // 后续邮件投递会被过滤掉（收不到优惠券通知）。
  let recipientEmail = "";
  const [sharer] = await tx
    .select({
      identityType: lotteryEntries.identityType,
      identityValue: lotteryEntries.identityValue,
    })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, sharerEntryId),
      eq(lotteryEntries.tenantId, tenantId),
      eq(lotteryEntries.drawId, drawId),
    ))
    .limit(1);
  if (sharer) {
    if (sharer.identityType === "user_id" && sharer.identityValue) {
      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, sharer.identityValue))
        .limit(1);
      recipientEmail = user?.email || "";
    } else {
      recipientEmail = sharer.identityValue || "";
    }
  }

  // CAS 原子发放：仅当仍为 available 时更新为 issued，并记录领取人
  const result = await tx
    .update(couponCodes)
    .set({
      status: "issued",
      drawId,
      recipientEmail,
    })
    .where(and(
      eq(couponCodes.id, available.id),
      eq(couponCodes.tenantId, tenantId),
      eq(couponCodes.status, "available"),
    ));
  if ((result.rowsAffected ?? 0) === 0) return false;

  // 审计日志（docs/252 §4.2）：bonus_coupon 发放写 activityEvents（reward_earned），
  // 与 bonus_spin 写 spins_log 对齐，保证 L3 能跨租户追踪优惠券奖励发放。
  // 与 triggerRewardEarned 的 reward_earned 事件同语义，metadata 记录奖励出口与码 label。
  try {
    await recordActivityEvent(tx, {
      tenantId,
      drawId,
      entryId: sharerEntryId,
      eventType: "reward_earned",
      metadata: {
        rewardExit: "bonus_coupon",
        rewardId,
        couponLabel: couponLabel || "",
        couponCode: available.code,
        recipientEmail,
      },
    });
  } catch (err) {
    // 审计失败不影响发券结果（与 recordSpinLog 的容错一致）
    console.error(`[lottery] recordActivityEvent bonus_coupon failed for ${drawId}:`, err);
  }

  return true;
}