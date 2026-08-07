/**
 * 邮件通知服务 — 基于 @usethink/cf-core/email EmailService 的薄封装。
 *
 * 模板管理：src/services/templates/*.ts —— 业务模板保留项目内（不纳入 cf-core）
 * 发送管道（重试/超时/escapeHtml/remote/Resend/CF Email）由 cf-core EmailService 统一提供。
 *
 * 通道优先级：cf-auth 邮件网关 → Cloudflare Email → Resend
 * cf-auth 网关自动从 CF_AUTH_ISSUER/CLIENT_ID/CLIENT_SECRET 推导，无需额外 env 变量。
 */
import { EmailService, escapeHtml, interpolate } from "@usethink/cf-core/features/email";
export { escapeHtml, interpolate };

import type { CloudflareEmailBinding } from "@usethink/cf-core/features/email/cloudflare";
import lotteryWinnerHtml from "./templates/lottery_winner";
import emailAccessCodeHtml from "./templates/email_access_code";
import drawReminderHtml from "./templates/draw_reminder";
import loserConsolationHtml from "./templates/loser_consolation";

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

/** 邮件环境配置：复用 CF_AUTH_* OAuth 凭据，无额外变量 */
export type EmailEnv = {
  resendApiKey?: string;
  emailFrom?: string;
  emailFromName?: string;
  email?: CloudflareEmailBinding;
  cfAuthIssuer?: string;
  cfAuthClientId?: string;
  cfAuthClientSecret?: string;
};

export interface SendEmailInput {
  to: string; template: string; templateData: Record<string, string>; orderId?: string;
}

export interface SendEmailResult {
  ok: boolean; message?: string; id?: string;
}

export async function sendEmail(
  emailEnv: EmailEnv,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const tpl = templates[input.template];
  if (!tpl) return { ok: false, message: `模板不存在: ${input.template}` };
  const subject = templateSubjects[input.template] || "通知";
  const html = interpolate(tpl, input.templateData);
  const from = emailEnv.emailFromName
    ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@eforge.xyz"}>`
    : (emailEnv.emailFrom || "noreply@eforge.xyz");

  const svc = new EmailService({
    ...(emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret
      ? { remote: { url: `${emailEnv.cfAuthIssuer}/api/email/send`, clientId: emailEnv.cfAuthClientId, clientSecret: emailEnv.cfAuthClientSecret } }
      : {}),
    ...(emailEnv.resendApiKey ? { apiKey: emailEnv.resendApiKey } : {}),
    ...(emailEnv.email ? { emailBinding: emailEnv.email } : {}),
    from,
  });

  const result = await svc.send({ to: input.to, subject, html });
  return { ok: result.ok, message: result.error || result.messageId, id: result.messageId };
}

export async function sendAccessCode(
  emailEnv: EmailEnv,
  to: string, drawName: string, code: string,
): Promise<{ ok: boolean; message: string }> {
  const html = interpolate(emailAccessCodeHtml, { drawName, code });
  const from = emailEnv.emailFromName
    ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@eforge.xyz"}>`
    : (emailEnv.emailFrom || "noreply@eforge.xyz");

  const svc = new EmailService({
    ...(emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret
      ? { remote: { url: `${emailEnv.cfAuthIssuer}/api/email/send`, clientId: emailEnv.cfAuthClientId, clientSecret: emailEnv.cfAuthClientSecret } }
      : {}),
    ...(emailEnv.resendApiKey ? { apiKey: emailEnv.resendApiKey } : {}),
    from,
  });

  const result = await svc.send({ to, subject: "您的抽奖验证码", html });
  return { ok: result.ok, message: result.error || "发送成功" };
}
