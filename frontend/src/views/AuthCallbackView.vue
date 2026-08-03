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
 */
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import {
  CF_AUTH_PKCE_KEY,
  CF_AUTH_RETURN_KEY,
  CF_AUTH_STATE_KEY,
  clearCfAuthPending,
} from '@/composables/useCfAuthLogin'

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
    clearCfAuthPending()
    return
  }
  const expectedState = sessionStorage.getItem(CF_AUTH_STATE_KEY) || ''
  const verifier = sessionStorage.getItem(CF_AUTH_PKCE_KEY) || ''
  const returnTo = sessionStorage.getItem(CF_AUTH_RETURN_KEY) || '/admin'
  if (!code || !verifier) {
    status.value = 'error'
    error.value = t('authCallback.missingCode')
    clearCfAuthPending()
    return
  }
  if (expectedState && state && expectedState !== state) {
    status.value = 'error'
    error.value = t('authCallback.stateMismatch')
    clearCfAuthPending()
    return
  }
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
      clearCfAuthPending()
      return
    }
    // 管理端与参与端共用：写入 admin token；参与页另存 session 邮箱
    setToken(data.token)
    if (data.email) {
      try {
        sessionStorage.setItem('lottery_session_email', data.email)
      } catch { /* ignore */ }
    }
    clearCfAuthPending()
    status.value = 'ok'
    showToast(t('authCallback.ok'), 'success')
    await router.replace(returnTo.startsWith('/') ? returnTo : '/admin')
  } catch {
    status.value = 'error'
    error.value = t('authCallback.network')
    clearCfAuthPending()
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
