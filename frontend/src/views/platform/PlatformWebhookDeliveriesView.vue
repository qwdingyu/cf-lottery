<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.tenantId" type="search" :placeholder="$t('platformWebhooks.tenantPlaceholder')" :disabled="batchOperating" @keyup.enter="searchData" />
        <select v-model="filter.status" :disabled="batchOperating" @change="searchData">
          <option value="">{{ $t('platformWebhooks.allStatus') }}</option>
          <option value="pending">{{ $t('platformWebhooks.statusPending') }}</option>
          <option value="sent">{{ $t('platformWebhooks.statusSent') }}</option>
          <option value="failed">{{ $t('platformWebhooks.statusFailed') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="searchData">
          {{ loading ? $t('platformWebhooks.searching') : $t('platformWebhooks.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="loadData">{{ $t('platformWebhooks.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('platformWebhooks.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('platformWebhooks.selectedCount', { count: selectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('platformWebhooks.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearSelection">
        {{ $t('platformWebhooks.clearSelection') }}
      </button>
      <button class="btn btn-primary btn-sm" type="button" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRetry">
        {{ $t('platformWebhooks.batchRetry', { count: selectedCount }) }}
      </button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformWebhooks.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="loading || batchOperating || selectableCount === 0"
                :aria-label="$t('platformWebhooks.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('platformWebhooks.colTime') }}</th>
            <th>{{ $t('platformWebhooks.colTenant') }}</th>
            <th>{{ $t('platformWebhooks.colEvent') }}</th>
            <th>{{ $t('platformWebhooks.colStatus') }}</th>
            <th>{{ $t('platformWebhooks.colAttempts') }}</th>
            <th>{{ $t('platformWebhooks.colError') }}</th>
            <th class="col-actions">{{ $t('platformWebhooks.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="8"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="d in deliveries" :key="d.id" :class="{ 'is-selected': isSelected(d.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(d.id)"
                :disabled="loading || batchOperating || !canRetryWebhookDelivery(d.status)"
                :aria-label="$t('platformWebhooks.selectRow')"
                @click="setSelected(d.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td class="time-cell">{{ formatTime(d.createdAt) }}</td>
            <td><code class="code-id" :title="d.tenantId" @click="copyText(d.tenantId)">{{ d.tenantId?.slice(0, 8) }}…</code></td>
            <td><span class="tag tag-info">{{ d.eventType }}</span></td>
            <td>
              <span class="tag" :class="statusClass(d.status)">{{ statusLabel(d.status) }}</span>
            </td>
            <td>{{ d.attemptCount }}</td>
            <td class="error-cell" :title="d.lastError">{{ d.lastError ? truncate(d.lastError, 60) : '-' }}</td>
            <td class="col-actions">
              <button
                v-if="canRetryWebhookDelivery(d.status)"
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="retryingId === d.id || batchOperating"
                @click="retryDelivery(d.id)"
              >{{ retryingId === d.id ? $t('platformWebhooks.retrying') : $t('platformWebhooks.retry') }}</button>
              <span v-else class="tag tag-muted">—</span>
            </td>
          </tr>
          <tr v-if="deliveries.length === 0">
            <td colspan="8" class="empty-text">{{ $t('platformWebhooks.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      v-if="pagination.total.value > 0"
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading || batchOperating"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminPagination from '@usethink/cf-admin-fe/components/AdminPagination.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { copyWithToast, useTablePagination } from '@usethink/cf-admin-fe/composables'
import { useTableSelection } from '@usethink/cf-admin-fe/composables'
import { useAdminBatchOperation } from '@usethink/cf-admin-fe/composables'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { buildAdminOffsetParams } from '@usethink/cf-admin-fe/utils'
import { adminRequest } from '@/composables/useAdminRequest'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { canRetryWebhookDelivery } from '@/views/admin/lottery/ops-utils'

type WebhookDelivery = {
  id: string
  tenantId: string
  eventType: string
  status: string
  attemptCount: number
  responseStatus?: number | null
  lastError: string
  createdAt: string
}

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const loading = ref(false)
const loadError = ref('')
const deliveries = ref<WebhookDelivery[]>([])
const retryingId = ref('')
const filter = ref({ tenantId: '', status: '' })
const pagination = useTablePagination({ initialLimit: 50 })

const deliveriesRef = computed(() => deliveries.value)
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()
const {
  selectedIds,
  selectedCount,
  selectableCount,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
  allVisibleSelected,
  partiallySelected,
} = useTableSelection(deliveriesRef, (row) => row.id, {
  isSelectable: (row) => canRetryWebhookDelivery(String(row.status || '')),
})

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: t('platformWebhooks.statusPending'),
    sent: t('platformWebhooks.statusSent'),
    failed: t('platformWebhooks.statusFailed'),
  }
  return map[status] || status
}

function statusClass(status: string): string {
  const map: Record<string, string> = { pending: 'tag-muted', sent: 'tag-success', failed: 'tag-danger' }
  return map[status] || 'tag-muted'
}

function truncate(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) + '…' : text
}

async function copyText(text: string) {
  if (!text) return
  await copyWithToast(text, {
    successMessage: t('lottery.copied'),
    errorMessage: t('platformTenants.copyIdFailed'),
  })
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams(buildAdminOffsetParams(pagination.page.value, pagination.limit.value))
    if (filter.value.tenantId) params.set('tenantId', filter.value.tenantId)
    if (filter.value.status) params.set('status', filter.value.status)
    const data = await adminRequest<{ deliveries: WebhookDelivery[] }>(`/api/platform/webhook-deliveries?${params}`)
    deliveries.value = data.deliveries || []
    pagination.setTotal(data.deliveries?.length === pagination.limit.value ? pagination.page.value * pagination.limit.value + 1 : (pagination.page.value - 1) * pagination.limit.value + (data.deliveries?.length || 0))
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('platformWebhooks.loadFailed')
  } finally {
    loading.value = false
  }
}

function searchData() { pagination.setPage(1); loadData() }

async function retryDelivery(id: string) {
  if (retryingId.value || batchOperating.value) return
  retryingId.value = id
  try {
    await adminRequest(`/api/platform/webhook-deliveries/${id}/retry`, { method: 'POST' })
    showToast(t('platformWebhooks.retried'), 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('platformWebhooks.retryFailed'), 'error')
  }
  retryingId.value = ''
}

/** 测试排障：仅 failed/pending 顺序重试，真实打外部 URL，后端已写审计 */
async function batchRetry() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('platformWebhooks.batchRetryConfirm', { count: ids.length })))) return
  const result = await runSequential(ids, async (id) => {
    await adminRequest(`/api/platform/webhook-deliveries/${id}/retry`, { method: 'POST' })
  })
  if (!result) return
  if (result.failed > 0) {
    showToast(t('platformWebhooks.batchRetryResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t('platformWebhooks.batchRetrySuccess', { count: result.success }), 'success')
  }
  clearSelection()
  await loadData()
}

onMounted(loadData)
</script>

<style scoped>
.time-cell { white-space: nowrap; font-size: 12px; }
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
.error-cell { max-width: 240px; font-size: 11px; color: var(--tg-hint, #9aa4b2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
