/**
 * cf-auth 登录启动（浏览器侧，docs/059）。
 * PKCE verifier / state 仅放 sessionStorage；client_secret 不在前端。
 * 参与闭环：跳转前可写入 pendingJoin，回调后 LotteryView 自动 verify-join。
 */
import { ref } from 'vue'
import {
  CF_AUTH_PKCE_KEY,
  CF_AUTH_RETURN_KEY,
  CF_AUTH_STATE_KEY,
  clearAllCfAuthBrowserState,
  saveCfAuthPendingJoin,
  type CfAuthPendingJoin,
} from './cf-auth-session'

export {
  CF_AUTH_PKCE_KEY,
  CF_AUTH_STATE_KEY,
  CF_AUTH_RETURN_KEY,
  CF_AUTH_PENDING_JOIN_KEY,
  LOTTERY_REGISTERED_TOKEN_KEY,
  LOTTERY_SESSION_EMAIL_KEY,
  applyCfAuthSessionToLottery,
  consumeCfAuthPendingJoin,
  readCfAuthPendingJoin,
  saveCfAuthPendingJoin,
  type CfAuthPendingJoin,
} from './cf-auth-session'

export type CfAuthMeta = {
  enabled: boolean
  issuer: string
  clientId: string
  redirectUri: string
  scopes: string
  authorizeUrl: string
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** 浏览器 PKCE S256（与后端 createPkcePair 算法一致） */
async function browserPkce(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const verifier = b64url(raw)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = b64url(new Uint8Array(digest))
  return { verifier, challenge }
}

function browserState(): string {
  const raw = new Uint8Array(16)
  crypto.getRandomValues(raw)
  return b64url(raw)
}

export function clearCfAuthPending() {
  clearAllCfAuthBrowserState(sessionStorage)
}

/** 拉取 meta；未启用返回 null */
export async function fetchCfAuthMeta(): Promise<CfAuthMeta | null> {
  try {
    const res = await fetch('/api/auth/cf-auth/meta')
    if (!res.ok) return null
    const data = (await res.json()) as CfAuthMeta & { ok?: boolean }
    if (!data.enabled || !data.clientId || !data.issuer) return null
    return data
  } catch {
    return null
  }
}

export type StartCfAuthLoginOpts = {
  returnTo?: string
  /** 参与页跳转前写入，OAuth 回来后自动 join */
  pendingJoin?: CfAuthPendingJoin
}

/**
 * 跳转 cf-auth authorize（PKCE）。
 * @param returnToOrOpts 回调成功后前端路由，或含 pendingJoin 的选项
 */
export async function startCfAuthLogin(returnToOrOpts: string | StartCfAuthLoginOpts = '/admin'): Promise<void> {
  const opts: StartCfAuthLoginOpts =
    typeof returnToOrOpts === 'string' ? { returnTo: returnToOrOpts } : returnToOrOpts || {}
  const returnTo = opts.returnTo || '/admin'

  const meta = await fetchCfAuthMeta()
  if (!meta) {
    throw new Error('cf-auth 未启用')
  }
  const { verifier, challenge } = await browserPkce()
  const state = browserState()
  sessionStorage.setItem(CF_AUTH_PKCE_KEY, verifier)
  sessionStorage.setItem(CF_AUTH_STATE_KEY, state)
  sessionStorage.setItem(CF_AUTH_RETURN_KEY, returnTo)
  if (opts.pendingJoin?.drawId) {
    saveCfAuthPendingJoin(sessionStorage, {
      ...opts.pendingJoin,
      returnPath: opts.pendingJoin.returnPath || returnTo,
    })
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: meta.clientId,
    redirect_uri: meta.redirectUri,
    scope: meta.scopes || 'openid profile email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  const url = `${meta.issuer.replace(/\/$/, '')}/api/auth/oauth2/authorize?${params}`
  window.location.assign(url)
}

/** 组合式：按钮 loading + 是否启用 */
export function useCfAuthLogin() {
  const enabled = ref(false)
  const loading = ref(false)
  const checked = ref(false)

  async function refresh() {
    const meta = await fetchCfAuthMeta()
    enabled.value = Boolean(meta?.enabled)
    checked.value = true
  }

  async function login(returnToOrOpts?: string | StartCfAuthLoginOpts) {
    loading.value = true
    try {
      if (typeof returnToOrOpts === 'object' && returnToOrOpts) {
        await startCfAuthLogin({
          ...returnToOrOpts,
          returnTo:
            returnToOrOpts.returnTo ||
            `${window.location.pathname}${window.location.search}` ||
            '/admin',
        })
      } else {
        const target =
          (typeof returnToOrOpts === 'string' && returnToOrOpts) ||
          `${window.location.pathname}${window.location.search}` ||
          '/admin'
        await startCfAuthLogin(target)
      }
    } finally {
      loading.value = false
    }
  }

  return { enabled, loading, checked, refresh, login }
}
