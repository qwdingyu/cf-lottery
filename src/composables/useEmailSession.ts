import { computed, ref } from 'vue'

export type EmailSessionPayload = {
  token: string
  email: string
  expiresInSeconds?: number
}

type StoredEmailSession = {
  token: string
  email: string
  expiresAt: number
}

const STORAGE_KEY = 'cf_shop_email_session_v1'
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const current = ref<StoredEmailSession | null>(readStored())

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function readStored(): StoredEmailSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as StoredEmailSession | null
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.email !== 'string' || typeof parsed.expiresAt !== 'number') return null
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return { token: parsed.token, email: normalizeEmail(parsed.email), expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

function persist(next: StoredEmailSession | null) {
  current.value = next
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // localStorage 不可用时只保留当前标签页内存状态。
  }
}

export function useEmailSession() {
  function refresh() {
    current.value = readStored()
    return current.value
  }

  function saveEmailSession(payload?: EmailSessionPayload | null) {
    if (!payload?.token || !payload.email) return
    const ttlSeconds = Number(payload.expiresInSeconds || DEFAULT_TTL_SECONDS)
    persist({
      token: payload.token,
      email: normalizeEmail(payload.email),
      expiresAt: Date.now() + Math.max(60, ttlSeconds) * 1000,
    })
  }

  function clearEmailSession() {
    persist(null)
  }

  function getEmailSession(): StoredEmailSession | null {
    return refresh()
  }

  function sessionForEmail(email: string): StoredEmailSession | null {
    const stored = refresh()
    return stored && stored.email === normalizeEmail(email) ? stored : null
  }

  return {
    emailSession: computed(() => refresh()),
    getEmailSession,
    saveEmailSession,
    clearEmailSession,
    sessionForEmail,
  }
}
