<template>
  <div class="member-view">
    <div class="page-section">
      <div class="section-label">{{ $t('nav.refer') }}</div>
      <h1 class="section-title">{{ $t('member.title') }}</h1>
      <p class="hint-text">{{ $t('member.desc') }}</p>
    </div>

    <div v-if="!sessionEmail" class="form-card">
      <form @submit.prevent="handleLogin">
        <div class="form-field">
          <label class="form-label" for="member-email">{{ $t('member.emailLabel') }}</label>
          <input id="member-email" v-model="email" type="email" required maxlength="160" />
        </div>
        <div class="form-field">
          <label class="form-label" for="member-code">{{ $t('member.codeLabel') }}</label>
          <div class="code-row">
            <input
              id="member-code"
              v-model="code"
              inputmode="numeric"
              pattern="\d{6}"
              maxlength="6"
              :placeholder="$t('member.codePlaceholder')"
              required
            />
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="sendingCode || cooldownLeft > 0"
              @click="sendCode"
            >
              {{ cooldownLeft > 0 ? `${cooldownLeft}s` : sendingCode ? $t('member.sending') : $t('member.getCode') }}
            </button>
          </div>
        </div>
        <Turnstile container-id="member-turnstile" />
        <button class="btn btn-primary btn-full" type="submit" :disabled="loggingIn">
          {{ loggingIn ? $t('member.verifying') : $t('member.viewCode') }}
        </button>
      </form>
      <p v-if="error" class="error-text">{{ error }}</p>
    </div>

    <template v-else>
      <div class="form-card">
        <p class="hint-text">{{ $t('member.verified') }}：{{ sessionEmail }}</p>
        <p class="balance-line">
          {{ $t('member.balance') }}：¥{{ (balanceCents / 100).toFixed(2) }}
          <button type="button" class="btn btn-ghost btn-sm" @click="logout">{{ $t('member.logout') }}</button>
        </p>
      </div>

      <div class="form-card">
        <h2 class="section-title" style="font-size: 1.1rem">{{ $t('member.referralCode') }}</h2>
        <template v-if="referralCode">
          <p class="code-display"><strong>{{ referralCode.code }}</strong></p>
          <p class="hint-text">
            {{ $t('member.rewardNone') }}：{{
              referralCode.rewardType === 'fixed'
                ? $t('member.rewardFixed', { amount: (referralCode.rewardValue / 100).toFixed(2) })
                : referralCode.rewardType === 'percent'
                  ? $t('member.rewardPercent', { percent: referralCode.rewardValue })
                  : $t('member.rewardNone')
            }}
            · {{ referralCode.active ? $t('member.active') : $t('member.inactive') }}
          </p>
          <div class="action-row">
            <button type="button" class="btn btn-primary" @click="copyPromoLink">{{ $t('member.copyLink') }}</button>
            <button type="button" class="btn btn-ghost" @click="copyCodeOnly">{{ $t('member.copyCode') }}</button>
          </div>
        </template>
        <p v-else class="hint-text">{{ $t('member.noCode') }}</p>
        <p v-if="error" class="error-text">{{ error }}</p>
      </div>

      <div class="form-card">
        <h2 class="section-title" style="font-size: 1.1rem">{{ $t('member.rewards') }}</h2>
        <ul v-if="rewards.length" class="code-list">
          <li v-for="(r, i) in rewards" :key="i">
            {{ r.status }} · {{ r.amountCents }} 分 · {{ r.referralCode }} · 单 {{ String(r.orderId || '').slice(0, 8) }}
          </li>
        </ul>
        <p v-else class="hint-text">{{ $t('member.noRewards') }}</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Turnstile from '@/components/Turnstile.vue'
import {
  createMemberSession,
  fetchMemberMe,
  fetchMemberRewards,
  getMemberToken,
  requestMemberAccessCode,
  setMemberToken,
} from '@/api'
import { useTurnstile } from '@/composables/useTurnstile'
import { useStorefrontContext } from '@/composables/useStorefrontContext'
import { useEmailSession } from '@/composables/useEmailSession'
import { writeClipboardText } from '@/composables/useClipboard'
import { useToast } from '@/composables/useToast'
import { REFERRAL_QUERY_KEY } from '@/lib/checkout-attribution'
import { getMemberShareReferralCode, setMemberShareReferralCode } from '@/lib/member-share-referral'

const { t } = useI18n()
const email = ref('')
const code = ref('')
const sessionEmail = ref('')
const balanceCents = ref(0)
const error = ref('')
const sendingCode = ref(false)
const loggingIn = ref(false)
const cooldownLeft = ref(0)
const referralCode = ref<{
  code: string
  rewardType: string
  rewardValue: number
  active: boolean
  createdAt: string
} | null>(null)
const rewards = ref<Array<Record<string, unknown>>>([])
const { getResponse, reset } = useTurnstile()
const { getEmailSession } = useEmailSession()
const { homePath } = useStorefrontContext()
const { showToast } = useToast()

let cooldownTimer: ReturnType<typeof setInterval> | null = null

function startCooldown(seconds: number) {
  cooldownLeft.value = seconds
  if (cooldownTimer) clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldownLeft.value -= 1
    if (cooldownLeft.value <= 0 && cooldownTimer) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
      cooldownLeft.value = 0
    }
  }, 1000)
}

async function refreshDashboard() {
  const me = await fetchMemberMe()
  sessionEmail.value = me.email
  balanceCents.value = me.balanceCents
  referralCode.value = me.referralCode
  if (me.referralCode?.code) {
    setMemberShareReferralCode(me.referralCode.code)
  }
  const rewardRes = await fetchMemberRewards()
  rewards.value = rewardRes.rewards || []
}

async function sendCode() {
  error.value = ''
  if (!email.value.includes('@')) {
    error.value = t('member.emailRequired')
    return
  }
  sendingCode.value = true
  try {
    await requestMemberAccessCode({
      email: email.value.trim(),
      turnstileToken: getResponse() || undefined,
    })
    startCooldown(60)
    reset()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : t('member.sendError')
  } finally {
    sendingCode.value = false
  }
}

async function handleLogin() {
  error.value = ''
  loggingIn.value = true
  try {
    const res = await createMemberSession({
      email: email.value.trim(),
      code: code.value.trim(),
    })
    setMemberToken(res.token)
    await refreshDashboard()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : t('member.error')
  } finally {
    loggingIn.value = false
  }
}

function logout() {
  setMemberToken('')
  setMemberShareReferralCode('')
  sessionEmail.value = ''
  referralCode.value = null
  rewards.value = []
}

async function copyPromoLink() {
  const codeValue = referralCode.value?.code
  if (!codeValue) return
  const path = homePath.value || '/shop'
  const url = `${window.location.origin}${path}?${REFERRAL_QUERY_KEY}=${encodeURIComponent(codeValue)}`
  await writeClipboardText(url)
  showToast(t('toast.copied'), 'success')
}

async function copyCodeOnly() {
  const codeValue = referralCode.value?.code
  if (!codeValue) return
  await writeClipboardText(codeValue)
  showToast(t('toast.copied'), 'success')
}

onMounted(async () => {
  // 已验证邮箱只用于减少输入；推广页涉及奖励和余额展示，仍必须走 member OTP 换短会话。
  if (!email.value.trim()) {
    const session = getEmailSession()
    if (session?.email) email.value = session.email
  }
  // 同步本地分享码缓存（商品页复制用）
  const cached = getMemberShareReferralCode()
  if (cached) {
    /* keep */
  }
  if (getMemberToken()) {
    try {
      await refreshDashboard()
    } catch {
      setMemberToken('')
    }
  }
})

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer)
})
</script>

<style scoped>
/*
 * 与 Lookup / Redeem 一致：.form-card / .form-label / .btn-* 走 desktop.css + base token。
 * 禁止 scoped 再盖一层浅色卡片背景（未定义 token 时曾回落到白底）。
 */
.member-view {
  padding-top: 16px;
  padding-bottom: 24px;
}

.hint-text {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--tg-hint);
}

.form-card + .form-card {
  margin-top: 12px;
}

.code-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.code-row input {
  flex: 1;
}

.code-display {
  font-size: 1.25rem;
  margin: 0.5rem 0;
  word-break: break-all;
  color: var(--tg-text);
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.code-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.code-list li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
  color: var(--tg-text);
  font-size: 13px;
}

.error-text {
  color: var(--tg-destructive, #ef4444);
  margin-top: 0.75rem;
  font-size: 14px;
}

.balance-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--tg-text);
}

.btn-sm {
  font-size: 0.85rem;
  padding: 0.25rem 0.5rem;
}

.btn-full {
  width: 100%;
  margin-top: 0.75rem;
}
</style>
