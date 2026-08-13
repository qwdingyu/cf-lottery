<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" :disabled="loading" @change="searchData">
          <option value="">{{ $t('adminPaymentOrders.allStatus') }}</option>
          <option value="pending">{{ $t('adminPaymentOrders.statusPending') }}</option>
          <option value="paid">{{ $t('adminPaymentOrders.statusPaid') }}</option>
          <option value="paid_fulfillment_failed">{{ $t('adminPaymentOrders.statusFulfillmentFailed') }}</option>
          <option value="paid_late_needs_refund">{{ $t('adminPaymentOrders.statusLateNeedsRefund') }}</option>
          <option value="needs_refund">{{ $t('adminPaymentOrders.statusNeedsRefund') }}</option>
          <option value="expired">{{ $t('adminPaymentOrders.statusExpired') }}</option>
          <option value="cancelled">{{ $t('adminPaymentOrders.statusCancelled') }}</option>
          <option value="refunded">{{ $t('adminPaymentOrders.statusRefunded') }}</option>
        </select>
        <select v-model="filter.provider" :disabled="loading" @change="searchData">
          <option value="">{{ $t('adminPaymentOrders.allProviders') }}</option>
          <option v-for="provider in providerOptions" :key="provider.name" :value="provider.name">
            {{ provider.displayName }}
          </option>
        </select>
        <input
          v-model.trim="filter.drawId"
          type="search"
          :placeholder="$t('adminPaymentOrders.drawIdPlaceholder')"
          :disabled="loading"
          @keyup.enter="searchData"
        />
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading" @click="searchData">{{ $t('adminPaymentOrders.search') }}</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">{{ $t('adminPaymentOrders.refresh') }}</button>
      </div>
    </div>

    <div v-if="error" class="table-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">{{ $t('adminPaymentOrders.retry') }}</button>
    </div>

    <div class="table-wrap" role="region" aria-label="Payment Orders" tabindex="0" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminPaymentOrders.colOrder') }}</th>
            <th>{{ $t('adminPaymentOrders.colDraw') }}</th>
            <th>{{ $t('adminPaymentOrders.colParticipant') }}</th>
            <th>{{ $t('adminPaymentOrders.colAmount') }}</th>
            <th>{{ $t('adminPaymentOrders.colStatus') }}</th>
            <th>{{ $t('adminPaymentOrders.colFulfillment') }}</th>
            <th>{{ $t('adminPaymentOrders.colTime') }}</th>
            <th>{{ $t('adminPaymentOrders.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td colspan="8"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="order in orders" :key="order.id">
            <td>
              <div class="cell-main">{{ order.id }}</div>
              <div class="cell-sub">{{ providerLabel(order.provider) }}</div>
              <div v-if="order.providerTradeNo" class="cell-sub">{{ order.providerTradeNo }}</div>
              <div v-if="order.pendingRefundAttemptCount" class="cell-sub refund-hint">
                {{ $t('adminPaymentOrders.refundAttemptPrefix', { count: order.pendingRefundAttemptCount }) }}
                <span v-if="order.pendingRefundProviderTradeNo">/{{ order.pendingRefundProviderTradeNo }}</span>
              </div>
            </td>
            <td>
              <div class="cell-main">{{ order.drawTitle }}</div>
              <div class="cell-sub">/{{ order.publicSlug }}</div>
            </td>
            <td>
              <div class="cell-main">{{ order.identityValue }}</div>
              <div class="cell-sub">{{ order.identityType }}</div>
            </td>
            <td>{{ formatAmount(order.amountCents, order.currency) }}</td>
            <td><span class="tag" :class="statusClass(order.status, order.pendingRefundAttemptCount)">{{ statusLabel(order.status, order.pendingRefundAttemptCount) }}</span></td>
            <td>
              <span class="tag" :class="order.hasPrizeCode ? 'tag-success' : 'tag-muted'">
                {{ order.hasPrizeCode ? $t('adminPaymentOrders.issued') : $t('adminPaymentOrders.notIssued') }}
              </span>
              <div v-if="order.prizeCodeStatus" class="cell-sub">{{ order.prizeCodeStatus }}</div>
            </td>
            <td>
              <div class="cell-main">{{ formatDate(order.createdAt) }}</div>
              <div v-if="order.paidAt" class="cell-sub">{{ $t('adminPaymentOrders.paidAtPrefix') }} {{ formatDate(order.paidAt) }}</div>
            </td>
            <td>
              <div class="row-actions">
                <button
                  class="btn btn-primary btn-xs"
                  type="button"
                  :disabled="mutatingId === order.id || order.status !== 'paid_fulfillment_failed'"
                  @click="retryFulfillment(order)"
                >
                  {{ mutatingId === order.id ? $t('adminPaymentOrders.processing') : $t('adminPaymentOrders.retryFulfillment') }}
                </button>
                <!-- 退款闭环（2026-08 上线补充）：paid / paid_fulfillment_failed / paid_late_needs_refund
                     可退款（后端 POST /payment-orders/:id/refund，owner/admin；已核销卡密会拒绝） -->
                <button
                  class="btn btn-danger btn-xs"
                  type="button"
                  :disabled="mutatingId === order.id || !isRefundable(order.status)"
                  @click="refundOrder(order)"
                >
                  {{ mutatingId === order.id ? $t('adminPaymentOrders.processing') : $t('adminPaymentOrders.refund') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="orders.length === 0">
            <td colspan="8" class="empty-text">{{ $t('adminPaymentOrders.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pagination-row">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || page <= 1" @click="previousPage">{{ $t('adminPaymentOrders.prevPage') }}</button>
      <span class="pagination-text">{{ $t('adminPaymentOrders.pageInfo', { page, total }) }}</span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || !hasMore" @click="nextPage">{{ $t('adminPaymentOrders.nextPage') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast, useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'
import { formatDate } from '@/composables/useFormat'
import type { AdminPaymentOrder, AdminPaymentOrdersResult } from '@/types/admin'

const { t } = useI18n()
const { showToast } = useToast()
const { askConfirm } = useConfirmDialog()
const loading = ref(false)
const error = ref('')
const orders = ref<AdminPaymentOrder[]>([])
const providerOptions = ref<AdminPaymentOrdersResult['providers']>([])
const total = ref(0)
const page = ref(1)
const limit = ref(20)
const mutatingId = ref('')
const filter = reactive({
  status: '',
  provider: '',
  drawId: '',
})

const hasMore = computed(() => page.value * limit.value < total.value)

function buildQuery() {
  const params = new URLSearchParams()
  params.set('limit', String(limit.value))
  params.set('offset', String((page.value - 1) * limit.value))
  if (filter.status) params.set('status', filter.status)
  if (filter.provider) params.set('provider', filter.provider)
  if (filter.drawId) params.set('drawId', filter.drawId)
  return params.toString()
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const data = await adminRequest<AdminPaymentOrdersResult>(`/api/admin/payment-orders?${buildQuery()}`)
    orders.value = data.orders
    providerOptions.value = data.providers || []
    total.value = data.total
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('adminPaymentOrders.loadFailed')
  } finally {
    loading.value = false
  }
}

function searchData() {
  page.value = 1
  void loadData()
}

function previousPage() {
  if (page.value <= 1) return
  page.value -= 1
  void loadData()
}

function nextPage() {
  if (!hasMore.value) return
  page.value += 1
  void loadData()
}

async function retryFulfillment(order: AdminPaymentOrder) {
  if (mutatingId.value) return
  mutatingId.value = order.id
  try {
    await adminRequest(`/api/admin/payment-orders/${encodeURIComponent(order.id)}/retry-fulfillment`, {
      method: 'POST',
    })
    showToast(t('adminPaymentOrders.retrySuccess'), 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('adminPaymentOrders.retryFailed'), 'error')
  } finally {
    mutatingId.value = ''
  }
}

/** 可退款状态（与后端 refundPaymentOrder 的 refundableStatuses 对齐） */
function isRefundable(status: string) {
  return status === 'paid' || status === 'paid_fulfillment_failed' || status === 'paid_late_needs_refund'
}

async function refundOrder(order: AdminPaymentOrder) {
  if (mutatingId.value) return
  const confirmed = await askConfirm(t('adminPaymentOrders.refundConfirm', { id: order.id }))
  if (!confirmed) return
  mutatingId.value = order.id
  try {
    await adminRequest(`/api/admin/payment-orders/${encodeURIComponent(order.id)}/refund`, {
      method: 'POST',
    })
    showToast(t('adminPaymentOrders.refundSuccess'), 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('adminPaymentOrders.refundFailed'), 'error')
  } finally {
    mutatingId.value = ''
  }
}

function statusLabel(status: string, pendingRefundAttemptCount = 0) {
  if (pendingRefundAttemptCount > 0) return t('adminPaymentOrders.statusNeedsRefund')
  const map: Record<string, string> = {
    pending: t('adminPaymentOrders.statusPending'),
    paid: t('adminPaymentOrders.statusPaid'),
    paid_fulfillment_failed: t('adminPaymentOrders.statusFulfillmentFailed'),
    paid_late_needs_refund: t('adminPaymentOrders.statusLateNeedsRefund'),
    refunded: t('adminPaymentOrders.statusRefunded'),
    expired: t('adminPaymentOrders.statusExpired'),
    cancelled: t('adminPaymentOrders.statusCancelled'),
  }
  return map[status] || status
}

function statusClass(status: string, pendingRefundAttemptCount = 0) {
  if (pendingRefundAttemptCount > 0) return 'tag-danger'
  if (status === 'paid') return 'tag-success'
  if (status === 'paid_fulfillment_failed') return 'tag-danger'
  if (status === 'paid_late_needs_refund') return 'tag-danger'
  if (status === 'pending') return 'tag-warning'
  return 'tag-muted'
}

function providerLabel(provider: string) {
  return providerOptions.value.find((item) => item.name === provider)?.displayName || provider
}

function formatAmount(amountCents: number, currency: string) {
  const normalized = currency.toUpperCase()
  if (normalized === 'JPY' || normalized === 'USDT') return `${amountCents} ${normalized}`
  return `${(amountCents / 100).toFixed(2)} ${normalized}`
}

onMounted(loadData)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row-actions { display: flex; gap: 6px; align-items: center; }
.cell-main { font-weight: 600; max-width: 260px; overflow-wrap: anywhere; }
.cell-sub { margin-top: 4px; color: var(--muted); font-size: 12px; max-width: 260px; overflow-wrap: anywhere; }
.pagination-row { display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-top: 14px; }
.pagination-text { color: var(--muted); font-size: 13px; }
.tag-warning { background: rgba(234, 179, 8, .16); color: #ca8a04; }
.tag-danger { background: rgba(239, 68, 68, .16); color: #dc2626; }
.refund-hint { color: #dc2626; }
</style>
