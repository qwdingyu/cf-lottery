import { ref, computed } from 'vue'
import {
  ADMIN_TOKEN_KEY,
  IMPERSONATION_TOKEN_KEY,
  PLATFORM_ROLE_KEY,
  clearFullBusinessBrowserSession,
} from './business-session'
import { normalizePlatformRoleFromApi } from './platform-access'

const TOKEN_KEY = ADMIN_TOKEN_KEY
// 模拟登录会话独立 key（L3→L2 路径）：
// 平台运营者模拟租户身份时写入独立 key，不覆盖运营者自己的 admin_token，
// 保证运营者能随时清除模拟态返回平台（详情见 docs/049 §10 L3→L2 路径闭环）。
const IMPERSONATION_KEY = IMPERSONATION_TOKEN_KEY
/** session token 有效期 8 小时，与后端 verify-jwt 颁发的 session JWT 一致 */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000

type StoredToken = { token: string; expiry: number }

/**
 * 解析 localStorage 中的 token 记录：
 * - 若未过期，返回 token 字符串
 * - 若已过期，自动清除并返回 ''
 * - 兼容旧版纯字符串格式（无 expiry 字段），视为永不过期（一次性迁移）
 *
 * @param key 记录所在 localStorage key（过期时按 key 清除）
 */
function parseStoredToken(raw: string | null, key: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as StoredToken
    if (typeof parsed.token === 'string' && typeof parsed.expiry === 'number') {
      if (Date.now() < parsed.expiry) return parsed.token
      // 已过期：清除，不复用
      localStorage.removeItem(key)
      return ''
    }
    // 格式不匹配（旧版纯字符串被 JSON.parse 但结构不对）
    return ''
  } catch {
    // 旧版纯字符串格式：向后兼容，不清除（本次 session 内仍可用）
    return raw
  }
}

/**
 * 读取当前生效的 token（包含过期检查）：
 * 模拟登录会话（impersonated_token）优先——平台运营者模拟租户身份时，
 * L2 后台 API 全部使用模拟身份；无模拟态时回退到自己的 admin_token。
 * 路由守卫在 setup 上下文外调用，需要这个纯函数版本。
 */
export function readAdminToken(): string {
  try {
    const impersonated = parseStoredToken(localStorage.getItem(IMPERSONATION_KEY), IMPERSONATION_KEY)
    if (impersonated) return impersonated
    return parseStoredToken(localStorage.getItem(TOKEN_KEY), TOKEN_KEY)
  } catch {
    return ''
  }
}

/** 是否处于平台运营者模拟登录状态（存在且未过期的 impersonated_token） */
export function isImpersonating(): boolean {
  try {
    return !!parseStoredToken(localStorage.getItem(IMPERSONATION_KEY), IMPERSONATION_KEY)
  } catch {
    return false
  }
}

/** 清除模拟登录态：删除 impersonated_token，回到运营者自己的会话（用于"返回平台"） */
export function clearImpersonation(): void {
  try {
    localStorage.removeItem(IMPERSONATION_KEY)
  } catch { /* ignore */ }
}

/**
 * 读取本地缓存的平台角色（路由守卫用）。
 * 值为 null 表示非平台成员，undefined 表示尚未从 API 获取。
 * 与 token 一起清除，避免 token 切换后残留旧角色的平台入口。
 */
export function readPlatformRole(): string | null | undefined {
  const raw = localStorage.getItem(PLATFORM_ROLE_KEY)
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as { value: string | null; tokenRef: string }
    // 只信任与当前 token 绑定的角色信息，防止 switch-account 残留
    if (parsed.tokenRef && parsed.tokenRef === readAdminToken()) {
      return parsed.value
    }
  } catch { /* ignore */ }
  return undefined
}

/**
 * 写入平台角色缓存（与当前 admin token 绑定）。
 * 供登录流、路由守卫、布局共用，避免各处手写 localStorage 分叉。
 */
export function writePlatformRole(role: string | null, tokenRef: string): void {
  try {
    localStorage.setItem(PLATFORM_ROLE_KEY, JSON.stringify({ value: role, tokenRef }))
  } catch { /* 隐私模式等 */ }
}

/**
 * 向服务端解析当前用户是否为活跃 L3，并写入缓存。
 *
 * 为何用 /api/auth/me 而非 /api/admin/me：
 * - admin/me 挂 requireTenantMember，无租户的 L3 会 403，角色永远写不进缓存
 * - auth/me 仅 requireAuth，L3/L2 均可解析 platformRole
 *
 * @returns 活跃角色字符串 | null（确认非 L3）| undefined（网络等未决，不写死 null）
 */
export async function ensurePlatformRole(
  token: string,
  options?: { fetchImpl?: typeof fetch; force?: boolean },
): Promise<string | null | undefined> {
  if (!token) return null
  if (!options?.force) {
    const cached = readPlatformRole()
    // 已与 token 绑定的缓存（含 null）直接返回，避免重复打 me
    if (cached !== undefined) return cached
  }

  const fetchImpl = options?.fetchImpl ?? fetch
  try {
    const res = await fetchImpl('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await res.json().catch(() => (null))) as {
      ok?: boolean
      platformRole?: string | null
      message?: string
    } | null

    if (res.status === 401) {
      writePlatformRole(null, token)
      return null
    }
    if (!res.ok || !data?.ok) {
      // 非 401 失败：不固化 null，允许重试；平台路由仍按 fail-closed 拒壳
      return undefined
    }

    const role = normalizePlatformRoleFromApi(data.platformRole)
    writePlatformRole(role, token)
    return role
  } catch {
    return undefined
  }
}

/** 管理端登录态：基于 localStorage 的轻量实现，session token 含8小时过期 */
export function useAdminAuth() {
  const token = ref<string>(readAdminToken())
  const platformRole = ref<string | null | undefined>(readPlatformRole())

  const isLoggedIn = computed(() => !!token.value)
  /** 当前用户是否是活跃平台成员 */
  const isPlatformMember = computed(() => !!platformRole.value)

  function setToken(value: string) {
    const stored: StoredToken = { token: value, expiry: Date.now() + TOKEN_TTL_MS }
    token.value = value
    localStorage.setItem(TOKEN_KEY, JSON.stringify(stored))
    // 新登录/切换身份后清除残留的模拟态，避免旧模拟会话影响新会话
    clearImpersonation()
    // token 已变：旧 platform_role 的 tokenRef 失效；ref 置 unknown，等 ensure 再填
    platformRole.value = undefined
  }

  function setPlatformRole(role: string | null, tokenRef: string) {
    platformRole.value = role
    writePlatformRole(role, tokenRef)
  }

  /**
   * 完整业务登出（管理端 UI / 401 共用）。
   * 同时清参与 session 与 cf-auth 临时键，避免 cf-auth 双写后「退出后台仍像活动已登录」。
   * 不调用 IdP 全局登出（无共享 BA cookie）。
   */
  function clearToken() {
    token.value = ''
    platformRole.value = undefined
    try {
      clearFullBusinessBrowserSession({
        localStorage,
        sessionStorage,
      })
    } catch {
      // 隐私模式等极端情况：至少尝试清管理端键
      try {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(IMPERSONATION_KEY)
        localStorage.removeItem(PLATFORM_ROLE_KEY)
      } catch { /* ignore */ }
    }
  }

  return {
    token,
    platformRole,
    isLoggedIn,
    isPlatformMember,
    setToken,
    setPlatformRole,
    clearToken,
    isImpersonating,
    clearImpersonation,
    /** 布局/登录后刷新 L3 缓存并同步本实例 ref */
    async refreshPlatformRole(opts?: { force?: boolean }) {
      const t = token.value || readAdminToken()
      if (!t) {
        platformRole.value = null
        return null
      }
      const role = await ensurePlatformRole(t, { force: opts?.force })
      if (role !== undefined) platformRole.value = role
      else platformRole.value = readPlatformRole()
      return role
    },
  }
}
