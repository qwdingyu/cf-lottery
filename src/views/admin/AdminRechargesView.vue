<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input
          v-model="filter.q"
          type="search"
          maxlength="120"
          :placeholder="$t('adminRecharges.searchOrderPlaceholder')"
          :title="$t('adminRecharges.searchOrderTitle')"
          :aria-label="$t('adminRecharges.searchOrderTitle')"
          @keyup.enter="searchData"
        />
        <input
          v-model="filter.email"
          type="search"
          maxlength="160"
          :placeholder="$t('adminRecharges.searchEmailPlaceholder')"
          :aria-label="$t('adminRecharges.searchEmailPlaceholder')"
          @keyup.enter="searchData"
        />
        <select v-model="filter.status" :aria-label="$t('adminRecharges.statusAll')" @change="searchData">
          <option value="">{{ $t('adminRecharges.statusAll') }}</option>
          <option value="pending">{{ $t('adminRecharges.statusPending') }}</option>
          <option value="paid">{{ $t('adminRecharges.statusPaid') }}</option>
          <option value="expired">{{ $t('adminRecharges.statusExpired') }}</option>
          <option value="failed">{{ $t('adminRecharges.statusFailed') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminRecharges.loading') : $t('adminRecharges.searchBtn') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminRecharges.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" @click="loadData">{{ $t('adminRecharges.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite">
      <span>{{ $t('adminRecharges.selectedCount', { count: selectedCount }) }}</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" @click="clearSelection">{{ $t('adminRecharges.actionClearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" @click="copySelected">{{ $t('adminRecharges.actionCopySelected') }}</button>
        <button class="btn btn-primary btn-sm" @click="exportSelected">{{ $t('adminRecharges.actionExportSelected') }}</button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminRecharges.title')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminRecharges.title')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading"
                :aria-label="$t('adminRecharges.title')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminRecharges.colOrderNo') }}</th>
            <th>{{ $t('adminRecharges.colEmail') }}</th>
            <th>{{ $t('adminRecharges.colAmount') }}</th>
            <th>{{ $t('adminRecharges.colStatus') }}</th>
            <th>{{ $t('adminRecharges.colProvider') }}</th>
            <th>{{ $t('adminRecharges.colPaymentRef') }}</th>
            <th>{{ $t('adminRecharges.colTime') }}</th>
            <th>{{ $t('adminRecharges.colPaidAt') }}</th>
            <th>{{ $t('adminRecharges.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="i" class="skeleton-row">
            <td colspan="10"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :aria-label="$t('adminRecharges.title') + ' ' + item.orderNo"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td><code>{{ item.orderNo }}</code></td>
            <td>{{ item.buyerEmail }}</td>
            <td>{{ formatMoney(item.amountCents, item.currency) }}</td>
            <td><span class="tag" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td>
            <td>{{ item.paymentProvider }}</td>
            <td>{{ item.paymentRef || '-' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>{{ formatDate(item.paidAt) }}</td>
            <td><button class="btn btn-ghost btn-xs" @click="copyOrders([item])">{{ $t('adminRecharges.actionCopy') }}</button></td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="10" class="empty-text">{{ $t('adminRecharges.noData') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchAdminRechargeOrders } from '@/api/admin'
import type { AdminRechargeOrder, AdminRechargeOrderFilter } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useTableSelection } from '@/composables/useTableSelection'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import { downloadCsv } from '@/lib/csv-export'
import AdminPagination from '@/components/AdminPagination.vue'
import { formatMoney, minorToMajorString } from '@shared/money'

const { t } = useI18n()
const { token } = useAdminAuth()
const { showToast } = useToast()
const items = ref<AdminRechargeOrder[]>([])
const loading = ref(false)
const loadError = ref('')
const filter = reactive<AdminRechargeOrderFilter>({ email: '', status: '', q: '' })
const pagination = useTablePagination()
let loadSequence = 0
const {
  selectedIds,
  selectedCount,
  selectableCount,
  allVisibleSelected,
  partiallySelected,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
} = useTableSelection(items, (item) => item.id)
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(item.id))
})

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminRechargeOrders(token.value, {
      ...filter,
      limit: pagination.limit.value,
      offset: (pagination.page.value - 1) * pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.items
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || t('adminRecharges.searchBtn')
    showToast(loadError.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  loadData()
}

function orderLine(item: AdminRechargeOrder) {
  return [
    item.orderNo,
    item.buyerEmail,
    minorToMajorString(item.amountCents, item.currency),
    item.currency,
    item.status,
    item.paymentProvider,
    item.paymentRef || '',
  ].join('\t')
}

async function copyOrders(rows: AdminRechargeOrder[]) {
  try {
    await writeClipboardText(rows.map(orderLine).join('\n'))
    showToast(t('adminRecharges.actionCopySelected') + ' ' + rows.length, 'success')
  } catch {
    showToast(t('toast.copyFailed'), 'error')
  }
}

function copySelected() {
  return copyOrders(selectedItems.value)
}

function exportSelected() {
  downloadCsv(
    `selected-recharge-orders-${new Date().toISOString().slice(0, 10)}.csv`,
    [
      ['orderNo', 'buyerEmail', 'amountCents', 'currency', 'status', 'paymentProvider', 'paymentRef', 'createdAt', 'paidAt', 'expiresAt'],
      ...selectedItems.value.map((item) => [
        item.orderNo,
        item.buyerEmail,
        String(item.amountCents),
        item.currency,
        item.status,
        item.paymentProvider,
        item.paymentRef || '',
        item.createdAt,
        item.paidAt || '',
        item.expiresAt,
      ]),
    ],
  )
  showToast(t('adminRecharges.actionExportSelected') + ' ' + selectedItems.value.length, 'success')
}

function statusLabel(status: string) {
  return ({ pending: t('adminRecharges.statusPending'), paid: t('adminRecharges.statusPaid'), expired: t('adminRecharges.statusExpired'), failed: t('adminRecharges.statusFailed') } as Record<string, string>)[status] || status
}

function statusClass(status: string) {
  if (status === 'paid') return 'tag-success'
  if (status === 'pending') return 'tag-warning'
  if (status === 'failed') return 'tag-danger'
  return 'tag-muted'
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
