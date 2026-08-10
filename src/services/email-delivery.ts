/**
 * 统一邮件投递队列。
 *
 * 设计取舍：
 * - 验证码邮件是用户当前请求的同步凭证，继续直接发送。
 * - 中奖、支付发卡、开奖提醒、安慰券邮件都是业务通知，必须先写 email_deliveries，
 *   再由 maintenance 或管理端重发路径发送，避免进程崩溃造成漏发且无审计。
 */
import { asc, and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbType, DbWriteScope } from "../db/client";
import { emailDeliveries, lotteryWinners } from "../db/schema";
import { sendEmail, type EmailEnv } from "./email-service";

export type EmailDeliverySourceType =
  | "lottery_winner"
  | "payment_order"
  | "draw_reminder"
  | "loser_consolation";

export type EnqueueEmailDeliveryInput = {
  tenantId: string;
  drawId?: string;
  sourceType: EmailDeliverySourceType;
  sourceId: string;
  recipientEmail: string;
  template: string;
  templateData: Record<string, string>;
};

function parseTemplateData(rawJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(rawJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) output[key] = String(value ?? "");
    return output;
  } catch {
    return {};
  }
}

/**
 * 幂等入队：同一 tenant/sourceType/sourceId 只保留一条投递任务。
 *
 * 已 sent 的任务不会被重置，避免管理端/cron 重复发送；failed/pending 会更新为 pending，
 * 支持“重发邮件”按钮把失败任务重新纳入发送队列。
 */
export async function enqueueEmailDelivery(
  db: DbWriteScope,
  input: EnqueueEmailDeliveryInput,
): Promise<{ deliveryId: string; enqueued: boolean }> {
  const now = new Date().toISOString();
  const [existing] = await db
    .select({ id: emailDeliveries.id, status: emailDeliveries.status })
    .from(emailDeliveries)
    .where(and(
      eq(emailDeliveries.tenantId, input.tenantId),
      eq(emailDeliveries.sourceType, input.sourceType),
      eq(emailDeliveries.sourceId, input.sourceId),
    ))
    .limit(1);

  if (existing) {
    if (existing.status === "sent") return { deliveryId: existing.id, enqueued: false };
    await db
      .update(emailDeliveries)
      .set({
        drawId: input.drawId || "",
        recipientEmail: input.recipientEmail,
        template: input.template,
        templateDataJson: JSON.stringify(input.templateData),
        status: "pending",
        lastError: "",
        nextRetryAt: null,
        updatedAt: now,
      })
      .where(eq(emailDeliveries.id, existing.id));
    return { deliveryId: existing.id, enqueued: true };
  }

  const id = crypto.randomUUID();
  await db.insert(emailDeliveries).values({
    id,
    tenantId: input.tenantId,
    drawId: input.drawId || "",
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    recipientEmail: input.recipientEmail,
    template: input.template,
    templateDataJson: JSON.stringify(input.templateData),
    status: "pending",
    attemptCount: 0,
    providerMessageId: "",
    responseBody: "",
    lastError: "",
    createdAt: now,
    updatedAt: now,
  });
  return { deliveryId: id, enqueued: true };
}

export async function dispatchEmailDeliveries(
  db: DbType,
  emailEnv: EmailEnv,
  options?: { limit?: number; deliveryIds?: string[] },
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 100));
  const deliveryIds = (options?.deliveryIds || []).filter(Boolean);
  const staleProcessingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const statusPredicate = or(
    eq(emailDeliveries.status, "pending"),
    and(
      eq(emailDeliveries.status, "processing"),
      sql`${emailDeliveries.updatedAt} <= ${staleProcessingCutoff}`,
    ),
  );
  const retryPredicate = sql`(${emailDeliveries.nextRetryAt} IS NULL OR ${emailDeliveries.nextRetryAt} <= ${nowIso})`;

  const rows = await db
    .select()
    .from(emailDeliveries)
    .where(deliveryIds.length > 0
      ? and(inArray(emailDeliveries.id, deliveryIds), statusPredicate, retryPredicate)
      : and(statusPredicate, retryPredicate))
    .orderBy(asc(emailDeliveries.createdAt))
    .limit(limit);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const delivery of rows) {
    const now = new Date().toISOString();
    const claimed = await db
      .update(emailDeliveries)
      .set({ status: "processing", updatedAt: now })
      .where(and(
        eq(emailDeliveries.id, delivery.id),
        or(
          eq(emailDeliveries.status, "pending"),
          and(
            eq(emailDeliveries.status, "processing"),
            sql`${emailDeliveries.updatedAt} <= ${staleProcessingCutoff}`,
          ),
        ),
      ))
      .returning({ id: emailDeliveries.id });
    if (claimed.length === 0) continue;

    try {
      const result = await sendEmail(emailEnv, {
        to: delivery.recipientEmail,
        template: delivery.template,
        templateData: parseTemplateData(delivery.templateDataJson),
      });
      const ok = result.ok;
      await db
        .update(emailDeliveries)
        .set({
          status: ok ? "sent" : "failed",
          attemptCount: delivery.attemptCount + 1,
          providerMessageId: result.id || "",
          responseBody: result.message || "",
          lastError: ok ? "" : (result.message || "邮件发送失败").slice(0, 500),
          sentAt: ok ? new Date().toISOString() : null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(emailDeliveries.id, delivery.id));
      if (delivery.sourceType === "lottery_winner") {
        await db
          .update(lotteryWinners)
          .set({
            notificationStatus: ok ? "sent" : "failed",
            notificationError: ok ? "" : (result.message || "邮件发送失败").slice(0, 500),
            notificationRetryCount: ok ? 0 : sql`notification_retry_count + 1`,
          })
          .where(and(
            eq(lotteryWinners.tenantId, delivery.tenantId),
            eq(lotteryWinners.id, delivery.sourceId),
          ));
      }
      if (ok) sent++;
      else {
        failed++;
        errors.push(`email ${delivery.id}: ${result.message || "邮件发送失败"}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const newAttempt = delivery.attemptCount + 1;
      const maxRetries = 3;
      await db
        .update(emailDeliveries)
        .set({
          status: newAttempt >= maxRetries ? "failed" : "pending",
          attemptCount: newAttempt,
          lastError: message.slice(0, 500),
          nextRetryAt: newAttempt >= maxRetries ? null : new Date(Date.now() + 60000 * newAttempt).toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(emailDeliveries.id, delivery.id));
      if (delivery.sourceType === "lottery_winner") {
        await db
          .update(lotteryWinners)
          .set({
            notificationStatus: "failed",
            notificationError: message.slice(0, 500),
            notificationRetryCount: sql`notification_retry_count + 1`,
          })
          .where(and(
            eq(lotteryWinners.tenantId, delivery.tenantId),
            eq(lotteryWinners.id, delivery.sourceId),
          ));
      }
      failed++;
      errors.push(`email ${delivery.id}: ${message.slice(0, 200)}`);
    }
  }

  return { sent, failed, errors };
}
