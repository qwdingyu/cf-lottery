<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" class="filter-input" :disabled="loading" @change="searchData">
          <option value="">全部状态</option>
          <option value="pending">待支付</option>
          <option value="paid">已支付</option>
          <option value="paid_fulfillment_failed">发卡失败</option>
          <option value="expired">已过期</option>
          <option value="cancelled">已取消</option>
          <option value="refunded">已退款</option>
        </select>
        <select v-model="filter.provider" class="filter-input" :disabled="loading" @change="searchData">
          <option value="">全部渠道</option>
          <option value="alipay">支付宝</option>
          <option value="stripe">Stripe</option>
          <option value="usdt_trc20">USDT-TRC20</option>
          <option value="easypay">易支付</option>
        </select>
        <input
          v-model.trim="filter.drawId"
          class="filter-input"
          type="search"
          placeholder="活动 ID"
          :disabled="loading"
          @keyup.enter="searchData"
        />
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading" @click="searchData">查询</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="error" class="table-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">重试</button>
    </div>

    <div class="table-wrap" role="region" aria-label="支付订单列表" tabindex="0" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>订单</th>
            <th>活动</th>
            <th>参与者</th>
            <th>金额</th>
            <th>状态</th>
            <th>发卡</th>
            <th>时间</th>
            <th>操作</th>
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
            <td><span class="tag" :class="statusClass(order.status)">{{ statusLabel(order.status) }}</span></td>
            <td>
              <span class="tag" :class="order.hasPrizeCode ? 'tag-success' : 'tag-muted'">
                {{ order.hasPrizeCode ? '已发卡' : '未发卡' }}
              </span>
              <div v-if="order.prizeCodeStatus" class="cell-sub">{{ order.prizeCodeStatus }}</div>
            </td>
            <td>
              <div class="cell-main">{{ formatDate(order.createdAt) }}</div>
              <div v-if="order.paidAt" class="cell-sub">支付 {{ formatDate(order.paidAt) }}</div>
            </td>
            <td>
              <button
                class="btn btn-primary btn-xs"
                type="button"
                :disabled="mutatingId === order.id || order.status !== 'paid_fulfillment_failed'"
                @click="retryFulfillment(order)"
              >
                {{ mutatingId === order.id ? '处理中' : '补发卡密' }}
              </button>
            </td>
          </tr>
          <tr v-if="orders.length === 0">
            <td colspan="8" class="empty-text">暂无支付订单</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pagination-row">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || page <= 1" @click="previousPage">上一页</button>
      <span class="pagination-text">第 {{ page }} 页 / 共 {{ total }} 条</span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || !hasMore" @click="nextPage">下一页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'
import { formatDate } from '@/composables/useFormat'
import type { AdminPaymentOrder, AdminPaymentOrdersResult } from '@/types/admin'

const { showToast } = useToast()
const loading = ref(false)
const error = ref('')
const orders = ref<AdminPaymentOrder[]>([])
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
    total.value = data.total
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
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
    showToast('补发成功', 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : '补发失败', 'error')
  } finally {
    mutatingId.value = ''
  }
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    pending: '待支付',
    paid: '已支付',
    paid_fulfillment_failed: '发卡失败',
    refunded: '已退款',
    expired: '已过期',
    cancelled: '已取消',
  }
  return map[status] || status
}

function statusClass(status: string) {
  if (status === 'paid') return 'tag-success'
  if (status === 'paid_fulfillment_failed') return 'tag-danger'
  if (status === 'pending') return 'tag-warning'
  return 'tag-muted'
}

function providerLabel(provider: string) {
  const map: Record<string, string> = {
    alipay: '支付宝',
    stripe: 'Stripe',
    usdt_trc20: 'USDT-TRC20',
    easypay: '易支付',
  }
  return map[provider] || provider
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
.filter-input { min-height: 34px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); }
.cell-main { font-weight: 600; max-width: 260px; overflow-wrap: anywhere; }
.cell-sub { margin-top: 4px; color: var(--muted); font-size: 12px; max-width: 260px; overflow-wrap: anywhere; }
.pagination-row { display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-top: 14px; }
.pagination-text { color: var(--muted); font-size: 13px; }
.tag-warning { background: rgba(234, 179, 8, .16); color: #ca8a04; }
.tag-danger { background: rgba(239, 68, 68, .16); color: #dc2626; }
</style>
