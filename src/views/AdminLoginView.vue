<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">{{ shopName }}{{ $t('admin.title') }}</h1>
      <p class="login-subtitle">{{ $t('admin.subtitle') }}</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <label class="field-label">
          <span>{{ $t('admin.tokenLabel') }}</span>
          <input
            v-model="adminToken"
            type="password"
            placeholder="ADMIN_TOKEN"
            autocomplete="current-password"
            autofocus
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? $t('admin.verifying') : $t('admin.login') }}
        </button>

        <p v-if="error" class="login-error">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { adminVerifyJwt, verifyAdminToken } from '@/api/admin'
import { useToast } from '@/composables/useToast'
import { useShopConfig } from '@/composables/useShopConfig'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { setToken } = useAdminAuth()
const { showToast } = useToast()
const { shopName, loadShopConfig } = useShopConfig()

const adminToken = ref('')
const loading = ref(false)
const error = ref('')

function redirectAfterLogin() {
  const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/admin')
    ? route.query.redirect
    : '/admin'
  return router.replace(redirect)
}

async function handleLogin() {
  error.value = ''
  if (!adminToken.value.trim()) {
    error.value = t('admin.tokenRequired')
    return
  }

  const candidateToken = adminToken.value.trim()
  loading.value = true
  try {
    // 未经后端确认的候选令牌绝不能进入持久化登录态，也不能提前提示成功。
    await verifyAdminToken(candidateToken)
    setToken(candidateToken)
    showToast(t('admin.loginSuccess'), 'success')
    await redirectAfterLogin()
  } catch (err: any) {
    error.value = err.message || t('admin.loginFailed')
  } finally {
    loading.value = false
  }
}

async function consumeJwtLogin(jwt: string) {
  error.value = ''
  loading.value = true
  try {
    const res = await adminVerifyJwt('', jwt)
    setToken(res.sessionToken)
    showToast(t('admin.loginSuccess'), 'success')
    await redirectAfterLogin()
  } catch (err: any) {
    error.value = err.message || t('admin.loginLinkExpired')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadShopConfig()
  // 从 URL fragment 读取 JWT（#jwt=xxx），不经过服务器日志和 Referrer header
  const hash = route.hash // e.g. "#jwt=eyJ..."
  const jwtMatch = hash.match(/[#&]jwt=([^&]+)/)
  if (jwtMatch?.[1]) {
    // 立即清除 hash，防止刷新后重放或被意外分享/书签
    history.replaceState(null, '', window.location.pathname + window.location.search)
    consumeJwtLogin(jwtMatch[1])
  }
})
</script>

<style scoped>
.admin-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--tg-bg, #0a0e17);
}

.login-card {
  width: 100%;
  max-width: 420px;
  background: var(--tg-secondary-bg, #151b28);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-lg, 12px);
  padding: 26px 22px;
  box-shadow: var(--shadow-lg, 0 20px 50px rgba(0, 0, 0, 0.45));
  color: var(--tg-text, #f0f2f5);
}

.login-title {
  margin: 0 0 6px;
  font-size: 20px;
  text-align: center;
}

.login-subtitle {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
  text-align: center;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--tg-text, #f0f2f5);
}

.field-label input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--tg-text, #f0f2f5);
  font-size: 14px;
}

.login-btn {
  margin-top: 4px;
}

.login-error {
  margin: 0;
  font-size: 13px;
  color: #ef4444;
  text-align: center;
}
</style>
