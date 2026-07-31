<template>
  <div class="admin-dashboard admin-page">
    <div class="toolbar">
      <h2 class="toolbar-title">{{ $t('adminDashboard.title') }}</h2>
    </div>

    <div v-if="summaryError" class="table-error" role="alert">
      <span>{{ summaryError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminDashboard.reload') }}</button>
    </div>

    <section class="priority-board" :aria-label="$t('adminDashboard.priorities')">
      <div class="priority-board-head">
        <div>
          <h2 class="priority-board-title">{{ $t('adminDashboard.priorities') }}</h2>
          <p class="priority-board-subtitle">
            {{ $t('adminDashboard.prioritiesHint') }}
          </p>
        </div>
        <div class="priority-board-meta">
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            :disabled="pendingLoading || loading"
            @click="refreshDashboard"
          >
            {{ pendingLoading || loading ? $t('adminDashboard.refreshing') : $t('adminDashboard.refresh') }}
          </button>
          <span
            class="priority-board-total"
            :class="{ 'priority-board-total--hot': hasAnyPending }"
          >
            {{ pendingTotalLabel }}
          </span>
        </div>
      </div>

      <div v-if="pendingError" class="priority-board-error" role="alert">
        <span>{{ pendingError }}</span>
        <button class="btn btn-ghost btn-xs" type="button" :disabled="pendingLoading" @click="loadPendingTasks">
          {{ $t('adminDashboard.retry') }}
        </button>
      </div>

      <div class="priority-strip" :aria-busy="pendingLoading">
        <button
          v-for="item in priorityItems"
          :key="item.id"
          type="button"
          class="priority-card"
          :class="[
            item.toneClass,
            item.count === 0 ? 'priority-card--empty' : 'priority-card--hot',
            { 'priority-card--loading': pendingLoading },
          ]"
          :disabled="pendingLoading"
          @click="item.go"
        >
          <div class="priority-card-top">
            <span class="priority-step">{{ item.step }}</span>
            <span class="priority-label">{{ item.label }}</span>
            <span v-if="item.countCap" class="priority-cap" :title="$t('adminDashboard.max50')">{{ $t('adminDashboard.max50') }}</span>
          </div>
          <div class="priority-value" :class="{ 'priority-value--muted': item.count === 0 }">
            <template v-if="pendingLoading">—</template>
            <template v-else>{{ item.countLabel }}</template>
          </div>
          <div class="priority-title">{{ item.title }}</div>
          <p class="priority-hint">{{ item.hint }}</p>
          <span class="priority-action">{{ item.actionLabel }}</span>
        </button>
      </div>
    </section>

    <section class="stats-grid" :aria-label="$t('adminDashboard.overview')">
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.products }}</div>
        <div class="stat-label">{{ $t('adminDashboard.statProducts') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.availableCards }}</div>
        <div class="stat-label">{{ $t('adminDashboard.statAvailableCards') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.totalOrders }}</div>
        <div class="stat-label">{{ $t('adminDashboard.statTotalOrders') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">{{ loading ? '—' : summary.pendingOrders }}</div>
        <div class="stat-label">{{ $t('adminDashboard.statPendingOrders') }}</div>
      </div>
      <button
        type="button"
        class="stat-card stat-card--clickable"
        :disabled="loading || summary.lowStockCount === 0"
        @click="scrollToLowStock"
      >
        <div class="stat-num">{{ loading ? '—' : summary.lowStockCount }}</div>
        <div class="stat-label">{{ $t('adminDashboard.lowStockAlert') }}</div>
      </button>
    </section>

    <section class="card marketing-summary-card">
      <div class="card-header">
        <div>
          <h2 class="card-title">{{ $t('adminDashboard.marketingSummary') }}</h2>
          <p class="card-hint">{{ $t('adminDashboard.marketingSummaryHint', { days: marketingDays }) }}</p>
        </div>
        <div class="card-header-actions">
          <select v-model.number="marketingDays" class="marketing-days-select" :aria-label="$t('adminDashboard.marketingDaysAria')" @change="loadMarketingSummary">
            <option :value="7">{{ $t('adminDashboard.marketingDays7') }}</option>
            <option :value="30">{{ $t('adminDashboard.marketingDays30') }}</option>
            <option :value="90">{{ $t('adminDashboard.marketingDays90') }}</option>
          </select>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="marketingLoading" @click="loadMarketingSummary">
            {{ marketingLoading ? $t('adminDashboard.refreshLoading') : $t('adminDashboard.refreshBtn') }}
          </button>
        </div>
      </div>
      <div v-if="marketingError" class="table-error" role="alert">
        <span>{{ marketingError }}</span>
        <button class="btn btn-ghost btn-xs" type="button" :disabled="marketingLoading" @click="loadMarketingSummary">{{ $t('adminDashboard.retry') }}</button>
      </div>
      <div v-else class="marketing-summary-grid" :aria-busy="marketingLoading">
        <div v-for="group in marketingGroups" :key="group.key" class="marketing-summary-group">
          <h3>{{ group.label }}</h3>
          <div v-if="marketingLoading" class="empty-text">{{ $t('adminDashboard.pendingLoading') }}</div>
          <div v-else-if="group.rows.length === 0" class="empty-text">{{ $t('adminDashboard.noMarketingData') }}</div>
          <table v-else class="admin-table marketing-summary-table">
            <thead>
              <tr>
                <th>{{ group.label }}</th>
                <th>{{ $t('adminDashboard.marketingOrders') }}</th>
                <th>{{ $t('adminDashboard.marketingAmount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in group.rows" :key="row.code">
                <td>
                  <button
                    type="button"
                    class="marketing-summary-link"
                    :title="$t('adminDashboard.marketingViewOrders')"
                    @click="goToMarketingOrders(group.key, row)"
                  >
                    <code>{{ row.code }}</code>
                  </button>
                </td>
                <td>{{ row.orderCount }}</td>
                <td>{{ formatMoney(row.amountCents, 'CNY') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">{{ $t('adminDashboard.tools') }}</h2>
        <span class="card-hint">{{ $t('adminDashboard.toolsHint') }}</span>
      </div>
      <div class="ops-grid">
        <button class="ops-action" type="button" @click="goToBalance">
          <span class="ops-title">{{ $t('adminDashboard.toolBalance') }}</span>
          <span class="ops-desc">{{ $t('adminDashboard.toolBalanceDesc') }}</span>
        </button>
        <button class="ops-action" type="button" @click="goToLogs">
          <span class="ops-title">{{ $t('adminDashboard.toolLogs') }}</span>
          <span class="ops-desc">{{ $t('adminDashboard.toolLogsDesc') }}</span>
        </button>
        <button class="ops-action" type="button" @click="goToConfig">
          <span class="ops-title">{{ $t('adminDashboard.toolConfig') }}</span>
          <span class="ops-desc">{{ $t('adminDashboard.toolConfigDesc') }}</span>
        </button>
        <button class="ops-action ops-action--maintenance" type="button" :disabled="cleanupLoading" @click="confirmCleanup">
          <span class="ops-title">{{ cleanupLoading ? $t('adminDashboard.toolCleanupLoading') : $t('adminDashboard.toolCleanup') }}</span>
          <span class="ops-desc">{{ $t('adminDashboard.toolCleanupDesc') }}</span>
        </button>
      </div>
      <p v-if="cleanupResult" class="maintenance-result">
        {{ cleanupResult }}
      </p>
    </section>

    <section class="card launch-check-card">
      <div class="card-header">
        <div>
          <h2 class="card-title">{{ $t('adminDashboard.checklist') }}</h2>
          <p class="launch-check-subtitle">{{ $t('adminDashboard.checklistSubtitle') }}</p>
        </div>
        <span class="launch-check-badge">{{ $t('adminDashboard.checklistBadge') }}</span>
      </div>
      <div class="launch-check-grid">
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>{{ $t('adminDashboard.checklistGate') }}</strong>
            <p>{{ $t('adminDashboard.checklistGateDesc') }}</p>
          </div>
        </div>
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>{{ $t('adminDashboard.checklistSmoke') }}</strong>
            <p>{{ $t('adminDashboard.checklistSmokeDesc') }}</p>
          </div>
        </div>
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>{{ $t('adminDashboard.checklistPayment') }}</strong>
            <p>{{ $t('adminDashboard.checklistPaymentDesc') }}</p>
          </div>
        </div>
        <div class="launch-check-item">
          <span class="launch-check-dot" />
          <div>
            <strong>{{ $t('adminDashboard.checklistOps') }}</strong>
            <p>{{ $t('adminDashboard.checklistOpsDesc') }}</p>
          </div>
        </div>
      </div>
      <div class="launch-check-actions">
        <button class="btn btn-primary btn-sm" type="button" @click="goToPayment">{{ $t('adminDashboard.checklistPaymentBtn') }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="goToConfig">{{ $t('adminDashboard.checklistConfigBtn') }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="goToLogs">{{ $t('adminDashboard.checklistLogsBtn') }}</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">{{ $t('adminDashboard.todayOverview') }}</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-num">{{ summary.ordersToday }}</div>
          <div class="stat-label">{{ $t('adminDashboard.todayOrders') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ summary.issuedToday }}</div>
          <div class="stat-label">{{ $t('adminDashboard.todayIssued') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.todayIncomeCents, 'CNY') }}</div>
          <div class="stat-label">{{ $t('adminDashboard.todayIncome') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.totalIncomeCents, 'CNY') }}</div>
          <div class="stat-label">{{ $t('adminDashboard.totalIncome') }}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">{{ $t('adminDashboard.todayRevenue') }}</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.todayAlipayCents, 'CNY') }}</div>
          <div class="stat-label">{{ $t('adminDashboard.channelOthers') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ formatMoney(summary.todayEasyPayCents, 'CNY') }}</div>
          <div class="stat-label">{{ $t('adminDashboard.channelEasyPay') }}</div>
        </div>
      </div>
    </section>

    <section class="card income-card">
      <div class="card-header income-header">
        <h2 class="card-title">{{ $t('adminDashboard.weekRevenue') }}</h2>
        <div class="income-total">
          <span>{{ $t('adminDashboard.weekTotal') }}</span>
          <strong>{{ formatMoney(weeklyIncomeCents, 'CNY') }}</strong>
        </div>
      </div>
      <div v-if="loading" class="skeleton-list">
        <div v-for="i in 7" :key="i" class="skeleton-line income-skeleton" />
      </div>
      <div v-else-if="dailyIncome.length === 0" class="empty-text">{{ $t('adminDashboard.noData') }}</div>
      <div v-else class="income-trend" role="list" :aria-label="$t('adminDashboard.weekRevenue')">
        <div v-for="row in incomeTrendRows" :key="row.date" class="income-row" role="listitem">
          <span class="income-date">{{ row.date }}</span>
          <span class="income-track" aria-hidden="true">
            <span class="income-bar" :style="{ width: row.barWidth }" />
          </span>
          <strong class="income-amount">{{ formatMoney(row.amountCents, 'CNY') }}</strong>
        </div>
      </div>
    </section>

    <section ref="lowStockSectionEl" class="card" id="low-stock-panel">
      <div class="card-header">
        <h2 class="card-title">{{ $t('adminDashboard.lowStockAlert') }}</h2>
        <div class="card-header-actions">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="lowStockLoading" @click="loadLowStock">
            {{ lowStockLoading ? $t('adminDashboard.refreshLoading') : $t('adminDashboard.refreshBtn') }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="goToLowStock">{{ $t('adminDashboard.filterProducts') }}</button>
        </div>
      </div>
      <div v-if="lowStockLoading || pendingLoading" class="skeleton-list">
        <div v-for="i in 3" :key="i" class="skeleton-line w-40" />
      </div>
      <div v-else-if="pendingError && lowStockProducts.length === 0" class="empty-text">
        {{ $t('adminDashboard.lowStockLoadError') }}
      </div>
      <div v-else-if="lowStockProducts.length === 0" class="empty-text">{{ $t('adminDashboard.noLowStock') }}</div>
      <table v-else class="admin-table" :aria-label="$t('adminDashboard.lowStockAlert')">
        <thead>
          <tr>
            <th>{{ $t('adminDashboard.colProduct') }}</th>
            <th>{{ $t('adminDashboard.colId') }}</th>
            <th>{{ $t('adminDashboard.colStock') }}</th>
            <th>{{ $t('adminDashboard.colAction') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in lowStockProducts" :key="item.id">
            <td>{{ item.title }}</td>
            <td class="mono-cell">{{ item.id }}</td>
            <td>
              <span class="stock-badge" :class="{ 'stock-badge--zero': Number(item.stock) === 0 }">
                {{ item.stock ?? '-' }}
              </span>
            </td>
            <td>
              <button class="btn btn-ghost btn-xs" type="button" @click="goProducts">{{ $t('adminDashboard.goProducts') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { fetchAdminMarketingSummary, fetchAdminSummary, fetchAdminLowStockProducts, fetchAdminPendingTasks, runAdminCleanup } from '@/api/admin'
import type { AdminMarketingSummary, AdminSummary, DailyIncome, AdminLowStockProduct, AdminPendingTasks } from '@/types/admin'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { normalizeCents } from '@/utils/currency'
import { formatMoney } from '@shared/money'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

/** 与 getTodayPendingTasks 中 order 列表 limit 保持一致 */
const PENDING_ORDER_LIST_CAP = 50

const { showToast } = useToast()
const { t } = useI18n()
const { token } = useAdminAuth()
const router = useRouter()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const summary = ref<AdminSummary>({
  products: 0,
  availableCards: 0,
  totalCards: 0,
  totalOrders: 0,
  pendingOrders: 0,
  lowStockCount: 0,
  ordersToday: 0,
  issuedToday: 0,
  totalIncomeCents: 0,
  todayIncomeCents: 0,
  todayAlipayCents: 0,
  todayEasyPayCents: 0,
})
const dailyIncome = ref<DailyIncome[]>([])
const loading = ref(true)
const summaryError = ref('')
const pendingLoading = ref(true)
const pendingError = ref('')
const lowStockLoading = ref(false)
const cleanupLoading = ref(false)
const cleanupResult = ref('')
const lowStockProducts = ref<AdminLowStockProduct[]>([])
const lowStockSectionEl = ref<HTMLElement | null>(null)
const pendingTasks = ref<AdminPendingTasks>({
  pendingOfflinePayments: [],
  paidButNotIssued: [],
  lowStockProducts: [],
})
const marketingDays = ref(30)
const marketingSummary = ref<AdminMarketingSummary>({
  days: 30,
  campaigns: [],
  referrals: [],
  storefronts: [],
})
const marketingLoading = ref(false)
const marketingError = ref('')
let marketingRequestSequence = 0

type MarketingGroupKey = 'storefronts' | 'campaigns' | 'referrals'

const marketingGroups = computed<Array<{ key: MarketingGroupKey; label: string; rows: AdminMarketingSummary['storefronts'] }>>(() => [
  { key: 'storefronts', label: t('adminDashboard.marketingStorefronts'), rows: marketingSummary.value.storefronts },
  { key: 'campaigns', label: t('adminDashboard.marketingCampaigns'), rows: marketingSummary.value.campaigns },
  { key: 'referrals', label: t('adminDashboard.marketingReferrals'), rows: marketingSummary.value.referrals },
])

function formatCappedCount(count: number, capped: boolean): string {
  if (capped && count >= PENDING_ORDER_LIST_CAP) return `${PENDING_ORDER_LIST_CAP}+`
  return String(count)
}

const offlinePendingCount = computed(() => pendingTasks.value.pendingOfflinePayments.length)
const paidPendingCount = computed(() => pendingTasks.value.paidButNotIssued.length)
const lowStockPendingCount = computed(() => pendingTasks.value.lowStockProducts.length)
const offlineCapped = computed(() => offlinePendingCount.value >= PENDING_ORDER_LIST_CAP)
const paidCapped = computed(() => paidPendingCount.value >= PENDING_ORDER_LIST_CAP)
const hasAnyPending = computed(() => (
  offlinePendingCount.value > 0 || paidPendingCount.value > 0 || lowStockPendingCount.value > 0
))

const pendingTotalLabel = computed(() => {
  if (pendingLoading.value) return t('adminDashboard.pendingLoading')
  if (!hasAnyPending.value) return t('adminDashboard.noPending')
  const parts: string[] = []
  if (offlinePendingCount.value > 0) {
    parts.push(`${t('adminDashboard.pendingOffline')} ${formatCappedCount(offlinePendingCount.value, offlineCapped.value)}`)
  }
  if (paidPendingCount.value > 0) {
    parts.push(`${t('adminDashboard.pendingPaid')} ${formatCappedCount(paidPendingCount.value, paidCapped.value)}`)
  }
  if (lowStockPendingCount.value > 0) {
    parts.push(`${t('adminDashboard.pendingLowStock')} ${lowStockPendingCount.value}`)
  }
  return parts.join(' · ')
})

const priorityItems = computed(() => [
  {
    id: 'offline',
    step: 1,
    label: t('adminDashboard.stepFirst'),
    title: t('adminDashboard.priorityOfflineTitle'),
    hint: t('adminDashboard.priorityOfflineHint'),
    count: offlinePendingCount.value,
    countCap: offlineCapped.value,
    countLabel: formatCappedCount(offlinePendingCount.value, offlineCapped.value),
    actionLabel: offlinePendingCount.value > 0 ? t('adminDashboard.actionProcess') : t('adminDashboard.actionView'),
    toneClass: 'priority-card--p1',
    go: goToPendingOfflinePayments,
  },
  {
    id: 'paid',
    step: 2,
    label: t('adminDashboard.stepSecond'),
    title: t('adminDashboard.priorityPaidTitle'),
    hint: t('adminDashboard.priorityPaidHint'),
    count: paidPendingCount.value,
    countCap: paidCapped.value,
    countLabel: formatCappedCount(paidPendingCount.value, paidCapped.value),
    actionLabel: paidPendingCount.value > 0 ? t('adminDashboard.actionProcess') : t('adminDashboard.actionView'),
    toneClass: 'priority-card--p2',
    go: goToPaidButNotIssued,
  },
  {
    id: 'stock',
    step: 3,
    label: t('adminDashboard.stepThird'),
    title: t('adminDashboard.priorityStockTitle'),
    hint: t('adminDashboard.priorityStockHint'),
    count: lowStockPendingCount.value,
    countCap: false,
    countLabel: String(lowStockPendingCount.value),
    actionLabel: lowStockPendingCount.value > 0 ? t('adminDashboard.actionRestock') : t('adminDashboard.actionViewProducts'),
    toneClass: 'priority-card--p3',
    go: goToLowStock,
  },
])

const incomeTrendRows = computed(() => {
  const rows = dailyIncome.value.map((row) => ({
    ...row,
    amountCents: normalizeCents(row.amountCents),
  }))
  const maxCents = Math.max(0, ...rows.map((row) => row.amountCents))

  return rows.map((row) => ({
    ...row,
    barWidth: maxCents > 0 && row.amountCents > 0
      ? `${Math.max(2, (row.amountCents / maxCents) * 100)}%`
      : '0%',
  }))
})

const weeklyIncomeCents = computed(() => (
  incomeTrendRows.value.reduce((total, row) => total + row.amountCents, 0)
))

async function loadData() {
  loading.value = true
  summaryError.value = ''
  try {
    const res = await fetchAdminSummary(token.value)
    summary.value = res.summary
    dailyIncome.value = res.dailyIncome
  } catch (err: any) {
    summaryError.value = err.message || t('adminDashboard.error')
    showToast(err.message || t('adminDashboard.error'), 'error')
  } finally {
    loading.value = false
  }
}

async function loadPendingTasks() {
  pendingLoading.value = true
  pendingError.value = ''
  try {
    const tasks = await fetchAdminPendingTasks(token.value)
    pendingTasks.value = tasks
    // 优先事项与低库存表同源：待办接口已带低库存列表，直接回填，避免二次请求与挂载竞态。
    lowStockProducts.value = tasks.lowStockProducts
  } catch (err: any) {
    pendingError.value = err.message || t('adminDashboard.error')
    showToast(pendingError.value, 'error')
  } finally {
    pendingLoading.value = false
  }
}

async function loadMarketingSummary() {
  const requestSequence = ++marketingRequestSequence
  marketingLoading.value = true
  marketingError.value = ''
  const requestedDays = marketingDays.value
  try {
    const result = await fetchAdminMarketingSummary(token.value, { days: requestedDays, limit: 10 })
    // 后台看板允许快速切换周期；只接收最后一次请求，避免慢响应覆盖新选择。
    if (requestSequence !== marketingRequestSequence) return
    marketingSummary.value = result.summary
  } catch (err: any) {
    if (requestSequence !== marketingRequestSequence) return
    marketingError.value = err.message || t('adminDashboard.error')
  } finally {
    if (requestSequence === marketingRequestSequence) {
      marketingLoading.value = false
    }
  }
}

async function loadLowStock() {
  lowStockLoading.value = true
  try {
    const res = await fetchAdminLowStockProducts(token.value)
    lowStockProducts.value = res.products
    // 与优先事项计数对齐
    pendingTasks.value = {
      ...pendingTasks.value,
      lowStockProducts: res.products,
    }
  } catch (err: any) {
    showToast(err.message || t('adminDashboard.error'), 'error')
  } finally {
    lowStockLoading.value = false
  }
}

async function refreshDashboard() {
  await Promise.all([loadData(), loadPendingTasks(), loadMarketingSummary()])
}

function goProducts() {
  router.push('/admin/products')
}

function goToPendingOfflinePayments() {
  router.push({ path: '/admin/orders', query: { tab: 'pending', paymentMethod: 'offline' } })
}

function goToPaidButNotIssued() {
  router.push({ path: '/admin/orders', query: { tab: 'all', status: 'paid' } })
}

function goToMarketingOrders(groupKey: MarketingGroupKey, row: AdminMarketingSummary['storefronts'][number]) {
  const query: Record<string, string> = {
    tab: 'all',
    status: 'paid,issued',
    orderSource: 'storefront',
  }
  if (groupKey === 'storefronts' && row.storefrontId) {
    query.storefrontId = row.storefrontId
  } else if (row.code) {
    // 活动码/推荐码复用订单列表统一 q；历史渠道快照缺 storefrontId 时也可按快照兜底搜索。
    query.q = row.code
  }
  router.push({ path: '/admin/orders', query })
}

function goToLowStock() {
  router.push({ path: '/admin/products', query: { lowStock: 'true' } })
}

function scrollToLowStock() {
  if (lowStockProducts.value.length === 0 && summary.value.lowStockCount > 0) {
    void loadLowStock()
  }
  lowStockSectionEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function goToBalance() {
  router.push('/admin/balance')
}

function goToLogs() {
  router.push('/admin/logs')
}

function goToConfig() {
  router.push('/admin/config')
}

function goToPayment() {
  router.push('/admin/payment')
}

async function runCleanup() {
  if (cleanupLoading.value) return
  cleanupLoading.value = true
  cleanupResult.value = ''
  try {
    const result = await runAdminCleanup(token.value)
    const deletedRows = Object.values(result.operationalData?.deleted || {}).reduce((sum, count) => sum + count, 0)
    const retentionResult = result.operationalData?.enabled
      ? t('adminDashboard.cleanupRetention', { rows: deletedRows })
      : t('adminDashboard.cleanupRetentionPaused')
    cleanupResult.value = t('adminDashboard.cleanupResult', {
      paid: result.reconciledPayments ?? 0,
      expired: result.expiredOrders,
      recharge: result.expiredRechargeOrders ?? 0,
      released: result.releasedCards,
      disabled: result.disabledExpiredCards ?? 0,
      retention: retentionResult,
    })
    showToast(result.message || t('adminDashboard.toolCleanup'), 'success')
    await Promise.all([loadData(), loadPendingTasks()])
  } catch (err: any) {
    showToast(err.message || t('adminDashboard.error'), 'error')
  } finally {
    cleanupLoading.value = false
  }
}

async function confirmCleanup() {
  if (!(await askConfirm(t('adminDashboard.confirmCleanup')))) return
  await runCleanup()
}

onMounted(() => {
  void refreshDashboard()
})
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
.admin-dashboard {
  display: flex;
  flex-direction: column;
  /* 区块间距与全站 stack token 对齐（略大于列表页 8/10，用 card-gap 作仪表盘段落） */
  gap: var(--admin-card-gap, 12px);
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.priority-board {
  display: flex;
  flex-direction: column;
  gap: var(--admin-card-gap, 12px);
  padding: var(--admin-card-pad, 12px);
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  background: var(--tg-secondary-bg, #151b28);
}

.priority-board-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.priority-board-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--tg-text, #f0f2f5);
}

.priority-board-subtitle {
  margin: 4px 0 0;
  max-width: 52ch;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.priority-board-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.priority-board-total {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 650;
  color: var(--tg-hint, #9aa4b2);
  background: rgba(148, 163, 184, 0.12);
  white-space: nowrap;
}

.priority-board-total--hot {
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.16);
}

.priority-board-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 0.5px solid rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.1);
  color: #fca5a5;
  font-size: 12px;
}

.priority-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.priority-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 172px;
  padding: 14px;
  border-radius: var(--r-lg, 12px);
  border: 0.5px solid transparent;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}

.priority-card:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);
}

.priority-card:focus-visible {
  outline: 2px solid var(--admin-accent, #f59e0b);
  outline-offset: 2px;
}

.priority-card:disabled {
  cursor: wait;
}

.priority-card--loading {
  opacity: 0.72;
}

.priority-card--p1 {
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.16), rgba(239, 68, 68, 0.05));
  border-color: rgba(239, 68, 68, 0.28);
}

.priority-card--p2 {
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.16), rgba(245, 158, 11, 0.05));
  border-color: rgba(245, 158, 11, 0.28);
}

.priority-card--p3 {
  background: linear-gradient(
    180deg,
    var(--admin-accent-soft, rgba(245, 158, 11, 0.16)),
    rgba(245, 158, 11, 0.05)
  );
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.28));
}

.priority-card--empty {
  opacity: 0.72;
}

.priority-card--hot {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.priority-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.priority-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: var(--tg-text, #f0f2f5);
  background: #6b7280;
}

.priority-card--p1 .priority-step {
  background: #dc2626;
}

.priority-card--p2 .priority-step {
  background: #d97706;
}

.priority-card--p3 .priority-step {
  background: var(--admin-accent, #f59e0b);
}

.priority-label {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--tg-hint, #9aa4b2);
}

.priority-card--p1 .priority-label {
  color: #fca5a5;
}

.priority-card--p2 .priority-label {
  color: #fcd34d;
}

.priority-card--p3 .priority-label {
  color: var(--admin-accent-text, #fbbf24);
}

.priority-cap {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 650;
  color: var(--tg-hint, #9aa4b2);
  background: rgba(148, 163, 184, 0.14);
}

.priority-value {
  margin-top: 4px;
  font-size: 30px;
  font-weight: 750;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--tg-text, #f0f2f5);
}

.priority-value--muted {
  color: var(--tg-hint, #9aa4b2);
}

.priority-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--tg-text, #f0f2f5);
}

.priority-hint {
  margin: 0;
  flex: 1;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.priority-action {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 650;
  color: var(--admin-accent-text, #fbbf24);
}

.priority-card--p1 .priority-action {
  color: #f87171;
}

.priority-card--p2 .priority-action {
  color: #fbbf24;
}

.priority-card--p3 .priority-action {
  color: var(--admin-accent-text, #fbbf24);
}

.card-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* mono-cell → admin.css */

.stock-badge {
  display: inline-flex;
  min-width: 2ch;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.stock-badge--zero {
  color: #f87171;
}

@media (max-width: 820px) {
  .priority-board-head {
    flex-direction: column;
  }

  .priority-board-meta {
    width: 100%;
    justify-content: space-between;
  }

  .priority-strip {
    grid-template-columns: 1fr;
  }

  .priority-card {
    min-height: 0;
  }
}

.admin-dashboard .toolbar {
  margin-bottom: 4px;
}

.toolbar-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--admin-card-gap, 12px);
}

.stat-card {
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  padding: var(--admin-card-pad, 12px);
  text-align: center;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
}

.stat-card--clickable {
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.stat-card--clickable:hover {
  transform: translateY(-1px);
  border-color: var(--admin-accent, #f59e0b);
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.22));
}

.stat-card--clickable:disabled {
  cursor: default;
  opacity: 0.72;
}

.stat-card--clickable:disabled:hover {
  transform: none;
  border-color: var(--border, rgba(148, 163, 184, 0.22));
  box-shadow: none;
}

.stat-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--admin-accent-text, #fbbf24);
}

.stat-label {
  margin-top: 6px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
}

.card {
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  padding: var(--admin-card-pad, 12px);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--admin-stack-gap, 8px);
}

.card-title {
  margin: 0;
  font-size: 16px;
}

.card-hint {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.marketing-summary-card {
  border-color: rgba(20, 184, 166, 0.24);
}

.marketing-days-select {
  min-height: 32px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  border-radius: var(--r-sm, 8px);
  background-color: var(--tg-bg, #0a0e17);
  color: var(--tg-text, #f0f2f5);
  font: inherit;
  font-size: 12px;
}

.marketing-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.marketing-summary-group {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  border-radius: var(--r-lg, 12px);
  background: var(--tg-bg, #0a0e17);
}

.marketing-summary-group h3 {
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
  font-weight: 650;
}

.marketing-summary-table {
  margin: 0;
  min-width: 0;
}

.marketing-summary-table th,
.marketing-summary-table td {
  padding: 8px 10px;
  font-size: 12px;
  white-space: nowrap;
}

.marketing-summary-table th:first-child,
.marketing-summary-table td:first-child {
  width: 100%;
}

.marketing-summary-table code {
  display: inline-block;
  max-width: 18ch;
  overflow: hidden;
  color: var(--tg-text, #f0f2f5);
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.marketing-summary-link {
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.marketing-summary-link:hover code,
.marketing-summary-link:focus-visible code {
  color: var(--admin-accent, #f59e0b);
  text-decoration: underline;
}

.marketing-summary-link:focus-visible {
  outline: 2px solid var(--admin-accent, #f59e0b);
  outline-offset: 2px;
  border-radius: 4px;
}

.ops-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.ops-action {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.22));
  border-radius: var(--r-lg, 12px);
  background: var(--tg-bg, #0a0e17);
  color: var(--tg-text, #f0f2f5);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, transform 0.15s ease;
}

.ops-action:hover:not(:disabled) {
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  transform: translateY(-1px);
}

.ops-action:disabled {
  cursor: wait;
  opacity: 0.65;
}

.ops-action--maintenance {
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.1));
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.28));
}

.ops-title {
  font-size: 14px;
  font-weight: 600;
}

.ops-desc {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.45;
}

.maintenance-result {
  margin: 10px 0 0;
  color: var(--tg-hint, #9aa4b2);
  font-size: 13px;
}

.launch-check-card {
  border-color: rgba(245, 158, 11, 0.28);
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.08), rgba(245, 158, 11, 0.025)), var(--tg-secondary-bg, #151b28);
}

.launch-check-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.launch-check-badge {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.16);
  color: #fbbf24;
  font-size: 12px;
  font-weight: 700;
}

.launch-check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.launch-check-item {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 0.5px solid rgba(245, 158, 11, 0.2);
  border-radius: var(--r-lg, 12px);
  background: var(--tg-secondary-bg, rgba(245, 158, 11, 0.06));
}

.launch-check-dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 999px;
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.14);
}

.launch-check-item strong {
  display: block;
  font-size: 14px;
  color: var(--tg-text, #f0f2f5);
}

.launch-check-item p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.launch-check-item code {
  color: var(--tg-text, #f0f2f5);
  font-weight: 700;
}

.launch-check-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

/* skeleton-list / skeleton-line / w-40 → admin.css */

.income-header {
  align-items: flex-start;
}

.income-total {
  display: flex;
  align-items: baseline;
  gap: 10px;
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
}

.income-total strong {
  color: var(--tg-text, #f0f2f5);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}

.income-trend {
  border-top: 0.5px solid var(--border, rgba(148, 163, 184, 0.22));
}

.income-row {
  display: grid;
  grid-template-columns: 56px minmax(80px, 1fr) minmax(90px, auto);
  align-items: center;
  gap: 14px;
  min-height: 44px;
  border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.22));
}

.income-row:last-child {
  border-bottom: 0;
}

.income-date,
.income-amount {
  font-variant-numeric: tabular-nums;
}

.income-date {
  color: var(--tg-hint, #9aa4b2);
  font-size: 13px;
}

.income-track {
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.14);
}

.income-bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--admin-accent, #f59e0b);
  transition: width 0.25s ease;
}

.income-amount {
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
  text-align: right;
}

.income-skeleton {
  width: 100%;
  height: 12px;
}

@media (max-width: 480px) {
  .marketing-summary-grid {
    grid-template-columns: 1fr;
  }

  .marketing-summary-card .card-header {
    align-items: stretch;
  }

  .marketing-summary-card .card-header-actions,
  .marketing-days-select {
    width: 100%;
  }

  .income-row {
    grid-template-columns: 48px minmax(32px, 1fr) minmax(78px, auto);
    gap: 8px;
  }

  .income-total {
    gap: 6px;
  }

  .income-total strong {
    font-size: 15px;
  }

  .income-amount {
    font-size: 12px;
  }
}

/* ── 桌面断点 ── */
@media (min-width: 1024px) {
  /* 间距继续走 --admin-card-gap，勿硬编码放大 */

  .stats-grid {
    grid-template-columns: repeat(5, 1fr);
    gap: var(--admin-card-gap, 12px);
  }

  .stat-card {
    padding: var(--admin-card-pad, 14px);
  }

  .stat-num {
    font-size: 26px;
  }

  .stat-label {
    margin-top: 6px;
    font-size: 13px;
  }

  .card {
    padding: var(--admin-card-pad, 14px);
  }

  .card-header {
    margin-bottom: var(--admin-stack-gap, 8px);
  }
}

@media (max-width: 900px) {
  .marketing-summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
