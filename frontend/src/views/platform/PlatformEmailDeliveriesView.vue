<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.tenantId" type="search" :placeholder="$t('platformEmails.tenantPlaceholder')" :disabled="batchOperating" @keyup.enter="searchData" />
        <select v-model="filter.status" :disabled="batchOperating" @change="searchData">
          <option value="">{{ $t('platformEmails.allStatus') }}</option>
          <option value="pending">{{ $t('platformEmails.statusPending') }}</option>
          <option value="processing">{{ $t('platformEmails.statusProcessing') }}</option>
          <option value="sent">{{ $t('platformEmails.statusSent') }}</option>
          <option value="failed">{{ $t('platformEmails.statusFailed') }}</option>
        </select>
        <select v-model="filter.template" :disabled="batchOperating" @change="searchData">
          <option value="">{{ $t('platformEmails.allTemplates') }}</option>
          <option value="lottery_winner">{{ $t('platformEmails.templateWinner') }}</option>
          <option value="draw_reminder">{{ $t('platformEmails.templateReminder') }}</option>
          <option value="loser_consolation">{{ $t('platformEmails.templateConsolation') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="searchData">
          {{ loading ? $t('platformEmails.searching') : $t('platformEmails.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="loadData">{{ $t('platformEmails.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('platformEmails.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('platformEmails.selectedCount', { count: selectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('platformEmails.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearSelection">
        {{ $t('platformEmails.clearSelection') }}
      </button>
      <button class="btn btn-primary btn-sm" type="button" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRetry">
        {{ $t('platformEmails.batchRetry', { count: selectedCount }) }}
      </button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformEmails.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="loading || batchOperating || selectableCount === 0"
                :aria-label="$t('platformEmails.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('platformEmails.colTime') }}</th>
            <th>{{ $t('platformEmails.colTenant') }}</th>
            <th>{{ $t('platformEmails.colRecipient') }}</th>
            <th>{{ $t('platformEmails.colTemplate') }}</th>
            <th>{{ $t('platformEmails.colSource') }}</th>
            <th>{{ $t('platformEmails.colStatus') }}</th>
            <th>{{ $t('platformEmails.colAttempts') }}</th>
            <th>{{ $t('platformEmails.colError') }}</th>
            <th class="col-actions">{{ $t('platformEmails.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="10"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="d in deliveries" :key="d.id" :class="{ 'is-selected': isSelected(d.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(d.id)"
                :disabled="loading || batchOperating || !canRetryEmailDelivery(d.status)"
                :aria-label="$t('platformEmails.selectRow')"
                @click="setSelected(d.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td class="time-cell">{{ formatTime(d.createdAt) }}</td>
            <td><code class="code-id" :title="d.tenantId" @click="copyText(d.tenantId)">{{ shortId(d.tenantId) }}</code></td>
            <td class="recipient-cell" :title="d.recipientEmail">{{ d.recipientEmail }}</td>
            <td><span class="tag tag-info">{{ templateLabel(d.template) }}</span></td>
            <td class="source-cell" :title="`${d.sourceType}:${d.sourceId}`">{{ d.sourceType }}</td>
            <td><span class="tag" :class="statusClass(d.status)">{{ statusLabel(d.status) }}</span></td>
            <td>{{ d.attemptCount }}</td>
            <td class="error-cell" :title="d.lastError">{{ d.lastError ? truncate(d.lastError, 60) : '-' }}</td>
            <td class="col-actions">
              <button
                v-if="canRetryEmailDelivery(d.status)"
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="retryingId === d.id || batchOperating"
                @click="retryDelivery(d.id)"
              >{{ retryingId === d.id ? $t('platformEmails.retrying') : $t('platformEmails.retry') }}</button>
              <span v-else class="tag tag-muted">-</span>
            </td>
          </tr>
          <tr v-if="deliveries.length === 0">
            <td colspan="10" class="empty-text">{{ $t('platformEmails.empty') }}</td>
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
import { buildAdminOffsetParams } from '@usethink/cf-admin-fe/utils'
import {
  copyWithToast,
  useAdminBatchOperation,
  useConfirmDialog,
  useTablePagination,
  useTableSelection,
  useToast,
} from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'

type EmailDelivery = {
  id: string
  tenantId: string
  drawId: string
  sourceType: string
  sourceId: string
  recipientEmail: string
  template: string
  status: string
  attemptCount: number
  nextRetryAt?: string | null
  providerMessageId: string
  lastError: string
  createdAt: string
  updatedAt: string
  sentAt?: string | null
}

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const loading = ref(false)
const loadError = ref('')
const deliveries = ref<EmailDelivery[]>([])
const retryingId = ref('')
const filter = ref({ tenantId: '', status: '', template: '' })
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
  isSelectable: (row) => canRetryEmailDelivery(String(row.status || '')),
})

function canRetryEmailDelivery(status: string): boolean {
  return status === 'pending' || status === 'failed' || status === 'processing'
}

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

function shortId(id: string): string {
  return id ? `${id.slice(0, 8)}...` : '-'
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: t('platformEmails.statusPending'),
    processing: t('platformEmails.statusProcessing'),
    sent: t('platformEmails.statusSent'),
    failed: t('platformEmails.statusFailed'),
  }
  return map[status] || status
}

function statusClass(status: string): string {
  const map: Record<string, string> = {
    pending: 'tag-muted',
    processing: 'tag-info',
    sent: 'tag-success',
    failed: 'tag-danger',
  }
  return map[status] || 'tag-muted'
}

function templateLabel(template: string): string {
  const map: Record<string, string> = {
    lottery_winner: t('platformEmails.templateWinner'),
    draw_reminder: t('platformEmails.templateReminder'),
    loser_consolation: t('platformEmails.templateConsolation'),
  }
  return map[template] || template
}

function truncate(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) + '...' : text
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
    if (filter.value.template) params.set('template', filter.value.template)
    const data = await adminRequest<{ deliveries: EmailDelivery[] }>(`/api/platform/email-deliveries?${params}`)
    deliveries.value = data.deliveries || []
    pagination.setTotal(data.deliveries?.length === pagination.limit.value ? pagination.page.value * pagination.limit.value + 1 : (pagination.page.value - 1) * pagination.limit.value + (data.deliveries?.length || 0))
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('platformEmails.loadFailed')
  } finally {
    loading.value = false
  }
}

function searchData() { pagination.setPage(1); loadData() }

async function retryDelivery(id: string) {
  if (retryingId.value || batchOperating.value) return
  retryingId.value = id
  try {
    await adminRequest(`/api/platform/email-deliveries/${id}/retry`, { method: 'POST' })
    showToast(t('platformEmails.retried'), 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('platformEmails.retryFailed'), 'error')
  }
  retryingId.value = ''
}

async function batchRetry() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('platformEmails.batchRetryConfirm', { count: ids.length })))) return
  const result = await runSequential(ids, async (id) => {
    await adminRequest(`/api/platform/email-deliveries/${id}/retry`, { method: 'POST' })
  })
  if (!result) return
  if (result.failed > 0) {
    showToast(t('platformEmails.batchRetryResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t('platformEmails.batchRetrySuccess', { count: result.success }), 'success')
  }
  clearSelection()
  await loadData()
}

onMounted(loadData)
</script>

<style scoped>
.time-cell { white-space: nowrap; font-size: 12px; }
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
.recipient-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-cell { max-width: 160px; font-size: 11px; color: var(--tg-hint, #9aa4b2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-cell { max-width: 240px; font-size: 11px; color: var(--tg-hint, #9aa4b2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
