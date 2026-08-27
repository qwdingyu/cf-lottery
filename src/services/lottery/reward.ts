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
import { and, eq, or, sql } from "drizzle-orm";
import { lotteryDraws, lotteryEntries, activityEvents } from "../../db/schema";
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

/** 解析后的奖励配置（parseRewardConfig 的返回结构） */
type ParsedRewardConfig = {
  mode: "fixed" | "percent";
  perInviteAmount: number;
  perInvitePercent: number;
  currency: string;
  quota: { perUserPerDay?: number; globalPerDay?: number };
};

/**
 * 宽容解析活动配置中的 reward 规则（docs/111 §5）。
 *
 * 从 lotteryDraws.activityConfig JSON 读取，无有效 reward 配置时返回 null，
 * 调用方应静默跳过（不影响未配置 reward 的抽奖/接龙等活动）。
 *
 * 支持两种模式：
 *   - fixed: 每邀请奖励固定金额（perInviteAmount），与旧版行为一致
 *   - percent: 基于成交金额百分比（perInvitePercent），
 *     实际金额在付款确认时由 cf-lottery 自己计算（paymentOrders.amountCents × percent / 100），
 *     不依赖中转站——cf-lottery 有完整的支付系统，百分比计算是系统内部职责。
 * 旧数据（无 mode 字段）兼容为 fixed 模式。
 *
 * 货币来源优先级：reward.currency > flashSale.currency > "cny"（与 paymentOrders 默认值一致）。
 * 用 Number() 而非 parseInt，因为配置值可能是字符串 "100" 或数字 100。
 * NaN <= 0 为 true，会走 no_reward_config 分支，防御非法配置。
 */
export function parseRewardConfig(activityConfig: string | null): ParsedRewardConfig | null {
  let config: {
    reward?: { mode?: string; perInviteAmount?: number; perInvitePercent?: number; currency?: string };
    quota?: { perUserPerDay?: number; globalPerDay?: number };
    promotionConfig?: { flashSale?: { currency?: string } };
  } | null = null;
  try {
    config = activityConfig ? JSON.parse(activityConfig) : null;
  } catch {
    config = null;
  }
  const rewardConfig = config?.reward;
  const mode = rewardConfig?.mode === "percent" ? "percent" : "fixed";
  const currency = rewardConfig?.currency || config?.promotionConfig?.flashSale?.currency || "cny";
  let perInviteAmount = 0;
  let perInvitePercent = 0;
  if (mode === "percent") {
    perInvitePercent = Number(rewardConfig?.perInvitePercent || 0);
  } else {
    perInviteAmount = Number(rewardConfig?.perInviteAmount || 0);
  }
  if (!rewardConfig || (mode === "fixed" && perInviteAmount <= 0) || (mode === "percent" && perInvitePercent <= 0)) {
    return null;
  }
  return {
    mode,
    perInviteAmount,
    perInvitePercent,
    currency,
    quota: {
      perUserPerDay: config?.quota?.perUserPerDay,
      globalPerDay: config?.quota?.globalPerDay,
    },
  };
}

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
 * @param options.source 事件来源标记：'trigger'=正常归因路径，'reissue'=运营补发路径。
 *   写入 reward_earned 事件的 metadata.source，便于审计日志区分补发与正常归因。
 * @param options.joinerEntryId 被邀请人（本次归因的加入者）entryId（docs/275 P1）。
 *   用户级邀请码是固定值、POST /share 复用最新码，同一邀请人对所有好友 refCode 恒定。
 *   若幂等键只有 (sharer, eventType, refCode)，同一邀请码的第 2 个及以后好友会被
 *   静默吞掉（返回 reward_sent），违背 perInviteAmount"每邀请一份"语义
 *   （perUserPerDay 配额的存在即证明同一邀请人日内多次发放是预期行为）。
 *   因此正常归因路径必须传入 joinerEntryId，把幂等粒度收敛到"每次邀请"；
 *   不传（如 reissue 补发路径，失败事件无被邀请人信息）则回退为 refCode 粒度，
 *   保守防重（docs/274 补发防重复写入的原始意图不变）。
 */
export async function triggerRewardEarned(
  tx: DbType,
  tenantId: string,
  drawId: string,
  sharerEntryId: string,
  inviterIdentityValue: string,
  refCode: string,
  options?: { source?: string; joinerEntryId?: string },
): Promise<TriggerRewardEarnedResult> {
  const [draw] = await tx
    .select({ tenantId: lotteryDraws.tenantId, activityConfig: lotteryDraws.activityConfig })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return { triggered: false, reason: "no_reward_config", sharerEntryId, deliveryIds: [] };

  // 宽容解析 activityConfig：只用 reward 字段判断是否触发。
  // 不依赖严格的 schema 校验——活动配置可能包含多种玩法（lottery/survey/vote），
  // 只有显式配置了 reward 规则的活动才触发，其余活动不受影响。
  // ⚠️ 注意：triggerRewardEarned 在 joinDraw 时调用，此时付款尚未完成，
  // 不知道成交金额。percent 模式下此函数只记录百分比配置，实际金额在付款确认后计算。
  const parsed = parseRewardConfig(draw.activityConfig);
  if (!parsed) {
    return { triggered: false, reason: "no_reward_config", sharerEntryId, deliveryIds: [] };
  }
  const { mode: rewardMode, perInviteAmount, perInvitePercent, currency: derivedCurrency, quota } = parsed;

  // ── 幂等性检查（前置）──
  // 检查是否已有 reward_earned/fixed 或 reward_pending/percent 事件。
  // 必须在配额消耗之前执行：如果请求因幂等被拒绝，不应消耗 perUserPerDay/globalPerDay 配额。
  // 幂等粒度（docs/275 P1）：
  //   - 传了 joinerEntryId（正常归因路径）→ 按"每次邀请"判重：
  //     同一邀请码的多个不同好友各自独立发放（perInviteAmount 语义），
  //     同一好友重复归因（reissue 重放/脏路径）仍被拦截。
  //   - 未传（reissue 补发路径）→ 回退 (sharer, refCode) 粒度防重复写入（docs/274 原意）。
  const eventType = rewardMode === "fixed" ? "reward_earned" : "reward_pending";
  const [alreadyRecorded] = await tx
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, sharerEntryId),
      eq(activityEvents.eventType, eventType),
      eq(activityEvents.refCode, refCode),
      // json1 扩展查询：仅当事件带 joinerEntryId 元数据且与之相等才算同一次邀请
      // （历史事件无该字段，json_extract 返回 NULL，不会误伤 reissue 回退粒度判重）
      ...(options?.joinerEntryId
        ? [sql`json_extract(${activityEvents.metadataJson}, '$.joinerEntryId') = ${options.joinerEntryId}`]
        : []),
    ))
    .limit(1);
  if (alreadyRecorded) {
    return { triggered: false, reason: "reward_sent", sharerEntryId, deliveryIds: [] };
  }

  // 每个配额门槛单独提取，与活动配置的 JSON 字段一一对应，
  // 避免 `x || default` 将配置值 0（关闭限制）误当作 falsy 跳过。
  // "不限制"语义（docs/274）：留空 / 0 / 负值 都视为关闭配额限制，
  // 用一个超大数（MAX_SAFE_INTEGER）兜底，保证 SELECT COUNT < limit 恒真。
  // 不能用 Math.max(1, ...) — 那会把 0/-1（意为关闭）误强转为 1，配额仍被强制。
  const UNLIMITED = Number.MAX_SAFE_INTEGER;
  const rawPerUserDay = quota?.perUserPerDay;
  const rawGlobalDay = quota?.globalPerDay;
  const isUnlimited = (v: number | null | undefined) => v == null || v <= 0;
  const perUserPerDay = isUnlimited(rawPerUserDay) ? UNLIMITED : Number(rawPerUserDay);
  const globalPerDay = isUnlimited(rawGlobalDay) ? UNLIMITED : Number(rawGlobalDay);

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
  }

  // 记录奖励意图事件（docs/271 状态机）：
  //   fixed 模式：reward_earned（resolved），金额已知，直接通知中转站
  //   percent 模式：reward_pending（pending），付款确认后计算实际金额再通知
  //
  // 顺序原因：如果 enqueueWebhookEvent 失败（抛异常），recordActivityEvent 已写入。
  // 此时事务会被 maybeTriggerReward 的 catch 捕获，但事件记录保留在事务中。
  // 这是有意为之：reward_earned 事件是看板/审计的唯一真相源（source of truth），
  // webhook 投递失败可以通过事件列表人工补偿。
  // 顶层 source 列用于漏斗看板按来源分组（useDrawAnalytics 按 activityEvents.source 分组），
  // 与 draw-execution.ts（loser_reward）和 leaderboard-rewards.ts（viral）的模式对齐。
  // 不写 source 列会导致 percent 模式奖励全部落入 "unknown" 分组。
  const eventSource = options?.source || "trigger";
  if (rewardMode === "fixed") {
    await recordActivityEvent(tx, {
      tenantId: draw.tenantId,
      drawId,
      entryId: sharerEntryId,
      eventType: "reward_earned",
      source: eventSource,
      refCode,
      metadata: {
        mode: "fixed",
        perInviteAmount,
        currency: derivedCurrency,
        sharerEntryId,
        inviterIdentityValue,
        status: "resolved",
        // 被邀请人维度：幂等判重按"每次邀请"粒度反查用（docs/275 P1）
        ...(options?.joinerEntryId ? { joinerEntryId: options.joinerEntryId } : {}),
      },
    });
  } else {
    // percent 模式：付款确认前金额未知，记录 reward_pending
    // 状态机：pending → settled（付款确认时 settleRewardByPercent 更新）
    //         pending → cancelled（付款取消/退款时 cancelRewardPending 更新）
    await recordActivityEvent(tx, {
      tenantId: draw.tenantId,
      drawId,
      entryId: sharerEntryId,
      eventType: "reward_pending",
      source: eventSource,
      refCode,
      metadata: {
        mode: "percent",
        perInvitePercent,
        currency: derivedCurrency,
        sharerEntryId,
        inviterIdentityValue,
        status: "pending",
        // 被邀请人维度：幂等判重按"每次邀请"粒度反查用（docs/275 P1）
        ...(options?.joinerEntryId ? { joinerEntryId: options.joinerEntryId } : {}),
      },
    });
  }

  // 通知中转站生成兑换码（入队，HTTP 投递由调用方在事务内异步 fire-and-forget）。
  // 与 performDraw 的 webhook 模式一致：入队是写库操作（事务内），实际 HTTP 调用
  // 由 dispatchWebhookDelivery 在事务内异步执行——SQLite 同连接事务内 SELECT 可见。
  //
  // percent 模式特殊处理：此时付款尚未完成（triggerRewardEarned 在 joinDraw 时调用），
  // 不知道成交金额。webhook 只传递百分比配置，实际金额在付款确认后由 cf-lottery
  // 自己计算（paymentOrders.amountCents × percent / 100），再通知中转站生成兑换码。
  // cf-lottery 有完整的支付系统（Stripe），百分比计算是系统内部职责，不依赖中转站。
  let webhookResult;
  if (rewardMode === "fixed") {
    // fixed 模式：金额已知，直接通知中转站
    webhookResult = await enqueueWebhookEvent(tx, {
      tenantId,
      eventType: "reward.earned",
      data: {
        account: inviterIdentityValue,
        sharerEntryId,
        amount: perInviteAmount,
        mode: "fixed",
        currency: derivedCurrency,
        refCode,
        drawId,
      },
    });
  } else {
    // percent 模式：记录配置，付款确认后再计算金额并通知中转站
    // 当前只记录 reward_pending 事件，付款确认时再触发 reward.earned webhook
    webhookResult = { deliveryIds: [] as string[] };
  }

  // 出站平台消息（QQ 群）：这里只做事务内入队，不做外部 HTTP 投递。
  // tx 不能 fire-and-forget 到函数返回后再用，否则事务生命周期已结束；因此 await 入队并吞掉失败。
  try {
    await enqueuePlatformEvent(tx, {
      tenantId,
      drawId,
      eventType: "reward.earned",
      data: {
        userName: inviterIdentityValue,
        rewardLabel: rewardMode === "fixed"
          ? (perInviteAmount > 0 ? `${perInviteAmount} ${derivedCurrency}` : "奖励")
          : `${perInvitePercent}%（待付款确认）`,
        // percent 模式参与时 rewardLabel 已含百分比，rewardValue 留空避免重复显示
        // 模板渲染：🎁 xxx 通过分享获得奖励：10%（待付款确认）而非 10%（待付款确认）（10%）
        rewardValue: rewardMode === "fixed"
          ? (perInviteAmount > 0 ? `${perInviteAmount} ${derivedCurrency}` : "")
          : "",
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

/**
 * 付款确认后结算 percent 模式奖励（docs/271）。
 *
 * 调用时机：handlePaymentCallback 中 fulfillment 成功后，与付款确认同事务。
 * 流程：
 *   1. 从 paymentOrder.entryId 查找 attributed_join 事件，获取 sharerEntryId 和 refCode
 *   2. 查找 sharer 的 reward_pending 事件，读取 perInvitePercent
 *   3. 计算实际金额：amountCents × percent / 100
 *   4. 写 reward_earned 事件 (status: settled, amount: 实际金额)
 *   5. 入队 webhook 通知中转站
 *
 * @param db 事务实例（与 handlePaymentCallback 同事务）
 * @param tenantId 租户 ID
 * @param drawId 活动 ID
 * @param joinerEntryId 付款人（被邀请者）的 entryId
 * @param amountCents 实际成交金额（单位：分）
 * @param currency 币种
 */
export async function settleRewardByPercent(
  db: DbType,
  tenantId: string,
  drawId: string,
  joinerEntryId: string,
  amountCents: number,
  currency: string,
): Promise<{ settled: boolean; reason?: string; deliveryIds: string[] }> {
  // 1. 查找 attributed_join 事件，获取 sharerEntryId 和 refCode
  const [joinEvent] = await db
    .select({ metadataJson: activityEvents.metadataJson, refCode: activityEvents.refCode })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, joinerEntryId),
      eq(activityEvents.eventType, "attributed_join"),
    ))
    .limit(1);
  if (!joinEvent) return { settled: false, reason: "attributed_join_not_found", deliveryIds: [] };

  let meta: { sharerEntryId?: string } = {};
  try { meta = JSON.parse(joinEvent.metadataJson || "{}"); } catch { meta = {}; }
  const sharerEntryId = meta.sharerEntryId;
  const refCode = joinEvent.refCode || "";
  if (!sharerEntryId) return { settled: false, reason: "sharer_entry_id_not_found", deliveryIds: [] };

  // 2. 查找 sharer 的 reward_pending 事件，读取 perInvitePercent
  // 用 refCode + joinerEntryId 精确匹配（docs/275 P1）：用户级邀请码为固定值，
  // 同一邀请码的多个好友会产生多条 (sharer, refCode) 相同的 reward_pending，
  // 必须按被邀请人维度取到"本次付款对应"的那条。
  // 兼容：改造前写入的 reward_pending 事件 metadata 无 joinerEntryId（NULL），
  // 作为兜底参与匹配（排序上优先精确匹配，其次按时间取最旧），存量在途事件仍可结算。
  const joinerMetaEq = sql`json_extract(${activityEvents.metadataJson}, '$.joinerEntryId') = ${joinerEntryId}`;
  const joinerMetaNull = sql`json_extract(${activityEvents.metadataJson}, '$.joinerEntryId') IS NULL`;
  const [pendingEvent] = await db
    .select({ id: activityEvents.id, metadataJson: activityEvents.metadataJson })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, sharerEntryId),
      eq(activityEvents.eventType, "reward_pending"),
      eq(activityEvents.refCode, refCode),
      or(joinerMetaEq, joinerMetaNull),
    ))
    .orderBy(
      // 精确匹配（本次付款人）优先，兜底的存量事件按创建时间正序取最旧一条
      sql`CASE WHEN ${joinerMetaEq} THEN 0 ELSE 1 END`,
      activityEvents.createdAt,
    )
    .limit(1);
  if (!pendingEvent) return { settled: false, reason: "reward_pending_not_found", deliveryIds: [] };

  // 幂等性检查：确认该 reward_pending 尚未被结算（避免 handlePaymentCallback 重复调用导致双倍结算）。
  // 通过查找同 sharerEntryId + refCode + joinerEntryId 的 reward_earned 事件来判断。
  // joinerEntryId 严格匹配是安全的：settle 写入的 reward_earned 事件 metadata 一直携带
  // joinerEntryId（历史事件同样如此，见 docs/271 实现），不会漏判已结算。
  const [alreadySettled] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, sharerEntryId),
      eq(activityEvents.eventType, "reward_earned"),
      eq(activityEvents.refCode, refCode),
      joinerMetaEq,
    ))
    .limit(1);
  if (alreadySettled) {
    return { settled: false, reason: "already_settled", deliveryIds: [] };
  }

  // 防御纵深：检查该 reward_pending 是否已被取消（cancelRewardPending 已写入 reward_cancelled）。
  // 如果已取消，不应再结算——避免 race condition 下 cancelled 被覆盖为 settled。
  // 正常流程中 handlePaymentCallback 的 CAS 防止此场景，但 retryPaymentFulfillment 无同类保护。
  // 同样按 joinerEntryId 维度判重（reward_cancelled 的 metadata 自 docs/273 起即携带该字段）。
  const [cancelledBefore] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, sharerEntryId),
      eq(activityEvents.eventType, "reward_cancelled"),
      eq(activityEvents.refCode, refCode),
      joinerMetaEq,
    ))
    .limit(1);
  if (cancelledBefore) {
    return { settled: false, reason: "cancelled_before_settle", deliveryIds: [] };
  }

  let pendingMeta: { perInvitePercent?: number; currency?: string; inviterIdentityValue?: string; source?: string } = {};
  try { pendingMeta = JSON.parse(pendingEvent.metadataJson || "{}"); } catch { pendingMeta = {}; }
  const percent = Number(pendingMeta.perInvitePercent || 0);
  if (percent <= 0) return { settled: false, reason: "invalid_percent", deliveryIds: [] };

  // 3. 计算实际金额
  // amountCents 是支付金额（分），percent 是百分比（如 10 = 10%）
  // 实际金额 = amountCents × percent / 100（单位：分）
  // 保留整数，向下取整（防止超付）
  const actualAmountCents = Math.floor(amountCents * percent / 100);
  if (actualAmountCents <= 0) {
    return { settled: false, reason: "amount_too_small", deliveryIds: [] };
  }

  // 4. 写 reward_earned 事件（status: settled）
  // 顶层 source 列与 triggerRewardEarned 对齐，漏斗看板按 source 分组时能正确归类
  await recordActivityEvent(db, {
    tenantId,
    drawId,
    entryId: sharerEntryId,
    eventType: "reward_earned",
    source: pendingMeta.source || "trigger",
    refCode,
    metadata: {
      mode: "percent",
      percent,
      amountCents: actualAmountCents,
      currency: pendingMeta.currency || currency || "cny",
      sharerEntryId,
      inviterIdentityValue: pendingMeta.inviterIdentityValue || "",
      status: "settled",
      joinerEntryId,
      settledFrom: "reward_pending",
    },
  });

  // P2-2 优化：结算后把存量 null-joinerEntryId 的 pending 绑定到当前付款人。
  // 问题：alreadySettled 按 joinerEntryId 严格判重，但存量 null pending 结算时写入的
  // reward_earned 带当前付款人的 joinerEntryId，其他付款人按各自 joinerEntryId 查不到
  // 已结算，会再次命中同一条 null pending 并重复结算。
  // 解决：结算后把 pending 的 joinerEntryId 更新为当前付款人，后续付款的
  // or(joinerMetaEq, joinerMetaNull) 查询自然排除（joinerEntryId 已设置且不匹配）。
  // 新格式 pending（已带 joinerEntryId）更新为相同值，无害。
  await db.update(activityEvents)
    .set({ metadataJson: sql`json_set(COALESCE(metadata_json, '{}'), '$.joinerEntryId', ${joinerEntryId})` })
    .where(eq(activityEvents.id, pendingEvent.id));

  // 5. 入队 webhook 通知中转站
  let deliveryIds: string[] = [];
  try {
    const webhookResult = await enqueueWebhookEvent(db, {
      tenantId,
      eventType: "reward.earned",
      data: {
        account: pendingMeta.inviterIdentityValue || "",
        sharerEntryId,
        amount: actualAmountCents,
        mode: "percent",
        percent,
        currency: pendingMeta.currency || currency || "cny",
        refCode,
        drawId,
        status: "settled",
      },
    });
    deliveryIds = webhookResult.deliveryIds;
  } catch (err) {
    // webhook 入队失败不影响结算结果（审计事件已落库，可人工补偿）
    logError("reward", `settleRewardByPercent: enqueueWebhookEvent draw=${drawId}`, err);
  }

  // 出站平台消息（QQ 群）：付款确认后通知邀请人奖励已结算。
  // 与 triggerRewardEarned 的 fixed 模式一致——fixed 在参与时发送，percent 在付款确认后发送。
  try {
    await enqueuePlatformEvent(db, {
      tenantId,
      drawId,
      eventType: "reward.earned",
      data: {
        userName: pendingMeta.inviterIdentityValue || "",
        rewardLabel: `${actualAmountCents} ${pendingMeta.currency || currency || "cny"}`,
        rewardValue: `${actualAmountCents} ${pendingMeta.currency || currency || "cny"}`,
      },
    });
  } catch (err) {
    logError("reward", `settleRewardByPercent: enqueuePlatformEvent draw=${drawId}`, err);
  }

  return { settled: true, deliveryIds };
}

/**
 * 取消 pending 状态的 percent 模式奖励（docs/271）。
 *
 * 调用时机：支付取消/退款/超时释放时，清除对应的 reward_pending 事件。
 * 写 reward_cancelled 事件记录取消原因（与 reward_failed 语义分离，docs/273），
 * reward_failed 用于实际奖励发放失败（可补发），reward_cancelled 用于支付取消（不可补发）。
 *
 * @param db 事务实例
 * @param tenantId 租户 ID
 * @param drawId 活动 ID
 * @param joinerEntryId 付款人（被邀请者）的 entryId
 * @param reason 取消原因（payment_cancelled / payment_refunded / payment_expired）
 */
export async function cancelRewardPending(
  db: DbType,
  tenantId: string,
  drawId: string,
  joinerEntryId: string,
  reason: string,
): Promise<{ cancelled: boolean }> {
  // 查找 attributed_join 事件，获取 sharerEntryId 和 refCode
  const [joinEvent] = await db
    .select({ metadataJson: activityEvents.metadataJson, refCode: activityEvents.refCode })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, joinerEntryId),
      eq(activityEvents.eventType, "attributed_join"),
    ))
    .limit(1);
  if (!joinEvent) return { cancelled: false };

  let meta: { sharerEntryId?: string } = {};
  try { meta = JSON.parse(joinEvent.metadataJson || "{}"); } catch { meta = {}; }
  const sharerEntryId = meta.sharerEntryId;
  const refCode = joinEvent.refCode || "";
  if (!sharerEntryId) return { cancelled: false };

  // 检查该 reward 是否已被结算（settleRewardByPercent 已写入 reward_earned）。
  // 如果已结算，不再写 reward_cancelled——避免同一笔奖励既有 settled 又有 cancelled 的矛盾状态。
  // 注意：同一个 sharerEntryId 可能有多条 reward_earned（不同 refCode 多次邀请），
  // 需要用 refCode + joinerEntryId 精确匹配到同一次归因（docs/275 P1）：
  // 同一邀请码的多个好友各自独立，好友 X 已结算不应拦截好友 Y 的取消。
  // reward_earned(settled) 与 reward_cancelled 的 metadata 均携带 joinerEntryId，严格匹配安全。
  const joinerMetaEq = sql`json_extract(${activityEvents.metadataJson}, '$.joinerEntryId') = ${joinerEntryId}`;
  const [settledEvent] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, sharerEntryId),
      eq(activityEvents.eventType, "reward_earned"),
      eq(activityEvents.refCode, refCode),
      joinerMetaEq,
    ))
    .limit(1);
  if (settledEvent) {
    // 已结算，跳过取消（reward_earned 是最终态）
    return { cancelled: false };
  }

  // 检查该 reward 是否已被取消（两次 cancelRewardPending 调用，如 expireOverdueOrders 重复触发）。
  // 幂等性：同 sharerEntryId + refCode + joinerEntryId 已有 reward_cancelled 则不再重复写。
  const [alreadyCancelled] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.drawId, drawId),
      eq(activityEvents.entryId, sharerEntryId),
      eq(activityEvents.eventType, "reward_cancelled"),
      eq(activityEvents.refCode, refCode),
      joinerMetaEq,
    ))
    .limit(1);
  if (alreadyCancelled) {
    return { cancelled: false };
  }

  // 写 reward_cancelled 事件记录取消（与 reward_failed 语义分离，docs/273）
  // reward_failed 用于实际奖励发放失败（可补发），reward_cancelled 用于支付取消/退款/超时（不可补发）
  // source 列映射：reason → source（用于漏斗分析分组），未知 reason 直接使用 reason 本身
  const CANCEL_SOURCE_MAP: Record<string, string> = {
    payment_expired: "payment_expired",
    payment_cancelled: "payment_cancelled",
    payment_refunded: "payment_refunded",
  };
  const cancelSource = CANCEL_SOURCE_MAP[reason] || reason;
  await recordActivityEvent(db, {
    tenantId,
    drawId,
    entryId: sharerEntryId,
    eventType: "reward_cancelled",
    refCode,
    source: cancelSource,
    metadata: {
      path: "cancelRewardPending",
      reason,
      joinerEntryId,
      status: "cancelled",
    },
  });

  return { cancelled: true };
}
