<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.action" type="search" :placeholder="$t('adminLogs.search')" :aria-label="$t('adminLogs.search')" @keyup.enter="searchData" />
        <input v-model="filter.targetType" type="search" :placeholder="$t('adminLogs.targetSearch')" :aria-label="$t('adminLogs.targetSearch')" @keyup.enter="searchData" />
        <input v-model="filter.targetId" type="search" :placeholder="$t('adminLogs.targetSearchPlaceholder')" :aria-label="$t('adminLogs.targetSearchPlaceholder')" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" @click="searchData">{{ $t('adminLogs.searchBtn') }}</button>
      </div>
      <div class="toolbar-actions">
        <!-- 后端未开放租户侧清空日志；引导用平台数据清理，避免点了必失败 -->
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="loading"
          :title="$t('adminLogs.clearAllUnavailable')"
          @click="showToast($t('adminLogs.clearAllUnavailable'), 'info')"
        >
          {{ $t('adminLogs.clearAll') }}
        </button>
      </div>
    </div>

    <div class="preset-strip">
      <button
        v-for="preset in presets"
        :key="preset.label"
        class="preset-btn"
        :class="{ 'is-active': isPresetActive(preset) }"
        type="button"
        :aria-pressed="isPresetActive(preset)"
        :disabled="logsMutating"
        @click="applyPreset(preset)"
      >
        <span class="preset-title">{{ preset.label }}</span>
        <span class="preset-desc">{{ preset.description }}</span>
      </button>
      <button
        class="preset-btn preset-btn--ghost"
        :class="{ 'is-active': isPresetActive() }"
        type="button"
        :aria-pressed="isPresetActive()"
        :disabled="logsMutating"
        @click="clearFilters"
      >
        <span class="preset-title">{{ $t('adminLogs.allLogs') }}</span>
        <span class="preset-desc">{{ $t('adminLogs.clearFilters') }}</span>
      </button>
    </div>

    <div v-if="error" class="table-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminLogs.reload') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || logsMutating">
      <span>{{ $t('adminLogs.selectedCount', { count: selectedCount }) }}</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || logsMutating" @click="clearSelection">{{ $t('adminLogs.clearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || logsMutating" @click="copySelectedLogs">{{ $t('adminLogs.copySelected') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || logsMutating" @click="exportSelectedLogs">{{ $t('adminLogs.exportSelectedCsv') }}</button>
        <!-- 批量删除 API 未开放：保留提示按钮，不走假删除路径 -->
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="loading"
          :title="$t('adminLogs.batchDeleteUnavailable')"
          @click="showToast($t('adminLogs.batchDeleteUnavailable'), 'info')"
        >
          {{ $t('adminLogs.batchDelete', { count: selectedCount }) }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminLogs.tableScrollArea')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminLogs.tableLabel')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || logsMutating"
                :aria-label="$t('adminLogs.selectAllPage')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminLogs.colTime') }}</th>
            <th>{{ $t('adminLogs.colAction') }}</th>
            <th>{{ $t('adminLogs.colTarget') }}</th>
            <th>{{ $t('adminLogs.colTargetId') }}</th>
            <th>{{ $t('adminLogs.colIpFingerprint') }}</th>
            <th>{{ $t('adminLogs.colMetadata') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="7"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="logKey(item)" :class="{ 'is-selected': isSelected(logKey(item)) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(logKey(item))"
                :disabled="loading || logsMutating"
                :aria-label="$t('adminLogs.selectRow', { log: item.action || item.id || '' })"
                @click="setSelected(logKey(item), ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.targetType }}</td>
            <td>{{ item.targetId }}</td>
            <td>
              <span class="hash-fingerprint" :title="item.ipHash || ''">{{ formatIpFingerprint(item.ipHash) }}</span>
            </td>
            <td>
              <button class="btn btn-ghost btn-xs" :disabled="loading || logsMutating" @click="viewMetadata(item)">{{ $t('adminLogs.viewMetadata') }}</button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="7" class="empty-text">{{ $t('adminLogs.noData') }}</td>
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
      :disabled="loading || logsMutating"
      @prev="previousPage"
      @next="nextPage"
      @update:limit="changeLimit"
    />

    <AdminModal v-model="metadataVisible" :title="$t('adminLogs.metadataTitle')" max-width="640px">
      <div v-if="currentLog" class="detail-box">
        <div class="detail-section">
          <div class="detail-title">{{ $t('adminLogs.basicInfo') }}</div>
          <div class="detail-row"><span class="detail-label">{{ $t('adminLogs.labelAction') }}</span><span class="detail-value">{{ currentLog.action }}</span></div>
          <div class="detail-row"><span class="detail-label">{{ $t('adminLogs.labelTargetType') }}</span><span class="detail-value">{{ currentLog.targetType }}</span></div>
          <div class="detail-row"><span class="detail-label">{{ $t('adminLogs.labelTargetId') }}</span><span class="detail-value">{{ currentLog.targetId }}</span></div>
          <div class="detail-row"><span class="detail-label">{{ $t('adminLogs.labelTime') }}</span><span class="detail-value">{{ formatDate(currentLog.createdAt) }}</span></div>
          <div class="detail-row"><span class="detail-label">{{ $t('adminLogs.labelIpFingerprint') }}</span><span class="detail-value">{{ currentLog.ipHash || '-' }}</span></div>
        </div>
        <div class="detail-section" v-if="currentLog.metadata && Object.keys(currentLog.metadata).length > 0">
          <div class="detail-title">{{ $t('adminLogs.labelMetadata') }}</div>
          <pre class="detail-json">{{ formatMetadata(currentLog.metadata) }}</pre>
        </div>
      </div>
    </AdminModal>

  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import i18n from '@/i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTableSelection } from '@/composables/useTableSelection'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import type { AdminAuditLog, AdminAuditLogFilter, AdminAuditLogListResult } from '@/types/admin'
import { adminRequest } from '@/composables/useAdminRequest'


/** 下载 CSV */
function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

const { token } = useAdminAuth()
const { showToast } = useToast()
const items = ref<AdminAuditLog[]>([])
const loading = ref(false)
// 批量删/清空日志 API 未开放，不再走 mutating 路径；保留多选复制导出
const logsMutating = computed(() => false)
const snapshotAt = ref('')
const page = ref(1)
const limit = ref(20)
const total = ref(0)
const hasMore = ref(false)
const nextCursor = ref('')
const pageCursors = ref<string[]>([''])
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
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
} = useTableSelection(items, logKey)
const filter = reactive<AdminAuditLogFilter>({
  action: '',
  targetType: '',
  targetId: '',
})

const presets = [
  { label: i18n.global.t('adminLogs.presetOrder'), description: i18n.global.t('adminLogs.presetOrderDesc'), action: '', targetType: 'order', targetId: '' },
  { label: i18n.global.t('adminLogs.presetStock'), description: i18n.global.t('adminLogs.presetStockDesc'), action: '', targetType: 'card', targetId: '' },
  { label: i18n.global.t('adminLogs.presetProduct'), description: i18n.global.t('adminLogs.presetProductDesc'), action: '', targetType: 'product', targetId: '' },
  { label: i18n.global.t('adminLogs.presetCleanup'), description: i18n.global.t('adminLogs.presetCleanupDesc'), action: 'run_cleanup', targetType: 'system', targetId: 'cleanup' },
]

const metadataVisible = ref(false)
const currentLog = ref<AdminAuditLog | null>(null)
const error = ref('')
let loadSequence = 0

async function fetchAdminLogs(_token: string, filter: AdminAuditLogFilter): Promise<AdminAuditLogListResult> {
  const params = new URLSearchParams()
  if (filter.action) params.set('action', filter.action)
  if (filter.targetType) params.set('targetType', filter.targetType)
  if (filter.targetId) params.set('targetId', filter.targetId)
  params.set('limit', String(filter.limit ?? 20))
  const data = await adminRequest<{ logs: AdminAuditLog[] }>(`/api/admin/logs?${params.toString()}`)
  return {
    logs: data.logs || [],
    total: data.logs?.length || 0,
    snapshotAt: new Date().toISOString(),
    nextCursor: '',
    hasMore: false,
  }
}

function formatIpFingerprint(value?: string): string {
  const text = String(value || '')
  if (!text) return '-'
  if (text.length <= 12) return text
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

function logKey(item: AdminAuditLog) {
  return item.id ? `${item.type || 'log'}:${item.id}` : `${item.createdAt || ''}:${item.action || ''}:${item.targetType || ''}:${item.targetId || ''}`
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
    error.value = ''
  try {
    const res = await fetchAdminLogs(token.value, {
      ...filter,
      limit: limit.value,
      snapshotAt: snapshotAt.value || undefined,
      cursor: pageCursors.value[page.value - 1] || undefined,
    })
    if (sequence !== loadSequence) return
    items.value = res.logs
    snapshotAt.value = res.snapshotAt
    total.value = res.total
    hasMore.value = res.hasMore
    nextCursor.value = res.nextCursor
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    error.value = err.message || '加载日志失败'
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
  resetPagination()
  loadData()
}

function applyPreset(preset: AdminAuditLogFilter & { label: string; description: string }) {
  filter.action = preset.action || ''
  filter.targetType = preset.targetType || ''
  filter.targetId = preset.targetId || ''
  resetPagination()
  loadData()
}

function isPresetActive(preset?: AdminAuditLogFilter) {
  return filter.action === (preset?.action || '')
    && filter.targetType === (preset?.targetType || '')
    && filter.targetId === (preset?.targetId || '')
}

function clearFilters() {
  filter.action = ''
  filter.targetType = ''
  filter.targetId = ''
  resetPagination()
  loadData()
}

function viewMetadata(item: AdminAuditLog) {
  currentLog.value = item
  metadataVisible.value = true
}

function formatMetadata(metadata: Record<string, unknown>) {
  try {
    return JSON.stringify(metadata, null, 2)
  } catch {
    return String(metadata)
  }
}

function selectedLogs() {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(logKey(item)))
}

function logRows(logs: AdminAuditLog[]) {
  return logs.map((item) => [
    item.createdAt || '',
    item.action || '',
    item.targetType || '',
    item.targetId || '',
    item.ipHash || '',
    item.metadata ? formatMetadata(item.metadata) : '',
  ])
}

async function copySelectedLogs() {
  const logs = selectedLogs()
  if (logs.length === 0) return
  const lines = logRows(logs).map((row) => row.join('\t')).join('\n')
  try {
    await writeClipboardText(lines)
    showToast(i18n.global.t('adminLogs.copySelectedSuccess', { count: logs.length }), 'success')
  } catch {
    showToast(i18n.global.t('adminLogs.copySelectedFailed'), 'error')
  }
}

function exportSelectedLogs() {
  const logs = selectedLogs()
  if (logs.length === 0) return
  downloadCsv(`selected-admin-logs-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['createdAt', 'action', 'targetType', 'targetId', 'ipHash', 'metadata'],
    ...logRows(logs),
  ])
  showToast(i18n.global.t('adminLogs.exportSelectedSuccess', { count: logs.length }), 'success')
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.preset-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--admin-control-gap, 8px);
  /* 垂直间距交给 .admin-page gap */
  margin: 0;
  flex-shrink: 0;
}

.hash-fingerprint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
}

.preset-btn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  border-radius: var(--r-lg, 12px);
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.1));
  color: var(--tg-text, #f0f2f5);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.preset-btn:hover {
  border-color: rgba(245, 158, 11, 0.55);
  background: var(--admin-accent-hover, rgba(245, 158, 11, 0.18));
}

.preset-btn.is-active {
  border-color: var(--admin-accent, #f59e0b);
  background: rgba(245, 158, 11, 0.22);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.2);
}

.preset-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.preset-btn--ghost {
  background: var(--surface, rgba(255, 255, 255, 0.04));
  border-color: var(--border, rgba(255, 255, 255, 0.1));
}

.preset-btn--ghost.is-active {
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.14));
}

.preset-btn.is-active .preset-title {
  color: var(--admin-accent-text, #fbbf24);
}

.preset-title {
  font-size: 13px;
  font-weight: 600;
}

.preset-desc {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.4;
}

/* detail-json 由 admin.css 提供 */

@media (max-width: 640px) {
  .preset-strip {
    display: flex;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
    margin-bottom: 0;
    padding-bottom: 2px;
  }

  .preset-btn {
    flex: 0 0 164px;
  }
}
</style>
