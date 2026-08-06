/**
 * 邮件通知服务 — Cloudflare Email / Resend provider（cf-lottery 精简版）
 *
 * escapeHtml / interpolate 统一从 @usethink/cf-core/email 引入。
 * 配置通过 wrangler secret/binding 设置：EMAIL（send_email binding，优先）或 RESEND_API_KEY。
 */
import { escapeHtml, interpolate } from "@usethink/cf-core/features/email";
import { sendViaCloudflareEmail, type CloudflareEmailBinding } from "@usethink/cf-core/features/email/cloudflare";
export { escapeHtml, interpolate };

import lotteryWinnerHtml from "./templates/lottery_winner";
import emailAccessCodeHtml from "./templates/email_access_code";
import drawReminderHtml from "./templates/draw_reminder";
import loserConsolationHtml from "./templates/loser_consolation";

interface ResendResponse { id?: string; message?: string; }

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

export function buildLotteryWinnerTemplateData(input: {
  drawName: string; productName: string; prizeValue?: string | null;
  orderNo?: string | null; accountLabel?: string | null;
  deliverySecret?: string | null; deliveryNote?: string | null;
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

export interface SendEmailInput {
  to: string; template: string; templateData: Record<string, string>; orderId?: string;
}

export interface SendEmailResult {
  ok: boolean; message?: string; id?: string;
}

export async function sendEmail(
  emailEnv: { resendApiKey?: string; emailFrom?: string; emailFromName?: string; email?: CloudflareEmailBinding },
  input: SendEmailInput,
): Promise<SendEmailResult> {
  // Cloudflare Email Service 优先（send_email binding，零第三方依赖）
  if (emailEnv.email) {
    const from = emailEnv.emailFromName
      ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@eforge.xyz"}>`
      : (emailEnv.emailFrom || "noreply@eforge.xyz");
    const tpl = templates[input.template];
    if (!tpl) return { ok: false, message: `模板不存在: ${input.template}` };
    const subject = templateSubjects[input.template] || "通知";
    const html = interpolate(tpl, input.templateData);
    const result = await sendViaCloudflareEmail(emailEnv.email, { from, to: input.to, subject, html });
    return { ok: result.ok, message: result.error || result.messageId, id: result.messageId };
  }

  // Resend 兜底（向后兼容）
  const apiKey = emailEnv.resendApiKey;
  if (!apiKey) return { ok: false, message: "邮件服务未配置" };
  const tpl = templates[input.template];
  if (!tpl) return { ok: false, message: `模板不存在: ${input.template}` };
  const subject = templateSubjects[input.template] || "通知";
  const html = interpolate(tpl, input.templateData);
  const fromEmail = emailEnv.emailFrom || "noreply@resend.dev";
  const from = emailEnv.emailFromName ? `${emailEnv.emailFromName} <${fromEmail}>` : fromEmail;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: input.to, subject, html }),
    });
    const body = await res.json() as ResendResponse;
    if (res.ok) return { ok: true, id: body.id };
    return { ok: false, message: body.message || "发送失败" };
  } catch (err: any) {
    return { ok: false, message: err.message || "网络错误" };
  }
}

export async function sendAccessCode(
  emailEnv: { resendApiKey: string; emailFrom: string; emailFromName?: string; email?: CloudflareEmailBinding },
  to: string, drawName: string, code: string,
): Promise<{ ok: boolean; message: string }> {
  const html = interpolate(emailAccessCodeHtml, { drawName, code });
  // Cloudflare Email Service 优先
  if (emailEnv.email) {
    const from = emailEnv.emailFromName
      ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@eforge.xyz"}>`
      : (emailEnv.emailFrom || "noreply@eforge.xyz");
    return sendViaCloudflareEmail(emailEnv.email, { from, to, subject: "您的抽奖验证码", html }).then(r => ({
      ok: r.ok, message: r.error || r.messageId || "发送成功",
    }));
  }
  // Resend 兜底
  if (!emailEnv.resendApiKey) return { ok: false, message: "邮件服务未配置" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${emailEnv.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: emailEnv.emailFromName
          ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@resend.dev"}>`
          : emailEnv.emailFrom || "noreply@resend.dev",
        to, subject: "您的抽奖验证码", html,
      }),
    });
    const body = await res.json() as ResendResponse;
    if (res.ok) return { ok: true, message: "发送成功" };
    return { ok: false, message: body.message || "发送失败" };
  } catch (err: any) {
    return { ok: false, message: err.message || "网络错误" };
  }
}
