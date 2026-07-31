/**
 * 全员推广：当前用户「自己的」推荐码（用于商品页复制出站链）。
 * - 仅在 /refer 验证邮箱并拿到码后写入
 * - **禁止**用会话入站归因（别人的 ref）冒充自己的码
 */
const STORAGE_KEY = 'member_share_referral_code'

export function getMemberShareReferralCode(): string {
  try {
    return String(localStorage.getItem(STORAGE_KEY) || '').trim().toLowerCase()
  } catch {
    return ''
  }
}

export function setMemberShareReferralCode(code: string): void {
  const normalized = String(code || '').trim().toLowerCase()
  try {
    if (normalized) localStorage.setItem(STORAGE_KEY, normalized)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * 商品确认层「复制链接」出站归因：
 * - 有自己的推广码 → 只带 ref=自己的码（不复播入站别人的 ref，不带 campaign）
 * - 无码 → 净商品链（无归因参数）
 */
export function resolveOutboundShareAttribution(): { referralCode?: string } {
  const mine = getMemberShareReferralCode()
  return mine ? { referralCode: mine } : {}
}
