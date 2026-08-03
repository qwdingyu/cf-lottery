<template>
  <div class="auth-callback">
    <div class="auth-callback-card">
      <h1>{{ $t('authCallback.title') }}</h1>
      <p v-if="status === 'working'" class="muted">{{ $t('authCallback.working') }}</p>
      <p v-else-if="status === 'ok'" class="ok">{{ $t('authCallback.ok') }}</p>
      <p v-else class="err" role="alert">{{ error || $t('authCallback.failed') }}</p>
      <button v-if="status === 'error'" type="button" class="btn btn-primary" @click="goHome">
        {{ $t('authCallback.back') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * cf-auth OAuth 回调页（docs/059）。
 * 浏览器只携带 code；code_verifier 来自 sessionStorage；secret 永不上前端。
 *
 * 参与闭环（skeptic 修复）：
 * - 除 admin_token 外，必须写入 lottery_registered_token，公开页 Bearer 才可见。
 * - pendingJoin 保留在 sessionStorage，回活动页后由 LotteryView 自动 verify-join。
 */
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import {
  CF_AUTH_PKCE_KEY,
  CF_AUTH_STATE_KEY,
  applyCfAuthSessionToLottery,
  clearCfAuthOauthTransit,
  clearAllCfAuthBrowserState,
  readCfAuthPendingJoin,
  resolveCfAuthReturnPath,
} from '@/composables/cf-auth-session'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { showToast } = useToast()
const { setToken } = useAdminAuth()

const status = ref<'working' | 'ok' | 'error'>('working')
const error = ref('')

function goHome() {
  void router.replace('/')
}

onMounted(async () => {
  const code = String(route.query.code || '')
  const state = String(route.query.state || '')
  const oauthError = String(route.query.error || '')
  if (oauthError) {
    status.value = 'error'
    error.value = oauthError
    clearAllCfAuthBrowserState(sessionStorage)
    return
  }
  const expectedState = sessionStorage.getItem(CF_AUTH_STATE_KEY) || ''
  const verifier = sessionStorage.getItem(CF_AUTH_PKCE_KEY) || ''
  if (!code || !verifier) {
    status.value = 'error'
    error.value = t('authCallback.missingCode')
    clearAllCfAuthBrowserState(sessionStorage)
    return
  }
  if (expectedState && state && expectedState !== state) {
    status.value = 'error'
    error.value = t('authCallback.stateMismatch')
    clearAllCfAuthBrowserState(sessionStorage)
    return
  }
  // 先读 pending（不 consume）：失败时可重试；成功后再由 LotteryView consume
  const pending = readCfAuthPendingJoin(sessionStorage)
  const returnTo = resolveCfAuthReturnPath(sessionStorage, pending)
  try {
    const res = await fetch('/api/auth/cf-auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    })
    const data = (await res.json()) as {
      ok?: boolean
      token?: string
      email?: string
      message?: string
    }
    if (!res.ok || !data.ok || !data.token) {
      status.value = 'error'
      error.value = data.message || t('authCallback.failed')
      // 交换失败：清 PKCE，保留 pendingJoin 便于用户回到活动页再点登录
      clearCfAuthOauthTransit(sessionStorage)
      return
    }
    // 1) 管理端 localStorage admin_token
    setToken(data.token)
    // 2) 参与端 sessionStorage：registered_token + session email（公开 Bearer 路径）
    applyCfAuthSessionToLottery(sessionStorage, {
      token: data.token,
      email: data.email,
    })
    // 3) 清 PKCE/state/return；pendingJoin 留给 LotteryView 自动参与后 consume
    clearCfAuthOauthTransit(sessionStorage)
    // return key 已被 clear；用已解析的 returnTo
    status.value = 'ok'
    showToast(t('authCallback.ok'), 'success')
    await router.replace(returnTo.startsWith('/') ? returnTo : '/admin')
  } catch {
    status.value = 'error'
    error.value = t('authCallback.network')
    clearCfAuthOauthTransit(sessionStorage)
  }
})
</script>

<style scoped>
.auth-callback {
  min-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.auth-callback-card {
  max-width: 420px;
  width: 100%;
  text-align: center;
}
.muted { opacity: 0.7; }
.ok { color: var(--success, #0a7); }
.err { color: var(--danger, #c33); }
</style>
