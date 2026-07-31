/**
 * 邮件通知服务 — Resend provider.
 *
 * 配置方式（按优先级）：
 * 1. 生产：在后台 system_config 中配置 resend_api_key / email_from
 * 2. 本地：在 .dev.vars 中写 RESEND_API_KEY=re_xxx、EMAIL_FROM="name <addr>"
 *
 * 模板管理：
 * - 模板文件位于 src/services/templates/*.ts，按导出名映射到模板名
 * - 例：order_issued → 购买/兑换发卡；lottery_winner → 抽奖中奖（禁止复用订单文案）
 * - 修改模板后 git push 触发部署即可生效（模板随代码打包进 Workers）
 * - 不支持运行时动态修改模板，修改必须走代码部署流程
 *
 * 发送时机：
 * - 订单发卡成功后 → order_issued（购买/兑换）
 * - 抽奖开奖中奖 → lottery_winner（活动中奖，非购买订单）
 * - 订单状态重要变更 → order_pending / order_paid / order_expired
 * - 邮箱验证码 → email_access_code
 */

import orderIssuedHtml from "./templates/order_issued";
import orderPendingHtml from "./templates/order_pending";
import orderPaidHtml from "./templates/order_paid";
import orderExpiredHtml from "./templates/order_expired";
import lowStockWarningHtml from "./templates/low_stock_warning";
import emailAccessCodeHtml from "./templates/email_access_code";
import lotteryWinnerHtml from "./templates/lottery_winner";
import type { DbType } from "../db/client";
import { emailLogs } from "../db/schema";
import { eq } from "drizzle-orm";

const TEMPLATES: Record<string, string> = {
  order_issued: orderIssuedHtml,
  order_pending: orderPendingHtml,
  order_paid: orderPaidHtml,
  order_expired: orderExpiredHtml,
  low_stock_warning: lowStockWarningHtml,
  email_access_code: emailAccessCodeHtml,
  lottery_winner: lotteryWinnerHtml,
};

type TemplateMeta = {
  subject: string;
  html: string;
};

// 各模板的 subject 配置（subject 不能放在 HTML 文件里避免暴露在模板源码中）
const SUBJECTS: Record<string, string> = {
  order_issued:  "🎉 您的订单已完成，卡密发放成功",
  order_pending:  "📋 您的订单已创建，请等待确认",
  order_paid:     "✅ 支付成功，订单正在处理中",
  order_expired:  "⏰ 您的订单已过期",
  low_stock_warning: "⚠️ 库存预警通知",
  email_access_code: "您的邮箱验证码",
  // 抽奖中奖：禁止复用 order_issued 的「订单已完成」文案
  lottery_winner: "🎉 恭喜中奖！奖品卡密已发放",
};

export function getTemplate(name: string): TemplateMeta | null {
  const html = TEMPLATES[name];
  if (!html) return null;
  const subject = SUBJECTS[name] ?? "您的订单通知";
  return { subject, html };
}

export type SendEmailOptions = {
  to: string;
  template: string;   // 模板名（如 "order_issued"）
  templateData: Record<string, string>;
  orderId?: string;
  from?: string;
};

const RESEND_FETCH_TIMEOUT_MS = 8000;

type IssuedDelivery = {
  accountLabel?: string | null;
  deliverySecret?: string | null;
  deliveryNote?: string | null;
};

/**
 * 订单邮件保留首张卡密的现有字段，并把其余卡密整理为纯文本列表。
 * 列表仍由 interpolate 统一 HTML 转义，不能在这里拼接可执行 HTML。
 */
export function buildIssuedDeliveryTemplateData(deliveries: IssuedDelivery[]): Record<string, string> {
  const normalized = deliveries.filter((item) => Boolean(item.accountLabel || item.deliverySecret || item.deliveryNote));
  const first = normalized[0];
  const additionalDeliveries = normalized.slice(1).map((item, index) => [
    `卡密 ${index + 2}`,
    item.accountLabel ? `账号：${item.accountLabel}` : "",
    item.deliverySecret ? `密码/密钥：${item.deliverySecret}` : "",
    item.deliveryNote ? `备注：${item.deliveryNote}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");

  return {
    accountLabel: first?.accountLabel || "",
    deliverySecret: first?.deliverySecret || "",
    deliveryNote: first?.deliveryNote || "",
    additionalDeliveries,
  };
}

/**
 * 抽奖中奖邮件字段。与 order_issued 分离：活动名 + 奖品 + 卡密；orderNo 仅作客服交付编号。
 * 禁止把抽奖文案硬塞进 order_issued（会让用户以为自己下了购买订单）。
 */
export function buildLotteryWinnerTemplateData(input: {
  drawName: string;
  productName: string;
  prizeValue?: string | null;
  orderNo?: string | null;
  accountLabel?: string | null;
  deliverySecret?: string | null;
  deliveryNote?: string | null;
}): Record<string, string> {
  return {
    drawName: input.drawName || "抽奖活动",
    productName: input.productName || "",
    prizeValue: input.prizeValue || "",
    orderNo: input.orderNo || "",
    accountLabel: input.accountLabel || "",
    deliverySecret: input.deliverySecret || "",
    deliveryNote: input.deliveryNote || "",
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] ?? c));
}

export function interpolate(template: string, data: Record<string, string>): string {
  return template
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => data[key] ? content : "")
    .replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(String(data[key] ?? "")));
}

export async function sendEmail(
  db: DbType,
  env: {
    resendApiKey: string;
    emailFrom: string;
  },
  opts: SendEmailOptions
): Promise<{ ok: boolean; message: string }> {
  const { to, template, templateData, orderId } = opts;
  const apiKey = env.resendApiKey;

  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not configured, skipping email send");
    return { ok: false, message: "邮件服务未配置" };
  }

  if (!to || !to.includes("@")) {
    return { ok: false, message: "无效的收件人邮箱" };
  }

  const tpl = getTemplate(template);
  if (!tpl) {
    return { ok: false, message: `未知邮件模板: ${template}` };
  }

  const subject = interpolate(tpl.subject, templateData);
  const html = interpolate(tpl.html, templateData);

  // 写邮件日志（pending 状态）— 使用 Drizzle ORM
  const logId = crypto.randomUUID();
  await db.insert(emailLogs).values({
    id: logId,
    orderId: orderId || "",
    toEmail: to,
    template,
    status: "pending",
    provider: "resend",
    errorMessage: "",
    createdAt: new Date().toISOString(),
  });

  try {
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [500, 1000, 2000];
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        // Resend 是外部依赖，必须给每次请求设置上限；否则 Worker waitUntil 被回收或 fetch 悬挂时，
        // email_logs 会永久停留在 pending，后台中奖列表也会长期显示“待发送”。
        const timeoutId = setTimeout(() => controller.abort("resend_timeout"), RESEND_FETCH_TIMEOUT_MS);
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          signal: controller.signal,
          body: JSON.stringify({
            from: opts.from || env.emailFrom || "eshop <noreply@eforge.xyz>",
            to,
            subject,
            html
          })
        }).finally(() => clearTimeout(timeoutId));

        let resData: { id?: string; message?: string } = {};
        try {
          resData = await res.json() as { id?: string; message?: string };
        } catch {
          resData = { message: `HTTP ${res.status}` };
        }

        if (res.ok) {
          // 发送成功：更新邮件日志状态为 sent — 使用 Drizzle ORM
          await db.update(emailLogs).set({ status: "sent", sentAt: new Date().toISOString() }).where(eq(emailLogs.id, logId));
          return { ok: true, message: resData.id || "sent" };
        }

        // 4xx 错误直接失败，不重试
        if (res.status >= 400 && res.status < 500) {
          await db.update(emailLogs).set({ status: "failed", errorMessage: resData.message || `HTTP ${res.status}` }).where(eq(emailLogs.id, logId));
          console.error("[email] Resend API error:", resData);
          return { ok: false, message: resData.message || "发送失败" };
        }

        // 5xx 错误，尝试重试
        lastError = resData.message || `HTTP ${res.status}`;
        if (attempt < MAX_RETRIES) {
          console.warn(`[email] Resend 5xx error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAYS[attempt - 1]}ms...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          continue;
        }

        // 最后一次仍 5xx
        await db.update(emailLogs).set({ status: "failed", errorMessage: lastError }).where(eq(emailLogs.id, logId));
        console.error("[email] Resend API error after retries:", resData);
        return { ok: false, message: lastError };
      } catch (fetchErr) {
        // 网络错误，尝试重试
        lastError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (lastError === "AbortError" || lastError === "The operation was aborted." || lastError.includes("resend_timeout")) {
          lastError = "Resend 请求超时";
        }
        if (attempt < MAX_RETRIES) {
          console.warn(`[email] Network error (attempt ${attempt}/${MAX_RETRIES}): ${lastError}, retrying in ${RETRY_DELAYS[attempt - 1]}ms...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          continue;
        }

        // 最后一次仍失败
        await db.update(emailLogs).set({ status: "failed", errorMessage: lastError }).where(eq(emailLogs.id, logId));
        console.error("[email] send error after retries:", lastError);
        return { ok: false, message: lastError };
      }
    }

    // 不应到达此处，但作为安全兜底
    await db.update(emailLogs).set({ status: "failed", errorMessage: lastError }).where(eq(emailLogs.id, logId));
    return { ok: false, message: lastError };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // 异常：更新邮件日志状态为 failed — 使用 Drizzle ORM
    await db.update(emailLogs).set({ status: "failed", errorMessage: errMsg }).where(eq(emailLogs.id, logId));
    console.error("[email] send error:", errMsg);
    return { ok: false, message: errMsg };
  }
}
