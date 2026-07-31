<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" :aria-label="$t('adminVouchers.statusLabel')" @change="searchData">
          <option value="">{{ $t('adminVouchers.statusAll') }}</option>
          <option value="active">{{ $t('adminVouchers.statusActive') }}</option>
          <option value="used">{{ $t('adminVouchers.statusUsed') }}</option>
          <option value="expired">{{ $t('adminVouchers.statusExpired') }}</option>
          <option value="revoked">{{ $t('adminVouchers.statusRevoked') }}</option>
        </select>
        <input v-model="filter.batchId" type="search" :placeholder="$t('adminVouchers.batchPlaceholder')" :aria-label="$t('adminVouchers.searchBatchAria')" @keyup.enter="searchData" />
        <input
          v-model="filter.search"
          type="search"
          maxlength="80"
          :placeholder="$t('adminVouchers.searchPlaceholder')"
          :title="$t('adminVouchers.searchTitle')"
          :aria-label="$t('adminVouchers.searchAriaLabel')"
          @keyup.enter="searchData"
        />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminVouchers.searching') : $t('adminVouchers.searchBtn') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="generating" @click="openGenerate">{{ $t('adminVouchers.batchGenerate') }}</button>
      </div>
    </div>

    <section class="stat-strip" :aria-label="$t('adminVouchers.statAriaLabel')">
      <div class="stat-item"><span>{{ $t('adminVouchers.statActive') }}</span><strong>{{ stats.active }}</strong><small>{{ formatMoney(stats.totalAmount, 'CNY') }}</small></div>
      <div class="stat-item"><span>{{ $t('adminVouchers.statUsed') }}</span><strong>{{ stats.used }}</strong><small>{{ formatMoney(stats.usedAmount, 'CNY') }}</small></div>
      <div class="stat-item"><span>{{ $t('adminVouchers.statExpired') }}</span><strong>{{ stats.expired }}</strong></div>
      <div class="stat-item"><span>{{ $t('adminVouchers.statRevoked') }}</span><strong>{{ stats.revoked }}</strong></div>
    </section>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminVouchers.reload') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || revoking">
      <span>{{ $t('adminVouchers.selectedCount', { count: selectedCount, revocable: selectedActiveCodes.length }) }}</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || revoking" @click="clearSelection">{{ $t('adminVouchers.clearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || revoking" @click="copySelected">{{ $t('adminVouchers.copySelected') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || revoking" @click="exportSelected">{{ $t('adminVouchers.exportSelected') }}</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || revoking || selectedActiveCodes.length === 0" @click="revokeSelected">
          {{ revoking ? $t('adminVouchers.revoking') : $t('adminVouchers.revokeSelected', { count: selectedActiveCodes.length }) }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminVouchers.tableRegionLabel')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminVouchers.tableLabel')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || revoking"
                :aria-label="$t('adminVouchers.selectAllAria')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminVouchers.colCode') }}</th><th>{{ $t('adminVouchers.colAmount') }}</th><th>{{ $t('adminVouchers.colStatus') }}</th><th>{{ $t('adminVouchers.colBatch') }}</th><th>{{ $t('adminVouchers.colUsedByEmail') }}</th><th>{{ $t('adminVouchers.colExpiresAt') }}</th><th>{{ $t('adminVouchers.colCreatedAt') }}</th><th>{{ $t('adminVouchers.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="`sk-${i}`" class="skeleton-row"><td colspan="9"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.code" :class="{ 'is-selected': isSelected(item.code) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.code)"
                :disabled="loading || revoking"
                :aria-label="$t('adminVouchers.selectRowAria', { code: item.code })"
                @click="setSelected(item.code, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td class="code-cell"><code>{{ item.code }}</code></td>
            <td>{{ formatMoney(item.amountCents, 'CNY') }}</td>
            <td><span class="tag" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td>
            <td>{{ item.batchId || '-' }}</td>
            <td>{{ item.usedByEmail || '-' }}</td>
            <td>{{ item.expiresAt ? formatDate(item.expiresAt) : $t('adminVouchers.permanent') }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" :disabled="revoking" @click="copyCode(item.code)">{{ $t('adminVouchers.copy') }}</button>
                <button v-if="item.status === 'active'" class="btn btn-danger btn-xs" :disabled="revoking" @click="revokeOne(item.code)">{{ $t('adminVouchers.revoke') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="9" class="empty-text">{{ $t('adminVouchers.noData') }}</td></tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading || revoking"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <AdminModal v-model="generateVisible" :title="$t('adminVouchers.modalTitle')" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="generate">
        <label><span>{{ $t('adminVouchers.formAmount') }}</span><input v-model="generateForm.amountYuan" inputmode="decimal" :placeholder="$t('adminVouchers.placeholderAmount')" required /></label>
        <label><span>{{ $t('adminVouchers.formCount') }}</span><input v-model.number="generateForm.count" type="number" min="1" max="500" required /></label>
        <label><span>{{ $t('adminVouchers.formBatch') }}</span><input v-model="generateForm.batchId" maxlength="80" required /></label>
        <label><span>{{ $t('adminVouchers.formExpiresAt') }}</span><input v-model="generateForm.expiresAt" type="datetime-local" :lang="locale" /></label>
        <label><span>{{ $t('adminVouchers.formNotes') }}</span><textarea v-model="generateForm.notes" rows="3" maxlength="500" /></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="generating" @click="generateVisible = false">{{ $t('adminVouchers.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="generating">{{ generating ? $t('adminVouchers.generating') : $t('adminVouchers.generate') }}</button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="resultVisible" :title="$t('adminVouchers.modalGeneratedTitle')" max-width="620px" hide-actions>
      <div class="generated-result">
        <p>{{ $t('adminVouchers.generatedResultText', { batchId: generatedBatchId, count: generatedCodes.length }) }}</p>
        <textarea :value="generatedCodes.join('\n')" rows="12" readonly :aria-label="$t('adminVouchers.generatedResultAria')" />
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="copyGenerated">{{ $t('adminVouchers.copyAll') }}</button>
          <button class="btn btn-primary" @click="exportGenerated">{{ $t('adminVouchers.downloadCsv') }}</button>
          <button class="btn btn-ghost" @click="resultVisible = false">{{ $t('adminVouchers.close') }}</button>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import { fetchAdminVouchers, fetchAdminVoucherStats, generateAdminVouchers, revokeAdminVouchers } from '@/api/admin'
import type { AdminVoucher, AdminVoucherFilter, AdminVoucherStats } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useTableSelection } from '@/composables/useTableSelection'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate, dateTimeLocalToIso } from '@/composables/useFormat'
import { downloadCsv } from '@/lib/csv-export'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { parseYuanToCents } from '@/utils/currency'
import { formatMoney } from '@shared/money'

const { t, locale } = useI18n()
const { token } = useAdminAuth()
const { showToast } = useToast()
const items = ref<AdminVoucher[]>([])
const stats = reactive<AdminVoucherStats>({ active: 0, used: 0, expired: 0, revoked: 0, totalAmount: 0, usedAmount: 0 })
const loading = ref(false)
const loadError = ref('')
const revoking = ref(false)
const generating = ref(false)
const filter = reactive<AdminVoucherFilter>({ status: '', batchId: '', search: '' })
const pagination = useTablePagination()
const { selectedIds, selectedCount, selectableCount, allVisibleSelected, partiallySelected, isSelected, setSelected, toggleAllVisible, clearSelection } = useTableSelection(items, (item) => item.code)
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(item.code))
})
const selectedActiveCodes = computed(() => selectedItems.value.filter((item) => item.status === 'active').map((item) => item.code))
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

const generateVisible = ref(false)
const resultVisible = ref(false)
const generatedCodes = ref<string[]>([])
const generatedBatchId = ref('')
const generateForm = reactive({ amountYuan: '50.00', count: 10, batchId: '', expiresAt: '', notes: '' })

function defaultBatchId() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `VCH-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const [list, nextStats] = await Promise.all([
      fetchAdminVouchers(token.value, { ...filter, limit: pagination.limit.value, offset: (pagination.page.value - 1) * pagination.limit.value }),
      fetchAdminVoucherStats(token.value),
    ])
    if (sequence !== loadSequence) return
    if (pagination.setTotal(list.total)) return loadData()
    items.value = list.items
    Object.assign(stats, nextStats)
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || t('adminVouchers.loadFailed')
    showToast(loadError.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() { pagination.page.value = 1; loadData() }
function openGenerate() { Object.assign(generateForm, { amountYuan: '50.00', count: 10, batchId: defaultBatchId(), expiresAt: '', notes: '' }); generateVisible.value = true }

async function generate() {
  if (generating.value) return
  const amountCents = parseYuanToCents(generateForm.amountYuan)
  if (amountCents === null || amountCents < 1) { showToast('面值必须大于 0，且最多保留两位小数', 'error'); return }
  generating.value = true
  try {
    const res = await generateAdminVouchers(token.value, {
      count: generateForm.count,
      amountCents,
      batchId: generateForm.batchId.trim(),
      expiresAt: dateTimeLocalToIso(generateForm.expiresAt),
      notes: generateForm.notes.trim(),
    })
    generatedCodes.value = res.codes
    generatedBatchId.value = res.batchId
    generateVisible.value = false
    resultVisible.value = true
    showToast(`已生成 ${res.codes.length} 张充值码`, 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '生成充值码失败', 'error')
  } finally { generating.value = false }
}

async function copyLines(lines: string[], success: string) {
  if (lines.length === 0) return
  try { await writeClipboardText(lines.join('\n')); showToast(success, 'success') }
  catch { showToast(i18n.global.t('adminVouchers.copyFailed'), 'error') }
}

function copyCode(code: string) { return copyLines([code], i18n.global.t('adminVouchers.copyCodeSuccess')) }
function copySelected() { return copyLines(selectedItems.value.map((item) => item.code), i18n.global.t('adminVouchers.copySelectedSuccess', { count: selectedItems.value.length })) }
function copyGenerated() { return copyLines(generatedCodes.value, i18n.global.t('adminVouchers.copyGeneratedSuccess', { count: generatedCodes.value.length })) }

function voucherRows(rows: AdminVoucher[]) {
  return rows.map((item) => [item.code, String(item.amountCents), item.status, item.batchId || '', item.usedByEmail || '', item.usedAt || '', item.expiresAt || '', item.notes || '', item.createdAt || ''])
}
function exportRows(filename: string, rows: AdminVoucher[]) { downloadCsv(filename, [['code', 'amountCents', 'status', 'batchId', 'usedByEmail', 'usedAt', 'expiresAt', 'notes', 'createdAt'], ...voucherRows(rows)]) }
function exportSelected() { exportRows(`selected-vouchers-${new Date().toISOString().slice(0, 10)}.csv`, selectedItems.value); showToast(i18n.global.t('adminVouchers.exportSuccess', { count: selectedItems.value.length }), 'success') }
function exportGenerated() { downloadCsv(`vouchers-${generatedBatchId.value}.csv`, [['code', 'batchId'], ...generatedCodes.value.map((code) => [code, generatedBatchId.value])]); showToast(i18n.global.t('adminVouchers.exportSuccess', { count: generatedCodes.value.length }), 'success') }

async function revokeCodes(codes: string[]) {
  if (codes.length === 0 || revoking.value) return
  if (!(await askConfirm(i18n.global.t('adminVouchers.confirmRevoke', { count: codes.length })))) return
  revoking.value = true
  try { const res = await revokeAdminVouchers(token.value, codes); showToast(res.message || i18n.global.t('adminVouchers.revokeSuccess', { count: res.count }), 'success'); await loadData() }
  catch (err: any) { showToast(err.message || i18n.global.t('adminVouchers.revokeFailed'), 'error') }
  finally { revoking.value = false }
}
function revokeOne(code: string) { return revokeCodes([code]) }
function revokeSelected() { return revokeCodes(selectedActiveCodes.value) }
function statusLabel(status: string) { return ({ active: t('adminVouchers.statusActive'), used: t('adminVouchers.statusUsed'), expired: t('adminVouchers.statusExpired'), revoked: t('adminVouchers.statusRevoked') } as Record<string, string>)[status] || status }
function statusClass(status: string) { if (status === 'active') return 'tag-success'; if (status === 'used') return 'tag-info'; if (status === 'expired') return 'tag-warning'; return 'tag-muted' }

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* stat-strip/stat-item / generated-result / modal-actions → admin.css
 * 垂直间距仅靠 .admin-page gap，勿再写 margin-bottom。
 */
.code-cell code {
  white-space: nowrap;
  font-size: 12px;
}
</style>
