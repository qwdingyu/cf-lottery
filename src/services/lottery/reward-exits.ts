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
import { lotteryEntries, couponCodes } from "../../db/schema";
import { recordSpinLog } from "./spins-log";

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

  // CAS 原子发放：仅当仍为 available 时更新为 issued
  const result = await tx
    .update(couponCodes)
    .set({
      status: "issued",
      drawId,
      // recipientEmail 由调用方负责填充（如果知道的话）
    })
    .where(and(
      eq(couponCodes.id, available.id),
      eq(couponCodes.tenantId, tenantId),
      eq(couponCodes.status, "available"),
    ));
  if ((result.rowsAffected ?? 0) === 0) return false;

  return true;
}