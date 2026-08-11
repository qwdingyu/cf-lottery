<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="searchQuery" type="search" :placeholder="$t('adminRedemption.searchPlaceholder')" @keyup.enter="loadData" />
        <select v-model="statusFilter" @change="loadData">
          <option value="">{{ $t('adminRedemption.allStatus') }}</option>
          <option value="active">{{ $t('adminRedemption.statusActive') }}</option>
          <option value="used">{{ $t('adminRedemption.statusUsed') }}</option>
          <option value="expired">{{ $t('adminRedemption.statusExpired') }}</option>
          <option value="disabled">{{ $t('adminRedemption.statusDisabled') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="loadData">{{ $t('adminRedemption.search') }}</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="batchOperating" @click="showBatch = true">{{ $t('adminRedemption.batchGenerate') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="loadData">{{ $t('adminRedemption.refresh') }}</button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <span class="stat-value">{{ stats.total }}</span>
        <span class="stat-label">{{ $t('adminRedemption.statTotal') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.active }}</span>
        <span class="stat-label">{{ $t('adminRedemption.statActive') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.used }}</span>
        <span class="stat-label">{{ $t('adminRedemption.statUsed') }}</span>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminRedemption.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('adminRedemption.selectedCount', { count: selectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('adminRedemption.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearSelection">
        {{ $t('adminRedemption.clearSelection') }}
      </button>
      <button class="btn btn-danger btn-sm" type="button" :disabled="loading || batchOperating || disableableSelectedCount === 0" @click="batchDisable">
        {{ $t('adminRedemption.batchDisable', { count: disableableSelectedCount }) }}
      </button>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="loading || batchOperating || selectableCount === 0"
                :aria-label="$t('adminRedemption.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminRedemption.colCode') }}</th>
            <th>{{ $t('adminRedemption.colActivityQuota') }}</th>
            <th>{{ $t('adminRedemption.colParticipantQuota') }}</th>
            <th>{{ $t('adminRedemption.colExpiresAt') }}</th>
            <th>{{ $t('adminRedemption.colStatus') }}</th>
            <th>{{ $t('adminRedemption.colUses') }}</th>
            <th>{{ $t('adminRedemption.colNote') }}</th>
            <th>{{ $t('adminRedemption.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('adminRedemption.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="10"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="code in codes" :key="code.id" :class="{ 'is-selected': isSelected(code.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(code.id)"
                :disabled="loading || batchOperating || !canDisableRedemptionCode(String(code.status || ''))"
                :aria-label="$t('adminRedemption.selectRow')"
                @click="setSelected(code.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td><code class="code-text">{{ code.code }}</code></td>
            <td>{{ code.activityQuota }}</td>
            <td>{{ code.participantQuota }}</td>
            <td>{{ formatDate(code.expiresAt) }}</td>
            <td><span class="tag" :class="statusClass(code.status)">{{ statusLabel(code.status) }}</span></td>
            <td>{{ code.usedCount }}/{{ code.maxUses }}</td>
            <td>{{ code.note || '-' }}</td>
            <td>{{ formatDate(code.createdAt) }}</td>
            <td class="col-actions">
              <button
                v-if="canDisableRedemptionCode(String(code.status || ''))"
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="operatingId === code.id || batchOperating"
                @click="handleDisable(code.id)"
              >{{ operatingId === code.id ? $t('adminRedemption.disabling') : $t('adminRedemption.disable') }}</button>
              <span v-else class="tag tag-muted">—</span>
            </td>
          </tr>
          <tr v-if="codes.length === 0">
            <td colspan="10" class="empty-text">{{ $t('adminRedemption.empty') }}</td>
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

    <AdminModal v-model="showBatch" :title="$t('adminRedemption.batchTitle')" max-width="560px" hide-actions>
      <form @submit.prevent="handleBatch">
        <div class="modal-form">
          <label>
            <span>{{ $t('adminRedemption.countLabel') }}</span>
            <input v-model.number="form.count" type="number" min="1" max="100" step="1" required />
            <small class="field-hint">{{ $t('adminRedemption.countHint') }}</small>
          </label>
          <label>
            <span>{{ $t('adminRedemption.activityQuotaLabel') }}</span>
            <input v-model.number="form.activityQuota" type="number" min="0" max="9999" step="1" />
            <small class="field-hint">{{ $t('adminRedemption.activityQuotaHint') }}</small>
          </label>
          <label>
            <span>{{ $t('adminRedemption.participantQuotaLabel') }}</span>
            <input v-model.number="form.participantQuota" type="number" min="0" max="999999" step="1" />
            <small class="field-hint">{{ $t('adminRedemption.participantQuotaHint') }}</small>
          </label>
          <label>
            <span>{{ $t('adminRedemption.durationLabel') }}</span>
            <input v-model.number="form.durationDays" type="number" min="1" max="3650" step="1" />
          </label>
          <label>
            <span>{{ $t('adminRedemption.noteLabel') }}</span>
            <input v-model="form.note" maxlength="200" :placeholder="$t('adminRedemption.notePlaceholder')" />
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showBatch = false">{{ $t('adminRedemption.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? $t('adminRedemption.generating') : $t('adminRedemption.generate') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="showResult" :title="$t('adminRedemption.resultTitle')" max-width="560px" hide-actions>
      <div class="modal-form">
        <p>{{ $t('adminRedemption.resultIntro', { count: generatedCodes.length }) }}</p>
        <textarea readonly :value="generatedCodes.join('\n')" rows="8" class="code-textarea" />
        <p class="field-hint">{{ $t('adminRedemption.resultHint', { activity: form.activityQuota, participant: form.participantQuota, days: form.durationDays }) }}</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary btn-sm" @click="copyCodes">{{ $t('adminRedemption.copyAll') }}</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="showResult = false; showBatch = false; loadData()">{{ $t('adminRedemption.close') }}</button>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { useTableSelection } from '@usethink/cf-admin-fe/composables'
import { useAdminBatchOperation } from '@usethink/cf-admin-fe/composables'
import { formatDate } from '@/composables/useFormat'
import { copyWithToast } from '@usethink/cf-admin-fe/composables'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import AdminPagination from '@usethink/cf-admin-fe/components/AdminPagination.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { useTablePagination } from '@usethink/cf-admin-fe/composables'
import { buildAdminOffsetParams } from '@usethink/cf-admin-fe/utils'
import { adminRequest } from '@/composables/useAdminRequest'
import { canDisableRedemptionCode } from './lottery/ops-utils'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const codes = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const operatingId = ref('')
const statusFilter = ref('')
const searchQuery = ref('')
const showBatch = ref(false)
const showResult = ref(false)
const generatedCodes = ref<string[]>([])
const pagination = useTablePagination({ initialLimit: 50 })

const stats = ref({ total: 0, active: 0, used: 0 })

const form = ref({
  count: 10,
  activityQuota: 5,
  participantQuota: 200,
  durationDays: 30,
  note: '',
})

const codesRef = computed(() => codes.value)
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
} = useTableSelection(codesRef, (row) => row.id, {
  isSelectable: (row) => canDisableRedemptionCode(String(row.status || '')),
})

const disableableSelectedCount = computed(() =>
  codes.value.filter((c) => selectedIds.value.includes(c.id) && canDisableRedemptionCode(String(c.status || ''))).length,
)

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    active: t('adminRedemption.statusActive'),
    used: t('adminRedemption.statusUsed'),
    expired: t('adminRedemption.statusExpired'),
    disabled: t('adminRedemption.statusDisabled'),
  }
  return map[status] || status
}
function statusClass(status: string): string {
  const map: Record<string, string> = { active: 'tag-success', used: 'tag-muted', expired: 'tag-danger', disabled: 'tag-muted' }
  return map[status] || 'tag-muted'
}

const PLATFORM_REDEMPTION_CODES_API = '/api/platform/redemption-codes'

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams(buildAdminOffsetParams(pagination.page.value, pagination.limit.value))
    if (statusFilter.value) params.set('status', statusFilter.value)
    if (searchQuery.value) params.set('search', searchQuery.value)
    const [data, statsData] = await Promise.all([
      adminRequest<{ codes: any[]; total: number }>(`${PLATFORM_REDEMPTION_CODES_API}?${params}`),
      adminRequest<any>(`${PLATFORM_REDEMPTION_CODES_API}/stats`),
    ])
    codes.value = data.codes || []
    stats.value = statsData
    pagination.setTotal(data.total || 0)
  } catch (err: any) {
    loadError.value = err.message || t('adminRedemption.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleBatch() {
  if (form.value.activityQuota === 0 && form.value.participantQuota === 0) {
    showToast(t('adminRedemption.bothQuotaZero'), 'error')
    return
  }
  submitting.value = true
  try {
    const data = await adminRequest<any>(`${PLATFORM_REDEMPTION_CODES_API}/batch`, {
      method: 'POST',
      body: JSON.stringify(form.value),
    })
    generatedCodes.value = data.codes || []
    showResult.value = true
  } catch (err: any) {
    showToast(err.message || t('adminRedemption.generateFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

async function copyCodes() {
  await copyWithToast(generatedCodes.value.join('\n'), {
    successMessage: t('adminRedemption.copied'),
    errorMessage: t('adminRedemption.copyFailed'),
  })
}

async function handleDisable(id: string) {
  if (operatingId.value || batchOperating.value) return
  if (!(await askConfirm(t('adminRedemption.disableConfirm')))) return
  operatingId.value = id
  try {
    await adminRequest(`${PLATFORM_REDEMPTION_CODES_API}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })
    showToast(t('adminRedemption.disabledOk'), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminRedemption.disableFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

/** 测试清场：仅 active 码顺序禁用，保留审计不物理删 */
async function batchDisable() {
  const targets = codes.value.filter(
    (c) => selectedIds.value.includes(c.id) && canDisableRedemptionCode(String(c.status || '')),
  )
  if (targets.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('adminRedemption.batchDisableConfirm', { count: targets.length })))) return
  const result = await runSequential(targets, async (row) => {
    await adminRequest(`${PLATFORM_REDEMPTION_CODES_API}/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })
  })
  if (!result) return
  if (result.failed > 0) {
    showToast(t('adminRedemption.batchDisableResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t('adminRedemption.batchDisableSuccess', { count: result.success }), 'success')
  }
  clearSelection()
  await loadData()
}

onMounted(loadData)
</script>

<style scoped>
.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; margin-bottom: 12px; }
.stat-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px; background: var(--tg-secondary-bg, #151b28); border-radius: var(--r-lg, 12px); border: 1px solid var(--border, rgba(255,255,255,0.1)); }
.stat-value { font-size: 24px; font-weight: 700; color: var(--admin-accent, #f59e0b); }
.stat-label { font-size: 12px; color: var(--tg-hint, #9aa4b2); }
.code-text { font-family: monospace; font-size: 13px; letter-spacing: 1px; background: var(--tg-bg, #0a0e17); padding: 2px 6px; border-radius: 4px; }
.code-textarea { width: 100%; font-family: monospace; font-size: 13px; background: var(--tg-bg, #0a0e17); color: var(--tg-text, #f0f2f5); border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius: 8px; padding: 8px; }
</style>
