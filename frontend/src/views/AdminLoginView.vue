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

      <form v-if="showRegister" class="register-form" @submit.prevent="handleRegister">
        <label class="field-label">
          <span>用户名</span>
          <input
            v-model="regUsername"
            type="text"
            placeholder="2-40 个字符"
            autocomplete="off"
            :disabled="loading"
          />
        </label>

        <label class="field-label">
          <span>密码</span>
          <input
            v-model="regPassword"
            type="password"
            placeholder="至少 6 个字符"
            autocomplete="new-password"
            :disabled="loading"
          />
        </label>

        <button class="btn btn-primary login-btn" type="submit" :disabled="loading">
          {{ loading ? '注册中…' : '注册并登录' }}
        </button>
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
const { setToken } = useAdminAuth()
const { showToast } = useToast()

const username = ref('')
const password = ref('')
const regUsername = ref('')
const regPassword = ref('')
const loading = ref(false)
const error = ref('')
const showRegister = ref(false)

function redirectAfterLogin() {
  const redirect = (route.query.redirect as string) || '/admin'
  router.replace(redirect)
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
  if (!regUsername.value || !regPassword.value) {
    error.value = '请输入用户名和密码'
    return
  }

  loading.value = true
  error.value = ''

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: regUsername.value, password: regPassword.value }),
    })
    const data = await res.json()

    if (data.ok && data.token) {
      setToken(data.token)
      showToast('注册成功', 'success')
      redirectAfterLogin()
    } else {
      error.value = data.message || '注册失败'
    }
  } catch {
    error.value = '网络错误，请稍后重试'
  } finally {
    loading.value = false
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