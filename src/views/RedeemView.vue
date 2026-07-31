<template>
  <div class="redeem-view">
    <div class="page-section">
      <div class="section-label">{{ $t('redeem.title') }}</div>
      <h1 class="section-title">{{ $t('redeem.title') }}</h1>
      <p class="hint-text">{{ $t('redeem.desc') }}</p>
    </div>

    <div class="form-card">
      <form @submit.prevent="handleSubmit">
        <div class="form-field">
          <label class="form-label" for="redeem-code">{{ $t('redeem.codeLabel') }}</label>
          <input
            id="redeem-code"
            v-model="code"
            type="text"
            :placeholder="$t('redeem.codePlaceholder')"
            autocomplete="one-time-code"
            minlength="8"
            maxlength="80"
            required
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="redeem-email">{{ $t('lookup.email') }}</label>
          <input
            id="redeem-email"
            v-model="email"
            type="email"
            :placeholder="$t('lookup.email')"
            required
          />
        </div>

        <!-- Turnstile -->
        <Turnstile container-id="turnstile-container" />

        <button class="btn btn-primary btn-full" type="submit" :disabled="submitting">
          {{ submitting ? $t('redeem.redeeming') : $t('redeem.redeem') }}
        </button>
      </form>

      <div v-if="result" class="result-box" :class="resultType">
        {{ result }}
      </div>

      <div v-if="resultType === 'status-success'" class="redeem-guide">
        <p>{{ $t('redeem.success') }}</p>
        <RouterLink :to="homePath" class="btn btn-ghost">{{ $t('shop.buy') }} →</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Turnstile from '@/components/Turnstile.vue'
import { redeemVoucher } from '@/api'
import { useTurnstile } from '@/composables/useTurnstile'
import { useStorefrontContext } from '@/composables/useStorefrontContext'
import { useEmailSession } from '@/composables/useEmailSession'

const { t } = useI18n()

const code = ref('')
const email = ref('')
const submitting = ref(false)
const result = ref('')
const resultType = ref('')
const { homePath } = useStorefrontContext()
const { getResponse, reset } = useTurnstile()
const { getEmailSession } = useEmailSession()

async function handleSubmit() {
  submitting.value = true
  result.value = ''
  resultType.value = ''
  try {
    const token = getResponse()
    const res = await redeemVoucher({
      code: code.value.trim(),
      email: email.value.trim(),
      turnstileToken: token || undefined,
    })
    resultType.value = 'status-success'
    result.value = res.message || t('redeem.redeemSuccess', { amount: res.amountYuan })
    code.value = ''
    // 连续兑换时保留邮箱，减少手机端重复输入；用户仍可直接编辑切换邮箱。
    reset()
  } catch (err: any) {
    reset()
    resultType.value = 'status-error'
    result.value = err.message || t('redeem.redeemFailed')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  if (email.value.trim()) return
  const session = getEmailSession()
  if (session?.email) email.value = session.email
})
</script>

<style scoped>
.redeem-view {
  padding-top: 16px;
  padding-bottom: 24px;
}

.hint-text {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--tg-hint);
}

.btn-full {
  width: 100%;
  margin-top: 4px;
}

/* Delivery info */
.delivery-info {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 0.5px solid var(--border);
}

.delivery-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}

.delivery-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0;
  font-size: 14px;
}

.delivery-label {
  color: var(--tg-hint);
  flex-shrink: 0;
  min-width: 32px;
}

.delivery-value {
  font-family: var(--font-mono);
  font-weight: 500;
  word-break: break-all;
}

/* Copy button */
.btn-copy {
  flex-shrink: 0;
  padding: 2px 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  transition: background var(--duration-fast) var(--ease-out);
}

.btn-copy:hover {
  background: var(--surface-hover);
}

.redeem-guide {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 0.5px solid var(--border);
  text-align: center;
}

.redeem-guide p {
  font-size: 14px;
  color: var(--tg-hint);
  margin-bottom: 8px;
}
</style>
