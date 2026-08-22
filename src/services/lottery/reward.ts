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
 * - 配额校验顺序：先个人后全局。个人超限时立即拒绝，避免消耗全局配额的写入。
 *   如果个人通过但全局超限，个人配额已被消耗——这是已知的权衡：
 *   "有人被邀请了"是事实，只是池子暂时满了，个人配额的消耗是合理的。
 */
import type { DbType } from "../../db/client";
import { logError } from "../../lib/logger";
import { and, eq } from "drizzle-orm";
import { lotteryDraws, lotteryEntries } from "../../db/schema";
import { checkDbRateLimit } from "../../lib/rate-limit";
import { recordActivityEvent, enqueueWebhookEvent } from "./integration";
import { enqueuePlatformEvent } from "../platform/delivery";

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
 * 调用时机：joinDraw 事务内，归因成功（attributed=true）后。
 * 调用方（maybeTriggerReward）用 try/catch 包裹，确保奖励失败不影响参与主流程。
 *
 * @param tx 事务实例（与 joinDraw 同事务，保证归因与奖励意图原子性）
 * @param drawId 活动 ID
 * @param sharerEntryId 邀请人（奖励受益人）的 entryId——用作配额 key 而非 identityValue，
 *   因为 entryId 是 UUID，无特殊字符，且同一 draw 内同一 identity 只有一个 entry
 * @param inviterIdentityValue 邀请人的身份值（用于 Webhook payload 与对账）
 * @param refCode 归因使用的分享码
 */
export async function triggerRewardEarned(
  tx: DbType,
  tenantId: string,
  drawId: string,
  sharerEntryId: string,
  inviterIdentityValue: string,
  refCode: string,
): Promise<TriggerRewardEarnedResult> {
  const [draw] = await tx
    .select({ tenantId: lotteryDraws.tenantId, activityConfig: lotteryDraws.activityConfig })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return { triggered: false, reason: "no_reward_config", sharerEntryId, deliveryIds: [] };

  // 宽容解析 activityConfig：只用 reward.perInviteAmount 字段判断是否触发。
  // 不依赖严格的 schema 校验——活动配置可能包含多种玩法（lottery/survey/vote），
  // 只有显式配置了 reward 规则的活动才触发，其余活动不受影响。
  let config: { reward?: { perInviteAmount?: number; currency?: string }; quota?: { perUserPerDay?: number; globalPerDay?: number } } | null = null;
  try {
    config = draw.activityConfig ? JSON.parse(draw.activityConfig) : null;
  } catch {
    config = null;
  }
  const rewardConfig = config?.reward;
  // 用 Number() 而非 parseInt，因为配置值可能是字符串 "100" 或数字 100。
  // NaN <= 0 为 true，会走 no_reward_config 分支，防御非法配置。
  const perInviteAmount = Number(rewardConfig?.perInviteAmount || 0);
  if (!rewardConfig || perInviteAmount <= 0) {
    return { triggered: false, reason: "no_reward_config", sharerEntryId, deliveryIds: [] };
  }

  // 每个配额门槛单独提取，与活动配置的 JSON 字段一一对应，
  // 避免 `x || default` 将配置值 0（关闭限制）误当作 falsy 跳过。
  // 关闭限制用 -1 或 0 表示"无限"，通过 Math.max(1, ...) 防御非正值。
  const rawPerUserDay = config?.quota?.perUserPerDay;
  const rawGlobalDay = config?.quota?.globalPerDay;
  const perUserPerDay = rawPerUserDay != null ? Math.max(1, Number(rawPerUserDay)) : 1;
  const globalPerDay = rawGlobalDay != null ? Math.max(1, Number(rawGlobalDay)) : 1;

  // 配额校验 1：邀请人（奖励受益人）每天最多 perUserPerDay 次。
  //
  // 先校验个人配额，再校验全局配额。顺序有意义：
  // - 个人配额是"防刷"的第一道闸门：同一邀请人短时间大量邀请 = 羊毛行为。
  // - 全局配额是"总池子"的第二道闸门：限制活动总奖励消耗。
  // - 个人超限时立即拒绝，避免消耗全局配额 key 的 INSERT（checkDbRateLimit 每次写入一条计数）。
  // - 如果个人通过但全局超限：个人配额已被消耗，但奖励未触发。这是已知设计权衡——
  //   "有人被邀请了"是事实，池子满只是暂时，下一次配额的消耗是合理的。
  const userKey = `reward:${drawId}:${sharerEntryId}`;
  if (!(await checkDbRateLimit(tx, userKey, perUserPerDay, REWARD_QUOTA_WINDOW_MS))) {
    return { triggered: false, reason: "quota_exceeded", sharerEntryId, deliveryIds: [] };
  }

  // 配额校验 2：活动每天最多 globalPerDay 次
  const globalKey = `reward:global:${drawId}`;
  if (!(await checkDbRateLimit(tx, globalKey, globalPerDay, REWARD_QUOTA_WINDOW_MS))) {
    return { triggered: false, reason: "quota_exceeded", sharerEntryId, deliveryIds: [] };
  }  // 记录奖励意图事件——必须先在事务内落库，再入队 webhook。
  // 顺序原因：如果 enqueueWebhookEvent 失败（抛异常），recordActivityEvent 已写入。
  // 此时事务会被 maybeTriggerReward 的 catch 捕获，但事件记录保留在事务中。
  // 这是有意为之：reward_earned 事件是看板/审计的唯一真相源（source of truth），
  // webhook 投递失败可以通过事件列表人工补偿。
  await recordActivityEvent(tx, {
    tenantId: draw.tenantId,
    drawId,
    entryId: sharerEntryId,
    eventType: "reward_earned",
    refCode,
    metadata: {
      perInviteAmount,
      currency: rewardConfig.currency || "USD",
      sharerEntryId,
      inviterIdentityValue,
      source: "trigger",
    },
  });

  // 通知中转站生成兑换码（入队，HTTP 投递由调用方在事务内异步 fire-and-forget）。
  // 与 performDraw 的 webhook 模式一致：入队是写库操作（事务内），实际 HTTP 调用
  // 由 dispatchWebhookDelivery 在事务内异步执行——SQLite 同连接事务内 SELECT 可见。
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

  // 出站平台消息（QQ 群）：这里只做事务内入队，不做外部 HTTP 投递。
  // tx 不能 fire-and-forget 到函数返回后再用，否则事务生命周期已结束；因此 await 入队并吞掉失败。
  try {
    await enqueuePlatformEvent(tx, {
      tenantId,
      drawId,
      eventType: "reward.earned",
      data: {
        userName: inviterIdentityValue,
        rewardLabel: perInviteAmount > 0 ? `${perInviteAmount} ${rewardConfig.currency || "USD"}` : "奖励",
        rewardValue: perInviteAmount > 0 ? `${perInviteAmount} ${rewardConfig.currency || "USD"}` : "",
      },
    });
  } catch (err) {
    logError("reward", `enqueuePlatformEvent reward.earned failed for ${drawId}`, err);
  }

  return { triggered: true, reason: "reward_sent", sharerEntryId, deliveryIds: webhookResult.deliveryIds };
}

/**
 * 查询奖励受益人（分享者）的参与身份，供 Webhook 对账使用。
 * 
 * 为什么需要这个函数而不是直接用 inviterIdentityValue？
 * maybeTriggerReward 从 recordAttributedJoin 拿到的是 sharerEntryId（UUID），
 * 但 Webhook payload 需要人类可读的账号（邮箱/用户名）供中转站对账。
 * 这个函数做 entryId → identityValue 的映射，查询结果可能为空（entry 被删除的极端情况），
 * 此时返回空字符串——Webhook 仍然会发送，但 payload 中的 account 为空。
 */
export async function getSharerIdentityValue(
  db: DbType,
  tenantId: string,
  drawId: string,
  sharerEntryId: string,
): Promise<string> {
  const [row] = await db
    .select({ identityValue: lotteryEntries.identityValue })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, sharerEntryId),
      eq(lotteryEntries.drawId, drawId),
      eq(lotteryEntries.tenantId, tenantId),
    ))
    .limit(1);
  return row?.identityValue || "";
}
