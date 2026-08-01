/**
 * 抽奖服务层 — 核心业务逻辑。
 *
 * 【设计原则】
 * - 只操作抽奖相关表，不涉及电商概念（订单/支付/余额/返佣）
 * - 所有函数接受 tenant_id 参数，确保多租户数据隔离
 * - 开奖流程：随机抽取候选池 → 原子锁定奖品码 → 写入中奖记录 → 异步通知
 * - 不产生订单、不涉及支付、不扣余额
 *
 * 【状态机】
 *   draft → open → drawing → drawn
 *   open → paused → open
 *   draft/open/paused → cancelled
 *   drawing 失败 → open（记录 failureReason，禁止永久卡死）
 *
 * 【并发安全】
 * - 参与去重：UNIQUE(tenant_id, draw_id, identity_type, identity_value)
 * - 开奖防双发：CAS 更新 status（open → drawing）
 * - 邀请码防超发：条件 UPDATE WHERE used_count < max_uses
 * - 锁码防重：条件 UPDATE WHERE status = 'available'
 */
import { withDbTransaction, type DbType, type DbWriteScope } from "../db/client";
import { and, eq, count, inArray, sql } from "drizzle-orm";
import { buildLotteryWinnerTemplateData, sendEmail } from "./email-service";
import {
  lotteryDraws,          // 抽奖活动表
  lotteryEntries,        // 候选池表
  lotteryWinners,        // 中奖记录表
  prizes,                // 奖品表
  prizeCodes,            // 奖品码池表
  lotteryPrizeTiers,     // 多奖项配置表
  lotteryRosterMembers,  // 限定名单表
  lotteryInviteCodes,    // 邀请码表
  auditLogs,             // 审计日志表
  lotteryBlacklist,      // 参与者黑名单
  activityOutcomes,      // 接龙/预约等活动的统一结果
  tenants,               // SaaS 租户与套餐
  tenantMembers,         // 团队成员配额统计
  systemConfig,          // 系统配置（含动态套餐额度）
  apiKeys,               // 外部集成 API Key
  webhookConfigs,        // Webhook 配额统计
  webhookDeliveries,     // Webhook 投递生命周期
  activityEvents,        // 活动事件与导流漏斗
  shareRecords,          // 分享裂变归因
  externalConversions,   // 外部成交/核销/注册回传事实
} from "../db/schema";

/* ── 类型定义 ─────────────────────────────────────────────── */

/** 开奖结果 */
export type DrawResult = {
  drawId: string;        // 活动 ID
  winnerCount: number;   // 实际中奖人数
  candidateCount: number; // 候选池总人数
};

export type ActivityOutcome = {
  id: string;
  drawId: string;
  entryId: string;
  outcomeType: string;
  status: string;
  sequenceNo: number;
  assignmentNo: number | null;
  resultKey: string;
  resultLabel: string;
  metadataJson: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TenantPlanLimits = {
  plan: string;
  maxActivities: number | null;
  maxParticipantsPerActivity: number;
  maxMembers: number | null;
  maxWebhooks: number | null;
};

export type ActivityEventType =
  | "page_view"
  | "participation_started"
  | "participation_completed"
  | "outcome_assigned"
  | "cta_impression"
  | "cta_click"
  | "share_created"
  | "share_click"
  | "attributed_join"
  | "external_conversion_reported";

export type RecordActivityEventInput = {
  tenantId: string;
  drawId: string;
  entryId?: string;
  eventType: ActivityEventType;
  source?: string;
  medium?: string;
  campaign?: string;
  refCode?: string;
  metadata?: Record<string, unknown>;
  ipHash?: string;
  userAgent?: string;
};

export type WebhookEventType =
  | "draw.published"
  | "draw.completed"
  | "entry.created"
  | "outcome.assigned"
  | "prize.issued"
  | "share.created"
  | "share.clicked"
  | "activity.event.recorded";

export type EnqueueWebhookEventInput = {
  tenantId: string;
  eventType: WebhookEventType;
  data: Record<string, unknown>;
  eventId?: string;
};

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ExternalConversionType =
  | "registration"
  | "purchase"
  | "coupon_redeemed"
  | "lead_qualified"
  | "offline_redeemed"
  | "custom";

export type RecordExternalConversionInput = {
  tenantId: string;
  drawId?: string;
  publicSlug?: string;
  externalEventId: string;
  conversionType: ExternalConversionType;
  source?: string;
  entryId?: string;
  identityType?: string;
  identityValue?: string;
  refCode?: string;
  amountCents?: number | null;
  currency?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
};

const ACTIVITY_EVENT_TYPES = new Set<ActivityEventType>([
  "page_view",
  "participation_started",
  "participation_completed",
  "outcome_assigned",
  "cta_impression",
  "cta_click",
  "share_created",
  "share_click",
  "attributed_join",
  "external_conversion_reported",
]);

const WEBHOOK_EVENT_TYPES = new Set<WebhookEventType>([
  "draw.published",
  "draw.completed",
  "entry.created",
  "outcome.assigned",
  "prize.issued",
  "share.created",
  "share.clicked",
  "activity.event.recorded",
]);

const EXTERNAL_CONVERSION_TYPES = new Set<ExternalConversionType>([
  "registration",
  "purchase",
  "coupon_redeemed",
  "lead_qualified",
  "offline_redeemed",
  "custom",
]);

const DEFAULT_ACTIVITY_PARTICIPANT_CAP = 5000;

const PLAN_LIMITS: Record<string, Omit<TenantPlanLimits, "plan">> = {
  free: {
    maxActivities: 10,
    maxParticipantsPerActivity: 200,
    maxMembers: 2,
    maxWebhooks: 0,
  },
  pro: {
    maxActivities: 200,
    maxParticipantsPerActivity: 5000,
    maxMembers: 10,
    maxWebhooks: 3,
  },
  team: {
    maxActivities: 1000,
    maxParticipantsPerActivity: 20000,
    maxMembers: 50,
    maxWebhooks: 10,
  },
  enterprise: {
    maxActivities: null,
    maxParticipantsPerActivity: 100000,
    maxMembers: null,
    maxWebhooks: null,
  },
};

export function getTenantPlanLimits(plan?: string | null): TenantPlanLimits {
  const normalized = String(plan || "free").trim().toLowerCase();
  const limits = PLAN_LIMITS[normalized] || PLAN_LIMITS.free!;
  return { plan: PLAN_LIMITS[normalized] ? normalized : "free", ...limits };
}

/**
 * 系统配置中套餐额度相关 key 的列表。
 * 平台运营者可在 /platform/config 页面修改这些值，动态覆盖硬编码的 PLAN_LIMITS。
 */
const PLAN_LIMITS_CONFIG_KEYS: string[] = [
  "plan_free_max_activities",
  "plan_free_max_participants_per_activity",
  "plan_pro_max_activities",
  "plan_pro_max_participants_per_activity",
  "plan_team_max_activities",
  "plan_team_max_participants_per_activity",
  "plan_enterprise_max_activities",
  "plan_enterprise_max_participants_per_activity",
] as const;

/**
 * 从 system_config 表读取动态套餐额度配置，与硬编码 PLAN_LIMITS 合并。
 * 读取 system_config 是后台管理/配额校验操作，当前不在公开参与热路径。
 * max_activities 的 0 表示不限（对应 null）；单活动参与上限必须大于 0。
 * 未配置或非法的套餐项继续使用 PLAN_LIMITS 默认值。
 */
async function loadDynamicPlanLimits(db: DbType): Promise<Record<string, Omit<TenantPlanLimits, "plan">>> {
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, PLAN_LIMITS_CONFIG_KEYS));

  const configMap: Record<string, string> = {};
  for (const row of rows) {
    configMap[row.key] = row.value;
  }

  // 深拷贝硬编码默认值
  const merged: Record<string, Omit<TenantPlanLimits, "plan">> = {};
  for (const [planName, planValues] of Object.entries(PLAN_LIMITS)) {
    merged[planName] = { ...planValues };
  }

  // 用系统配置中的值覆盖（如果存在且有效）
  for (const planName of ["free", "pro", "team", "enterprise"] as const) {
    const maxActivitiesVal = configMap[`plan_${planName}_max_activities`];
    const maxParticipantsVal = configMap[`plan_${planName}_max_participants_per_activity`];

    if (maxActivitiesVal !== undefined && merged[planName]) {
      const parsed = parseInt(maxActivitiesVal, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        merged[planName].maxActivities = parsed === 0 ? null : parsed;
      }
    }
    if (maxParticipantsVal !== undefined && merged[planName]) {
      const parsed = parseInt(maxParticipantsVal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        merged[planName].maxParticipantsPerActivity = parsed;
      }
    }
  }

  return merged;
}

export async function getTenantUsage(db: DbType, tenantId: string) {
  // 读取动态套餐额度配置（平台运营者在 /platform/config 中设置），覆盖硬编码默认值。
  const dynamicPlanLimits = await loadDynamicPlanLimits(db);
  // 查询租户信息，含兑换码购买的额外额度
  const [tenant] = await db
    .select({
      plan: tenants.plan,
      extraActivityQuota: tenants.extraActivityQuota,
      extraParticipantQuota: tenants.extraParticipantQuota,
      extraQuotaExpiresAt: tenants.extraQuotaExpiresAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const rawPlan = String(tenant?.plan || "free").trim().toLowerCase();
  const plan = PLAN_LIMITS[rawPlan] ? rawPlan : "free";
  // 优先使用动态套餐额度（平台运营者在 /platform/config 中设置），兜底用硬编码默认值。
  const dynamicPlan = dynamicPlanLimits[plan] || PLAN_LIMITS[plan] || PLAN_LIMITS.free!;
  const limits: TenantPlanLimits = { plan, ...dynamicPlan };

  const [{ total: activityCount }] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.tenantId, tenantId),
      sql`${lotteryDraws.status} <> 'cancelled'`,
    ));

  const [{ total: memberCount }] = await db
    .select({ total: count() })
    .from(tenantMembers)
    .where(eq(tenantMembers.tenantId, tenantId));

  const [{ total: webhookCount }] = await db
    .select({ total: count() })
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, 1)));

  // 兑换码额外额度仅在有效期内生效
  const extraValid = tenant?.extraQuotaExpiresAt ? new Date() < new Date(tenant.extraQuotaExpiresAt) : false;
  const extraActivities = extraValid ? (tenant?.extraActivityQuota || 0) : 0;
  const extraParticipants = extraValid ? (tenant?.extraParticipantQuota || 0) : 0;

  // 返回有效额度 = 套餐基础额度 + 兑换码额外额度（未过期）
  return {
    plan: limits.plan,
    limits: {
      ...limits,
      maxActivities: limits.maxActivities !== null ? limits.maxActivities + extraActivities : null,
      maxParticipantsPerActivity: limits.maxParticipantsPerActivity + extraParticipants,
    },
    usage: {
      activities: Number(activityCount || 0),
      members: Number(memberCount || 0),
      webhooks: Number(webhookCount || 0),
    },
  };
}

async function enforceTenantActivityQuota(
  db: DbType,
  tenantId: string,
  requestedMaxParticipants?: number,
) {
  const usage = await getTenantUsage(db, tenantId);
  if (usage.limits.maxActivities !== null && usage.usage.activities >= usage.limits.maxActivities) {
    throw new Error(`当前套餐最多可保留 ${usage.limits.maxActivities} 个活动，请升级套餐或删除草稿活动`);
  }

  if (requestedMaxParticipants !== undefined && requestedMaxParticipants > usage.limits.maxParticipantsPerActivity) {
    throw new Error(`当前套餐单活动最多允许 ${usage.limits.maxParticipantsPerActivity} 人参与，请降低名额或升级套餐`);
  }

  return usage.limits;
}

export async function recordActivityEvent(db: DbWriteScope, input: RecordActivityEventInput) {
  if (!ACTIVITY_EVENT_TYPES.has(input.eventType)) {
    throw new Error("活动事件类型无效");
  }

  const id = crypto.randomUUID();
  await db.insert(activityEvents).values({
    id,
    tenantId: input.tenantId,
    drawId: input.drawId,
    entryId: truncateForEvent(input.entryId || "", 80),
    eventType: input.eventType,
    source: truncateForEvent(input.source || "", 100),
    medium: truncateForEvent(input.medium || "", 100),
    campaign: truncateForEvent(input.campaign || "", 160),
    refCode: truncateForEvent(input.refCode || "", 80),
    metadataJson: JSON.stringify(input.metadata || {}),
    ipHash: truncateForEvent(input.ipHash || "", 128),
    userAgent: truncateForEvent(input.userAgent || "", 300),
    createdAt: new Date().toISOString(),
  });
  return { id };
}

export async function getActivityEventSummary(db: DbType, tenantId: string, drawId: string) {
  const rows = await db
    .select({ eventType: activityEvents.eventType, total: count() })
    .from(activityEvents)
    .where(and(eq(activityEvents.tenantId, tenantId), eq(activityEvents.drawId, drawId)))
    .groupBy(activityEvents.eventType);

  const totals: Record<string, number> = {};
  for (const row of rows) {
    totals[row.eventType] = Number(row.total || 0);
  }

  return {
    totals,
    pageViews: totals.page_view || 0,
    participationCompleted: totals.participation_completed || 0,
    ctaClicks: totals.cta_click || 0,
    shareClicks: totals.share_click || 0,
    attributedJoins: totals.attributed_join || 0,
    externalConversionsReported: totals.external_conversion_reported || 0,
  };
}

export async function authenticateApiKey(db: DbType, rawKey: string) {
  const key = String(rawKey || "").trim();
  if (!key) return null;

  const [row] = await db
    .select({ id: apiKeys.id, tenantId: apiKeys.tenantId, name: apiKeys.name })
    .from(apiKeys)
    .where(and(eq(apiKeys.key, key), eq(apiKeys.active, 1)))
    .limit(1);

  return row || null;
}

export async function recordExternalConversion(db: DbType, input: RecordExternalConversionInput) {
  if (!EXTERNAL_CONVERSION_TYPES.has(input.conversionType)) {
    throw new Error("外部转化类型无效");
  }
  const externalEventId = truncateForEvent(String(input.externalEventId || "").trim(), 160);
  if (!externalEventId) throw new Error("缺少外部事件 ID");

  const source = truncateForEvent(String(input.source || "api").trim() || "api", 80);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new Error("外部转化时间无效");
  const amountCents = input.amountCents === null || input.amountCents === undefined
    ? null
    : Math.max(0, Math.trunc(Number(input.amountCents)));
  const currency = truncateForEvent(String(input.currency || "").trim().toUpperCase(), 12);

  return withDbTransaction(db, async (tx) => {
    const [draw] = await tx
      .select({ id: lotteryDraws.id, publicSlug: lotteryDraws.publicSlug })
      .from(lotteryDraws)
      .where(and(
        eq(lotteryDraws.tenantId, input.tenantId),
        input.drawId
          ? eq(lotteryDraws.id, input.drawId)
          : eq(lotteryDraws.publicSlug, String(input.publicSlug || "")),
      ))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    const [existing] = await tx
      .select()
      .from(externalConversions)
      .where(and(
        eq(externalConversions.tenantId, input.tenantId),
        eq(externalConversions.source, source),
        eq(externalConversions.externalEventId, externalEventId),
      ))
      .limit(1);
    if (existing) {
      return { created: false, conversion: existing };
    }

    const normalizedIdentityType = truncateForEvent(String(input.identityType || "").trim().toLowerCase(), 32);
    const normalizedIdentityValue = truncateForEvent(String(input.identityValue || "").trim().toLowerCase(), 200);
    let entryId = truncateForEvent(String(input.entryId || "").trim(), 80);
    if (entryId) {
      const [entry] = await tx
        .select({ id: lotteryEntries.id })
        .from(lotteryEntries)
        .where(and(
          eq(lotteryEntries.tenantId, input.tenantId),
          eq(lotteryEntries.drawId, draw.id),
          eq(lotteryEntries.id, entryId),
        ))
        .limit(1);
      if (!entry) throw new Error("参与记录不存在");
    } else if (normalizedIdentityValue) {
      const [entry] = await tx
        .select({ id: lotteryEntries.id })
        .from(lotteryEntries)
        .where(and(
          eq(lotteryEntries.tenantId, input.tenantId),
          eq(lotteryEntries.drawId, draw.id),
          eq(lotteryEntries.identityValue, normalizedIdentityValue),
        ))
        .limit(1);
      entryId = entry?.id || "";
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const conversion = {
      id,
      tenantId: input.tenantId,
      drawId: draw.id,
      entryId,
      externalEventId,
      conversionType: input.conversionType,
      source,
      refCode: truncateForEvent(String(input.refCode || "").trim(), 80),
      amountCents,
      currency,
      identityType: normalizedIdentityType,
      identityValue: normalizedIdentityValue,
      payloadJson: jsonStringifyLimited(input.payload || {}, 10000),
      occurredAt: occurredAt.toISOString(),
      createdAt: now,
    };
    await tx.insert(externalConversions).values(conversion);

    await recordActivityEvent(tx, {
      tenantId: input.tenantId,
      drawId: draw.id,
      entryId,
      eventType: "external_conversion_reported",
      source,
      refCode: conversion.refCode,
      metadata: {
        conversionId: id,
        conversionType: input.conversionType,
        externalEventId,
        amountCents,
        currency,
      },
    });

    return { created: true, conversion };
  });
}

export async function listExternalConversions(
  db: DbType,
  tenantId: string,
  drawId: string,
  limit = 50,
  offset = 0,
) {
  return db
    .select()
    .from(externalConversions)
    .where(and(eq(externalConversions.tenantId, tenantId), eq(externalConversions.drawId, drawId)))
    .orderBy(externalConversions.createdAt)
    .limit(Math.max(1, Math.min(200, limit)))
    .offset(Math.max(0, offset));
}

export async function getExternalConversionSummary(db: DbType, tenantId: string, drawId: string) {
  const rows = await db
    .select({
      conversionType: externalConversions.conversionType,
      total: count(),
      amountCents: sql<number>`coalesce(sum(${externalConversions.amountCents}), 0)`,
    })
    .from(externalConversions)
    .where(and(eq(externalConversions.tenantId, tenantId), eq(externalConversions.drawId, drawId)))
    .groupBy(externalConversions.conversionType);

  const totals: Record<string, { count: number; amountCents: number }> = {};
  let totalCount = 0;
  let totalAmountCents = 0;
  for (const row of rows) {
    const countValue = Number(row.total || 0);
    const amountValue = Number(row.amountCents || 0);
    totals[row.conversionType] = { count: countValue, amountCents: amountValue };
    totalCount += countValue;
    totalAmountCents += amountValue;
  }

  return { totalCount, totalAmountCents, totals };
}

export function createWebhookSigningSecret(): string {
  return `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function enqueueWebhookEvent(db: DbType, input: EnqueueWebhookEventInput) {
  if (!WEBHOOK_EVENT_TYPES.has(input.eventType)) {
    throw new Error("Webhook 事件类型无效");
  }

  const configs = await db
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, input.tenantId), eq(webhookConfigs.active, 1)));

  const eventId = input.eventId || `evt_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();
  const payload = {
    id: eventId,
    type: input.eventType,
    createdAt: now,
    tenantId: input.tenantId,
    data: input.data,
  };
  const payloadJson = JSON.stringify(payload);
  const deliveryIds: string[] = [];

  for (const config of configs) {
    if (!webhookConfigAcceptsEvent(config.events, input.eventType)) continue;

    let signingSecret = config.signingSecret || "";
    if (!signingSecret) {
      signingSecret = createWebhookSigningSecret();
      await db
        .update(webhookConfigs)
        .set({ signingSecret, updatedAt: now })
        .where(and(eq(webhookConfigs.id, config.id), eq(webhookConfigs.tenantId, input.tenantId)));
    }

    const deliveryId = crypto.randomUUID();
    const signature = await signWebhookPayload(signingSecret, now, payloadJson);
    const [existingDelivery] = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.webhookConfigId, config.id), eq(webhookDeliveries.eventId, eventId)))
      .limit(1);
    if (existingDelivery) continue;

    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      tenantId: input.tenantId,
      webhookConfigId: config.id,
      eventId,
      eventType: input.eventType,
      url: config.url,
      payloadJson,
      signature,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    deliveryIds.push(deliveryId);
  }

  return { eventId, deliveryIds };
}

export async function dispatchWebhookDelivery(
  db: DbType,
  tenantId: string,
  deliveryId: string,
  fetcher: WebhookFetch = fetch,
) {
  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.tenantId, tenantId)))
    .limit(1);
  if (!delivery) throw new Error("Webhook 投递记录不存在");
  if (delivery.status === "sent") return { delivered: true, status: "sent" };

  const now = new Date().toISOString();
  const attempt = delivery.attemptCount + 1;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const [config] = await db
    .select({ signingSecret: webhookConfigs.signingSecret })
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.id, delivery.webhookConfigId), eq(webhookConfigs.tenantId, tenantId)))
    .limit(1);
  const signature = await signWebhookPayload(config?.signingSecret || "", timestamp, delivery.payloadJson);

  try {
    const response = await fetcher(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "cf-lottery-webhook/1.0",
        "X-CF-Lottery-Event": delivery.eventType,
        "X-CF-Lottery-Event-Id": delivery.eventId,
        "X-CF-Lottery-Timestamp": timestamp,
        "X-CF-Lottery-Signature": signature,
      },
      body: delivery.payloadJson,
    });
    const responseText = truncateForEvent(await response.text().catch(() => ""), 1000);
    const sent = response.status >= 200 && response.status < 300;
    const failedNextRetry = sent ? null : nextWebhookRetryAt(attempt);
    await db
      .update(webhookDeliveries)
      .set({
        status: sent ? "sent" : "failed",
        attemptCount: attempt,
        nextRetryAt: failedNextRetry,
        responseStatus: response.status,
        responseBody: responseText,
        lastError: sent ? "" : `HTTP ${response.status}`,
        signature,
        sentAt: sent ? now : null,
        updatedAt: now,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.tenantId, tenantId)));
    await updateWebhookConfigDeliveryState(db, tenantId, delivery.webhookConfigId, sent ? "" : `HTTP ${response.status}`);
    return { delivered: sent, status: sent ? "sent" : "failed", responseStatus: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "Webhook 投递失败";
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        attemptCount: attempt,
        nextRetryAt: nextWebhookRetryAt(attempt),
        lastError: message,
        signature,
        updatedAt: now,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.tenantId, tenantId)));
    await updateWebhookConfigDeliveryState(db, tenantId, delivery.webhookConfigId, message);
    return { delivered: false, status: "failed", error: message };
  }
}

export async function processPendingWebhookDeliveries(
  db: DbType,
  tenantId: string,
  fetcher: WebhookFetch = fetch,
  limit = 20,
) {
  const now = new Date().toISOString();
  const deliveries = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(
      eq(webhookDeliveries.tenantId, tenantId),
      sql`${webhookDeliveries.status} <> 'sent'`,
      sql`(${webhookDeliveries.nextRetryAt} IS NULL OR ${webhookDeliveries.nextRetryAt} <= ${now})`,
      sql`${webhookDeliveries.attemptCount} < 5`,
    ))
    .limit(Math.max(1, Math.min(50, limit)));

  let sent = 0;
  let failed = 0;
  for (const delivery of deliveries) {
    const result = await dispatchWebhookDelivery(db, tenantId, delivery.id, fetcher);
    if (result.delivered) sent++;
    else failed++;
  }
  return { processed: deliveries.length, sent, failed };
}

export async function processPendingWebhookDeliveriesForAllTenants(
  db: DbType,
  fetcher: WebhookFetch = fetch,
  options?: { tenantLimit?: number; perTenantLimit?: number },
) {
  const now = new Date().toISOString();
  const tenantLimit = Math.max(1, Math.min(100, options?.tenantLimit ?? 25));
  const perTenantLimit = Math.max(1, Math.min(50, options?.perTenantLimit ?? 20));
  const rows = await db
    .select({ tenantId: webhookDeliveries.tenantId })
    .from(webhookDeliveries)
    .where(and(
      sql`${webhookDeliveries.status} <> 'sent'`,
      sql`(${webhookDeliveries.nextRetryAt} IS NULL OR ${webhookDeliveries.nextRetryAt} <= ${now})`,
      sql`${webhookDeliveries.attemptCount} < 5`,
    ))
    .orderBy(webhookDeliveries.createdAt)
    .limit(tenantLimit * perTenantLimit);

  const tenantIds = Array.from(new Set(rows.map((row) => row.tenantId))).slice(0, tenantLimit);
  const tenantsProcessed: Array<{ tenantId: string; processed: number; sent: number; failed: number }> = [];
  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    const result = await processPendingWebhookDeliveries(db, tenantId, fetcher, perTenantLimit);
    tenantsProcessed.push({ tenantId, ...result });
    processed += result.processed;
    sent += result.sent;
    failed += result.failed;
  }

  return {
    tenantCount: tenantIds.length,
    processed,
    sent,
    failed,
    tenants: tenantsProcessed,
  };
}

export async function listWebhookDeliveries(
  db: DbType,
  tenantId: string,
  limit = 50,
  offset = 0,
) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.tenantId, tenantId))
    .orderBy(webhookDeliveries.createdAt)
    .limit(Math.max(1, Math.min(200, limit)))
    .offset(Math.max(0, offset));
}

function truncateForEvent(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function jsonStringifyLimited(value: Record<string, unknown>, max: number): string {
  const text = JSON.stringify(value || {});
  return text.length > max ? text.slice(0, max) : text;
}

function webhookConfigAcceptsEvent(eventsJson: string, eventType: WebhookEventType): boolean {
  try {
    const events = JSON.parse(eventsJson);
    return Array.isArray(events) && (events.includes("*") || events.includes(eventType));
  } catch {
    return false;
  }
}

async function signWebhookPayload(secret: string, timestamp: string, payloadJson: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = encoder.encode(`${timestamp}.${payloadJson}`);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const hex = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v1=${hex}`;
}

function nextWebhookRetryAt(attempt: number): string | null {
  if (attempt >= 5) return null;
  const delaySeconds = Math.min(3600, 60 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

async function updateWebhookConfigDeliveryState(
  db: DbType,
  tenantId: string,
  webhookConfigId: string,
  lastError: string,
) {
  await db
    .update(webhookConfigs)
    .set({ lastSentAt: new Date().toISOString(), lastError, updatedAt: new Date().toISOString() })
    .where(and(eq(webhookConfigs.id, webhookConfigId), eq(webhookConfigs.tenantId, tenantId)));
}

/* ── 内部工具 ─────────────────────────────────────────────── */

/**
 * Fisher-Yates 洗牌算法，使用 CSPRNG（crypto.getRandomValues）。
 * 从候选数组中随机抽取指定数量的元素，保证等概率。
 *
 * 为什么不使用 Math.random()：
 * Math.random() 是伪随机数生成器，可预测且不安全。
 * crypto.getRandomValues() 是密码学安全的随机数生成器，适合抽奖等公平性场景。
 */
export async function randomSelect<T>(candidates: T[], count: number): Promise<T[]> {
  // 实际抽取数量不超过候选池大小
  const n = Math.min(count, candidates.length);
  if (n <= 0) return [];

  // 复制候选数组，避免修改原数组
  const result = [...candidates];
  // Fisher-Yates 洗牌：从后往前，每次随机交换一个元素
  for (let i = result.length - 1; i > 0; i--) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    // 取模运算产生 0 到 i 之间的随机索引
    const j = random[0]! % (i + 1);
    // 交换 result[i] 和 result[j]
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }

  // 洗牌后取前 n 个作为中奖者
  return result.slice(0, n);
}

/* ── 密码工具 ────────────────────────────────────────────── */

/**
 * 对访问密码做 SHA-256 hash。
 * 避免在数据库中明文存储密码。
 */
export async function hashAccessPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ── 查询函数 ────────────────────────────────────────────── */

/**
 * 查询单个活动（带租户隔离）。
 * 返回 null 表示活动不存在或不属于该租户。
 */
export async function getDraw(db: DbType, drawId: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  return row || null;
}

/**
 * 获取候选池总数（不含租户隔离，用于公开页展示）。
 */
export async function getDrawEntriesCount(db: DbType, drawId: string, tenantId?: string): Promise<number> {
  const conditions = [eq(lotteryEntries.drawId, drawId)];
  if (tenantId) conditions.push(eq(lotteryEntries.tenantId, tenantId));
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(and(...conditions));
  return Number(total);
}

/**
 * 获取中奖记录（带租户隔离）。
 */
export async function getDrawWinners(db: DbType, drawId: string, tenantId: string) {
  return db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));
}

/* ── 活动管理 ────────────────────────────────────────────── */

/**
 * 创建抽奖活动。
 *
 * 校验规则：
 * - 参与开始时间必须早于结束时间
 * - 定时开奖必须设置开奖时间
 * - 开奖时间必须在参与结束后
 * - 中奖名额至少为 1
 *
 * 生成的 public_slug 取 UUID 前 8 位，用于公开活动链接。
 * 不可枚举，防止遍历活动 ID。
 */
export async function createDraw(
  db: DbType,
  tenantId: string,
  data: {
    title: string;
    description?: string;
    activityKind?: string;         // 活动类型：lottery/signup_chain/reservation...
    participationMode?: string;   // 参与模式：open/roster/password/invite_code
    experienceType?: string;       // 前端体验：wheel/slot/scratch/card/submit...
    drawTrigger?: string;          // 开奖触发：manual/scheduled
    resultMode?: string;           // 结果模式：manual/scheduled/instant/ordered_assignment...
    allocationPolicy?: string;     // 分配策略：capacity/waitlist/fifo/priority...
    policyVersion?: number;        // 规则版本，便于后续活动引擎演进
    startAt: string;               // 参与开始时间（ISO 8601）
    endAt: string;                 // 参与结束时间（ISO 8601）
    drawAt?: string;               // 定时开奖时间（ISO 8601）
    accessPassword?: string;       // 密码模式下的访问密码（明文，存储时需 hash）
    maxParticipants?: number;      // 最大参与人数（null=不限）
    winnerCount?: number;          // 中奖人数
    showParticipantCount?: number; // 是否公开参与人数（0/1）
    showWinnerCount?: number;      // 是否公开中奖人数（0/1）
    showWinnerList?: number;       // 是否公开中奖名单（0/1）
    productLink?: string;          // 旧导流配置，JSON 字符串
    promotionConfig?: string;      // 活动引擎导流配置，JSON 字符串
  },
) {
  const requestedMaxParticipants = data.maxParticipants ? Number(data.maxParticipants) : undefined;
  const planLimits = await enforceTenantActivityQuota(db, tenantId, requestedMaxParticipants);
  const activityKind = data.activityKind || "lottery";
  const drawTrigger = data.drawTrigger || "manual";
  const winnerCount = normalizeWinnerCount(activityKind, data.winnerCount);

  // 校验参与时间合法性
  const start = new Date(data.startAt);
  const end = new Date(data.endAt);
  if (start >= end) throw new Error("参与开始时间必须早于结束时间");

  // 定时开奖必须设置开奖时间
  if (drawTrigger === "scheduled" && !data.drawAt) {
    throw new Error("定时开奖必须设置开奖时间");
  }

  // 开奖时间必须在参与结束后
  if (data.drawAt) {
    const draw = new Date(data.drawAt);
    if (end >= draw) throw new Error("开奖时间必须在参与结束后");
  }

  // 只有抽奖类活动要求中奖名额；接龙、问卷、预约等不应被 winner 语义绑住。
  if (requiresWinnerCount(activityKind) && winnerCount < 1) {
    throw new Error("中奖名额至少为 1");
  }

  const id = crypto.randomUUID();
  // 取 UUID 前 8 位作为公开链接 slug，不可枚举
  const publicSlug = crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const experienceType = data.experienceType || defaultExperienceForActivity(activityKind, data.participationMode || "open");
  const resultMode = data.resultMode || defaultResultModeForActivity(activityKind, drawTrigger);

  await db.insert(lotteryDraws).values({
    id,
    tenantId,
    publicSlug,
    title: data.title,
    description: data.description || "",
    activityKind,
    participationMode: data.participationMode || "open",
    experienceType,
    drawTrigger,
    resultMode,
    allocationPolicy: data.allocationPolicy || (activityKind === "signup_chain" ? "capacity" : "capacity"),
    policyVersion: data.policyVersion || 1,
    startAt: data.startAt,
    endAt: data.endAt,
    drawAt: data.drawAt || null,
    accessPassword: data.accessPassword ? await hashAccessPassword(data.accessPassword) : "",
    maxParticipants: requestedMaxParticipants || Math.min(DEFAULT_ACTIVITY_PARTICIPANT_CAP, planLimits.maxParticipantsPerActivity),
    winnerCount,
    showParticipantCount: data.showParticipantCount ?? 1,
    showWinnerCount: data.showWinnerCount ?? 1,
    showWinnerList: data.showWinnerList ?? 0,
    productLink: data.productLink || "{}",
    promotionConfig: data.promotionConfig || "{}",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  return { id, publicSlug };
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === "signup_chain") return "list";
  if (activityKind === "reservation") return "calendar";
  if (activityKind === "vote") return "ballot";
  if (activityKind === "survey") return "form";
  if (activityKind === "checkin") return "checkin";
  if (activityKind === "waitlist") return "queue";
  if (activityKind === "approval") return "form";
  if (activityKind === "claim") return "reveal";
  return defaultExperienceForParticipation(participationMode);
}

/**
 * 根据活动类型和开奖触发方式计算默认结果模式。
 *
 * 这是活动引擎的规则入口：不同 activity_kind 对应不同的结果分配方式。
 * 抽奖类默认 manual（管理员手动开奖）或 scheduled（定时开奖）；
 * 接龙类默认 ordered_assignment（按报名顺序分配）；
 * 问卷/签到类默认 no_result（无结果分配）。
 *
 * 该函数同时被 lottery-service（创建活动）和 admin-lottery（路由层校验）使用，
 * 因此导出为公共函数，避免两处维护不同步。
 */
export function defaultResultModeForActivity(activityKind: string, drawTrigger: string): string {
  if (activityKind === "signup_chain") return "ordered_assignment";
  if (activityKind === "reservation") return "capacity_assignment";
  if (activityKind === "vote") return "vote_tally";
  if (activityKind === "survey") return "no_result";
  if (activityKind === "checkin") return "no_result";
  if (activityKind === "waitlist") return "ordered_assignment";
  if (activityKind === "approval") return "review_decision";
  if (activityKind === "claim") return "instant";
  if (activityKind === "assignment") return "ordered_assignment";
  return drawTrigger === "scheduled" ? "scheduled" : "manual";
}

function requiresWinnerCount(activityKind: string): boolean {
  return activityKind === "lottery";
}

function normalizeWinnerCount(activityKind: string, winnerCount?: number): number {
  if (!requiresWinnerCount(activityKind)) return winnerCount ?? 0;
  return winnerCount ?? 1;
}

/**
 * 发布活动（draft → open）。
 *
 * 发布前二次校验：
 * - 标题不能为空
 * - 活动时间必须设置
 * - 定时开奖必须设置开奖时间
 *
 * 使用 CAS 更新（WHERE status = 'draft'），防止并发发布。
 */
export async function publishDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有草稿状态可以发布
  if (draw.status !== "draft") throw new Error("只有草稿状态的活动才能发布");

  // 发布前二次校验（创建时已校验，但发布前再次确认）
  if (!draw.title) throw new Error("活动标题不能为空");
  if (!draw.startAt || !draw.endAt) throw new Error("请设置活动时间");
  if (draw.drawTrigger === "scheduled" && !draw.drawAt) throw new Error("定时开奖必须设置开奖时间");

  // CAS 更新：条件为 status = 'draft'，防止并发发布
  const result = await db
    .update(lotteryDraws)
    .set({ status: "open", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "draft")));

  return (result.rowsAffected ?? 0) > 0;
}

/**
 * 暂停活动（open → paused）
 */
export async function pauseDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const result = await db
    .update(lotteryDraws)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * 恢复活动（paused → open）
 */
export async function resumeDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const result = await db
    .update(lotteryDraws)
    .set({ status: "open", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "paused")));
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * 取消活动（draft/open/paused → cancelled）。
 * 已开奖或开奖中的活动不可取消。
 */
export async function cancelDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 已开奖或开奖中的活动不可取消，防止数据不一致
  if (draw.status === "drawn" || draw.status === "drawing") {
    throw new Error("已开奖或开奖中的活动不可取消");
  }

  const result = await db
    .update(lotteryDraws)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

  return (result.rowsAffected ?? 0) > 0;
}

/* ── 候选池 ───────────────────────────────────────────────── */

/**
 * 加入候选池。
 *
 * 支持四种参与模式：
 * - open（公开）：任何人都可参与，无需额外验证
 * - roster（名单）：检查参与者是否在预置名单中
 * - password（密码）：需要输入正确的访问密码
 * - invite_code（邀请码）：需要输入有效的邀请码（CAS 扣减使用次数）
 *
 * 通用校验：
 * - 活动必须处于 open 状态
 * - 参与时间必须在活动时间窗口内
 * - 不超过最大参与人数上限
 * - 同一身份不可重复参与（UNIQUE 约束）
 * - 签到活动例外：同一身份每天可签到一次（identity_value 附加日期后缀）
 */
export async function joinDraw(
  db: DbType,
  slug: string,                    // 活动公开链接 slug
  identityValue: string,           // 参与者身份标识（邮箱/手机号）
  identityType: string = "email",  // 身份类型
  options?: {
    accessPassword?: string;       // 密码模式下的访问密码
    inviteCode?: string;           // 邀请码模式下的邀请码
    ipHash?: string;               // 参与者 IP hash（用于轻量防刷）
    refCode?: string;              // 分享码。只有成功入库的新参与才计为有效邀请。
    userAgent?: string;
  },
) {
  // 通过 public_slug 查找活动（不暴露活动 ID）
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有 open 状态的活动可以参与（draft/paused/drawing/drawn/cancelled 均不可参与）
  if (draw.status !== "open") throw new Error("活动未开启");

  // ── 身份标识归一化 ──
  // 统一转小写去空格，确保同一邮箱的不同写法被识别为同一身份
  let normalizedValue = identityValue.trim().toLowerCase();

  // ── 签到活动特殊处理 ──
  // 签到活动（checkin）允许同一人每天签到一次，但 UNIQUE(tenant_id,draw_id,identity_type,identity_value)
  // 约束会阻止同一天重复签到。解决方案：identity_value 附加日期后缀（如 "user@test.com:2026-08-01"），
  // 使每天生成不同的 identity_value，既允许每日签到，又防止同一天重复。
  // 注意：黑名单和名单模式使用原始 value 做校验，只有写入时使用日期后缀 value。
  const checkinDateSuffix = draw.activityKind === "checkin" ? `:${new Date().toISOString().slice(0, 10)}` : "";
  const uniqueValue = normalizedValue + checkinDateSuffix;
  const [banned] = await db
    .select({ id: lotteryBlacklist.id })
    .from(lotteryBlacklist)
    .where(and(eq(lotteryBlacklist.tenantId, draw.tenantId), eq(lotteryBlacklist.identityValue, normalizedValue)))
    .limit(1);
  if (banned) {
    return { joined: false, message: "您已被限制参与此活动" };
  }

  // ── 参与模式校验 ──

  // 名单模式：检查参与者是否在预置名单中
  if (draw.participationMode === "roster") {
    const [member] = await db
      .select({ id: lotteryRosterMembers.id })
      .from(lotteryRosterMembers)
      .where(and(
        eq(lotteryRosterMembers.drawId, draw.id),
        eq(lotteryRosterMembers.identityValue, normalizedValue),
      ))
      .limit(1);
    if (!member) {
      return { joined: false, message: "您不在参与名单中" };
    }
  }

  // 密码模式：校验访问密码（hash 比较）
  if (draw.participationMode === "password") {
    if (!options?.accessPassword) {
      return { joined: false, message: "请输入访问密码" };
    }
    // 对输入的密码做 SHA-256 hash 后与存储的 hash 比较
    const inputHash = await hashAccessPassword(options.accessPassword);
    if (inputHash !== draw.accessPassword) {
      return { joined: false, message: "访问密码错误" };
    }
  }

  if (draw.participationMode === "invite_code" && !options?.inviteCode) {
    return { joined: false, message: "请输入邀请码" };
  }

  // ── 参与时间校验 ──
  const now = new Date();
  if (now < new Date(draw.startAt) || now > new Date(draw.endAt)) {
    return { joined: false, message: "不在参与时间内" };
  }

  const nowIso = now.toISOString();

  try {
    return await withDbTransaction(db, async (tx) => {
      // 邀请码扣减和参与记录写入必须在同一事务中，避免重复/满额时白白消耗邀请码。
      let inviteCodeId = "";
      if (draw.participationMode === "invite_code") {
        const inviteResult = await tx
          .update(lotteryInviteCodes)
          .set({ usedCount: sql`${lotteryInviteCodes.usedCount} + 1` })
          .where(and(
            eq(lotteryInviteCodes.tenantId, draw.tenantId),
            eq(lotteryInviteCodes.drawId, draw.id),
            eq(lotteryInviteCodes.code, options!.inviteCode!),
            eq(lotteryInviteCodes.active, 1),
            sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
          ));
        if ((inviteResult.rowsAffected ?? 0) === 0) {
          return { joined: false, message: "邀请码无效或已用完" };
        }
        const [invite] = await tx
          .select({ id: lotteryInviteCodes.id })
          .from(lotteryInviteCodes)
          .where(and(
            eq(lotteryInviteCodes.tenantId, draw.tenantId),
            eq(lotteryInviteCodes.drawId, draw.id),
            eq(lotteryInviteCodes.code, options!.inviteCode!),
          ))
          .limit(1);
        inviteCodeId = invite?.id || "";
      }

      const entryId = crypto.randomUUID();
      const effectiveMax = draw.maxParticipants ?? 50000;
      const acceptsWaitlist = draw.activityKind === "signup_chain" && draw.allocationPolicy === "waitlist";
      // 容量检查：仅按活动维度（draw_id）校验，不做租户级累计参与人数 COUNT。
      // 原因：租户级 COUNT 会扩大 Turso rows read 和请求延迟，不适合放在用户参与热路径。
      // 租户级累计参与人数额度未来通过快照表（定时任务预聚合）实现。
      // 详见 docs/023_Cloudflare免费版与Turso约束下认证和运行安全方案_2026-08-01.md
      const capacityClause = acceptsWaitlist
        ? sql`1 = 1`
        : sql`(SELECT COUNT(*) FROM lottery_entries WHERE tenant_id = ${draw.tenantId} AND draw_id = ${draw.id}) < ${effectiveMax}`;
      // 写入参与记录。使用条件 INSERT 确保并发安全：
      // 1. 活动级容量检查（capacityClause）：防止同时写入超过 maxParticipants
      // 2. 签到活动使用 uniqueValue（含日期后缀）作为 identity_value，
      //    使 UNIQUE 约束允许每日签到但不允许同一天重复。
      const insertResult = await tx.run(sql`
        INSERT INTO lottery_entries (id, tenant_id, draw_id, identity_type, identity_value, invite_code_id, ip_hash, joined_at)
        SELECT ${entryId}, ${draw.tenantId}, ${draw.id}, ${identityType}, ${checkinDateSuffix ? uniqueValue : normalizedValue}, ${inviteCodeId}, ${options?.ipHash || ""}, ${nowIso}
        WHERE ${capacityClause}
      `);

      if ((insertResult.rowsAffected ?? 0) === 0) {
        return { joined: false, message: acceptsWaitlist ? "参与失败，请稍后重试" : "活动名额已满" };
      }

      if (draw.activityKind !== "signup_chain") {
        const attribution = await recordAttributedJoin(tx, {
          tenantId: draw.tenantId,
          drawId: draw.id,
          entryId,
          refCode: options?.refCode,
          ipHash: options?.ipHash,
          userAgent: options?.userAgent,
        });
        return { joined: true, entryId, activityKind: draw.activityKind, attribution };
      }

      const [{ total }] = await tx
        .select({ total: count() })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.tenantId, draw.tenantId), eq(lotteryEntries.drawId, draw.id)));
      const sequenceNo = Number(total);
      const status = draw.maxParticipants && sequenceNo > draw.maxParticipants ? "waitlisted" : "assigned";
      const assignmentNo = status === "assigned" ? sequenceNo : null;
      const resultLabel = status === "assigned"
        ? `第 ${sequenceNo} 位`
        : `候补第 ${sequenceNo - (draw.maxParticipants || 0)} 位`;
      const outcomeId = crypto.randomUUID();
      await tx.insert(activityOutcomes).values({
        id: outcomeId,
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId,
        outcomeType: "assignment",
        status,
        sequenceNo,
        assignmentNo,
        resultKey: status === "assigned" ? `slot_${sequenceNo}` : `waitlist_${sequenceNo - (draw.maxParticipants || 0)}`,
        resultLabel,
        metadataJson: JSON.stringify({ source: "signup_chain", allocationPolicy: draw.allocationPolicy }),
        decidedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const attribution = await recordAttributedJoin(tx, {
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId,
        refCode: options?.refCode,
        ipHash: options?.ipHash,
        userAgent: options?.userAgent,
      });

      return {
        joined: true,
        entryId,
        activityKind: draw.activityKind,
        attribution,
        outcome: {
          id: outcomeId,
          drawId: draw.id,
          entryId,
          outcomeType: "assignment",
          status,
          sequenceNo,
          assignmentNo,
          resultLabel,
        },
      };
    });
  } catch (err: any) {
    // UNIQUE 约束冲突：同一参与者重复提交
    if (err.message?.includes("UNIQUE constraint")) {
      return { joined: false, message: "您已参与此活动" };
    }
    throw err;
  }
}

async function recordAttributedJoin(
  db: DbWriteScope,
  input: {
    tenantId: string;
    drawId: string;
    entryId: string;
    refCode?: string;
    ipHash?: string;
    userAgent?: string;
  },
) {
  const refCode = String(input.refCode || "").trim();
  if (!refCode) return { attributed: false };

  const [share] = await db
    .select({
      id: shareRecords.id,
      sharerEntryId: shareRecords.sharerEntryId,
    })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, input.tenantId),
      eq(shareRecords.drawId, input.drawId),
      eq(shareRecords.shareCode, refCode),
    ))
    .limit(1);
  if (!share) return { attributed: false };

  await db
    .update(shareRecords)
    .set({ joinedCount: sql`${shareRecords.joinedCount} + 1` })
    .where(eq(shareRecords.id, share.id));

  await recordActivityEvent(db, {
    tenantId: input.tenantId,
    drawId: input.drawId,
    entryId: input.entryId,
    eventType: "attributed_join",
    refCode,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
    metadata: {
      shareRecordId: share.id,
      sharerEntryId: share.sharerEntryId,
    },
  });

  return { attributed: true, refCode, shareRecordId: share.id };
}

/**
 * 查询参与者在活动中的结果。
 * 公开接口只能通过活动 slug + 身份查找，管理接口必须额外传租户。
 */
export async function getActivityOutcome(
  db: DbType,
  tenantId: string,
  drawId: string,
  entryId: string,
) {
  const [outcome] = await db
    .select()
    .from(activityOutcomes)
    .where(and(
      eq(activityOutcomes.tenantId, tenantId),
      eq(activityOutcomes.drawId, drawId),
      eq(activityOutcomes.entryId, entryId),
    ))
    .limit(1);
  return outcome || null;
}

export async function getActivityOutcomes(
  db: DbType,
  tenantId: string,
  drawId: string,
  limit = 100,
  offset = 0,
) {
  return db
    .select()
    .from(activityOutcomes)
    .where(and(eq(activityOutcomes.tenantId, tenantId), eq(activityOutcomes.drawId, drawId)))
    .orderBy(activityOutcomes.sequenceNo)
    .limit(limit)
    .offset(offset);
}

/**
 * 获取候选池列表（分页，带租户隔离）。
 */
export async function getEntries(
  db: DbType,
  tenantId: string,
  drawId: string,
  limit: number = 100,
  offset: number = 0,
) {
  return db
    .select()
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.tenantId, tenantId)))
    .limit(limit)
    .offset(offset)
    .orderBy(lotteryEntries.joinedAt);
}

/* ── 开奖核心 ─────────────────────────────────────────────── */

/**
 * 执行手动开奖。
 *
 * 流程：
 * 1. CAS 原子夺取开奖权（open → drawing）
 * 2. 生成随机种子并记录 hash（事后可验证公平性）
 * 3. 读取候选池，随机抽取中奖者
 * 4. 事务内原子锁码 + 写入中奖记录
 * 5. 更新活动状态为 drawn
 * 6. 写审计日志
 *
 * 失败处理：
 * - 任何步骤失败 → 恢复状态为 open + 记录 failureReason
 * - 已开奖活动再次开奖 → 返回已有结果（幂等）
 */
export async function performDraw(
  db: DbType,
  tenantId: string,
  drawId: string,
  operatorUserId: string,  // 操作者用户 ID（用于审计日志）
  emailEnv?: { resendApiKey: string; emailFrom: string },  // 邮件通知配置（可选，未配置时跳过通知）
): Promise<DrawResult> {
  const now = new Date().toISOString();

  // 1. CAS 原子夺取开奖权：仅当 status = 'open' 时才更新为 'drawing'
  //    使用 returning() 获取更新后的记录，确认 CAS 成功
  const claimResult = await db
    .update(lotteryDraws)
    .set({ status: "drawing", updatedAt: now })
    .where(and(
      eq(lotteryDraws.id, drawId),
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, "open"),
    ));

  // rowsAffected = 0 表示 CAS 失败（活动已被其他进程开奖或状态不是 open）
  if ((claimResult.rowsAffected ?? 0) === 0) {
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);

    if (!draw) throw new Error("活动不存在");
    // 卡在 drawing 状态的活动：尝试治愈
    if (draw.status === "drawing") {
      const healed = await healDrawingState(db, drawId, tenantId);
      if (healed === "drawn") {
        return { drawId, winnerCount: 0, candidateCount: 0 };
      }
      if (healed === "open") {
        // 治愈成功，状态已回滚为 open，重新尝试夺取开奖权
        const retryResult = await db
          .update(lotteryDraws)
          .set({ status: "drawing", updatedAt: new Date().toISOString() })
          .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
        if ((retryResult.rowsAffected ?? 0) === 0) {
          throw new Error("开奖权已被其他进程夺取，请稍后重试");
        }
        // 继续执行开奖流程
      }
    }
    // 已开奖活动再次开奖 → 幂等返回实际数据
    if (draw.status === "drawn") {
      const actualWinnerCount = await db
        .select({ total: count() })
        .from(lotteryWinners)
        .where(eq(lotteryWinners.drawId, drawId));
      const actualCandidateCount = await db
        .select({ total: count() })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.drawId, drawId));
      return {
        drawId,
        winnerCount: Number(actualWinnerCount[0]?.total ?? 0),
        candidateCount: Number(actualCandidateCount[0]?.total ?? 0),
      };
    }
    throw new Error("开奖权已被其他进程夺取，请稍后重试");
  }

  try {
    // 2. 生成开奖随机种子并记录 SHA-256 hash（公平性可验证）
    //    开奖前先记录 hash，开奖后可展示原始 seed 供参与者验证
    const seed = crypto.randomUUID();
    const seedHash = await hashDrawSeed(seed);
    await db
      .update(lotteryDraws)
      .set({ drawSeedHash: seedHash, drawSeed: seed, algorithmVersion: "uniform_v1", updatedAt: now })
      .where(eq(lotteryDraws.id, drawId));

    // 3. 读取候选池（所有参与者）
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId));

    const candidateCount = entries.length;
    if (candidateCount === 0) {
      throw new Error("候选池为空，无参与者");
    }

    // 获取活动配置（读取最新状态）
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    // 获取多奖项配置（一等奖、二等奖等）
    const tiers = await db
      .select()
      .from(lotteryPrizeTiers)
      .where(eq(lotteryPrizeTiers.drawId, drawId))
      .orderBy(lotteryPrizeTiers.sortOrder);

    // 计算总中奖人数：有奖项配置时按奖项总和，否则按活动默认 winnerCount
    const totalWinners = tiers.length > 0
      ? tiers.reduce((sum, t) => sum + t.winnerCount, 0)
      : draw.winnerCount;

    // Fisher-Yates 随机抽取中奖者
    const selected = await randomSelect(entries, totalWinners);

    // 4. 事务内写入中奖记录 + 原子锁码
    //    使用事务保证：锁码和写入中奖记录要么全部成功，要么全部回滚
    let entryIndex = 0;  // 已处理的中奖者数量（在事务外声明，用于审计日志）
    await withDbTransaction(db, async (tx) => {
      // 如果没有配置多奖项，创建默认奖项"中奖"
      const effectiveTiers = tiers.length > 0 ? tiers : [{
        id: crypto.randomUUID(),
        tenantId,
        drawId,
        prizeId: "",          // 空 = 不关联奖品码
        tierName: "中奖",
        winnerCount: draw.winnerCount,
        sortOrder: 100,
      }];

      for (const tier of effectiveTiers) {
        // 按奖项名额逐个分配中奖者
        for (let i = 0; i < tier.winnerCount && entryIndex < selected.length; i++) {
          const entry = selected[entryIndex]!;
          entryIndex++;

          // 原子锁码：如果奖项配置了奖品，从奖品码池中取一条 available 的记录
          // 【关键】先 SELECT 获取一条可用码的 ID，再按 ID 执行 UPDATE
          // 不能直接 UPDATE ... WHERE status='available'（会更新所有可用码，导致数据损坏）
          let prizeCodeId = "";
          if (tier.prizeId) {
            // 步骤 1: SELECT 获取一条可用码（原子操作，配合事务保证并发安全）
            const [availableCode] = await tx
              .select({ id: prizeCodes.id, code: prizeCodes.code })
              .from(prizeCodes)
              .where(and(
                eq(prizeCodes.prizeId, tier.prizeId),
                eq(prizeCodes.status, "available"),
                eq(prizeCodes.tenantId, tenantId),
              ))
              .limit(1);

            if (availableCode) {
              // 步骤 2: 按 ID 原子锁定（仅更新该条码）
              const lockResult = await tx
                .update(prizeCodes)
                .set({ status: "issued", winnerId: entry.id, issuedAt: now })
                .where(and(
                  eq(prizeCodes.id, availableCode.id),
                  eq(prizeCodes.status, "available"),
                ));

            // rowsAffected = 0 表示码已用完（被其他中奖者锁定）
            if ((lockResult.rowsAffected ?? 0) > 0) {
              // 查询刚锁定的码的 ID
              const [lockedCode] = await tx
                .select({ id: prizeCodes.id })
                .from(prizeCodes)
                .where(and(
                  eq(prizeCodes.prizeId, tier.prizeId),
                  eq(prizeCodes.winnerId, entry.id),
                  eq(prizeCodes.tenantId, tenantId),
                ))
                .limit(1);
              prizeCodeId = lockedCode?.id || "";
            }
            // 码不足时跳过（prizeCodeId 保持空字符串），中奖者仍记录但无码
            }
          }

          // 写入中奖记录
          const winnerId = crypto.randomUUID();
          await tx.insert(lotteryWinners).values({
            id: winnerId,
            tenantId,
            drawId,
            tierId: tier.id,
            entryId: entry.id,
            identityType: entry.identityType,
            identityValue: entry.identityValue,
            prizeCodeId: prizeCodeId || "",
            drawnAt: now,
            notificationStatus: "pending",  // 待发送通知
          });
        }
      }
    });

    // 5. 更新活动状态为 drawn（开奖完成）
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: now, updatedAt: now, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

    // 6. 写审计日志（记录谁在什么时候开奖、结果如何）
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId: operatorUserId,
      action: "draw.perform",
      targetType: "lottery_draw",
      targetId: drawId,
      metadataJson: JSON.stringify({
        winnerCount: entryIndex,
        candidateCount,
        seedHash,
        algorithmVersion: "uniform_v1",
      }),
      createdAt: now,
    });

    // 异步发送中奖通知邮件（不阻塞主流程，失败不影响开奖结果）
    // 仅在邮件配置可用时发送
    if (emailEnv?.resendApiKey) {
      void sendWinnerNotifications(db, tenantId, drawId, emailEnv).catch((err) => {
        console.error(`[lottery] sendWinnerNotifications failed for ${drawId}:`, err);
      });
    }

    const webhookEvent = await enqueueWebhookEvent(db, {
      tenantId,
      eventType: "draw.completed",
      data: { drawId, winnerCount: entryIndex, candidateCount },
    });
    for (const deliveryId of webhookEvent.deliveryIds) {
      void dispatchWebhookDelivery(db, tenantId, deliveryId).catch((err) => {
        console.error(`[lottery] dispatchWebhookDelivery failed for ${deliveryId}:`, err);
      });
    }

    return { drawId, winnerCount: entryIndex, candidateCount };
  } catch (error) {
    // 开奖失败：恢复为 open 状态并记录失败原因
    // 不清除 drawSeedHash，保留审计线索
    const reason = error instanceof Error ? error.message.slice(0, 500) : "开奖失败（未知错误）";
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: reason, updatedAt: new Date().toISOString() })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    throw error;
  }
}

/**
 * 异步发送中奖通知邮件。
 * 在开奖完成后调用，不阻塞主流程。
 * 每个中奖者独立发送，失败不影响其他人。
 */
export async function sendWinnerNotifications(
  db: DbType,
  tenantId: string,
  drawId: string,
  emailEnv: { resendApiKey?: string; emailFrom?: string },
) {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return;

  const winners = await db
    .select({
      winnerId: lotteryWinners.id,
      email: lotteryWinners.identityValue,
      prizeCodeId: lotteryWinners.prizeCodeId,
      notificationStatus: lotteryWinners.notificationStatus,
    })
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));

  for (const winner of winners) {
    if (winner.notificationStatus === "sent") continue;

    let accountLabel = "";
    let deliverySecret = "";

    if (winner.prizeCodeId) {
      const [code] = await db
        .select({ code: prizeCodes.code, secret: prizeCodes.secret })
        .from(prizeCodes)
        .where(eq(prizeCodes.id, winner.prizeCodeId))
        .limit(1);
      if (code) { accountLabel = code.code; deliverySecret = code.secret; }
    }

    try {
      const result = await sendEmail(db, emailEnv, {
        to: winner.email,
        template: "lottery_winner",
        templateData: buildLotteryWinnerTemplateData({
          drawName: draw.title,
          productName: draw.title,
          accountLabel,
          deliverySecret,
        }),
      });

      await db
        .update(lotteryWinners)
        .set({
          notificationStatus: result.ok ? "sent" : "failed",
          notificationError: result.ok ? "" : (result.message || "").slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.winnerId));
    } catch (err) {
      await db
        .update(lotteryWinners)
        .set({
          notificationStatus: "failed",
          notificationError: (err as Error).message.slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.winnerId));
    }
  }
}

/**
 * 治愈卡死的 drawing 状态。
 *
 * 背景：如果一个开奖因 Worker 崩溃/超时卡在 drawing 状态，
 * 后续无法再次开奖。此函数检查 drawing 状态的活动：
 * - 如果已有中奖记录 → 补设为 drawn（开奖实际已完成）
 * - 如果无中奖记录且超时 → 回滚为 open（允许重新开奖）
 *
 * 借鉴 cf-shop 的 healDrawingState 模式。
 */
export async function healDrawingState(
  db: DbType,
  drawId: string,
  tenantId: string,
  options?: { staleMs?: number },
): Promise<"drawn" | "open" | null> {
  const staleMs = options?.staleMs ?? 300000; // 默认 5 分钟超时

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw || draw.status !== "drawing") return null;

  // 检查是否已有中奖记录
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));

  const nowIso = new Date().toISOString();

  if (Number(total) > 0) {
    // 中奖已落库但状态未 drawn：补状态
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: draw.drawnAt || nowIso, updatedAt: nowIso, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    return "drawn";
  }

  // 无中奖记录：检查是否超时
  const updatedAt = new Date(draw.updatedAt || draw.createdAt).getTime();
  if (Date.now() - updatedAt > staleMs) {
    // 超时且无中奖：回滚为 open
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: "开奖超时，已自动回滚", updatedAt: nowIso })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    return "open";
  }

  return null;
}

/* ── 奖品管理 ────────────────────────────────────────────── */

/**
 * 创建奖品。
 */
export async function createPrize(
  db: DbType,
  tenantId: string,
  data: { name: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string },
) {
  const id = crypto.randomUUID();
  await db.insert(prizes).values({
    id,
    tenantId,
    name: data.name,
    description: data.description || "",
    imageUrl: data.imageUrl || "",   // 奖品图片 URL（可选）
    valueText: data.valueText || "",  // 展示价值文案，不参与金额计算
    prizeType: data.prizeType || "code",  // 默认卡密类型
  });
  return { id };
}

/**
 * 导入奖品码（批量）。
 * 每个码独立 INSERT，不保证原子性。
 * 如果部分失败，已成功的码不会回滚。
 */
export async function importPrizeCodes(
  db: DbType,
  tenantId: string,
  prizeId: string,
  codes: Array<{ code: string; secret?: string }>,
) {
  // 校验奖品存在且属于当前租户
  const [prize] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!prize) throw new Error("奖品不存在");

  for (const item of codes) {
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(),
      tenantId,
      prizeId,
      code: item.code,
      secret: item.secret || "",
      status: "available",  // 初始状态：可用
    });
  }
}

/* ── 定时开奖兜底 ─────────────────────────────────────────── */

/**
 * 处理到期活动（Cron 定时调用）。
 *
 * 每次最多处理 limit 个活动，避免单次 Worker 请求 CPU 超限。
 * 失败的活动不影响其他活动，每个活动独立 try/catch。
 *
 * 调用频率：建议每 5 分钟执行一次（Cloudflare Cron Triggers）。
 */
export async function processDueDraws(
  db: DbType,
  options?: { limit?: number; emailEnv?: { resendApiKey: string; emailFrom: string } },
): Promise<{ processed: number; failed: number; errors: Array<{ drawId: string; message: string }> }> {
  // 单次最多处理 50 个，默认 20 个
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
  const emailEnv = options?.emailEnv;
  const now = new Date().toISOString();

  // 查询到期且未开奖的定时活动
  const due = await db
    .select()
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
      sql`${lotteryDraws.drawAt} <= ${now}`,  // 开奖时间已到
    ))
    .orderBy(lotteryDraws.drawAt)  // 按开奖时间排序，先到期的先处理
    .limit(limit);

  let processed = 0;
  let failed = 0;
  const errors: Array<{ drawId: string; message: string }> = [];

  // 先治愈卡在 drawing 状态的活动（借鉴 cf-shop 的 healStaleDrawings）
  const staleDrawings = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.status, "drawing"))
    .limit(10);
  for (const draw of staleDrawings) {
    try {
      await healDrawingState(db, draw.id, draw.tenantId);
    } catch (err) { console.error(`[heal] 状态自愈失败 draw=${draw.id}`, err); }
  }

  for (const draw of due) {
    try {
      // Cron 调用时 operatorUserId 为 "system"
      await performDraw(db, draw.tenantId, draw.id, "system", emailEnv);
      processed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "未知错误";
      errors.push({ drawId: draw.id, message });
    }
  }

  return { processed, failed, errors };
}

/**
 * 对开奖随机种子做 SHA-256 hash，用于事后公平性验证。
 *
 * 开奖前先记录 hash，开奖后可展示原始 seed 供参与者验证：
 * 1. 参与者拿到 seed，计算 SHA-256(seed)
 * 2. 比对开奖前记录的 hash 是否一致
 * 3. 一致则证明开奖结果未被篡改
 */
async function hashDrawSeed(seed: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
