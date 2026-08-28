/**
 * 邮件通知服务 — 基于 @usethink/cf-core/email EmailService 的薄封装。
 *
 * 模板管理：src/services/templates/*.ts —— 业务模板保留项目内（不纳入 cf-core）
 * 发送管道（重试/超时/escapeHtml/remote/Resend/CF Email）由 cf-core EmailService 统一提供。
 *
 * 通道优先级：独立远程邮件网关 → cf-auth 邮件网关 → Cloudflare Email → Resend
 * 远程网关优先于 cf-auth，适配 VPS 生产部署；cf-auth 网关自动从 CF_AUTH_* 推导。
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
  /** 公开邮件链接使用的服务端配置域名，禁止信任请求 Host。 */
  appOrigin?: string;
  email?: CloudflareEmailBinding;
  /** 独立远程邮件网关；与 cf-auth 网关并存，适配 VPS 生产部署。 */
  remoteEmailUrl?: string;
  remoteEmailClientId?: string;
  remoteEmailClientSecret?: string;
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

/**
 * 私有工厂：按邮件环境构建 EmailService 实例。
 * 为什么提取（docs/196 M1）：sendEmail / sendAccessCode 重复构造 15 行，
 * 通道优先级（cf-auth 网关 → Resend → CF Email）必须单一实现，避免两处漂移。
 */
function createEmailService(emailEnv: EmailEnv): EmailService {
  const from = emailEnv.emailFromName
    ? `${emailEnv.emailFromName} <${emailEnv.emailFrom || "noreply@eforge.xyz"}>`
    : (emailEnv.emailFrom || "noreply@eforge.xyz");
  const remote = emailEnv.remoteEmailUrl && emailEnv.remoteEmailClientId && emailEnv.remoteEmailClientSecret
    ? {
        url: emailEnv.remoteEmailUrl,
        clientId: emailEnv.remoteEmailClientId,
        clientSecret: emailEnv.remoteEmailClientSecret,
      }
    : emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret
      ? {
          url: `${emailEnv.cfAuthIssuer}/api/email/send`,
          clientId: emailEnv.cfAuthClientId,
          clientSecret: emailEnv.cfAuthClientSecret,
        }
      : undefined;
  return new EmailService({
    ...(remote ? { remote } : {}),
    ...(emailEnv.resendApiKey ? { apiKey: emailEnv.resendApiKey } : {}),
    ...(emailEnv.email ? { emailBinding: emailEnv.email } : {}),
    from,
  });
}

export async function sendEmail(
  emailEnv: EmailEnv,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const tpl = templates[input.template];
  if (!tpl) return { ok: false, message: `模板不存在: ${input.template}` };
  const subject = templateSubjects[input.template] || "通知";
  const html = interpolate(tpl, input.templateData);

  const svc = createEmailService(emailEnv);
  const result = await svc.send({ to: input.to, subject, html });
  return { ok: result.ok, message: result.error || result.messageId, id: result.messageId };
}

export async function sendAccessCode(
  emailEnv: EmailEnv,
  to: string, drawName: string, code: string,
): Promise<{ ok: boolean; message: string }> {
  const html = interpolate(emailAccessCodeHtml, { drawName, code });

  const svc = createEmailService(emailEnv);
  const result = await svc.send({ to, subject: "您的抽奖验证码", html });
  return { ok: result.ok, message: result.error || "发送成功" };
}
