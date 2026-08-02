/**
 * 邮件通知服务 — Resend provider（cf-lottery 精简版）
 *
 * 从 cf-shop 抽取，只保留抽奖中奖和邮箱验证码模板。
 * 配置通过 wrangler secret put 设置 RESEND_API_KEY / EMAIL_FROM。
 */
import lotteryWinnerHtml from "./templates/lottery_winner";
import emailAccessCodeHtml from "./templates/email_access_code";
import drawReminderHtml from "./templates/draw_reminder";
import loserConsolationHtml from "./templates/loser_consolation";

/**
 * Resend API 响应类型（仅定义本服务关心的字段）
 */
interface ResendResponse {
  id?: string;
  message?: string;
}

const templates: Record<string, string> = {
  lottery_winner: lotteryWinnerHtml,
  email_access_code: emailAccessCodeHtml,
  draw_reminder: drawReminderHtml,
  loser_consolation: loserConsolationHtml,
};

const templateSubjects: Record<string, string> = {
  lottery_winner: "🎉 恭喜中奖！奖品卡密已发放",
  email_access_code: "您的抽奖验证码",
  draw_reminder: "⏰ 开奖提醒",
  loser_consolation: "🎁 开奖结果 + 专属优惠",
};

/** 构建中奖邮件模板数据 */
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

export interface SendEmailInput {
  to: string;
  template: string;
  templateData: Record<string, string>;
  orderId?: string;
}

export interface SendEmailResult {
  ok: boolean;
  message?: string;
  id?: string;
}

/** 发送邮件（通过 Resend API） */
export async function sendEmail(
  _db: any,
  emailEnv: { resendApiKey?: string; emailFrom?: string; emailFromName?: string },
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const apiKey = emailEnv.resendApiKey;
  if (!apiKey) return { ok: false, message: "邮件服务未配置" };

  const template = templates[input.template];
  if (!template) return { ok: false, message: `模板不存在: ${input.template}` };

  const subject = templateSubjects[input.template] || "通知";
  const html = interpolate(template, input.templateData);
  // 发件人：优先使用系统配置的名称+邮箱，兜底用原始邮箱地址
  const fromEmail = emailEnv.emailFrom || "noreply@resend.dev";
  const from = emailEnv.emailFromName ? `${emailEnv.emailFromName} <${fromEmail}>` : fromEmail;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject,
        html,
      }),
    });

    const body = await res.json() as ResendResponse;
    if (res.ok) return { ok: true, id: body.id };
    return { ok: false, message: body.message || "发送失败" };
  } catch (err: any) {
    return { ok: false, message: err.message || "网络错误" };
  }
}

/**
 * 发送邮箱验证码。
 * 通过 Resend 发送 6 位数字验证码到用户邮箱。
 */
export async function sendAccessCode(
  emailEnv: { resendApiKey: string; emailFrom: string; emailFromName?: string },
  to: string,
  drawName: string,
  code: string,
): Promise<{ ok: boolean; message: string }> {
  const html = interpolate(emailAccessCodeHtml, { drawName, code });

  if (!emailEnv.resendApiKey) {
    console.warn("[email] RESEND_API_KEY not configured");
    return { ok: false, message: "邮件服务未配置" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${emailEnv.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailEnv.emailFromName
          ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@resend.dev"}>`
          : emailEnv.emailFrom || "noreply@resend.dev",
        to,
        subject: "您的抽奖验证码",
        html,
      }),
    });
    const body = await res.json() as ResendResponse;
    if (res.ok) return { ok: true, message: "发送成功" };
    return { ok: false, message: body.message || "发送失败" };
  } catch (err: any) {
    return { ok: false, message: err.message || "网络错误" };
  }
}
