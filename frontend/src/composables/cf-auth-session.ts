/**
 * cf-auth OAuth 往返会话（纯函数，docs/059 参与闭环）。
 *
 * 为什么独立：
 * - AuthCallback 必须把业务 JWT 写入 lottery_registered_token，
 *   参与页 verify-join / access-code 只认 sessionStorage，不认 admin_token。
 * - 跳转 IdP 会卸掉 Vue 状态，pendingJoin 必须跨页持久化。
 * - vitest 可直接驱动本模块，禁止只在 SFC 里“写死成功路径”。
 */

/** 与 useCfAuthLogin / AuthCallback 共享的 PKCE 键 */
export const CF_AUTH_PKCE_KEY = 'cf_auth_pkce_verifier'
export const CF_AUTH_STATE_KEY = 'cf_auth_oauth_state'
export const CF_AUTH_RETURN_KEY = 'cf_auth_return_to'

/** 跨 OAuth 往返保留的参与意图（JSON） */
export const CF_AUTH_PENDING_JOIN_KEY = 'cf_auth_pending_join'

/** 参与页 JWT / 邮箱会话键（与 LotteryView 一致） */
export const LOTTERY_REGISTERED_TOKEN_KEY = 'lottery_registered_token'
export const LOTTERY_REGISTERED_USERNAME_KEY = 'lottery_registered_username'
export const LOTTERY_SESSION_EMAIL_KEY = 'lottery_session_email'

export type CfAuthPendingJoin = {
  /** 公开 slug 或活动 id（与 LotteryView pendingJoinDrawId 对齐） */
  drawId: string
  accessPassword?: string
  inviteCode?: string
  refCode?: string
  /** 回调成功后优先回跳的路径（通常含 /lottery/:slug） */
  returnPath?: string
}

export type CfAuthExchangeSuccess = {
  token: string
  email?: string
  /** 展示名；缺省用 email 本地部分 */
  displayName?: string
}

/** 最小 Storage 面，便于 vitest 注入 Map 模拟 */
export type SessionStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 保存参与意图（startCfAuth 跳转前调用） */
export function saveCfAuthPendingJoin(store: SessionStore, pending: CfAuthPendingJoin): void {
  const drawId = String(pending.drawId || '').trim()
  if (!drawId) {
    store.removeItem(CF_AUTH_PENDING_JOIN_KEY)
    return
  }
  const payload: CfAuthPendingJoin = {
    drawId,
    accessPassword: pending.accessPassword ? String(pending.accessPassword) : undefined,
    inviteCode: pending.inviteCode ? String(pending.inviteCode) : undefined,
    refCode: pending.refCode ? String(pending.refCode) : undefined,
    returnPath: pending.returnPath ? String(pending.returnPath) : undefined,
  }
  store.setItem(CF_AUTH_PENDING_JOIN_KEY, JSON.stringify(payload))
}

/** 只读 pending（不删除） */
export function readCfAuthPendingJoin(store: SessionStore): CfAuthPendingJoin | null {
  const raw = store.getItem(CF_AUTH_PENDING_JOIN_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CfAuthPendingJoin
    if (!parsed?.drawId || typeof parsed.drawId !== 'string') return null
    return {
      drawId: parsed.drawId,
      accessPassword: parsed.accessPassword ? String(parsed.accessPassword) : undefined,
      inviteCode: parsed.inviteCode ? String(parsed.inviteCode) : undefined,
      refCode: parsed.refCode ? String(parsed.refCode) : undefined,
      returnPath: parsed.returnPath ? String(parsed.returnPath) : undefined,
    }
  } catch {
    return null
  }
}

/** 读取并清除 pending（消费一次） */
export function consumeCfAuthPendingJoin(store: SessionStore): CfAuthPendingJoin | null {
  const pending = readCfAuthPendingJoin(store)
  store.removeItem(CF_AUTH_PENDING_JOIN_KEY)
  return pending
}

/**
 * exchange 成功后写入参与可见会话。
 * - lottery_registered_token：verify-join / access-code Bearer
 * - lottery_session_email：展示与 open 模式 email 对齐
 * 不写 admin_token（由 AuthCallback 另调 setToken）。
 */
export function applyCfAuthSessionToLottery(
  store: SessionStore,
  success: CfAuthExchangeSuccess,
): { token: string; email: string; displayName: string } {
  const token = String(success.token || '').trim()
  if (!token) {
    throw new Error('cf-auth exchange 缺少 token')
  }
  const email = String(success.email || '').trim()
  const displayName =
    String(success.displayName || '').trim() ||
    (email.includes('@') ? email.split('@')[0]! : email) ||
    'cf-auth'
  store.setItem(LOTTERY_REGISTERED_TOKEN_KEY, token)
  store.setItem(LOTTERY_REGISTERED_USERNAME_KEY, displayName)
  if (email) {
    store.setItem(LOTTERY_SESSION_EMAIL_KEY, email)
  }
  return { token, email, displayName }
}

/** 清除 PKCE / state / return（不碰 pendingJoin，便于失败重试策略由调用方决定） */
export function clearCfAuthOauthTransit(store: SessionStore): void {
  store.removeItem(CF_AUTH_PKCE_KEY)
  store.removeItem(CF_AUTH_STATE_KEY)
  store.removeItem(CF_AUTH_RETURN_KEY)
}

/** 清除全部 cf-auth 临时键（含 pending） */
export function clearAllCfAuthBrowserState(store: SessionStore): void {
  clearCfAuthOauthTransit(store)
  store.removeItem(CF_AUTH_PENDING_JOIN_KEY)
}

/**
 * 解析回调成功后的回跳路径。
 * 优先 pending.returnPath，其次 CF_AUTH_RETURN_KEY，默认 /admin。
 */
export function resolveCfAuthReturnPath(
  store: SessionStore,
  pending: CfAuthPendingJoin | null,
): string {
  const fromPending = pending?.returnPath?.trim()
  if (fromPending && fromPending.startsWith('/')) return fromPending
  const fromKey = store.getItem(CF_AUTH_RETURN_KEY)?.trim()
  if (fromKey && fromKey.startsWith('/')) return fromKey
  return '/admin'
}

/**
 * 构造 verify-join 请求体（open/password/invite 等 + Bearer 跳过验证码）。
 * registered 模式 LotteryView 仍走 access-code；本函数供 open 系自动参与。
 */
export function buildCfAuthVerifyJoinBody(input: {
  email: string
  pending: CfAuthPendingJoin
  submission?: unknown
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    email: String(input.email || '').trim(),
    code: '',
  }
  if (input.pending.accessPassword) body.accessPassword = input.pending.accessPassword
  if (input.pending.inviteCode) body.inviteCode = input.pending.inviteCode
  if (input.pending.refCode) body.refCode = input.pending.refCode
  if (input.submission !== undefined) body.submission = input.submission
  return body
}

/**
 * 是否应在活动页自动 resume join。
 * 条件：有 pending.drawId 且有业务 JWT（session 或传入）。
 * 故意不 consume：失败时保留 pending，便于补密码/重试。
 */
export function shouldResumeCfAuthJoin(input: {
  pending: CfAuthPendingJoin | null
  token: string
}): boolean {
  const drawId = String(input.pending?.drawId || '').trim()
  const token = String(input.token || '').trim()
  return Boolean(drawId && token)
}

/**
 * 从业务 JWT payload 粗读 tenantId（不验签；仅前端路由分流）。
 * 无租户 → 管理端应进 onboarding（与 router jwtTenantId 对齐）。
 */
export function readTenantIdFromBusinessJwt(token: string): string {
  const raw = String(token || '').trim()
  if (!raw) return ''
  try {
    const parts = raw.split('.')
    if (parts.length < 2 || !parts[1]) return ''
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = atob(b64 + pad)
    const payload = JSON.parse(json) as { tenantId?: unknown }
    return typeof payload.tenantId === 'string' ? payload.tenantId.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 管理端回跳：无 tenant 且目标是后台时强制 onboarding。
 * 参与页路径（/lottery…）原样返回，不打断 join 闭环。
 */
export function resolveAdminPathAfterCfAuth(input: {
  token: string
  returnPath: string
}): string {
  const ret = String(input.returnPath || '').trim()
  const path = ret.startsWith('/') ? ret : '/admin'
  // 参与闭环优先：带 pending 回活动页时不改写
  if (path.startsWith('/lottery') || path.startsWith('/auth/')) {
    return path
  }
  if (!readTenantIdFromBusinessJwt(input.token)) {
    return '/admin/onboarding'
  }
  return path
}

/**
 * AuthCallback 最终落地路径（与 AuthCallbackView 同源，便于 vitest）。
 *
 * 优先级：
 * 1. API `needsTenant===true` 且回跳非参与页 → `/admin/onboarding`
 * 2. 否则 `resolveAdminPathAfterCfAuth`（JWT tenantId 粗读兜底）
 */
export function resolveCfAuthCallbackLanding(input: {
  token: string
  returnPath: string
  needsTenant?: boolean
}): string {
  const baseReturn = String(input.returnPath || '').trim()
  const path = baseReturn.startsWith('/') ? baseReturn : '/admin'
  if (input.needsTenant === true && !path.startsWith('/lottery')) {
    return '/admin/onboarding'
  }
  return resolveAdminPathAfterCfAuth({
    token: input.token,
    returnPath: path,
  })
}

/**
 * password / invite 模式跳转 IdP 前的凭证完整性（纯函数，供 vitest）。
 * participationMode 未知时不拦（由 UI 层再校验）。
 */
export function missingJoinCredentialForMode(input: {
  participationMode?: string | null
  accessPassword?: string
  inviteCode?: string
}): 'password' | 'invite' | null {
  const mode = String(input.participationMode || '').trim()
  if (mode === 'password' && !String(input.accessPassword || '').trim()) return 'password'
  if (mode === 'invite_code' && !String(input.inviteCode || '').trim()) return 'invite'
  return null
}
