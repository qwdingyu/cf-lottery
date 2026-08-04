/**
 * 外部集成路由。
 *
 * 这些接口面向租户自己的业务系统或第三方系统，使用租户 API Key 鉴权。
 * 外部成交、核销、注册等只能通过这里回传，不能由公开页点击或 UTM 推断。
 */
import { Hono, type Context } from "hono";
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
import {
  lotteryEntries,
  lotteryDraws,
  activityEvents,
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
// 外部事件入口（docs/111 §5 阶段二）
//
// 支持事件类型：
//   member.left_group — QQ 机器人上报退群，触发波及名单计算 + 处罚 Webhook
//   reward.issued     — 中转站回传发卡确认
//   penalty.executed  — 中转站回传处罚执行确认
//
// 鉴权：租户 API Key（与 /conversions 相同）
// 幂等：idempotencyKey 去重，防机器人重报
// ═════════════════════════════════════════════════════════

const INTEGRATION_EVENT_LIMIT = 60;  // 外部事件限流：60 次/分钟/API key
const INTEGRATION_EVENT_WINDOW_MS = 60000;

type IntegrationEventType = "member.left_group" | "reward.issued" | "penalty.executed";
const INTEGRATION_EVENT_TYPES = new Set<IntegrationEventType>([
  "member.left_group",
  "reward.issued",
  "penalty.executed",
]);

integrationRoute.post("/events", async (c) => {
  const db = getDb(c);
  const apiKey = await authenticateApiKey(db, readApiKey(c));
  if (!apiKey) return fail(c, "API Key 无效", 401);

  if (!(await checkDbRateLimit(db, `integration:${apiKey.id}`, INTEGRATION_EVENT_LIMIT, INTEGRATION_EVENT_WINDOW_MS))) {
    return fail(c, "调用过于频繁，请稍后再试", 429);
  }

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

  // ── 幂等：同一 API key 的同一 idempotencyKey 只处理一次 ──
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

  // ── 处理 member.left_group ──
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

    // 将 entryId 列表转换为 identityValue（供 Webhook 负载使用）
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
