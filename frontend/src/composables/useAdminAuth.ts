import { ref, computed } from 'vue'

const TOKEN_KEY = 'admin_token'
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

/** 管理端登录态：基于 localStorage 的轻量实现，session token 含8小时过期 */
export function useAdminAuth() {
  const token = ref<string>(readAdminToken())

  const isLoggedIn = computed(() => !!token.value)

  function setToken(value: string) {
    const stored: StoredToken = { token: value, expiry: Date.now() + TOKEN_TTL_MS }
    token.value = value
    localStorage.setItem(TOKEN_KEY, JSON.stringify(stored))
  }

  function clearToken() {
    token.value = ''
    localStorage.removeItem(TOKEN_KEY)
  }

  return {
    token,
    isLoggedIn,
    setToken,
    clearToken,
  }
}
