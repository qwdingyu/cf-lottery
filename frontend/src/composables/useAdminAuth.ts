import { ref, computed } from 'vue'

const TOKEN_KEY = 'admin_token'
const PLATFORM_ROLE_KEY = 'platform_role'
/** session token 有效期 8 小时，与后端 verify-jwt 颁发的 session JWT 一致 */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000

type StoredToken = { token: string; expiry: number }

/**
 * 解析 localStorage 中的 token 记录：
 * - 若未过期，返回 token 字符串
 * - 若已过期，自动清除并返回 ''
 * - 兼容旧版纯字符串格式（无 expiry 字段），视为永不过期（一次性迁移）
 */
function parseStoredToken(raw: string | null): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as StoredToken
    if (typeof parsed.token === 'string' && typeof parsed.expiry === 'number') {
      if (Date.now() < parsed.expiry) return parsed.token
      // 已过期：清除，不复用
      localStorage.removeItem(TOKEN_KEY)
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
 * 读取有效的 admin token（包含过期检查）。
 * 路由守卫在 setup 上下文外调用，需要这个纯函数版本。
 */
export function readAdminToken(): string {
  try {
    return parseStoredToken(localStorage.getItem(TOKEN_KEY))
  } catch {
    return ''
  }
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
  }

  function setPlatformRole(role: string | null, tokenRef: string) {
    platformRole.value = role
    localStorage.setItem(PLATFORM_ROLE_KEY, JSON.stringify({ value: role, tokenRef }))
  }

  function clearToken() {
    token.value = ''
    platformRole.value = undefined
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(PLATFORM_ROLE_KEY)
  }

  return {
    token,
    platformRole,
    isLoggedIn,
    isPlatformMember,
    setToken,
    setPlatformRole,
    clearToken,
  }
}
