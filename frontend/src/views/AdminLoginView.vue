<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">{{ $t('app.title') }} {{ $t('adminLogin.title') }}</h1>
      <p class="login-subtitle">{{ $t('adminLogin.subtitle') }}</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <label class="field-label">
          <span>{{ $t('adminLogin.username') }}</span>
          <input
            v-model="username"
            type="text"
            :placeholder="$t('adminLogin.usernamePlaceholder')"
            autocomplete="username"
            autofocus
            :disabled="loading"
          />
        </label>

        <label class="field-label">
          <span>{{ $t('adminLogin.password') }}</span>
          <input
            v-model="password"
            type="password"
            :placeholder="$t('adminLogin.passwordPlaceholder')"
            autocomplete="current-password"
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? $t('adminLogin.loggingIn') : $t('adminLogin.loginBtn') }}
        </button>

        <p v-if="error" class="login-error">{{ error }}</p>
      </form>

      <!-- Logto 身份认证登录（docs/051 方案） -->
      <div v-if="logtoEnabled" class="logto-section">
        <div class="logto-divider"><span class="divider-text">{{ $t('adminLogin.or') }}</span></div>
        <button type="button" class="btn btn-ghost login-btn logto-btn" :disabled="logtoLoading" @click="handleLogtoLogin">
          <span class="logto-icon">L</span> 使用 Logto 登录
        </button>
      </div>

      <div v-if="cfAuthEnabled" class="logto-section">
        <div class="logto-divider"><span class="divider-text">{{ $t('adminLogin.or') }}</span></div>
        <button
          type="button"
          class="btn btn-ghost login-btn"
          :disabled="cfAuthLoading"
          @click="handleCfAuthLogin"
        >{{ $t('adminLogin.cfAuthLogin') }}</button>
      </div>

      <div class="login-footer">
        <span>{{ $t('adminLogin.noAccount') }}</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="showRegister = !showRegister">
          {{ showRegister ? $t('adminLogin.switchToLogin') : $t('adminLogin.switchToRegister') }}
        </button>
      </div>

      <form v-if="showRegister && !showVerifyCode" class="register-form" @submit.prevent="handleRegister">
        <label class="field-label">
          <span>{{ $t('adminLogin.email') }}</span>
          <input
            v-model="regEmail"
            type="email"
            :placeholder="$t('adminLogin.emailPlaceholder')"
            autocomplete="email"
            :disabled="loading"
          />
        </label>
        <label class="field-label">
          <span>{{ $t('adminLogin.username') }}</span>
          <input
            v-model="regUsername"
            type="text"
            :placeholder="$t('adminLogin.regUsernamePlaceholder')"
            autocomplete="off"
            :disabled="loading"
          />
        </label>
        <label class="field-label">
          <span>{{ $t('adminLogin.password') }}</span>
          <input
            v-model="regPassword"
            type="password"
            :placeholder="$t('adminLogin.regPasswordPlaceholder')"
            autocomplete="new-password"
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? $t('adminLogin.sendCode') : $t('adminLogin.registerBtn') }}
        </button>
      </form>

      <!-- 验证码输入 -->
      <form v-if="showRegister && showVerifyCode" class="register-form" @submit.prevent="handleVerifyEmail">
        <p class="field-hint">{{ $t('adminLogin.codeSent') }} <strong>{{ regEmail }}</strong></p>
        <label class="field-label">
          <span>{{ $t('adminLogin.verifyCode') }}</span>
          <input
            v-model="regCode"
            type="text"
            maxlength="6"
            :placeholder="$t('adminLogin.verifyCodePlaceholder')"
            autocomplete="off"
            :disabled="verifying"
          />
        </label>
        <button class="btn btn-primary login-btn" type="submit" :disabled="verifying || !regCode">
          {{ verifying ? $t('adminLogin.verifying') : $t('adminLogin.verifyComplete') }}
        </button>
        <p class="field-hint" style="text-align:center;margin-top:8px;">
          <button type="button" class="btn btn-ghost btn-xs" :disabled="loading" @click="handleRegister">
            {{ $t('adminLogin.resendCode') }}
          </button>
        </p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useLogto } from '@logto/vue'
import { useCfAuthLogin } from '@/composables/useCfAuthLogin'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { setToken, setPlatformRole } = useAdminAuth()
const { showToast } = useToast()

// Logto 身份认证（docs/051 方案）：环境变量未配置时隐藏 Logto 登录按钮
const logtoEnabled = !!(import.meta.env.VITE_LOGTO_ENDPOINT && import.meta.env.VITE_LOGTO_APP_ID)
const logto = logtoEnabled ? useLogto() : null
const logtoLoading = ref(false)

const cfAuth = useCfAuthLogin()
const cfAuthEnabled = cfAuth.enabled
const cfAuthLoading = cfAuth.loading
onMounted(() => { void cfAuth.refresh() })

async function handleCfAuthLogin() {
  try {
    await cfAuth.login('/admin')
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'cf-auth 登录失败', 'error')
  }
}

async function handleLogtoLogin() {
  if (!logto) return
  logtoLoading.value = true
  try {
    // 跳转到 Logto 登录页，登录成功后回调到当前页面
    const redirectUri = window.location.origin + '/admin/login'
    await logto.signIn(redirectUri)
  } catch (err) {
    console.error('[logto] signIn error:', err)
    showToast('Logto 登录失败', 'error')
    logtoLoading.value = false
  }
}

const username = ref('')
const password = ref('')
const regUsername = ref('')
const regPassword = ref('')
const regEmail = ref('')
const regCode = ref('')
const showVerifyCode = ref(false)
const verifying = ref(false)
const loading = ref(false)
const error = ref('')
const showRegister = ref(false)

function redirectAfterLogin() {
  const redirect = (route.query.redirect as string) || '/admin'
  router.replace(redirect)
}

/**
 * 登录/注册成功后，异步获取平台角色信息并缓存到 localStorage。
 * 这个调用不阻塞页面跳转——如果失败（非平台成员），platformRole 被设为 null，
 * 下次访问 /platform/* 路由时守卫会拦住。
 */
async function fetchPlatformRole(token: string) {
  try {
    const res = await fetch('/api/admin/me', {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const data = await res.json()
    if (data.ok) {
      setPlatformRole(data.platformRole ?? null, token)
    } else {
      setPlatformRole(null, token)
    }
  } catch {
    // 网络异常时不写入 null，保留 undefined 状态让路由守卫放行
    // （PlatformLayout 内部会展示错误提示）
  }
}

async function handleLogin() {
  if (!username.value || !password.value) {
    error.value = t('adminLogin.missingUsernamePassword')
    return
  }

  loading.value = true
  error.value = ''

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    })
    const data = await res.json()

    if (data.ok && data.token) {
      setToken(data.token)
      // ★ 必须先等平台角色查询完成再跳转，否则 AdminLayout 读取时 localStorage 尚未写入
      await fetchPlatformRole(data.token)
      if (data.needsTenant) {
        showToast(t('adminLogin.createWorkspaceFirst'))
        router.replace({ name: 'Onboarding' })
        return
      }
      showToast(t('adminLogin.loginSuccess'), 'success')
      redirectAfterLogin()
    } else {
      error.value = data.message || t('adminLogin.loginFailed')
    }
  } catch {
    error.value = t('adminLogin.networkError')
  } finally {
    loading.value = false
  }
}

async function handleRegister() {
  if (!regUsername.value || !regPassword.value || !regEmail.value) {
    error.value = t('adminLogin.fillAllFields')
    return
  }
  if (!regEmail.value.includes('@')) {
    error.value = t('adminLogin.invalidEmail')
    return
  }

  loading.value = true
  error.value = ''

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: regUsername.value,
        password: regPassword.value,
        email: regEmail.value.trim(),
      }),
    })
    const data = await res.json()

    if (data.ok) {
      showVerifyCode.value = true
      showToast(t('adminLogin.codeSentToast'), 'success')
    } else {
      error.value = data.message || t('adminLogin.registerFailed')
    }
  } catch {
    error.value = t('adminLogin.networkError')
  } finally {
    loading.value = false
  }
}

async function handleVerifyEmail() {
  if (!regCode.value || regCode.value.length !== 6) {
    error.value = t('adminLogin.enterSixDigitCode')
    return
  }
  verifying.value = true
  error.value = ''
  try {
    const res = await fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: regEmail.value.trim(), code: regCode.value.trim() }),
    })
    const data = await res.json()
    if (data.ok && data.token) {
      setToken(data.token)
      await fetchPlatformRole(data.token)
      showToast(t('adminLogin.registerSuccess'), 'success')
      redirectAfterLogin()
    } else {
      error.value = data.message || t('adminLogin.verifyFailed')
    }
  } catch {
    error.value = t('adminLogin.networkError')
  } finally {
    verifying.value = false
  }
}
</script>

<style scoped>
.admin-login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--tg-bg, #0a0e17);
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  padding: 32px 24px;
}

.login-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--tg-text, #f0f2f5);
}

.login-subtitle {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
}

.login-form,
.register-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--tg-text, #f0f2f5);
}

.field-label input {
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--tg-bg, #0a0e17);
  color: var(--tg-text, #f0f2f5);
  font-size: 14px;
  outline: none;
}

.field-label input:focus {
  border-color: var(--admin-accent, #f59e0b);
}

.login-btn {
  height: 40px;
  font-size: 14px;
}

.login-error {
  margin: 0;
  font-size: 13px;
  color: var(--admin-danger, #fca5a5);
  text-align: center;
}

.login-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
}
</style>