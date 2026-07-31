<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" :aria-label="t('adminEmailLogs.statusAll')" @change="searchData">
          <option value="">{{ $t('adminEmailLogs.statusAll') }}</option>
          <option value="sent">{{ $t('adminEmailLogs.statusSent') }}</option>
          <option value="failed">{{ $t('adminEmailLogs.statusFailed') }}</option>
          <option value="pending">{{ $t('adminEmailLogs.statusPending') }}</option>
        </select>
        <input
          v-model="filter.search"
          type="search"
          maxlength="200"
          :placeholder="$t('adminEmailLogs.searchPlaceholder')"
          :title="$t('adminEmailLogs.searchTitle')"
          :aria-label="$t('adminEmailLogs.searchTitle')"
          @keyup.enter="searchData"
        />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminEmailLogs.loading') : $t('adminEmailLogs.searchBtn') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminEmailLogs.refresh') }}</button>
      </div>
    </div>

    <p class="balance-helper">{{ $t('adminEmailLogs.helperText') }}</p>

    <div v-if="error" class="table-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminEmailLogs.refresh') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || batchDeleting">
      <span>{{ $t('adminEmailLogs.selectedCount', { count: selectedCount }) }}</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchDeleting" @click="clearSelection">{{ $t('adminEmailLogs.actionClearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchDeleting" @click="copySelected">{{ $t('adminEmailLogs.actionCopySelected') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchDeleting" @click="exportSelected">{{ $t('adminEmailLogs.actionExportSelected') }}</button>
        <button
          class="btn btn-danger btn-sm"
          :disabled="loading || batchDeleting || selectedIdsList.length === 0"
          @click="batchRemove"
        >
          {{ batchDeleting ? $t('adminEmailLogs.batchDeleting') : $t('adminEmailLogs.batchDelete', { count: selectedIdsList.length }) }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminEmailLogs.title')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminEmailLogs.title')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchDeleting"
                :aria-label="$t('adminEmailLogs.selectPageLabel')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminEmailLogs.colTime') }}</th>
            <th>{{ $t('adminEmailLogs.colEmail') }}</th>
            <th>{{ $t('adminEmailLogs.colOrderId') }}</th>
            <th>{{ $t('adminEmailLogs.colTemplate') }}</th>
            <th>{{ $t('adminEmailLogs.colStatus') }}</th>
            <th>{{ $t('adminEmailLogs.colProvider') }}</th>
            <th>{{ $t('adminEmailLogs.colError') }}</th>
            <th>{{ $t('adminEmailLogs.colSentAt') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr
            v-for="item in items"
            :key="rowKey(item)"
            :class="{ 'is-selected': isSelected(rowKey(item)) }"
          >
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(rowKey(item))"
                :disabled="loading || batchDeleting || !item.id"
                :aria-label="$t('adminEmailLogs.selectRowLabel', { email: item.toEmail || item.to || item.id || '' })"
                @click="setSelected(rowKey(item), ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td><code>{{ item.toEmail || item.to || '-' }}</code></td>
            <td class="id-cell">
              <RouterLink
                v-if="item.orderId"
                class="admin-deeplink"
                :to="{ path: '/admin/orders', query: { q: String(item.orderId).slice(0, 120) } }"
                :title="$t('adminEmailLogs.searchOrderTitle', { id: item.orderId })"
              >
                {{ item.orderId }}
              </RouterLink>
              <template v-else>-</template>
            </td>
            <td>{{ item.template || item.subject || '-' }}</td>
            <td><span class="tag" :class="statusClass(item.displayStatus || item.status)">{{ statusLabel(item.displayStatus || item.status) }}</span></td>
            <td>{{ item.provider || '-' }}</td>
            <td class="note-cell">{{ item.displayErrorMessage || item.errorMessage || item.error || '-' }}</td>
            <td>{{ formatDate(item.sentAt) }}</td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="9" class="empty-text">{{ $t('adminEmailLogs.noData') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="page"
      :total="total"
      :total-pages="totalPages"
      :limit="limit"
      cursor-mode
      :has-more="hasMore"
      :disabled="loading || batchDeleting"
      @prev="previousPage"
      @next="nextPage"
      @update:limit="changeLimit"
    />

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ref, computed, onMounted } from 'vue'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTableSelection } from '@/composables/useTableSelection'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import AdminPagination from '@/components/AdminPagination.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

/** 下载 CSV（内联实现） */
function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

/** 管理端 API 请求封装 */
async function adminRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const token = (() => { try { return localStorage.getItem('admin_token') || ''; } catch { return ''; } })();
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || `请求失败: ${res.status}`);
  return data as T;
}

const { token } = useAdminAuth()
const router = useRouter()
const { t } = useI18n()
const { token } = useAdminAuth()
const { showToast } = useToast()
const items = ref<AdminEmailLog[]>([])
const loading = ref(false)
const batchDeleting = ref(false)
const error = ref('')
const snapshotAt = ref('')
const page = ref(1)
const limit = ref(20)
const total = ref(0)
const hasMore = ref(false)
const nextCursor = ref('')
const pageCursors = ref<string[]>([''])
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
const filter = reactive<AdminEmailLogFilter>({ status: '', search: '' })
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

/** 与 admin 路由 GET /email-logs search 上限 200 对齐 */
function initFilterFromRoute() {
  filter.status = typeof route.query.status === 'string' ? route.query.status.slice(0, 50) : ''
  filter.search = typeof route.query.search === 'string' ? route.query.search.slice(0, 200) : ''
}

function rowKey(item: AdminEmailLog) {
  return item.id || `${item.createdAt || ''}:${item.toEmail || item.to || ''}:${item.orderId || ''}`
}

const {
  selectedCount,
  selectableCount,
  allVisibleSelected,
  partiallySelected,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
} = useTableSelection(items, rowKey)

const selectedIdsList = computed(() =>
  items.value
    .filter((item) => item.id && isSelected(rowKey(item)))
    .map((item) => String(item.id)),
)

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const res = await fetchAdminEmailLogs(token.value, {
      ...filter,
      limit: limit.value,
      snapshotAt: snapshotAt.value || undefined,
      cursor: pageCursors.value[page.value - 1] || undefined,
    })
    if (sequence !== loadSequence) return
    items.value = res.results || []
    snapshotAt.value = res.snapshotAt
    total.value = res.total
    hasMore.value = res.hasMore
    nextCursor.value = res.nextCursor
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    error.value = err.message || t('adminEmailLogs.loadError')
    showToast(error.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function resetPagination() {
  page.value = 1
  snapshotAt.value = ''
  hasMore.value = false
  nextCursor.value = ''
  pageCursors.value = ['']
}

function previousPage() {
  if (loading.value || page.value <= 1) return
  page.value -= 1
  loadData()
}

function nextPage() {
  if (loading.value || !hasMore.value || !nextCursor.value) return
  pageCursors.value[page.value] = nextCursor.value
  page.value += 1
  loadData()
}

function changeLimit(value: number) {
  limit.value = value
  resetPagination()
  loadData()
}

function searchData() {
  const query: Record<string, string> = {}
  if (filter.status) query.status = filter.status
  if (filter.search) query.search = filter.search.slice(0, 200)
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    resetPagination()
    void loadData()
    return
  }
  // 写回 query，便于分享筛选；watch(route.query) 会重置分页并加载
  void router.replace({ path: route.path, query })
}

function statusLabel(status?: string) {
  return ({
    sent: t('adminEmailLogs.statusSent'),
    failed: t('adminEmailLogs.statusFailed'),
    pending: t('adminEmailLogs.statusPending'),
    stale_pending: t('adminEmailLogs.statusStalePending'),
  } as Record<string, string>)[status || ''] || status || '-'
}

function statusClass(status?: string) {
  if (status === 'sent') return 'tag-success'
  if (status === 'failed') return 'tag-danger'
  if (status === 'stale_pending') return 'tag-danger'
  if (status === 'pending') return 'tag-warning'
  return 'tag-muted'
}

function selectedRows() {
  return items.value.filter((item) => isSelected(rowKey(item)))
}

async function copySelected() {
  const rows = selectedRows()
  const text = rows.map((item) =>
    [
      item.createdAt || '',
      item.toEmail || item.to || '',
      item.orderId || '',
      item.template || '',
      item.status || '',
      item.errorMessage || item.error || '',
    ].join('\t'),
  ).join('\n')
  try {
    await writeClipboardText(text)
    showToast(t('adminEmailLogs.copySelectedSuccess', { count: rows.length }), 'success')
  } catch {
    showToast(t('adminEmailLogs.copySelectedFailed'), 'error')
  }
}

function exportSelected() {
  const rows = selectedRows()
  downloadCsv(
    `selected-email-logs-${new Date().toISOString().slice(0, 10)}.csv`,
    [
      ['id', 'createdAt', 'toEmail', 'orderId', 'template', 'status', 'provider', 'errorMessage', 'sentAt'],
      ...rows.map((item) => [
        item.id || '',
        item.createdAt || '',
        item.toEmail || item.to || '',
        item.orderId || '',
        item.template || '',
        item.status || '',
        item.provider || '',
        item.errorMessage || item.error || '',
        item.sentAt || '',
      ]),
    ],
  )
  showToast(t('adminEmailLogs.exportSelectedSuccess', { count: rows.length }), 'success')
}

async function batchRemove() {
  const ids = selectedIdsList.value
  if (ids.length === 0) return
  const ok = await askConfirm(t('adminEmailLogs.batchDeleteConfirm', { count: ids.length }))
  if (!ok) return
  batchDeleting.value = true
  try {
    const res = await batchDeleteAdminEmailLogs(token.value, ids)
    showToast(t('adminEmailLogs.batchDeleteSuccess', { count: res.deleted }), 'success')
    resetPagination()
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminEmailLogs.batchDeleteFailed'), 'error')
  } finally {
    batchDeleting.value = false
  }
}

onMounted(() => {
  initFilterFromRoute()
  loadData()
})

watch(
  () => route.query,
  () => {
    resetPagination()
    initFilterFromRoute()
    loadData()
  },
)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.admin-deeplink {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.admin-deeplink:hover {
  color: var(--admin-accent, #2563eb);
}
</style>
