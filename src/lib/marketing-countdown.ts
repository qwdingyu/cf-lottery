/**
 * 限时营销倒计时格式化
 *
 * 只用于商品卡片和确认层的前端展示，不影响支付、报价、库存或订单金额。
 * 输入为 ISO 字符串，输出为 i18n 格式的倒计时文本。
 * 如果已过期或无效，返回空字符串，调用方应隐藏组件。
 */
export function formatMarketingCountdown(
  endsAt: string,
  nowMs: number,
  t: (key: string, params?: Record<string, number>) => string,
): string {
  const ms = Date.parse(endsAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return t("productCard.marketingEndsMinutes", { minutes });
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return t("productCard.marketingEndsHours", { hours });
  const days = Math.ceil(hours / 24);
  return t("productCard.marketingEndsDays", { days });
}