/**
 * 外部集成路由。
 *
 * 这些接口面向租户自己的业务系统或第三方系统，使用租户 API Key 鉴权。
 * 外部成交、核销、注册等只能通过这里回传，不能由公开页点击或 UTM 推断。
 */
import { Hono, type Context } from "hono";
import { logError } from "../lib/logger";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok } from "../lib/http";
import { checkDbRateLimit } from "../lib/rate-limit";
import {
  authenticateApiKey,
  recordExternalConversion,
  type ExternalConversionType,
  enqueueWebhookEvent,
  computePenaltyTargets,
  recordActivityEvent,
} from "../services/lottery-service";
import { enqueuePlatformEvent } from "../services/platform/delivery";
import {
  lotteryEntries,
  lotteryDraws,
  activityEvents,
  prizeCodes,
} from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";

export const integrationRoute = new Hono<AppEnv>();

const CONVERSION_TYPES = new Set<ExternalConversionType>([
  "registration",
  "purchase",
  "coupon_redeemed",
  "lead_qualified",
  "offline_redeemed",
  "custom",
]);

// 外部转化回传限流：300 次/分钟/API key（#15）。
// 正常业务量远低于此（回传按事件计数），阈值仅防滥用刷爆 external_conversions 表；
// 使用 DB 级限流（单条原子条件 INSERT，跨 Worker 实例一致），不依赖内存 Map。
const CONVERSION_RATE_LIMIT = 300;
const CONVERSION_RATE_WINDOW_MS = 60000;

function readApiKey(c: Context<AppEnv>): string {
  const authHeader = c.req.header("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  return bearer || c.req.header("X-CF-Lottery-API-Key") || "";
}

/** 外部转化回传：成交/核销/注册等必须由外部系统显式上报。 */
integrationRoute.post("/conversions", async (c) => {
  const db = getDb(c);
  const apiKey = await authenticateApiKey(db, readApiKey(c));
  if (!apiKey) return fail(c, "API Key 无效", 401);

  // 限流检查：以 API key 维度计数，防止单个 key 高频写入拖垮数据表与 Turso rows written 配额
  if (!(await checkDbRateLimit(db, `integration:${apiKey.id}`, CONVERSION_RATE_LIMIT, CONVERSION_RATE_WINDOW_MS))) {
    return fail(c, "调用过于频繁，请稍后再试", 429);
  }

  const body = await c.req.json<{
    drawId?: string;
    publicSlug?: string;
    externalEventId?: string;
    conversionType?: ExternalConversionType;
    source?: string;
    entryId?: string;
    identityType?: string;
    identityValue?: string;
    refCode?: string;
    amountCents?: number;
    currency?: string;
    payload?: Record<string, unknown>;
    occurredAt?: string;
  }>().catch(() => null);
  if (!body) return fail(c, "请求体不是有效 JSON", 400);
  if (!body.drawId && !body.publicSlug) return fail(c, "请提供 drawId 或 publicSlug", 400);
  if (!body.externalEventId) return fail(c, "请提供 externalEventId", 400);
  if (!body.conversionType || !CONVERSION_TYPES.has(body.conversionType)) {
    return fail(c, "外部转化类型无效", 400);
  }

  try {
    const result = await recordExternalConversion(db, {
      tenantId: apiKey.tenantId,
      drawId: body.drawId,
      publicSlug: body.publicSlug,
      externalEventId: body.externalEventId,
      conversionType: body.conversionType,
      source: body.source,
      entryId: body.entryId,
      identityType: body.identityType,
      identityValue: body.identityValue,
      refCode: body.refCode,
      amountCents: body.amountCents,
      currency: body.currency,
      payload: body.payload,
      occurredAt: body.occurredAt,
    });
    return ok(c, {
      created: result.created,
      conversionId: result.conversion.id,
      drawId: result.conversion.drawId,
      eventId: result.conversion.externalEventId,
    });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "外部转化回传失败", 400);
  }
});

// ═════════════════════════════════════════════════════════
// 外部事件入口（docs/111 §5 阶段二 + docs/114 §4）
//
// 机制：租户 API Key 鉴权 + 限流 + 幂等 + 事件路由。
// 幂等实现：同一 API key 的同一 idempotencyKey 只处理一次。
//   幂等检查通过 activityEvents 表：eventType=ext:{event}, refCode=idempotencyKey。
//   refCode 字段截断到 80 字符——与 activityEvents.refCode 的存储长度一致，
//   避免越界 INSERT。假定 idempotencyKey 是 UUID/短哈希，前 80 字符足够唯一。
//
// 支持事件类型：
//   member.left_group — QQ 机器人上报退群，触发波及名单计算 + 处罚 Webhook
//   reward.issued     — 中转站回传发卡确认
//   penalty.executed  — 中转站回传处罚执行确认
//   reward.redeemed   — 中转站回传兑换码核销确认（标记 prizeCode redeemed）
// ═════════════════════════════════════════════════════════

const INTEGRATION_EVENT_LIMIT = 60;  // 外部事件限流：60 次/分钟/API key
const INTEGRATION_EVENT_WINDOW_MS = 60000;

type IntegrationEventType = "member.left_group" | "reward.issued" | "penalty.executed" | "reward.redeemed";
const INTEGRATION_EVENT_TYPES = new Set<IntegrationEventType>([
  "member.left_group",
  "reward.issued",
  "penalty.executed",
  "reward.redeemed",
]);

integrationRoute.post("/events", async (c) => {
  const db = getDb(c);
  const apiKey = await authenticateApiKey(db, readApiKey(c));
  if (!apiKey) return fail(c, "API Key 无效", 401);

  const body = await c.req.json<{
    event?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }>().catch(() => null);
  if (!body) return fail(c, "请求体不是有效 JSON", 400);

  const eventType = String(body.event || "").trim();
  if (!eventType || !INTEGRATION_EVENT_TYPES.has(eventType as IntegrationEventType)) {
    return fail(c, `不支持的事件类型: ${eventType || "空"}`, 400);
  }
  const event = eventType as IntegrationEventType;
  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey) return fail(c, "请提供 idempotencyKey", 400);
  const payload = body.payload || {};

  // ── 幂等检查（先于限流，避免 Webhook 重试请求被误限流） ──
  // 机器人重报、中转站 Webhook 投递重试、事件回传重试都不应消耗限流配额。
  const existing = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, apiKey.tenantId),
      eq(activityEvents.eventType, `ext:${event}`),
      eq(activityEvents.refCode, idempotencyKey.slice(0, 80)),
    ))
    .limit(1);
  if (existing.length > 0) {
    return ok(c, { handled: false, reason: "idempotencyKey 已处理" });
  }

  // ── 限流（幂等之后，只消耗"新事件"的配额） ──
  if (!(await checkDbRateLimit(db, `integration:${apiKey.id}`, INTEGRATION_EVENT_LIMIT, INTEGRATION_EVENT_WINDOW_MS))) {
    return fail(c, "调用过于频繁，请稍后再试", 429);
  }

  // ── 处理 member.left_group ──
  // 流程：验证活动存在 → 计算波及名单 → 将 entryId 映射为 identityValue
  //       → 记录退群事件 → 记录处罚意图 → 发送处罚 Webhook 通知中转站。
  //
  // 注意：webhook 入队失败不影响事件记录。penalty_requested 事件和 ext:member.left_group
  // 事件都是看板/审计依据，webhook 投递失败可通过管理端重试。
  if (event === "member.left_group") {
    const account = String(payload.account || "").trim();
    const drawId = String(payload.drawId || "").trim();
    if (!account) return fail(c, "payload.account 不能为空", 400);
    if (!drawId) return fail(c, "payload.drawId 不能为空", 400);

    // 验证活动存在且属于该租户
    const [draw] = await db
      .select({ id: lotteryDraws.id, activityConfig: lotteryDraws.activityConfig })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, apiKey.tenantId)))
      .limit(1);
    if (!draw) return fail(c, "活动不存在", 404);

    // 计算波及名单
    const targets = await computePenaltyTargets(db, apiKey.tenantId, draw.id, account);
    if (!targets) {
      // 退群者没有参与记录，仍记录事件但不触发处罚
      await recordActivityEvent(db, {
        tenantId: apiKey.tenantId,
        drawId: draw.id,
        eventType: "ext:member.left_group",
        refCode: idempotencyKey,
        metadata: { ...payload, note: "no_entry_found" },
      });
      return ok(c, { handled: true, penaltyTriggered: false, reason: "退群者未参与此活动" });
    }

    // 将 entryId 列表转换为 identityValue（供 Webhook 负载使用）。
    // 为什么需要这一步？computePenaltyTargets 返回的是 entryId（UUID），
    // 但中转站需要人类可读的账号（邮箱/用户名）来定位用户和作废兑换码。
    // 这里做一次批量查询映射，避免在 Webhook payload 中暴露内部 UUID。
    //
    // penaltyEntryIds 可能包含重复 ID（退群者本人可能在 inviterEntryId 或 invitedEntryIds 中重复），
    // 但 Map 的 key 去重特性保证 identityMap 不会重复，inArray 查数据库也不会有问题。
    const penaltyEntryIds = [targets.leaverEntryId];
    if (targets.inviterEntryId) penaltyEntryIds.push(targets.inviterEntryId);
    penaltyEntryIds.push(...targets.invitedEntryIds);

    const entryRows = await db
      .select({ id: lotteryEntries.id, identityValue: lotteryEntries.identityValue })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, apiKey.tenantId),
        eq(lotteryEntries.drawId, draw.id),
        inArray(lotteryEntries.id, penaltyEntryIds),
      ));

    const identityMap = new Map(entryRows.map((e) => [e.id, e.identityValue]));
    const penaltyTargets = {
      leaver: identityMap.get(targets.leaverEntryId) || account,
      inviter: targets.inviterEntryId ? (identityMap.get(targets.inviterEntryId) || null) : null,
      invited: targets.invitedEntryIds.map((id) => identityMap.get(id)).filter(Boolean),
    };

    // 记录退群事件
    await recordActivityEvent(db, {
      tenantId: apiKey.tenantId,
      drawId: draw.id,
      entryId: targets.leaverEntryId,
      eventType: "ext:member.left_group",
      refCode: idempotencyKey,
      metadata: { ...payload, penaltyTargets },
    });

    // 记录处罚意图
    await recordActivityEvent(db, {
      tenantId: apiKey.tenantId,
      drawId: draw.id,
      entryId: targets.leaverEntryId,
      eventType: "penalty_requested",
      refCode: idempotencyKey,
      metadata: { penaltyTargets },
    });

    // 向中转站发送处罚 Webhook
    const webhookResult = await enqueueWebhookEvent(db, {
      tenantId: apiKey.tenantId,
      eventType: "penalty.requested",
      eventId: `pen_${idempotencyKey}`,
      data: {
        reason: "member.left_group",
        targets: penaltyTargets,
        leaverAccount: account,
        leftAt: payload.leftAt,
        groupId: payload.groupId,
        idempotencyKey,
      },
    });

    // 出站平台消息（QQ 群）：退群处罚通知。失败不影响处罚业务。
    void enqueuePlatformEvent(db, {
      tenantId: apiKey.tenantId,
      drawId: draw.id,
      eventType: "penalty.requested",
      data: {
        penaltyDetail: `退群成员 ${penaltyTargets.leaver} 已触发处理`
          + (payload.groupId ? `，群号 ${String(payload.groupId)}` : ""),
      },
    }).catch((err) => {
      logError("integration", "enqueuePlatformEvent penalty.requested failed", err);
    });

    return ok(c, {
      handled: true,
      penaltyTriggered: true,
      targets: {
        leaver: penaltyTargets.leaver,
        inviter: penaltyTargets.inviter,
        invitedCount: penaltyTargets.invited.length,
      },
      webhookDeliveryIds: webhookResult.deliveryIds,
    });

  // ── reward.redeemed：中转站回传兑换码核销确认（docs/114 §4） ──
  // 将 prizeCode 从 issued 标记为 redeemed，让 cf-lottery 知道"卡已被用"，
  // 退群处罚时可区分"发了没换"与"发了已换"（已核销的由中转站扣余额，不重复 revoked）。
  //
  // 幂等设计（为什么不是简单的 UPDATE）：
  // - 如果卡已被 revoked（退群收回），再次回传 redeemed 是无效操作——返回 redeemed=false，
  //   HTTP 200（不是 409/422），因为这是正常业务状态（退群先于核销），不是调用方错误。
  // - 如果卡已被 redeemed（重复回传），同样返回 redeemed=false，幂等。
  // - previousStatus 字段帮助中转站排查：是"被退群收回了"还是"已经核销过了"。
  //
  // 为什么不检查 drawId 一致性？reward.redeemed 是"卡密级别的操作"，不依赖活动上下文。
  // 卡密的归属（tenantId + prizeId）已在 importPrizeCodes 时确定，核销只需校验租户权限。
  } else if (event === "reward.redeemed") {
    const code = String(payload.code || "").trim();
    const prizeCodeId = String(payload.prizeCodeId || "").trim();
    if (!code && !prizeCodeId) return fail(c, "payload.code 或 payload.prizeCodeId 至少提供一个", 400);

    // 按 tenant + (id 或 code) 定位卡密
    const conditions = prizeCodeId
      ? and(eq(prizeCodes.tenantId, apiKey.tenantId), eq(prizeCodes.id, prizeCodeId))
      : and(eq(prizeCodes.tenantId, apiKey.tenantId), eq(prizeCodes.code, code));
    const [prizeCode] = await db
      .select({ id: prizeCodes.id, status: prizeCodes.status })
      .from(prizeCodes)
      .where(conditions)
      .limit(1);
    if (!prizeCode) return fail(c, "卡密不存在或不属于该租户", 404);

    let redeemed = false;
    if (prizeCode.status === "issued") {
      const result = await db.update(prizeCodes)
        .set({ status: "redeemed" })
        .where(and(
          eq(prizeCodes.id, prizeCode.id),
          eq(prizeCodes.tenantId, apiKey.tenantId),
          eq(prizeCodes.status, "issued"),
        ));
      redeemed = (result.rowsAffected ?? 0) > 0;
    }
    // 幂等：already redeemed 也返回成功，但标记 redeemed=false（未发生变更）

    await recordActivityEvent(db, {
      tenantId: apiKey.tenantId,
      drawId: String(payload.drawId || "").trim() || "",
      entryId: String(payload.entryId || "").trim() || "",
      eventType: "ext:reward.redeemed",
      refCode: idempotencyKey,
      metadata: { ...payload, prizeCodeId: prizeCode.id, previousStatus: prizeCode.status },
    });

    return ok(c, { handled: true, redeemed, prizeCodeId: prizeCode.id, previousStatus: prizeCode.status });

  // ── reward.issued / penalty.executed：仅记录事实 ──
  } else {
    await recordActivityEvent(db, {
      tenantId: apiKey.tenantId,
      drawId: String(payload.drawId || "").trim() || "",
      entryId: String(payload.entryId || "").trim() || "",
      eventType: `ext:${event}`,
      refCode: idempotencyKey,
      metadata: payload,
    });

    return ok(c, { handled: true, event });
  }
});
