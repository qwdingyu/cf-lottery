/**
 * 邮箱/短信 OTP 输入规范化（纯函数，可 vitest）。
 *
 * 与参与页 LotteryView 行为对齐（docs/055a P1）：
 * - 只保留数字，最长 6 位（后端注册/参与码均为 6 位）
 * - 便于 SMS/邮件自动填充后触发「满 6 位自动提交」
 */
export const OTP_CODE_LENGTH = 6;

/** 去掉非数字并截断到 OTP 长度 */
export function normalizeOtpDigits(raw: string, maxLen = OTP_CODE_LENGTH): string {
  return String(raw || "").replace(/\D/g, "").slice(0, maxLen);
}

/** 是否已满位、可触发自动提交 */
export function isOtpComplete(digits: string, maxLen = OTP_CODE_LENGTH): boolean {
  return digits.length === maxLen;
}
