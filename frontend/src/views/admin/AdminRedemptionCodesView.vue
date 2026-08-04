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
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadData">{{ $t('adminRedemption.search') }}</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" @click="showBatch = true">{{ $t('adminRedemption.batchGenerate') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminRedemption.refresh') }}</button>
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

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminRedemption.colCode') }}</th>
            <th>{{ $t('adminRedemption.colActivityQuota') }}</th>
            <th>{{ $t('adminRedemption.colParticipantQuota') }}</th>
            <th>{{ $t('adminRedemption.colExpiresAt') }}</th>
            <th>{{ $t('adminRedemption.colStatus') }}</th>
            <th>{{ $t('adminRedemption.colUses') }}</th>
            <th>{{ $t('adminRedemption.colNote') }}</th>
            <th>{{ $t('adminRedemption.colCreatedAt') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="8"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="code in codes" :key="code.id">
            <td><code class="code-text">{{ code.code }}</code></td>
            <td>{{ code.activityQuota }}</td>
            <td>{{ code.participantQuota }}</td>
            <td>{{ formatDate(code.expiresAt) }}</td>
            <td><span class="tag" :class="statusClass(code.status)">{{ statusLabel(code.status) }}</span></td>
            <td>{{ code.usedCount }}/{{ code.maxUses }}</td>
            <td>{{ code.note || '-' }}</td>
            <td>{{ formatDate(code.createdAt) }}</td>
          </tr>
          <tr v-if="codes.length === 0">
            <td colspan="8" class="empty-text">{{ $t('adminRedemption.empty') }}</td>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import AdminModal from '@/components/AdminModal.vue'
import AdminPagination from '@/components/AdminPagination.vue'
import { useTablePagination } from '@/composables/useTablePagination'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()
const codes = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
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
    const params = new URLSearchParams({ limit: String(pagination.limit.value), offset: String((pagination.page.value - 1) * pagination.limit.value) })
    if (statusFilter.value) params.set('status', statusFilter.value)
    if (searchQuery.value) params.set('search', searchQuery.value)
    const [data, statsData] = await Promise.all([
      adminRequest<{ codes: any[] }>(`${PLATFORM_REDEMPTION_CODES_API}?${params}`),
      adminRequest<any>(`${PLATFORM_REDEMPTION_CODES_API}/stats`),
    ])
    codes.value = data.codes || []
    stats.value = statsData
    pagination.setTotal(data.codes?.length === pagination.limit.value ? pagination.page.value * pagination.limit.value + 1 : (pagination.page.value - 1) * pagination.limit.value + (data.codes?.length || 0))
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
  try {
    await writeClipboardText(generatedCodes.value.join('\n'))
    showToast(t('adminRedemption.copied'), 'success')
  } catch {
    showToast(t('adminRedemption.copyFailed'), 'error')
  }
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
