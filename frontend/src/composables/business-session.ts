/**
 * 业务会话清理（纯函数，可 vitest）。
 *
 * 为什么独立：
 * - cf-auth exchange 会同时写 admin_token（localStorage）与 lottery_registered_*（sessionStorage）。
 * - 管理端「退出」若只清 admin，活动页仍像已登录；活动页「退出」不应误删管理后台会话。
 * - 不调用 IdP 全局登出（auth.eforge.xyz 会话独立；RP 业务 JWT 无服务端黑名单）。
 */
import {
  clearAllCfAuthBrowserState,
  LOTTERY_REGISTERED_TOKEN_KEY,
  LOTTERY_REGISTERED_USERNAME_KEY,
  LOTTERY_SESSION_EMAIL_KEY,
  type SessionStore,
} from './cf-auth-session'
import { clearJoinedHints } from '@/views/lottery/joined-session'

/** 与 useAdminAuth 保持同一 key，避免分叉 */
export const ADMIN_TOKEN_KEY = 'admin_token'
export const IMPERSONATION_TOKEN_KEY = 'impersonated_token'
export const PLATFORM_ROLE_KEY = 'platform_role'

/**
 * 仅清公开活动参与会话（sessionStorage）。
 * 用于 LotteryView「退出」：不碰管理端 admin_token。
 */
export function clearLotteryParticipationSession(store: SessionStore): void {
  store.removeItem(LOTTERY_REGISTERED_TOKEN_KEY)
  store.removeItem(LOTTERY_REGISTERED_USERNAME_KEY)
  store.removeItem(LOTTERY_SESSION_EMAIL_KEY)
  // 本机「已参与」UI 提示随参与会话清掉，避免换号后仍显示已参与（docs/098）
  clearJoinedHints(store)
}

/**
 * 仅清管理端 localStorage 会话键（含模拟登录与平台角色缓存）。
 */
export function clearAdminAuthStorage(store: SessionStore): void {
  store.removeItem(ADMIN_TOKEN_KEY)
  store.removeItem(IMPERSONATION_TOKEN_KEY)
  store.removeItem(PLATFORM_ROLE_KEY)
}

/**
 * 完整业务登出：管理端 + 参与端 + cf-auth OAuth 临时键。
 * Landing / Onboarding / Admin / Platform / 401 统一走这里。
 */
export function clearFullBusinessBrowserSession(input: {
  localStorage: SessionStore
  sessionStorage: SessionStore
}): void {
  clearAdminAuthStorage(input.localStorage)
  clearLotteryParticipationSession(input.sessionStorage)
  // 退出后不应再 resume pending join / 残留 PKCE
  clearAllCfAuthBrowserState(input.sessionStorage)
}

/**
 * 活动页退出：参与会话 + OAuth 临时态；保留 admin_token。
 * 避免运营者在活动预览页点退出后被踢出后台。
 */
export function clearLotteryBrowserSessionOnly(sessionStore: SessionStore): void {
  clearLotteryParticipationSession(sessionStore)
  clearAllCfAuthBrowserState(sessionStore)
}
