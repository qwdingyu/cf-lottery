<template>
  <div class="lookup-view">
    <div class="page-section">
      <div class="section-label">{{ $t('lookup.title') }}</div>
      <h1 class="section-title">{{ $t('lookup.title') }}</h1>
      <p class="hint-text">{{ $t('lookup.emailCodeHint') }}</p>
      <p v-if="turnstileEnabled" class="hint-text">{{ $t('lookup.turnstileHint') }}</p>
    </div>

    <div class="form-card">
      <form @submit.prevent="handleSubmit">
        <div class="form-field">
          <label class="form-label" for="lookup-email">{{ $t('lookup.email') }}</label>
          <input
            id="lookup-email"
            v-model="email"
            type="email"
            :placeholder="$t('lookup.email')"
            required
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="lookup-email-code">{{ $t('lookup.emailCodeLabel') }}</label>
          <div v-if="verifiedSessionForEmail" class="verified-email-row">
            <span>已验证邮箱 {{ verifiedSessionForEmail.email }}</span>
            <button class="btn btn-ghost btn-sm" type="button" @click="clearVerifiedEmail">切换邮箱</button>
          </div>
          <div class="email-code-row">
            <input
              id="lookup-email-code"
              v-model="emailAccessCode"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              pattern="[0-9]{6}"
              :placeholder="$t('lookup.emailCodePlaceholder')"
              :required="!verifiedSessionForEmail"
            />
            <button
              class="btn btn-secondary btn-sm"
              type="button"
              :disabled="sendingEmailCode || emailCodeCoolingDown || !email.trim()"
              @click="sendEmailCode"
            >
              {{ sendingEmailCode ? $t('lookup.sendingCode') : emailCodeButtonText }}
            </button>
          </div>
          <div v-if="emailCodeMsg" class="email-code-msg" :class="emailCodeSent ? 'valid' : 'invalid'">
            {{ emailCodeMsg }}
          </div>
        </div>

        <Turnstile v-if="turnstileEnabled" container-id="turnstile-container" />

        <button class="btn btn-primary btn-full" type="submit" :disabled="loading">
          {{ loading ? $t('lookup.searching') : $t('lookup.search') }}
        </button>
      </form>

      <!-- Results -->
      <div v-if="orders.length > 0" class="order-list">
        <div
          v-for="order in orders"
          :key="order.id"
          class="order-item"
        >
          <div class="order-header">
            <span class="order-id">{{ order.orderNo || order.id }}</span>
            <span class="status-badge" :class="`status-${order.status}`">
              {{ statusLabel(order.status) }}
            </span>
          </div>
          <div class="order-meta">
            <span>{{ order.productTitle || order.productName }}</span>
            <span>{{ formatPrice(order.priceCents || order.amountCents, order.currency) }}</span>
          </div>
          <div class="order-submeta">
            <span>{{ formatDate(order.createdAt) }}</span>
            <span>{{ $t('lookup.search') }} {{ order.quantity || 1 }}</span>
          </div>
          <!-- Token 查询可能包含交付内容；邮箱验证码查询只展示订单摘要。 -->
          <div v-if="order.delivery?.accountLabel || order.delivery?.url || order.delivery?.code || order.delivery?.text || order.delivery?.content || order.delivery?.inviteCode" class="delivery-info">
            <DeliveryInfo :delivery="order.delivery" :fulfillment-mode="deliveryFulfillmentMode(order)" />
          </div>
          <div v-if="order.cards && order.cards.length" class="delivery-info">
            <DeliveryInfo :cards="order.cards" fulfillment-mode="card" />
          </div>
          <div v-if="order.deliveryMessage" class="safe-summary-note">
            {{ order.deliveryMessage }}
          </div>
          <div v-if="!hasDelivery(order)" class="safe-summary-note">
            {{ $t('lookup.emailOnlySummary') }}
          </div>
          <div class="order-detail-link">
            <button
              v-if="order.orderToken"
              class="btn btn-ghost btn-sm"
              @click="goToOrder(order.id, order.orderToken)"
              type="button"
            >{{ $t('checkout.viewOrder') }}</button>
          </div>
        </div>
      </div>

      <div v-else-if="error" class="result-box" :class="errorType">
        {{ error }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { lookupOrders, lookupOrdersByEmail, requestEmailAccessCode } from '@/api'
import { formatPrice, formatDate, statusLabel } from '@/composables/useFormat'
import DeliveryInfo from '@/components/DeliveryInfo.vue'
import Turnstile from '@/components/Turnstile.vue'
import { useTurnstile } from '@/composables/useTurnstile'
import { useShopConfig } from '@/composables/useShopConfig'
import { retryAfterSecondsFromError, useEmailCodeCooldown } from '@/composables/useEmailCodeCooldown'
import { useEmailSession } from '@/composables/useEmailSession'
import type { Order } from '@/types'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const email = ref('')
const emailAccessCode = ref('')
const { getEmailSession, sessionForEmail, saveEmailSession, clearEmailSession } = useEmailSession()
const verifiedSessionForEmail = computed(() => email.value.trim() ? sessionForEmail(email.value) : null)
const sendingEmailCode = ref(false)
const emailCodeMsg = ref('')
const emailCodeSent = ref(false)
const {
  remainingSeconds: emailCodeCooldownSeconds,
  isCoolingDown: emailCodeCoolingDown,
  buttonText: emailCodeButtonText,
  startCooldown: startEmailCodeCooldown,
  stopCooldown: stopEmailCodeCooldown,
} = useEmailCodeCooldown()
const loading = ref(false)
const orders = ref<Order[]>([])
const error = ref('')
const errorType = ref<'status-error' | 'status-info'>('status-error')
const { getResponse, ensureConfigLoaded, reset } = useTurnstile()
const { turnstileEnabled, loadShopConfig } = useShopConfig()

async function handleSubmit() {
  const session = verifiedSessionForEmail.value
  if (!session && !/^\d{6}$/.test(emailAccessCode.value.trim())) {
    error.value = t('lookup.emailCodeRequired')
    errorType.value = 'status-error'
    return
  }
  loading.value = true
  error.value = ''
  errorType.value = 'status-error'
  orders.value = []
  try {
    const res = await lookupOrdersByEmail(email.value.trim(), session
      ? { emailSessionToken: session.token }
      : { emailAccessCode: emailAccessCode.value.trim() })
    orders.value = res.orders
    saveEmailSession(res.emailSession)
    if (orders.value.length === 0) {
      error.value = t('lookup.noOrders')
      errorType.value = 'status-info'
    }
  } catch (err: any) {
    error.value = err.message || t('lookup.error')
    errorType.value = 'status-error'
  } finally {
    loading.value = false
  }
}

function clearVerifiedEmail() {
  clearEmailSession()
  emailAccessCode.value = ''
}

async function sendEmailCode() {
  emailCodeMsg.value = ''
  emailCodeSent.value = false
  if (emailCodeCoolingDown.value) {
    emailCodeMsg.value = t('lookup.cooldown', { seconds: emailCodeCooldownSeconds.value })
    return
  }
  emailAccessCode.value = ''
  if (!email.value.trim()) {
    emailCodeMsg.value = t('lookup.emailRequired')
    return
  }

  sendingEmailCode.value = true
  const turnstileToken = getResponse()
  try {
    const res = await requestEmailAccessCode(email.value.trim(), turnstileToken || undefined)
    startEmailCodeCooldown(res.resendCooldownSeconds || 60)
    emailCodeSent.value = true
    emailCodeMsg.value = t('lookup.emailCodeSent')
  } catch (err: any) {
    const retryAfterSeconds = retryAfterSecondsFromError(err)
    if (retryAfterSeconds > 0) startEmailCodeCooldown(retryAfterSeconds)
    emailCodeMsg.value = err.message || t('lookup.emailCodeFailed')
  } finally {
    sendingEmailCode.value = false
    if (turnstileToken) reset()
  }
}

async function loadByToken(token: string) {
  loading.value = true
  error.value = ''
  errorType.value = 'status-error'
  orders.value = []
  try {
    orders.value = (await lookupOrders(token)).map((order) => ({
      ...order,
      orderToken: order.orderToken || token,
    }))
    if (orders.value.length === 0) {
      error.value = t('lookup.noResult')
      errorType.value = 'status-info'
    }
  } catch (err: any) {
    error.value = err.message || t('lookup.error')
    errorType.value = 'status-error'
  } finally {
    loading.value = false
  }
}

function goToOrder(orderId: string, token: string) {
  router.push({ name: 'Order', query: { orderId, token } })
}

function hasDelivery(order: Order) {
  return Boolean(
    (order.delivery && Object.values(order.delivery).some(Boolean)) ||
    (order.cards && order.cards.length > 0) ||
    Boolean(order.deliveryMessage),
  )
}

function deliveryFulfillmentMode(order: Order) {
  const firstItem = order.items?.find(item => item.fulfillmentMode)
  return firstItem?.fulfillmentMode || order.fulfillmentMode || (order.cards?.length ? 'card' : '')
}

onMounted(async () => {
  await loadShopConfig()
  await ensureConfigLoaded()
  const token = typeof route.query.token === 'string' && route.query.token
    ? route.query.token
    : typeof route.query.t === 'string'
      ? route.query.t
      : ''
  if (token) {
    await loadByToken(token)
  } else if (!email.value.trim()) {
    const session = getEmailSession()
    if (session?.email) email.value = session.email
  }
})

watch(email, () => {
  emailAccessCode.value = ''
  emailCodeMsg.value = ''
  emailCodeSent.value = false
  stopEmailCodeCooldown()
})

onUnmounted(() => {
  stopEmailCodeCooldown()
})
</script>

<style scoped>
.lookup-view {
  padding-top: 16px;
  padding-bottom: 24px;
}

.hint-text {
  margin-top: 6px;
  font-size: 14px;
  color: var(--tg-hint);
}

.btn-full {
  width: 100%;
  margin-top: 4px;
}

.email-code-row {
  display: flex;
  gap: 8px;
}

.email-code-row input {
  flex: 1;
  min-width: 0;
}

.email-code-row .btn-sm {
  flex-shrink: 0;
  white-space: nowrap;
}

.email-code-msg {
  margin-top: 6px;
  font-size: 13px;
}

.email-code-msg.valid { color: #22c55e; }
.email-code-msg.invalid { color: #ef4444; }

/* Order list */
.order-list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.order-item {
  padding: 14px 16px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 0.5px solid var(--border);
}

.order-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.order-id {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--tg-text);
  overflow-wrap: anywhere;
}

.status-badge {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--r-full);
}

.status-badge.status-issued {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.status-badge.status-paid {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.status-badge.status-pending {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.status-badge.status-expired,
.status-badge.status-failed,
.status-badge.status-canceled,
.status-badge.status-closed,
.status-badge.status-refunded {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.order-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--tg-hint);
  gap: 12px;
}

.order-meta span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

.order-meta span:last-child {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--tg-text);
}

.order-submeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 3px;
  font-size: 12px;
  color: var(--tg-hint);
}

.delivery-info {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 0.5px solid var(--border);
}

.safe-summary-note {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: rgba(59, 130, 246, 0.08);
  color: var(--tg-hint);
  font-size: 13px;
  line-height: 1.5;
}

.delivery-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}

.delivery-label {
  color: var(--tg-hint);
  flex-shrink: 0;
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

/* Order detail link */
.order-detail-link {
  text-align: center;
  padding-top: 4px;
}

/* Result box */
.result-box {
  margin-top: 12px;
  padding: 12px 16px;
  border-radius: var(--r-md);
  font-size: 14px;
}

.result-box.status-error {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.result-box.status-info {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

</style>
