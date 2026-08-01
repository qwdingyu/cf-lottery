<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">{{ $t('app.title') }} 管理后台</h1>
      <p class="login-subtitle">请登录以管理抽奖活动</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <label class="field-label">
          <span>用户名</span>
          <input
            v-model="username"
            type="text"
            placeholder="请输入用户名"
            autocomplete="username"
            autofocus
            :disabled="loading"
          />
        </label>

        <label class="field-label">
          <span>密码</span>
          <input
            v-model="password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>

        <p v-if="error" class="login-error">{{ error }}</p>
      </form>

      <div class="login-footer">
        <span>还没有账号？</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="showRegister = !showRegister">
          {{ showRegister ? '返回登录' : '注册' }}
        </button>
      </div>

      <form v-if="showRegister && !showVerifyCode" class="register-form" @submit.prevent="handleRegister">
        <label class="field-label">
          <span>邮箱</span>
          <input
            v-model="regEmail"
            type="email"
            placeholder="your@email.com"
            autocomplete="email"
            :disabled="loading"
          />
        </label>
        <label class="field-label">
          <span>用户名</span>
          <input
            v-model="regUsername"
            type="text"
            placeholder="4-20 个字符，字母数字下划线"
            autocomplete="off"
            :disabled="loading"
          />
        </label>
        <label class="field-label">
          <span>密码</span>
          <input
            v-model="regPassword"
            type="password"
            placeholder="至少 8 位，包含字母和数字"
            autocomplete="new-password"
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? '发送验证码…' : '注册' }}
        </button>
      </form>

      <!-- 验证码输入 -->
      <form v-if="showRegister && showVerifyCode" class="register-form" @submit.prevent="handleVerifyEmail">
        <p class="field-hint">验证码已发送到 <strong>{{ regEmail }}</strong></p>
        <label class="field-label">
          <span>验证码</span>
          <input
            v-model="regCode"
            type="text"
            maxlength="6"
            placeholder="请输入 6 位验证码"
            autocomplete="off"
            :disabled="verifying"
          />
        </label>
        <button class="btn btn-primary login-btn" type="submit" :disabled="verifying || !regCode">
          {{ verifying ? '验证中…' : '验证并完成注册' }}
        </button>
        <p class="field-hint" style="text-align:center;margin-top:8px;">
          <button type="button" class="btn btn-ghost btn-xs" :disabled="loading" @click="handleRegister">
            重新发送验证码
          </button>
        </p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const { setToken, setPlatformRole } = useAdminAuth()
const { showToast } = useToast()

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
    error.value = '请输入用户名和密码'
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
      // cf-lottery 使用 JWT token 作为 admin_token
      setToken(data.token)
      fetchPlatformRole(data.token)
      showToast('登录成功', 'success')
      redirectAfterLogin()
    } else {
      error.value = data.message || '登录失败'
    }
  } catch {
    error.value = '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function handleRegister() {
  if (!regUsername.value || !regPassword.value || !regEmail.value) {
    error.value = '请填写所有字段'
    return
  }
  if (!regEmail.value.includes('@')) {
    error.value = '请输入有效的邮箱地址'
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
      showToast('验证码已发送到邮箱', 'success')
    } else {
      error.value = data.message || '注册失败'
    }
  } catch {
    error.value = '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function handleVerifyEmail() {
  if (!regCode.value || regCode.value.length !== 6) {
    error.value = '请输入 6 位验证码'
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
      fetchPlatformRole(data.token)
      showToast('注册成功', 'success')
      redirectAfterLogin()
    } else {
      error.value = data.message || '验证失败'
    }
  } catch {
    error.value = '网络错误'
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