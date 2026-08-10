/**
 * 平台出站消息投递服务（docs/167 出站方向，Phase 1）
 *
 * 职责：
 * - enqueuePlatformEvent：事件发生时，查匹配的 platformTargets，渲染模板，写入 platformDeliveries
 * - dispatchPlatformDeliveries：维护 cron 拾取 pending 投递，经 QQ 适配器发送，更新状态
 *
 * 设计约束：
 * - 出站投递不阻塞业务热路径：事件写入 platformDeliveries 即返回，剩余由 cron 异步处理
 * - 发送失败不回滚业务：delivery 标记 failed/max_retries，不影响开奖/参与/签到
 * - 适配器连接失败时，记录 lastError 和 nextRetryAt，下次 cron 轮询重试
 */
import { asc, and, eq, or, sql } from "drizzle-orm";
import type { DbType, DbWriteScope } from "../../db/client";
import { platformTargets, platformDeliveries } from "../../db/schema";
import { getPlatformAdapter } from "./adapter-factory";
import type { PlatformMessage, PlatformType } from "./types";
import { PLATFORM_EVENT_TYPES_SET, type PlatformEventType, renderPlatformEventMessage } from "./templates";
import { parsePlatformAdapterConfigJson, resolvePlatformAdapterConfigForRuntime } from "./adapter-config";

export interface EnqueuePlatformEventInput {
  tenantId: string;
  drawId: string;
  eventType: PlatformEventType;
  /** 模板变量字典，键与模板中的 {{变量名}} 对应 */
  data: Record<string, string>;
  /** 可选的全局事件 ID（用于去重） */
  eventId?: string;
}

export interface EnqueuePrivatePlatformMessageInput {
  tenantId: string;
  platformTargetId: string;
  platform: string;
  targetId: string;
  targetUserId: string;
  groupId?: string;
  text: string;
}

/** 匹配某租户/活动的所有已启用平台目标，为每个目标创建一条投递记录 */
export async function enqueuePlatformEvent(db: DbWriteScope, input: EnqueuePlatformEventInput) {
  if (!PLATFORM_EVENT_TYPES_SET.has(input.eventType)) {
    throw new Error(`平台事件类型无效: ${input.eventType}`);
  }

  /** 查找该租户下绑定该活动且已启用助手的平台目标 */
  const targets = await db
    .select()
    .from(platformTargets)
    .where(and(
      eq(platformTargets.tenantId, input.tenantId),
      eq(platformTargets.activeDrawId, input.drawId),
      eq(platformTargets.assistantEnabled, 1),
    ));

  const deliveryIds: string[] = [];
  const now = new Date().toISOString();
  const eventId = input.eventId || `pevt_${crypto.randomUUID().replace(/-/g, "")}`;

  for (const target of targets) {
    const message = renderPlatformEventMessage(input.eventType, input.data);
    const deliveryId = crypto.randomUUID();
    const payloadJson = JSON.stringify({
      eventType: input.eventType,
      data: input.data,
      renderedMessage: message,
    });

    await db.insert(platformDeliveries).values({
      id: deliveryId,
      tenantId: input.tenantId,
      platformTargetId: target.id,
      platform: target.platform,
      targetId: target.targetId,
      eventId,
      eventType: input.eventType,
      command: "",
      payloadJson,
      status: "pending",
      attemptCount: 0,
      providerMessageId: "",
      responseBody: "",
      lastError: "",
      createdAt: now,
      updatedAt: now,
    });
    deliveryIds.push(deliveryId);
  }

  return { eventId, deliveryIds, targetCount: targets.length };
}

/** 将私聊/临时消息写入统一平台投递队列，避免 webhook 热路径同步等待第三方 Bot API。 */
export async function enqueuePrivatePlatformMessage(
  db: DbWriteScope,
  input: EnqueuePrivatePlatformMessageInput,
): Promise<{ deliveryId: string }> {
  const now = new Date().toISOString();
  const deliveryId = crypto.randomUUID();
  await db.insert(platformDeliveries).values({
    id: deliveryId,
    tenantId: input.tenantId,
    platformTargetId: input.platformTargetId,
    platform: input.platform,
    targetId: input.targetId,
    eventId: `pmsg_${crypto.randomUUID().replace(/-/g, "")}`,
    eventType: "private_message",
    command: "private_message",
    payloadJson: JSON.stringify({
      renderedMessage: input.text,
      targetType: "private",
      privateTargetId: input.targetUserId,
      groupId: input.groupId || "",
    }),
    status: "pending",
    attemptCount: 0,
    providerMessageId: "",
    responseBody: "",
    lastError: "",
    createdAt: now,
    updatedAt: now,
  });
  return { deliveryId };
}

/** 拾取并投递待处理的平台消息（由维护 cron 触发） */
export async function dispatchPlatformDeliveries(
  db: DbType,
  limit: number,
  fetcher: typeof fetch = fetch,
  options?: { credentialsEncryptionKey?: string },
) {
  // 数据库存储的是 ISO 8601 字符串；统一在应用层计算 ISO 截止时间，
  // 避免 SQLite `datetime('now')` 的空格格式与 ISO `T` 格式做字符串比较时失真。
  const staleProcessingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const rows = await db
    .select()
    .from(platformDeliveries)
    .where(and(
      or(
        eq(platformDeliveries.status, "pending"),
        and(
          eq(platformDeliveries.status, "processing"),
          sql`${platformDeliveries.updatedAt} <= ${staleProcessingCutoff}`,
        ),
      ),
      sql`(${platformDeliveries.nextRetryAt} IS NULL OR ${platformDeliveries.nextRetryAt} <= ${new Date().toISOString()})`,
    ))
    .orderBy(asc(platformDeliveries.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  for (const delivery of rows) {
    // 先领取再发送：防止两个维护任务同时看到同一条 pending 记录并重复发消息。
    // processing 超过 10 分钟会被上面的查询重新捞起，避免进程崩溃后永久卡住。
    const claimed = await db
      .update(platformDeliveries)
      .set({ status: "processing", updatedAt: now })
      .where(and(
        eq(platformDeliveries.id, delivery.id),
        or(
          eq(platformDeliveries.status, "pending"),
          and(
            eq(platformDeliveries.status, "processing"),
            sql`${platformDeliveries.updatedAt} <= ${staleProcessingCutoff}`,
          ),
        ),
      ))
      .returning({ id: platformDeliveries.id });
    if (claimed.length === 0) continue;

    const [target] = await db
      .select()
      .from(platformTargets)
      .where(eq(platformTargets.id, delivery.platformTargetId))
      .limit(1);

    if (!target) {
      await db
        .update(platformDeliveries)
        .set({
          status: "failed",
          lastError: "平台目标已删除",
          updatedAt: now,
        })
        .where(eq(platformDeliveries.id, delivery.id));
      failed++;
      errors.push(`delivery ${delivery.id}: 平台目标 ${delivery.platformTargetId} 已删除`);
      continue;
    }

    // 使用适配器工厂获取平台对应的适配器，不硬编码平台名
    // 新增平台只需在 adapter-factory.ts 注册工厂，无需改动 delivery.ts
    try {
      const adapterConfig = await resolvePlatformAdapterConfigForRuntime(
        parsePlatformAdapterConfigJson(target.adapterConfigJson),
        options?.credentialsEncryptionKey,
      );
      const adapter = getPlatformAdapter(target.platform, adapterConfig, fetcher);
      const payload = parseDeliveryPayload(delivery.payloadJson);
      const message: PlatformMessage = {
        platform: target.platform as PlatformType,
        targetId: payload.targetType === "private" && payload.privateTargetId
          ? payload.privateTargetId
          : target.targetId,
        targetType: payload.targetType,
        groupId: payload.groupId,
        type: "text",
        text: payload.renderedMessage || delivery.eventType,
      };
      const result = await adapter.send(message);
      await db
        .update(platformDeliveries)
        .set({
          status: "sent",
          attemptCount: delivery.attemptCount + 1,
          providerMessageId: result.messageId,
          responseBody: JSON.stringify(result.response || {}),
          sentAt: now,
          updatedAt: now,
        })
        .where(eq(platformDeliveries.id, delivery.id));
      sent++;
    } catch (err) {
      const errorMsg = String(err instanceof Error ? err.message : err);
      const newAttempt = delivery.attemptCount + 1;
      const maxRetries = 3;
      const nextRetry = newAttempt >= maxRetries ? null : new Date(Date.now() + 60000 * newAttempt).toISOString();
      await db
        .update(platformDeliveries)
        .set({
          status: newAttempt >= maxRetries ? "failed" : "pending",
          attemptCount: newAttempt,
          lastError: errorMsg.slice(0, 500),
          nextRetryAt: nextRetry,
          updatedAt: now,
        })
        .where(eq(platformDeliveries.id, delivery.id));
      failed++;
      errors.push(`delivery ${delivery.id}: ${errorMsg.slice(0, 200)}`);
    }
  }

  return { sent, failed, errors };
}

function parseDeliveryPayload(payloadJson: string): {
  renderedMessage: string;
  targetType?: "group" | "private";
  privateTargetId?: string;
  groupId?: string;
} {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    const targetType = parsed.targetType === "private" ? "private" : undefined;
    return {
      renderedMessage: typeof parsed.renderedMessage === "string" ? parsed.renderedMessage : "",
      targetType,
      privateTargetId: typeof parsed.privateTargetId === "string" ? parsed.privateTargetId : undefined,
      groupId: typeof parsed.groupId === "string" ? parsed.groupId : undefined,
    };
  } catch {
    return { renderedMessage: "" };
  }
}

/**
 * 记录私聊发送失败到 platformDeliveries 审计表（P1-1）。
 *
 * 在 QQ/Telegram 路由层的私聊发送 catch 块中调用，将失败信息写入投递审计表，
 * 方便后台排查，不影响主流程。
 *
 * @param db 数据库实例
 * @param target 平台目标绑定（含 tenantId、platformTargetId、targetId）
 * @param platform 平台标识（qq / telegram）
 * @param targetUserId 目标用户 ID
 * @param textPreview 消息文本预览（前 50 字符）
 * @param errorMessage 错误描述
 */
export async function logPrivateMessageFailure(
  db: DbType,
  target: { tenantId: string; id: string; targetId: string },
  platform: string,
  targetUserId: string,
  textPreview: string,
  errorMessage: string,
): Promise<void> {
  try {
    await db.insert(platformDeliveries).values({
      id: crypto.randomUUID(),
      tenantId: target.tenantId,
      platformTargetId: target.id,
      platform,
      targetId: target.targetId,
      eventType: "private_message",
      status: "failed",
      lastError: errorMessage,
      payloadJson: JSON.stringify({ targetUserId, textPreview: textPreview.slice(0, 50) }),
    });
  } catch {
    // 审计日志写入失败不阻塞主流程
  }
}

/** 遍历所有租户处理待投递平台消息（由维护 cron 调用） */
export async function processPendingPlatformDeliveriesForAllTenants(
  db: DbType,
  options?: { perTenantLimit?: number; fetcher?: typeof fetch; credentialsEncryptionKey?: string },
) {
  return dispatchPlatformDeliveries(db, options?.perTenantLimit ?? 20, options?.fetcher, {
    credentialsEncryptionKey: options?.credentialsEncryptionKey,
  });
}
