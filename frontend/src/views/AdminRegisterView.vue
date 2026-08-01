<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">注册 Lucky Draw</h1>
      <p class="login-subtitle">创建账号，开始你的第一个抽奖活动</p>

      <form class="login-form" @submit.prevent="handleRegister">
        <label class="field-label">
          <span>用户名</span>
          <input
            v-model="username"
            type="text"
            placeholder="2-40 个字符，字母数字下划线"
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
            placeholder="至少 8 位，包含字母和数字"
            autocomplete="new-password"
            :disabled="loading"
          />
        </label>

        <p v-if="error" class="form-error">{{ error }}</p>

        <button type="submit" class="btn btn-primary btn-block" :disabled="loading">
          {{ loading ? '注册中…' : '注册' }}
        </button>
      </form>

      <p class="login-footer">
        已有账号？<RouterLink to="/admin/login">登录</RouterLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const router = useRouter()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function handleRegister() {
  error.value = ''
  const u = username.value.trim()
  const p = password.value

  if (u.length < 2 || u.length > 40) { error.value = '用户名需要 2-40 个字符'; return }
  if (!/^[a-zA-Z0-9_]+$/.test(u)) { error.value = '用户名只能包含字母、数字和下划线'; return }
  if (p.length < 8) { error.value = '密码至少需要 8 个字符'; return }
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) { error.value = '密码需要同时包含字母和数字'; return }

  loading.value = true
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    })
    const data = await res.json() as any
    if (data.ok) {
      localStorage.setItem('admin_token', data.token)
      router.push('/admin')
    } else {
      error.value = data.message || '注册失败'
    }
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.admin-login { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
.login-card { width: 100%; max-width: 380px; background: var(--tg-surface); border-radius: 16px; padding: 32px 24px; }
.login-title { font-size: 22px; font-weight: 700; text-align: center; margin-bottom: 4px; }
.login-subtitle { text-align: center; color: var(--tg-hint); font-size: 14px; margin-bottom: 24px; }
.login-form { display: flex; flex-direction: column; gap: 14px; }
.field-label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--tg-hint); }
.field-label input { padding: 10px 12px; border: 1px solid var(--tg-border); border-radius: 8px; background: var(--tg-bg); color: var(--tg-text); font-size: 15px; }
.btn-block { width: 100%; padding: 12px; font-size: 15px; border-radius: 8px; }
.form-error { color: #f43f5e; font-size: 13px; text-align: center; }
.login-footer { text-align: center; margin-top: 16px; font-size: 13px; color: var(--tg-hint); }
.login-footer a { color: var(--tg-link); }
</style>