<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">注册 Lucky Draw</h1>
      <p class="login-subtitle">创建账号，开始你的第一个抽奖活动</p>

      <!-- 第一步：填写信息 -->
      <form v-if="!codeSent" class="login-form" @submit.prevent="handleRegister">
        <label class="field-label">
          <span>用户名</span>
          <input v-model="username" type="text" placeholder="2-40 个字符，字母数字下划线" autocomplete="username" :disabled="loading" />
        </label>
        <label class="field-label">
          <span>邮箱</span>
          <input v-model="email" type="email" placeholder="用于接收验证码和开奖通知" autocomplete="email" :disabled="loading" />
        </label>
        <label class="field-label">
          <span>密码</span>
          <input v-model="password" type="password" placeholder="至少 8 位，包含字母和数字" autocomplete="new-password" :disabled="loading" />
        </label>
        <p v-if="error" class="form-error">{{ error }}</p>
        <button type="submit" class="btn btn-primary btn-block" :disabled="loading">{{ loading ? '提交中…' : '发送验证码' }}</button>
      </form>

      <!-- 第二步：验证邮箱 -->
      <form v-else class="login-form" @submit.prevent="handleVerify">
        <p class="verify-hint">验证码已发送到 <strong>{{ email }}</strong>，10 分钟内有效</p>
        <label class="field-label">
          <span>验证码</span>
          <input v-model="code" type="text" inputmode="numeric" maxlength="6" placeholder="6 位数字" autofocus :disabled="verifying" />
        </label>
        <p v-if="error" class="form-error">{{ error }}</p>
        <button type="submit" class="btn btn-primary btn-block" :disabled="verifying">{{ verifying ? '验证中…' : '验证并注册' }}</button>
        <button type="button" class="btn btn-ghost btn-block" @click="codeSent = false" :disabled="verifying">修改信息</button>
      </form>

      <p class="login-footer">已有账号？<RouterLink to="/admin/login">登录</RouterLink></p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

const router = useRouter()
const username = ref('')
const email = ref('')
const password = ref('')
const code = ref('')
const loading = ref(false)
const verifying = ref(false)
const codeSent = ref(false)
const error = ref('')

async function handleRegister() {
  error.value = ''
  const u = username.value.trim()
  const e = email.value.trim().toLowerCase()
  const p = password.value
  if (u.length < 2 || u.length > 40) { error.value = '用户名需要 2-40 个字符'; return }
  if (!/^[a-zA-Z0-9_]+$/.test(u)) { error.value = '用户名只能包含字母、数字和下划线'; return }
  if (!e.includes('@')) { error.value = '请输入有效的邮箱地址'; return }
  if (p.length < 8) { error.value = '密码至少需要 8 个字符'; return }
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) { error.value = '密码需要同时包含字母和数字'; return }
  loading.value = true
  try {
    const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p, email: e }) })
    const data = await res.json() as any
    if (data.ok) { codeSent.value = true; error.value = '' }
    else { error.value = data.message || '注册失败' }
  } catch { error.value = '网络错误，请重试' }
  finally { loading.value = false }
}

async function handleVerify() {
  error.value = ''
  const c = code.value.trim()
  if (c.length !== 6) { error.value = '请输入 6 位验证码'; return }
  verifying.value = true
  try {
    const res = await fetch('/api/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value.trim().toLowerCase(), code: c }) })
    const data = await res.json() as any
    if (data.ok) { localStorage.setItem('admin_token', data.token); router.push('/admin') }
    else { error.value = data.message || '验证失败' }
  } catch { error.value = '网络错误，请重试' }
  finally { verifying.value = false }
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
.verify-hint { text-align: center; font-size: 14px; color: var(--tg-hint); margin-bottom: 8px; }
.login-footer { text-align: center; margin-top: 16px; font-size: 13px; color: var(--tg-hint); }
.login-footer a { color: var(--tg-link); }
</style>