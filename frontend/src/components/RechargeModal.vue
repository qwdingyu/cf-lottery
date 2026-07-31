<template>
  <Teleport to="body">
    <div v-if="visible" class="recharge-overlay" role="presentation" @click.self="close">
      <section class="recharge-dialog" role="dialog" aria-modal="true" aria-labelledby="recharge-title">
        <header class="recharge-header">
          <div><span class="recharge-eyebrow">{{ $t('recharge.balance') }}</span><h2 id="recharge-title">{{ title }}</h2></div>
          <button class="recharge-close" type="button" :aria-label="$t('recharge.close')" :disabled="submitting" @click="close">×</button>
        </header>

        <form v-if="step === 'form'" class="recharge-body" @submit.prevent="submit">
          <div class="amount-presets" role="group" :aria-label="$t('recharge.presets')">
            <button v-for="value in presetAmounts" :key="value" type="button" :class="{ active: amountCents === value }" @click="setAmount(value)">
              {{ formatMoney(value, 'CNY') }}
            </button>
          </div>
          <label class="recharge-field"><span>{{ $t('recharge.customAmount') }}</span><input v-model="amountYuan" inputmode="decimal" :placeholder="$t('recharge.customAmountPlaceholder')" @input="syncCustomAmount" /></label>
          <label class="recharge-field"><span>{{ $t('recharge.emailLabel') }}</span><input v-model="email" type="email" autocomplete="email" :placeholder="$t('recharge.emailPlaceholder')" /></label>
          <div v-if="verifiedSessionForEmail" class="verified-email-row">
            <span>已验证邮箱 {{ verifiedSessionForEmail.email }}</span>
            <button type="button" class="btn btn-ghost" @click="clearVerifiedEmail">切换邮箱</button>
          </div>
          <div class="code-row">
            <label class="recharge-field"><span>{{ $t('recharge.codeLabel') }}</span><input v-model="emailCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" enterkeyhint="go" :placeholder="$t('recharge.codePlaceholder')" /></label>
            <button type="button" class="btn btn-ghost" :disabled="sendingCode || isCoolingDown || methodsLoading || methods.length === 0" @click="sendCode">{{ sendingCode ? $t('recharge.sending') : buttonText }}</button>
          </div>
          <Turnstile container-id="recharge-turnstile" />
          <div v-if="methods.length > 0" class="recharge-methods" role="group" :aria-label="$t('recharge.paymentMethods')">
            <button v-for="method in methods" :key="method.channel" type="button" :class="{ active: selectedChannel === method.channel }" @click="selectedChannel = method.channel">
              {{ method.label }}
            </button>
          </div>
          <p v-if="paymentAvailabilityError" class="recharge-error" role="alert">{{ paymentAvailabilityError }}</p>
          <p v-if="error" class="recharge-error" role="alert">{{ error }}</p>
          <button class="btn btn-primary recharge-primary" type="submit" :disabled="submitting || methodsLoading || methods.length === 0">
            {{ submitting ? $t('recharge.submitting') : $t('recharge.submit', { amount: formatMoney(amountCents, 'CNY') }) }}
          </button>
        </form>

        <div v-else class="recharge-body recharge-payment">
          <div class="recharge-summary"><span>{{ $t('recharge.amount') }}</span><strong>{{ formatMoney(amountCents, 'CNY') }}</strong><small>{{ orderNo }}</small></div>
          <img v-if="qrImageUrl" class="recharge-qr" :src="qrImageUrl" :alt="$t('recharge.qrAlt')" />
          <a v-if="redirectUrl" class="btn btn-primary recharge-primary" :href="redirectUrl" target="_blank" rel="noopener noreferrer">{{ $t('recharge.openPay', { label: paymentLabel }) }}</a>
          <div class="recharge-state" :class="status">
            <strong>{{ statusTitle }}</strong>
            <span>{{ statusMessage }}</span>
          </div>
          <p v-if="error" class="recharge-error" role="alert">{{ error }}</p>
          <button v-if="status === 'paid'" class="btn btn-primary recharge-primary" type="button" @click="close">{{ $t('recharge.done') }}</button>
          <button v-else-if="status === 'expired' || status === 'failed'" class="btn btn-ghost recharge-primary" type="button" @click="restart">{{ $t('recharge.retry') }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiError, createBalanceRecharge, fetchBalanceRechargeStatus, fetchPaymentMethods, requestEmailAccessCode, type PublicPaymentMethod } from '@/api'
import { useRecharge } from '@/composables/useRecharge'
import { useShopConfig } from '@/composables/useShopConfig'
import { retryAfterSecondsFromError, useEmailCodeCooldown } from '@/composables/useEmailCodeCooldown'
import { useTurnstile } from '@/composables/useTurnstile'
import { useEmailSession } from '@/composables/useEmailSession'
import Turnstile from '@/components/Turnstile.vue'
import { parseYuanToCents } from '@/utils/currency'
import { formatMoney, minorToMajorString } from '@shared/money'

const { t } = useI18n()

type RechargeStatus = 'pending' | 'paid' | 'expired' | 'failed'
type StoredRecharge = { idempotencyKey: string; email: string; amountCents: number; channel: PublicPaymentMethod['channel']; createdAt: string; orderId?: string; orderNo?: string; orderToken?: string; expiresAt?: string; qrImageUrl?: string; redirectUrl?: string; paymentLabel?: string }

const STORAGE_KEY = 'pending_balance_recharge'
const PENDING_RECHARGE_TTL_MS = 2 * 60 * 60 * 1000
const { visible, closeRecharge } = useRecharge()
const { balanceRechargeMinCents, balanceRechargeMaxCents, loadShopConfig } = useShopConfig()
const { getRechargeResponse, resetRechargeTurnstile } = useTurnstile()
const { isCoolingDown, buttonText, startCooldown } = useEmailCodeCooldown()
const step = ref<'form' | 'payment'>('form')
const email = ref('')
const emailCode = ref('')
const amountYuan = ref('50.00')
const amountCents = ref(5000)
const methods = ref<PublicPaymentMethod[]>([])
const selectedChannel = ref<PublicPaymentMethod['channel']>('alipay')
const sendingCode = ref(false)
const submitting = ref(false)
const methodsLoading = ref(false)
const methodsLoadError = ref('')
const error = ref('')
const { getEmailSession, sessionForEmail, saveEmailSession, clearEmailSession } = useEmailSession()
const orderId = ref('')
const orderNo = ref('')
const orderToken = ref('')
const qrImageUrl = ref('')
const redirectUrl = ref('')
const paymentLabel = ref(t('recharge.alipayDefault'))
const status = ref<RechargeStatus>('pending')
let idempotencyKey = createKey()
let pollTimer: ReturnType<typeof setInterval> | undefined

const presetAmounts = computed(() => [1000, 2000, 5000, 10000, 20000, 50000].filter((value) => value >= balanceRechargeMinCents.value && value <= balanceRechargeMaxCents.value))
const paymentAvailabilityError = computed(() => {
  if (methodsLoading.value) return ''
  if (methodsLoadError.value) return methodsLoadError.value
  return methods.value.length === 0 ? t('recharge.noPaymentMethods') : ''
})
const title = computed(() => step.value === 'form' ? t('recharge.title') : status.value === 'paid' ? t('recharge.success') : t('recharge.waitingPayment'))
const statusTitle = computed(() => ({
  pending: t('recharge.statusPending'),
  paid: t('recharge.statusPaid'),
  expired: t('recharge.statusExpired'),
  failed: t('recharge.statusFailed'),
})[status.value])
const statusMessage = computed(() => status.value === 'pending' ? t('recharge.msgPending') : status.value === 'paid' ? t('recharge.msgPaid', { amount: formatMoney(amountCents.value, 'CNY'), email: email.value }) : t('recharge.msgFailed'))
const verifiedSessionForEmail = computed(() => email.value.trim() ? sessionForEmail(email.value) : null)

function setAmount(value: number) { amountCents.value = value; amountYuan.value = minorToMajorString(value, 'CNY') }
function syncCustomAmount() { amountCents.value = parseYuanToCents(amountYuan.value) ?? 0 }
function createKey() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('') }
function savePending(extra: Partial<StoredRecharge> = {}) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ idempotencyKey, email: email.value.trim().toLowerCase(), amountCents: amountCents.value, channel: selectedChannel.value, createdAt: new Date().toISOString(), orderId: orderId.value || undefined, orderNo: orderNo.value || undefined, orderToken: orderToken.value || undefined, qrImageUrl: qrImageUrl.value || undefined, redirectUrl: redirectUrl.value || undefined, paymentLabel: paymentLabel.value, ...extra }))
  } catch {
    // Payment remains usable when browser privacy settings disable session storage.
  }
}
function clearPending() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* no persisted session to clear */ }
}

function resetFormState() {
  step.value = 'form'
  status.value = 'pending'
  emailCode.value = ''
  orderId.value = ''
  orderNo.value = ''
  orderToken.value = ''
  qrImageUrl.value = ''
  redirectUrl.value = ''
  paymentLabel.value = t('recharge.alipayDefault')
  error.value = ''
  idempotencyKey = createKey()
}

function clearVerifiedEmail() {
  clearEmailSession()
  emailCode.value = ''
}

async function loadMethods() {
  methodsLoading.value = true
  methodsLoadError.value = ''
  try {
    const res = await fetchPaymentMethods()
    methods.value = res.methods
    if (!methods.value.some((item) => item.channel === selectedChannel.value)) selectedChannel.value = methods.value[0]?.channel || 'alipay'
  } catch (err: any) {
    methods.value = []
    methodsLoadError.value = err.message || t('recharge.loadMethodsFailed')
  } finally {
    methodsLoading.value = false
  }
}

async function sendCode() {
  if (sendingCode.value || isCoolingDown.value) return
  if (methodsLoading.value) { error.value = t('recharge.methodsLoading'); return }
  if (methods.value.length === 0) return
  if (!/^\S+@\S+\.\S+$/.test(email.value.trim())) { error.value = t('recharge.validEmail'); return }
  sendingCode.value = true; error.value = ''
  try { const res = await requestEmailAccessCode(email.value.trim(), getRechargeResponse() || undefined); startCooldown(res.resendCooldownSeconds || 60); resetRechargeTurnstile() }
  catch (err: any) { const retry = retryAfterSecondsFromError(err); if (retry) startCooldown(retry); error.value = err.message || t('recharge.emailCodeFailed'); resetRechargeTurnstile() }
  finally { sendingCode.value = false }
}

function applyOrder(data: Record<string, any>) {
  saveEmailSession(data.emailSession)
  orderId.value = String(data.orderId || '')
  orderNo.value = String(data.orderNo || '')
  orderToken.value = String(data.orderToken || '')
  qrImageUrl.value = String(data.qrImageUrl || '')
  redirectUrl.value = String(data.redirectUrl || '')
  paymentLabel.value = String(data.paymentChannelLabel || paymentLabel.value)
  status.value = (data.status || 'pending') as RechargeStatus
  step.value = 'payment'
  savePending()
  startPolling()
}

async function submit() {
  if (submitting.value) return
  if (!/^\S+@\S+\.\S+$/.test(email.value.trim())) { error.value = t('recharge.validEmail'); return }
  const session = verifiedSessionForEmail.value
  if (!session && !/^\d{6}$/.test(emailCode.value.trim())) { error.value = t('recharge.validCode'); return }
  if (amountCents.value < balanceRechargeMinCents.value || amountCents.value > balanceRechargeMaxCents.value) {
    error.value = t('recharge.amountRange', { min: formatMoney(balanceRechargeMinCents.value, 'CNY'), max: formatMoney(balanceRechargeMaxCents.value, 'CNY') })
    return
  }
  if (methodsLoading.value) { error.value = t('recharge.methodsLoading'); return }
  if (methods.value.length === 0) return
  submitting.value = true; error.value = ''; savePending()
  try { applyOrder(await createBalanceRecharge({ buyerEmail: email.value.trim(), emailAccessCode: session ? undefined : emailCode.value.trim(), emailSessionToken: session?.token, amountCents: amountCents.value, paymentChannel: selectedChannel.value, idempotencyKey })) }
  catch (err: any) {
    const details = err instanceof ApiError ? err.details : undefined
    if ((err.code === 'PAYMENT_CREATION_UNCERTAIN' || err.code === 'IDEMPOTENCY_PENDING') && details?.orderId && details?.orderToken) applyOrder(details)
    else { error.value = err.message || t('recharge.createOrderFailed'); if (err.code !== 'IDEMPOTENCY_PENDING') { clearPending(); idempotencyKey = createKey() } }
  } finally { submitting.value = false }
}

async function poll() {
  if (!orderId.value || !orderToken.value || status.value !== 'pending') return
  try {
    const res = await fetchBalanceRechargeStatus(orderId.value, orderToken.value)
    status.value = res.status
    if (res.status !== 'pending') { stopPolling(); clearPending() }
  } catch (err: any) { if (err.status === 404) { status.value = 'failed'; stopPolling(); clearPending() } }
}
function startPolling() { stopPolling(); pollTimer = setInterval(poll, 2500); poll() }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined }
function close() { if (submitting.value) return; stopPolling(); closeRecharge(); resetFormState() }
function restart() { stopPolling(); clearPending(); resetFormState() }

function restore() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as StoredRecharge | null
    const createdAt = stored && typeof stored.createdAt === 'string' ? Date.parse(stored.createdAt) : NaN
    if (!stored || !Number.isFinite(createdAt) || createdAt < Date.now() - PENDING_RECHARGE_TTL_MS || typeof stored.idempotencyKey !== 'string' || typeof stored.email !== 'string' || !Number.isInteger(stored.amountCents) || !['alipay', 'wxpay', 'qqpay'].includes(stored.channel)) {
      clearPending()
      resetFormState()
      return false
    }
    idempotencyKey = stored.idempotencyKey; email.value = stored.email; setAmount(stored.amountCents); selectedChannel.value = stored.channel
    if (stored.orderId && stored.orderToken) { orderId.value = stored.orderId; orderNo.value = stored.orderNo || ''; orderToken.value = stored.orderToken; qrImageUrl.value = stored.qrImageUrl || ''; redirectUrl.value = stored.redirectUrl || ''; paymentLabel.value = stored.paymentLabel || t('recharge.onlineFallback'); step.value = 'payment'; startPolling() }
    return true
  } catch { clearPending(); resetFormState(); return false }
}

watch(visible, async (next) => {
  if (!next) { stopPolling(); return }
  error.value = ''
  // 先同步恢复旧订单，不能让网络刷新窗口短暂展示一个可再次提交的新表单。
  const restored = restore()
  // 充值是加钱路径，可复用邮箱会话创建待支付单；但待恢复充值单必须保留原邮箱和幂等键。
  if (!restored && !email.value.trim()) {
    const session = getEmailSession()
    if (session?.email) email.value = session.email
  }
  await Promise.all([
    loadShopConfig(true).catch(() => undefined),
    loadMethods(),
  ])
})
onMounted(() => { if (restore()) visible.value = true })
onUnmounted(stopPolling)
</script>

<style scoped>
/* fallback 必须暗底可读：禁止 #fff / #e5e7eb / #111827 浅色主题默认 */
.recharge-overlay { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--overlay, rgba(0, 0, 0, 0.55)); }
.recharge-dialog { width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; border-radius: var(--r-lg, 8px); background: var(--tg-secondary-bg, #151b28); color: var(--tg-text, #f0f2f5); box-shadow: var(--shadow-lg, 0 4px 16px rgba(0, 0, 0, 0.5)); }
.recharge-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 0.5px solid var(--border, rgba(255, 255, 255, 0.1)); }
.recharge-header h2 { margin: 2px 0 0; font-size: 18px; }
.recharge-eyebrow { color: var(--tg-hint, #9aa4b2); font-size: 11px; font-weight: 600; }
.recharge-close { width: 32px; height: 32px; border: 0; background: transparent; color: var(--tg-hint, #9aa4b2); font-size: 24px; cursor: pointer; }
.recharge-body { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.amount-presets, .recharge-methods { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.amount-presets button, .recharge-methods button { min-height: 42px; border: 0.5px solid var(--border, rgba(255, 255, 255, 0.1)); border-radius: var(--r-md, 8px); background: var(--surface, rgba(255, 255, 255, 0.04)); color: var(--tg-text, #f0f2f5); cursor: pointer; }
.amount-presets button.active, .recharge-methods button.active { border-color: var(--tg-btn); background: color-mix(in srgb, var(--tg-btn) 10%, transparent); color: var(--tg-btn); font-weight: 700; }
.recharge-field { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 0; font-size: 12px; }
.recharge-field input { width: 100%; min-height: 42px; padding: 9px 10px; border: 0.5px solid var(--border, rgba(255, 255, 255, 0.1)); border-radius: var(--r-md, 8px); background: var(--surface, rgba(255, 255, 255, 0.04)); color: var(--tg-text, #f0f2f5); font-size: 14px; }
.code-row { display: flex; align-items: flex-end; gap: 8px; }
.code-row .btn { min-height: 42px; flex-shrink: 0; }
.recharge-primary { width: 100%; min-height: 44px; }
.recharge-error { margin: 0; color: var(--tg-destructive, #ef4444); font-size: 13px; }
.recharge-summary { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.recharge-summary span, .recharge-summary small { color: var(--tg-hint, #9aa4b2); font-size: 12px; }
.recharge-summary strong { font-size: 28px; }
.recharge-qr { width: min(240px, 80vw); aspect-ratio: 1; object-fit: contain; align-self: center; }
.recharge-state { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: 0.5px solid var(--border, rgba(255, 255, 255, 0.1)); border-radius: var(--r-md, 8px); }
.recharge-state span { color: var(--tg-hint, #9aa4b2); font-size: 13px; line-height: 1.5; }
.recharge-state.paid { border-color: var(--admin-success-border, rgba(52, 211, 153, 0.28)); background: var(--admin-success-soft, rgba(52, 211, 153, 0.12)); }
@media (max-width: 640px) { .recharge-overlay { align-items: flex-end; padding: 0; } .recharge-dialog { width: 100%; max-height: 92vh; border-radius: 8px 8px 0 0; } }
</style>
