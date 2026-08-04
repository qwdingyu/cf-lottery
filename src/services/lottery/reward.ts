/**
 * 奖励意图触发（docs/111 §5 阶段一）
 *
 * 归因成功后（新用户通过分享链接参与），检查活动配置中的 reward 规则，
 * 通过配额校验后记录 reward_earned 事件并通知中转站生成兑换码。
 *
 * 设计要点：
 * - 配置读取宽容：从 lotteryDraws.activityConfig JSON 读取，无 reward 配置则静默跳过，
 *   不影响任何现有活动（兼容未配置 reward 的抽奖/接龙）。
 * - 配额用 checkDbRateLimit（原子 INSERT…SELECT，多 Worker 实例一致）：
 *   perUserPerDay 按「邀请人」维度，globalPerDay 按活动维度。
 * - 通知只入队（enqueue），实际 HTTP 投递由调用方在事务外异步触发，
 *   与 performDraw 的 webhook 模式一致，失败不影响参与主流程。
 */
import type { DbType } from "../../db/client";
import { and, eq } from "drizzle-orm";
import { lotteryDraws, lotteryEntries } from "../../db/schema";
import { checkDbRateLimit } from "../../lib/rate-limit";
import { recordActivityEvent, enqueueWebhookEvent } from "./integration";

const REWARD_QUOTA_WINDOW_MS = 24 * 3600 * 1000;  // 配额窗口：24 小时

export type TriggerRewardEarnedResult = {
  triggered: boolean;
  reason: "no_reward_config" | "quota_exceeded" | "reward_sent";
  sharerEntryId: string;
  /** 入队的 Webhook 投递 ID（调用方在事务外异步 dispatch） */
  deliveryIds: string[];
};

/**
 * 归因成功后触发奖励意图。
 *
 * @param tx 事务实例（与 joinDraw 同事务，保证归因与奖励意图原子性）
 * @param drawId 活动 ID
 * @param sharerEntryId 邀请人（奖励受益人）的 entryId
 * @param inviterIdentityValue 邀请人的身份值（用于 Webhook payload 与对账）
 * @param refCode 归因使用的分享码
 */
export async function triggerRewardEarned(
  tx: DbType,
  drawId: string,
  sharerEntryId: string,
  inviterIdentityValue: string,
  refCode: string,
): Promise<TriggerRewardEarnedResult> {
  const [draw] = await tx
    .select({ tenantId: lotteryDraws.tenantId, activityConfig: lotteryDraws.activityConfig })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.id, drawId))
    .limit(1);
  if (!draw) return { triggered: false, reason: "no_reward_config", sharerEntryId, deliveryIds: [] };

  // 宽容解析 activityConfig：只有带 reward.perInviteAmount 的配置才触发
  let config: { reward?: { perInviteAmount?: number; currency?: string }; quota?: { perUserPerDay?: number; globalPerDay?: number } } | null = null;
  try {
    config = draw.activityConfig ? JSON.parse(draw.activityConfig) : null;
  } catch {
    config = null;
  }
  const rewardConfig = config?.reward;
  const perInviteAmount = Number(rewardConfig?.perInviteAmount || 0);
  if (!rewardConfig || perInviteAmount <= 0) {
    return { triggered: false, reason: "no_reward_config", sharerEntryId, deliveryIds: [] };
  }

  const perUserPerDay = Math.max(1, Number(config?.quota?.perUserPerDay || 1));
  const globalPerDay = Math.max(1, Number(config?.quota?.globalPerDay || 100));

  // 配额校验 1：邀请人（奖励受益人）每天最多 perUserPerDay 次
  const userKey = `reward:${drawId}:${sharerEntryId}`;
  if (!(await checkDbRateLimit(tx, userKey, perUserPerDay, REWARD_QUOTA_WINDOW_MS))) {
    return { triggered: false, reason: "quota_exceeded", sharerEntryId, deliveryIds: [] };
  }

  // 配额校验 2：活动每天最多 globalPerDay 次（总池子）
  const globalKey = `reward:global:${drawId}`;
  if (!(await checkDbRateLimit(tx, globalKey, globalPerDay, REWARD_QUOTA_WINDOW_MS))) {
    return { triggered: false, reason: "quota_exceeded", sharerEntryId, deliveryIds: [] };
  }

  const tenantId = draw.tenantId;

  // 记录奖励意图事件（看板/审计依据）
  await recordActivityEvent(tx, {
    tenantId,
    drawId,
    entryId: sharerEntryId,
    eventType: "reward_earned",
    refCode,
    metadata: {
      perInviteAmount,
      currency: rewardConfig.currency || "USD",
      sharerEntryId,
      inviterIdentityValue,
    },
  });

  // 通知中转站生成兑换码（入队，HTTP 投递由调用方异步执行）
  const webhookResult = await enqueueWebhookEvent(tx, {
    tenantId,
    eventType: "reward.earned",
    data: {
      account: inviterIdentityValue,
      sharerEntryId,
      amount: perInviteAmount,
      currency: rewardConfig.currency || "USD",
      refCode,
      drawId,
    },
  });

  return { triggered: true, reason: "reward_sent", sharerEntryId, deliveryIds: webhookResult.deliveryIds };
}

/**
 * 查询奖励受益人（分享者）的参与身份，供 Webhook 对账使用。
 */
export async function getSharerIdentityValue(
  db: DbType,
  drawId: string,
  sharerEntryId: string,
): Promise<string> {
  const [row] = await db
    .select({ identityValue: lotteryEntries.identityValue })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.id, sharerEntryId), eq(lotteryEntries.drawId, drawId)))
    .limit(1);
  return row?.identityValue || "";
}
