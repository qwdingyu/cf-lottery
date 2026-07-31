<template>
  <div class="order-view">
    <div class="page-section">
      <div class="section-label">{{ $t('order.title') }}</div>
      <h1 class="section-title">{{ $t('order.title') }}</h1>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="skeleton-card">
      <div class="skeleton skeleton-line w-70" />
      <div class="skeleton skeleton-line w-40" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="result-box status-error">
      {{ error }}
    </div>

    <!-- Order result -->
    <div v-else-if="order" class="order-result">
      <div class="result-status" :class="`result-${order.status}`">
        <span class="result-icon">{{ statusIcon }}</span>
        <span class="result-title">{{ statusText }}</span>
      </div>

      <div class="order-meta-box">
        <div class="meta-row">
          <span class="meta-label">{{ $t('order.orderNo') }}</span>
          <span class="meta-value">{{ order.orderNo || order.id }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">{{ $t('order.productName') }}</span>
          <span class="meta-value">{{ order.productTitle || order.productName }}</span>
        </div>
        <div class="meta-row" v-if="order.buyerEmail || order.buyerContact">
          <span class="meta-label">{{ $t('order.email') }}</span>
          <span class="meta-value">{{ order.buyerContact || order.buyerEmail || '-' }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">{{ $t('order.amount') }}</span>
          <span class="meta-value">{{ formatPrice(order.paidCents || order.amountCents, order.currency) }}</span>
        </div>
        <div v-if="order.paymentRef" class="meta-row">
          <span class="meta-label">{{ $t('order.amount') }}</span>
          <span class="meta-value">{{ order.paymentRef }}</span>
        </div>
        <div v-if="order.paidAt" class="meta-row">
          <span class="meta-label">{{ $t('order.time') }}</span>
          <span class="meta-value">{{ new Date(order.paidAt).toLocaleString() }}</span>
        </div>
        <div v-if="order.issuedAt" class="meta-row">
          <span class="meta-label">{{ $t('order.time') }}</span>
          <span class="meta-value">{{ new Date(order.issuedAt).toLocaleString() }}</span>
        </div>
        <div v-if="order.expiresAt" class="meta-row">
          <span class="meta-label">{{ $t('checkout.remainingTime') }}</span>
          <span class="meta-value">{{ new Date(order.expiresAt).toLocaleString() }}</span>
        </div>
      </div>

      <!-- Delivery info（复用共享组件，同时支持卡密和虚拟资料模式） -->
      <div v-if="(order.delivery && order.status === 'issued') || (order.cards && order.cards.length)" class="delivery-box">
        <h3 class="delivery-title">{{ isCardDelivery ? $t('delivery.cardData') : $t('order.deliveryInfo') }}</h3>
        <DeliveryInfo :delivery="order.delivery" :cards="order.cards" :fulfillment-mode="deliveryFulfillmentMode" />
        <div class="delivery-actions">
          <button v-if="copyPayload" class="btn btn-ghost btn-sm" type="button" @click="copyDelivery($event)">
            {{ $t('toast.copied') }}
          </button>
          <a v-if="supportEmail" class="btn btn-ghost btn-sm" :href="`mailto:${supportEmail}?subject=${encodeURIComponent($t('order.title') + ' ' + (order.orderNo || order.id))}`">
            {{ $t('order.title') }}
          </a>
        </div>
      </div>
      <div v-else-if="order.status === 'issued' && order.deliveryMessage" class="delivery-box">
        <h3 class="delivery-title">{{ $t('delivery.emailOnly') }}</h3>
        <p class="delivery-email-note">{{ order.deliveryMessage }}</p>
        <div class="delivery-actions">
          <a v-if="supportEmail" class="btn btn-ghost btn-sm" :href="`mailto:${supportEmail}?subject=${encodeURIComponent($t('order.title') + ' ' + (order.orderNo || order.id))}`">
            {{ $t('order.title') }}
          </a>
        </div>
      </div>

      <div class="step-actions">
        <RouterLink :to="shopHomePath" class="btn btn-primary">{{ $t('shop.buy') }}</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { getPayStatus, lookupOrders } from '@/api'
import { formatPrice } from '@/composables/useFormat'
import DeliveryInfo from '@/components/DeliveryInfo.vue'
import { useShopConfig } from '@/composables/useShopConfig'
import { useToast } from '@/composables/useToast'
import { copyText } from '@/composables/useClipboard'
import { fieldLabel, getDeliveryEntries } from '@/composables/useDeliveryDisplay'
import { useI18n } from 'vue-i18n'
import { useStorefrontContext } from '@/composables/useStorefrontContext'
import { normalizeOrderStatus, TERMINAL_ORDER_STATUS_SET } from '@shared/order-status'
import type { Order } from '@/types'

const { t } = useI18n()
const route = useRoute()
const loading = ref(true)
const error = ref('')
const order = ref<Order | null>(null)
const { supportEmail, loadShopConfig } = useShopConfig()
const { showToast } = useToast()
const { homePath: storefrontHomePath } = useStorefrontContext()
const shopHomePath = computed(() => storefrontHomePath.value)

const statusText = computed(() => {
  if (!order.value) return ''
  const normalized = normalizeOrderStatus(order.value.status)
  const map: Record<string, string> = {
    pending: t('order.statusText.pending'),
    paid: t('checkout.payConfirmed'),
    issued: t('order.statusText.issued'),
    expired: t('order.statusText.expired'),
    failed: t('order.statusText.failed'),
    canceled: t('order.statusText.cancelled'),
    closed: t('order.statusText.cancelled'),
    refunded: t('order.statusText.refunded'),
  }
  return map[normalized] || order.value.status
})

const statusIcon = computed(() => {
  if (!order.value) return '⟳'
  const icons: Record<string, string> = {
    pending: '⟳',
    paid: '⏳',
    issued: '✓',
    expired: '⏰',
    failed: '✕',
    canceled: '✕',
    closed: '✕',
    refunded: '↩',
  }
  return icons[normalizeOrderStatus(order.value.status)] || '⟳'
})

const deliveryFulfillmentMode = computed(() => {
  const firstItem = order.value?.items?.find(item => item.fulfillmentMode)
  return firstItem?.fulfillmentMode || order.value?.fulfillmentMode || (order.value?.cards?.length ? 'card' : '')
})
const isCardDelivery = computed(() => deliveryFulfillmentMode.value === 'card' || Boolean(order.value?.cards?.length))

// ReadonlySet<string>：normalize 返回 string，避免 Set 字面量联合类型导致 .has 报 TS2345
const pollableStatuses: ReadonlySet<string> = new Set(['pending', 'paid'])
const terminalStatuses: ReadonlySet<string> = TERMINAL_ORDER_STATUS_SET

let orderPollTimer: ReturnType<typeof setInterval> | null = null
let orderPollInFlight = false
let orderPollContext: { orderId: string; token: string } | null = null

function buildOrderState(res: any): Order {
  return {
    id: res.orderId,
    orderNo: res.orderNo || '',
    productId: '',
    productTitle: res.productTitle || '',
    productName: res.productTitle || '',
    priceCents: res.amountCents || 0,
    amountCents: res.amountCents || 0,
    paidCents: res.amountCents || 0,
    currency: res.currency || 'CNY',
    status: res.status as Order['status'],
    fulfillmentMode: res.fulfillmentMode,
    delivery: res.delivery,
    cards: res.cards || [],
    items: res.items || [],
    expiresAt: res.expiresAt,
    createdAt: '',
    buyerEmail: res.buyerEmail,
    buyerContact: res.buyerContact,
    paymentRef: res.paymentRef,
    paidAt: res.paidAt,
    issuedAt: res.issuedAt,
    deliveryVisibility: res.deliveryVisibility,
    deliveryMessage: res.deliveryMessage,
  }
}

function buildLookupOrderState(row: Order): Order {
  return {
    ...row,
    productName: row.productName || row.productTitle || '',
    priceCents: row.priceCents ?? row.amountCents ?? 0,
    amountCents: row.amountCents ?? row.priceCents ?? 0,
    paidCents: row.paidCents ?? row.amountCents ?? row.priceCents ?? 0,
    cards: row.cards || [],
    items: row.items || [],
  }
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] || '').trim()
  return String(value || '').trim()
}

function readOrderLinkParam(name: 'orderId' | 'token'): string {
  const queryValue = firstQueryValue(route.query[name])
  if (queryValue) return queryValue
  const hashQuery = route.hash.includes('?') ? route.hash.slice(route.hash.indexOf('?') + 1) : route.hash.replace(/^#/, '')
  return new URLSearchParams(hashQuery).get(name)?.trim() || ''
}

function stopOrderPolling() {
  if (orderPollTimer) {
    clearInterval(orderPollTimer)
    orderPollTimer = null
  }
  orderPollInFlight = false
  orderPollContext = null
}

async function refreshOrderStatus() {
  if (!orderPollContext || orderPollInFlight) return
  orderPollInFlight = true
  try {
    const res = await getPayStatus(orderPollContext.orderId, orderPollContext.token)
    order.value = buildOrderState(res)
    if (!pollableStatuses.has(normalizeOrderStatus(res.status))) {
      stopOrderPolling()
    }
  } catch {
    // 查询抖动时继续轮询，让订单详情自然收敛到最终状态。
  } finally {
    orderPollInFlight = false
  }
}

function startOrderPolling(orderId: string, token: string) {
  orderPollContext = { orderId, token }
  if (orderPollTimer) return
  orderPollTimer = setInterval(() => {
    void refreshOrderStatus()
  }, 3000)
}

const copyPayload = computed(() => {
  if (!order.value) return ''
  const segments: string[] = []
  if (isCardDelivery.value) {
    if (order.value.delivery?.accountLabel) segments.push(t('delivery.accountLabel') + '：' + order.value.delivery.accountLabel)
    if (order.value.delivery?.deliverySecret) segments.push(t('delivery.deliverySecret') + '：' + order.value.delivery.deliverySecret)
    if (order.value.delivery?.deliveryNote) segments.push(t('delivery.deliveryNote') + '：' + order.value.delivery.deliveryNote)
  } else {
    getDeliveryEntries(order.value.delivery as Record<string, unknown> | undefined | null, { includeLegacyDeliveryFields: true })
      .forEach(([key, value]) => segments.push(`${fieldLabel(key)}：${value}`))
  }
  if (order.value.cards?.length) {
    order.value.cards.forEach((card, index) => {
      segments.push(t('order.cardItem', { index: index + 1, data: card.cardData || card.deliverySecret || '' }))
    })
  }
  return segments.join('\n')
})



async function loadOrder() {
  stopOrderPolling()
  const orderId = readOrderLinkParam('orderId')
  const token = readOrderLinkParam('token')
  if (!token) {
    error.value = t('order.missingOrderInfo')
    loading.value = false
    return
  }
  try {
    if (!orderId) {
      // 抽奖中奖邮件和用户端中奖入口只携带高熵 token，不携带 orderId。
      // token-only 安全链接走 /api/orders/lookup，支付过程中的待支付/轮询订单仍走 getPayStatus(orderId, token)。
      const rows = await lookupOrders(token)
      const first = rows[0]
      if (!first) {
        error.value = t('order.queryFailed')
        return
      }
      order.value = buildLookupOrderState(first)
      return
    }
    const res = await getPayStatus(orderId, token)
    order.value = buildOrderState(res)
    const status = normalizeOrderStatus(res.status)
    if (pollableStatuses.has(status)) {
      startOrderPolling(orderId, token)
    } else if (terminalStatuses.has(status)) {
      stopOrderPolling()
    }
  } catch (err: any) {
    error.value = err.message || t('order.queryFailed')
  } finally {
    loading.value = false
  }
}

function copyDelivery(event: Event) {
  if (!copyPayload.value) return
  try {
    copyText(copyPayload.value, event)
    showToast(t('order.deliveryCopied'), 'success')
  } catch {
    showToast(t('order.copyFailed'), 'error')
  }
}

onMounted(() => {
  loadShopConfig()
  loadOrder()
})

onBeforeUnmount(() => {
  stopOrderPolling()
})
</script>

<style scoped>
.order-view {
  padding-top: 16px;
  padding-bottom: 24px;
}

.skeleton-card {
  padding: 16px;
  border-radius: var(--r-lg);
  background: var(--tg-secondary-bg);
}

.skeleton-line {
  height: 16px;
  margin-bottom: 12px;
}

.skeleton-line.w-70 { width: 70%; }
.skeleton-line.w-40 { width: 40%; }

.order-result {
  text-align: center;
}

.result-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  border-radius: var(--r-lg);
  margin-bottom: 20px;
  font-size: 18px;
  font-weight: 600;
}

.result-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.result-status.result-issued {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}

.result-status.result-paid {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.result-status.result-pending {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.result-status.result-expired,
.result-status.result-failed,
.result-status.result-canceled,
.result-status.result-closed,
.result-status.result-refunded {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.order-meta-box {
  text-align: left;
  padding: 14px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: 16px;
}

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 14px;
}

.meta-label {
  color: var(--tg-hint);
}

.meta-value {
  font-weight: 500;
  font-family: var(--font-mono);
}

.delivery-box {
  text-align: left;
  padding: 14px 16px;
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: 16px;
}

.delivery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
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

.step-actions {
  margin-top: 20px;
}
</style>
