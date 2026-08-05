<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">{{ $t('adminRegister.title') }}</h1>
      <p class="login-subtitle">{{ $t('adminRegister.subtitle') }}</p>

      <!-- 第一步：填写信息 -->
      <form v-if="!codeSent" class="login-form" @submit.prevent="handleRegister">
        <label class="field-label">
          <span>{{ $t('adminRegister.username') }}</span>
          <input v-model="username" type="text" :placeholder="$t('adminRegister.usernamePlaceholder')" autocomplete="username" :disabled="loading" />
        </label>
        <label class="field-label">
          <span>{{ $t('adminRegister.email') }}</span>
          <input v-model="email" type="email" :placeholder="$t('adminRegister.emailPlaceholder')" autocomplete="email" :disabled="loading" />
        </label>
        <label class="field-label">
          <span>{{ $t('adminRegister.password') }}</span>
          <input v-model="password" type="password" :placeholder="$t('adminRegister.passwordPlaceholder')" autocomplete="new-password" :disabled="loading" />
        </label>
        <p v-if="error" class="form-error">{{ error }}</p>
        <button type="submit" class="btn btn-primary btn-block" :disabled="loading">{{ loading ? $t('adminRegister.submitting') : $t('adminRegister.sendCode') }}</button>
      </form>

      <!-- 第二步：验证邮箱 -->
      <form v-else class="login-form" @submit.prevent="handleVerify">
        <p class="verify-hint">{{ $t('adminRegister.codeSentHint') }} <strong>{{ email }}</strong>{{ $t('adminRegister.codeValidMinutes') }}</p>
        <label class="field-label">
          <span>{{ $t('adminRegister.verifyCode') }}</span>
          <!-- 055a P1 / docs/073：与参与页 OTP 对齐 — 数字规范化 + one-time-code + 满 6 位自动提交 -->
          <input
            ref="codeInputRef"
            v-model="code"
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="6"
            name="one-time-code"
            autocomplete="one-time-code"
            :placeholder="$t('adminRegister.codePlaceholder')"
            autofocus
            :disabled="verifying"
          />
        </label>
        <p v-if="error" class="form-error">{{ error }}</p>
        <button type="submit" class="btn btn-primary btn-block" :disabled="verifying">{{ verifying ? $t('adminRegister.verifying') : $t('adminRegister.verifyAndRegister') }}</button>
        <button type="button" class="btn btn-ghost btn-block" @click="codeSent = false" :disabled="verifying">{{ $t('adminRegister.editInfo') }}</button>
      </form>

      <p class="login-footer">{{ $t('adminRegister.haveAccount') }}<RouterLink to="/admin/login">{{ $t('adminRegister.loginLink') }}</RouterLink></p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { isOtpComplete, normalizeOtpDigits } from '@/composables/otp-input'

const router = useRouter()
const { t } = useI18n()
const { setToken, setPlatformRole } = useAdminAuth()
const username = ref('')
const email = ref('')
const password = ref('')
const code = ref('')
const codeInputRef = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const verifying = ref(false)
const codeSent = ref(false)
const error = ref('')
/** 防止自动填充触发重复 verify */
let otpAutoSubmitLock = false

// 只保留数字；满 6 位自动提交（与 LotteryView 参与 OTP 同策略）
watch(code, (raw) => {
  const digits = normalizeOtpDigits(raw)
  if (digits !== raw) {
    code.value = digits
    return
  }
  if (codeSent.value && isOtpComplete(digits) && !verifying.value && !otpAutoSubmitLock) {
    otpAutoSubmitLock = true
    void handleVerify().finally(() => {
      otpAutoSubmitLock = false
    })
  }
})

watch(codeSent, async (sent) => {
  if (!sent) return
  await nextTick()
  codeInputRef.value?.focus({ preventScroll: true })
})

async function handleRegister() {
  error.value = ''
  const u = username.value.trim()
  const e = email.value.trim().toLowerCase()
  const p = password.value
  if (u.length < 2 || u.length > 40) { error.value = t('adminRegister.usernameLengthError'); return }
  if (!/^[a-zA-Z0-9_]+$/.test(u)) { error.value = t('adminRegister.usernameCharsError'); return }
  if (!e.includes('@')) { error.value = t('adminRegister.invalidEmail'); return }
  if (p.length < 8) { error.value = t('adminRegister.passwordLengthError'); return }
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) { error.value = t('adminRegister.passwordComplexityError'); return }
  loading.value = true
  try {
    const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p, email: e }) })
    const data = await res.json() as any
    if (data.ok) { codeSent.value = true; error.value = '' }
    else { error.value = data.message || t('adminRegister.registerFailed') }
  } catch { error.value = t('adminRegister.networkError') }
  finally { loading.value = false }
}

async function handleVerify() {
  error.value = ''
  const c = normalizeOtpDigits(code.value)
  if (!isOtpComplete(c)) { error.value = t('adminRegister.enterSixDigitCode'); return }
  verifying.value = true
  try {
    const res = await fetch('/api/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value.trim().toLowerCase(), code: c }) })
    const data = await res.json() as any
    if (data.ok) {
      setToken(data.token)
      // docs/125：用 /api/auth/me 解析 L3（不绑租户）；失败不阻塞 onboarding
      const { ensurePlatformRole } = await import('@/composables/useAdminAuth')
      const role = await ensurePlatformRole(data.token, { force: true })
      if (role !== undefined) setPlatformRole(role, data.token)
      // ★ 045 方案 C：新注册用户无租户（needsTenant=true），引导 onboarding 创建租户
      if (data.needsTenant) {
        router.replace({ name: 'Onboarding' })
      } else {
        router.push('/admin')
      }
    }
    else { error.value = data.message || t('adminRegister.verifyFailed') }
  } catch { error.value = t('adminRegister.networkError') }
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
