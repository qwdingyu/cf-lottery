<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.tenantId" type="search" :placeholder="$t('platformWebhooks.tenantPlaceholder')" @keyup.enter="searchData" />
        <select v-model="filter.status" @change="searchData">
          <option value="">{{ $t('platformWebhooks.allStatus') }}</option>
          <option value="pending">{{ $t('platformWebhooks.statusPending') }}</option>
          <option value="sent">{{ $t('platformWebhooks.statusSent') }}</option>
          <option value="failed">{{ $t('platformWebhooks.statusFailed') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('platformWebhooks.searching') : $t('platformWebhooks.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('platformWebhooks.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('platformWebhooks.retry') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformWebhooks.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
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
            <td :colspan="7"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="d in deliveries" :key="d.id">
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
                v-if="d.status === 'failed' || d.status === 'pending'"
                class="btn btn-ghost btn-xs"
                :disabled="retryingId === d.id"
                @click="retryDelivery(d.id)"
              >{{ retryingId === d.id ? $t('platformWebhooks.retrying') : $t('platformWebhooks.retry') }}</button>
            </td>
          </tr>
          <tr v-if="deliveries.length === 0">
            <td colspan="7" class="empty-text">{{ $t('platformWebhooks.empty') }}</td>
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
      :disabled="loading"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminPagination from '@/components/AdminPagination.vue'
import { useTablePagination } from '@/composables/useTablePagination'
import { adminRequest } from '@/composables/useAdminRequest'
import { useToast } from '@/composables/useToast'

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
const loading = ref(false)
const loadError = ref('')
const deliveries = ref<WebhookDelivery[]>([])
const retryingId = ref('')
const filter = ref({ tenantId: '', status: '' })
const pagination = useTablePagination({ initialLimit: 50 })

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

function copyText(text: string) {
  if (text) navigator.clipboard.writeText(text).catch(() => {})
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams({ limit: String(pagination.limit.value), offset: String((pagination.page.value - 1) * pagination.limit.value) })
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
  if (retryingId.value) return
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

onMounted(loadData)
</script>

<style scoped>
.time-cell { white-space: nowrap; font-size: 12px; }
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
.error-cell { max-width: 240px; font-size: 11px; color: var(--tg-hint, #9aa4b2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
