/**
 * cf-auth 登录启动（浏览器侧，docs/059）。
 * PKCE verifier / state 仅放 sessionStorage；client_secret 不在前端。
 */
import { ref } from 'vue'

/** 与 AuthCallbackView 共享的 session key */
export const CF_AUTH_PKCE_KEY = 'cf_auth_pkce_verifier'
export const CF_AUTH_STATE_KEY = 'cf_auth_oauth_state'
export const CF_AUTH_RETURN_KEY = 'cf_auth_return_to'

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
  sessionStorage.removeItem(CF_AUTH_PKCE_KEY)
  sessionStorage.removeItem(CF_AUTH_STATE_KEY)
  sessionStorage.removeItem(CF_AUTH_RETURN_KEY)
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

/**
 * 跳转 cf-auth authorize（PKCE）。
 * @param returnTo 回调成功后前端路由
 */
export async function startCfAuthLogin(returnTo = '/admin'): Promise<void> {
  const meta = await fetchCfAuthMeta()
  if (!meta) {
    throw new Error('cf-auth 未启用')
  }
  const { verifier, challenge } = await browserPkce()
  const state = browserState()
  sessionStorage.setItem(CF_AUTH_PKCE_KEY, verifier)
  sessionStorage.setItem(CF_AUTH_STATE_KEY, state)
  sessionStorage.setItem(CF_AUTH_RETURN_KEY, returnTo)

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

  async function login(returnTo?: string) {
    loading.value = true
    try {
      const target =
        returnTo ||
        `${window.location.pathname}${window.location.search}` ||
        '/admin'
      await startCfAuthLogin(target)
    } finally {
      loading.value = false
    }
  }

  return { enabled, loading, checked, refresh, login }
}
