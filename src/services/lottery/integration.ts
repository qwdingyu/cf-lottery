/**
 * 抽奖服务层 — 集成/事件域（lottery-service 拆分，docs/049 #17）
 *
 * 活动事件漏斗（page_view/participation/outcome…）、外部 API Key 认证、
 * 外部转化回传（成交/核销/注册）、Webhook 配置/投递/重试全生命周期。
 * 被参与域（recordActivityEvent）与开奖域（enqueueWebhookEvent/dispatchWebhookDelivery）复用。
 */
import type { DbType, DbWriteScope } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { and, eq, count, or, sql } from "drizzle-orm";
import {
  activityEvents,
  apiKeys,
  externalConversions,
  lotteryDraws,
  lotteryEntries,
  webhookConfigs,
  webhookDeliveries,
} from "../../db/schema";
import {
  ACTIVITY_EVENT_TYPES,
  WEBHOOK_EVENT_TYPES,
  EXTERNAL_CONVERSION_TYPES,
} from "./types";
import type {
  RecordActivityEventInput,
  WebhookEventType,
  EnqueueWebhookEventInput,
  WebhookFetch,
  RecordExternalConversionInput,
} from "./types";

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

/**
 * API Key 哈希（SHA-256）。
 *
 * 为什么哈希：API Key 以明文存储时，数据库泄漏即密钥全量暴露。
 * 改为存储哈希后，即使数据库泄漏，攻击者也无法直接使用密钥。
 * 创建时明文只返回一次（前端弹窗展示后即丢弃），库中只存哈希。
 *
 * 哈希算法（docs/091 P1-10）：统一为裸 sha256（cf-core 语义），消除 cf-lottery-apikey: salt 分叉。
 * 存量 key 支持 legacy salt 哈希 + 明文匹配，命中后自动升级为裸 sha256 存储。
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Legacy salt 哈希（兼容存量 key，过渡期后移除） */
async function legacyHashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`cf-lottery-apikey:${key}`));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function authenticateApiKey(db: DbType, rawKey: string) {
  const key = String(rawKey || "").trim();
  if (!key) return null;
  // 三重匹配：裸 sha256（新格式）→ legacy salt 哈希（存量哈希）→ 明文（最早存量）
  // 命中后自动升级为裸 sha256 存储（渐进式迁移，消除明文/双格式窗口）
  const keyHash = await hashApiKey(key);
  const legacyHash = await legacyHashApiKey(key);
  const [row] = await db
    .select({ id: apiKeys.id, tenantId: apiKeys.tenantId, name: apiKeys.name, key: apiKeys.key })
    .from(apiKeys)
    .where(and(
      eq(apiKeys.active, 1),
      or(eq(apiKeys.key, key), eq(apiKeys.key, keyHash), eq(apiKeys.key, legacyHash)),
    ))
    .limit(1);

  if (!row) return null;

  // 渐进式迁移：库中非裸 sha256 的存量 key（明文或 legacy 哈希）验证通过后升级为统一格式
  if (row.key !== keyHash) {
    await db
      .update(apiKeys)
      .set({ key: keyHash, updatedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row.id));
  }

  return row;
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

