/**
 * 平台（QQ 群）出站消息模板（docs/167 出站方向）
 *
 * 设计要点：
 * - 与 email 模板（src/services/templates/）分离：QQ 群是纯文本环境，
 *   不能复用邮件模板的 HTML 结构。
 * - 复用 cf-core interpolate 的 {{#if}} 块语法，但**不做 HTML 转义**：
 *   QQ 纯文本若把 &、<、> 转义成实体，群友看到的是乱码。
 *   因此这里提供 renderPlatformTextTemplate()（无转义版本）。
 * - 模板是固定集合，事件类型与模板一一对应；新增事件先在
 *   src/services/lottery/types.ts 的 PLATFORM_EVENT_TYPES 注册。
 */
export const PLATFORM_EVENT_TYPES_SET = new Set([
  "draw.published",
  "draw.completed",
  "entry.created",
  "outcome.assigned",
  "prize.issued",
  "reward.earned",
  "penalty.requested",
  "share.created",
  "checkin.completed",
]);

export type PlatformEventType =
  | "draw.published"
  | "draw.completed"
  | "entry.created"
  | "outcome.assigned"
  | "prize.issued"
  | "reward.earned"
  | "penalty.requested"
  | "share.created"
  | "checkin.completed";

/**
 * 纯文本渲染（无 HTML 转义）。
 * 与 cf-core interpolate 的差异：值替换不做 escapeHtml，其余语法一致。
 */
export function renderPlatformTextTemplate(template: string, data: Record<string, string>): string {
  return template
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) =>
      (data[key] && String(data[key]) !== "" ? content : ""),
    )
    .replace(/\{\{(\w+)\}\}/g, (_, key) => String(data[key] ?? ""));
}

/** 各事件类型的默认模板文案（P0 覆盖核心事件，其余沿用通用兜底） */
export const PLATFORM_EVENT_TEMPLATES: Record<PlatformEventType, string> = {
  "draw.published": "🎉 活动已发布：{{drawName}}\n{{#if drawAt}}开奖时间：{{drawAt}}{{/if}}\n{{#if shareUrl}}立即参与：{{shareUrl}}{{/if}}",
  "draw.completed": "🏁 活动「{{drawName}}」已开奖\n{{#if winnerSummary}}{{winnerSummary}}{{/if}}",
  "entry.created": "✅ {{userName}} 已成功参与「{{drawName}}」\n{{#if shareUrl}}邀请好友提高权重：{{shareUrl}}{{/if}}",
  "outcome.assigned": "🎉 恭喜 {{userName}} 在「{{drawName}}」中奖！\n奖品：{{prizeName}}\n{{#if prizeValue}}价值：{{prizeValue}}\n{{/if}}{{#if claimHint}}{{claimHint}}{{/if}}",
  "prize.issued": "📦 奖品已发放：{{userName}} 获得「{{prizeName}}」{{#if orderNo}}（编号 {{orderNo}}）{{/if}}",
  "reward.earned": "🎁 {{userName}} 通过分享获得奖励：{{rewardLabel}}{{#if rewardValue}}（{{rewardValue}}）{{/if}}",
  "penalty.requested": "⚠️ 成员离开群，已触发活动相关处理。{{#if penaltyDetail}}{{penaltyDetail}}{{/if}}",
  "share.created": "📣 {{userName}} 分享活动，{{#if gainUserName}}{{gainUserName}}{{/if}}获得额外权重！",
  "checkin.completed": "☀️ {{userName}} 签到成功！{{#if bonusText}}{{bonusText}}{{/if}}",
};

/** 渲染某事件类型的出站消息 */
export function renderPlatformEventMessage(
  eventType: PlatformEventType,
  data: Record<string, string>,
): string {
  const template = PLATFORM_EVENT_TEMPLATES[eventType] ?? "{{#if summary}}{{summary}}{{/if}}";
  return renderPlatformTextTemplate(template, data);
}