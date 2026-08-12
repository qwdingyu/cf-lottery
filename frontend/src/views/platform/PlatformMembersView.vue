<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="$t('platformMembers.searchPlaceholder')"
          :disabled="loading || batchOperating"
          @keyup.enter="searchData"
        />
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="loadData">
          {{ loading ? $t('platformMembers.loading') : $t('platformMembers.refresh') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="showAdd = true">{{ $t('platformMembers.add') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('platformMembers.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('platformMembers.selectedCount', { count: selectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('platformMembers.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearSelection">
        {{ $t('platformMembers.clearSelection') }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating || disableableCount === 0" @click="batchSetStatus('disabled')">
        {{ $t('platformMembers.batchDisable', { count: disableableCount }) }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating || enableableCount === 0" @click="batchSetStatus('active')">
        {{ $t('platformMembers.batchEnable', { count: enableableCount }) }}
      </button>
      <button class="btn btn-danger btn-sm" type="button" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemove">
        {{ $t('platformMembers.batchRemove', { count: selectedCount }) }}
      </button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformMembers.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="loading || batchOperating || selectableCount === 0"
                :aria-label="$t('platformMembers.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('platformMembers.colUserId') }}</th>
            <th>{{ $t('platformMembers.colRole') }}</th>
            <th>{{ $t('platformMembers.colStatus') }}</th>
            <th>{{ $t('platformMembers.colJoinedAt') }}</th>
            <th class="col-actions">{{ $t('platformMembers.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="6"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="m in members" :key="m.userId" :class="{ 'is-selected': isSelected(m.userId) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(m.userId)"
                :disabled="loading || batchOperating || !canOperatePlatformMember(m.userId, myUserId)"
                :aria-label="$t('platformMembers.selectRow')"
                @click="setSelected(m.userId, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td><code class="code-id" :title="m.userId" @click="copyText(m.userId)">{{ m.userId.slice(0, 10) }}…</code></td>
            <td>
              <select :value="m.role" :disabled="operatingId === m.userId || m.userId === myUserId || batchOperating" @change="updateRole(m, ($event.target as HTMLSelectElement).value)">
                <option value="platform_owner">{{ $t('platformMembers.roleOwner') }}</option>
                <option value="platform_operator">{{ $t('platformMembers.roleOperator') }}</option>
                <option value="platform_support">{{ $t('platformMembers.roleSupport') }}</option>
              </select>
            </td>
            <td>
              <span class="tag" :class="m.status === 'active' ? 'tag-success' : 'tag-danger'">
                {{ m.status === 'active' ? $t('platformMembers.statusActive') : $t('platformMembers.statusDisabled') }}
              </span>
            </td>
            <td>{{ formatTime(m.createdAt) }}</td>
            <td class="col-actions">
              <button
                v-if="m.userId !== myUserId"
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="operatingId === m.userId || batchOperating"
                @click="toggleStatus(m)"
              >{{ m.status === 'active' ? $t('platformMembers.disable') : $t('platformMembers.enable') }}</button>
              <button
                v-if="m.userId !== myUserId"
                class="btn btn-danger btn-xs"
                type="button"
                :disabled="operatingId === m.userId || batchOperating"
                @click="handleRemove(m)"
              >{{ $t('platformMembers.remove') }}</button>
              <span v-else class="tag tag-muted">{{ $t('platformMembers.currentUser') }}</span>
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="6" class="empty-text">{{ $t('platformMembers.empty') }}</td>
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
      :offset="pagination.offset.value"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="(p: number) => { pagination.setPage(p); loadData() }"
    />

    <AdminModal v-model="showAdd" :title="$t('platformMembers.addTitle')" max-width="480px" hide-actions>
      <form @submit.prevent="handleAdd">
        <div class="modal-form">
          <label>
            <span>{{ $t('platformMembers.keyLabel') }}</span>
            <input v-model="formKey" required maxlength="120" :placeholder="$t('platformMembers.keyPlaceholder')" />
            <small class="field-hint">{{ $t('platformMembers.keyHint') }}</small>
          </label>
          <label>
            <span>{{ $t('platformMembers.roleLabel') }}</span>
            <select v-model="formRole">
              <option value="platform_operator">{{ $t('platformMembers.roleOperator') }}</option>
              <option value="platform_owner">{{ $t('platformMembers.roleOwner') }}</option>
              <option value="platform_support">{{ $t('platformMembers.roleSupport') }}</option>
            </select>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showAdd = false">{{ $t('platformMembers.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? $t('platformMembers.adding') : $t('platformMembers.addBtn') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import AdminPagination from '@usethink/cf-admin-fe/components/AdminPagination.vue'
import { copyWithToast, useToast, useTablePagination } from '@usethink/cf-admin-fe/composables'
import { buildAdminOffsetParams } from '@usethink/cf-admin-fe/utils'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { useTableSelection } from '@usethink/cf-admin-fe/composables'
import { useAdminBatchOperation } from '@usethink/cf-admin-fe/composables'
import { readAdminToken } from '@/composables/useAdminAuth'
import { adminRequest } from '@/composables/useAdminRequest'
import { canOperatePlatformMember } from '@/views/admin/lottery/ops-utils'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const members = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const operatingId = ref('')
const showAdd = ref(false)
const formKey = ref('')
const formRole = ref('platform_operator')
const searchQuery = ref('')
const pagination = useTablePagination({ initialLimit: 50 })
const myUserId = ref('')

const membersRef = computed(() => members.value)
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
} = useTableSelection(membersRef, (row) => row.userId, {
  isSelectable: (row) => canOperatePlatformMember(String(row.userId || ''), myUserId.value),
})

const disableableCount = computed(() =>
  members.value.filter((m) => selectedIds.value.includes(m.userId) && m.status === 'active').length,
)
const enableableCount = computed(() =>
  members.value.filter((m) => selectedIds.value.includes(m.userId) && m.status !== 'active').length,
)

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) }
  catch { return iso }
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
    try {
      const token = readAdminToken()
      const payload = JSON.parse(atob(token.split('.')[1]))
      myUserId.value = payload.sub || ''
    } catch { /* 忽略 */ }
    const params = new URLSearchParams(buildAdminOffsetParams(pagination.page.value, pagination.limit.value))
    if (searchQuery.value) params.set('search', searchQuery.value)
    const data = await adminRequest<{ members: any[]; total: number }>(`/api/platform/members?${params.toString()}`)
    members.value = data.members || []
    pagination.setTotal(data.total || 0)
  } catch (err: any) {
    loadError.value = err.message || t('platformMembers.loadFailed')
  } finally {
    loading.value = false
  }
}

function searchData() {
  pagination.setPage(1)
  void loadData()
}

async function handleAdd() {
  if (!formKey.value.trim()) return
  submitting.value = true
  try {
    const key = formKey.value.trim()
    const body = key.includes('@') ? { email: key, role: formRole.value } : { username: key, role: formRole.value }
    await adminRequest('/api/platform/members', { method: 'POST', body: JSON.stringify(body) })
    showToast(t('platformMembers.added'), 'success')
    showAdd.value = false
    formKey.value = ''
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('platformMembers.addFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

async function updateRole(m: any, role: string) {
  if (operatingId.value || batchOperating.value || role === m.role) return
  operatingId.value = m.userId
  try {
    await adminRequest(`/api/platform/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role }) })
    showToast(t('platformMembers.roleUpdated'), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('platformMembers.updateFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function toggleStatus(m: any) {
  if (operatingId.value || batchOperating.value) return
  operatingId.value = m.userId
  try {
    const status = m.status === 'active' ? 'disabled' : 'active'
    await adminRequest(`/api/platform/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    showToast(status === 'active' ? t('platformMembers.enabled') : t('platformMembers.disabled'), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('platformMembers.opFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleRemove(m: any) {
  if (operatingId.value || batchOperating.value) return
  if (!(await askConfirm(t('platformMembers.removeConfirm', { id: m.userId.slice(0, 10) })))) return
  operatingId.value = m.userId
  try {
    await adminRequest(`/api/platform/members/${m.userId}`, { method: 'DELETE' })
    showToast(t('platformMembers.removed'), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('platformMembers.removeFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function batchSetStatus(status: 'active' | 'disabled') {
  const targets = members.value.filter((m) => {
    if (!selectedIds.value.includes(m.userId)) return false
    if (status === 'disabled') return m.status === 'active'
    return m.status !== 'active'
  })
  if (targets.length === 0 || loading.value || batchOperating.value) return
  const confirmKey = status === 'disabled' ? 'platformMembers.batchDisableConfirm' : 'platformMembers.batchEnableConfirm'
  if (!(await askConfirm(t(confirmKey, { count: targets.length })))) return
  const result = await runSequential(targets, async (row) => {
    await adminRequest(`/api/platform/members/${row.userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
  })
  if (!result) return
  toastBatch(result, status === 'disabled' ? 'batchDisable' : 'batchEnable')
  clearSelection()
  await loadData()
}

async function batchRemove() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('platformMembers.batchRemoveConfirm', { count: ids.length })))) return
  const result = await runSequential(ids, async (id) => {
    await adminRequest(`/api/platform/members/${id}`, { method: 'DELETE' })
  })
  if (!result) return
  toastBatch(result, 'batchRemove')
  clearSelection()
  await loadData()
}

function toastBatch(result: { success: number; failed: number }, kind: 'batchDisable' | 'batchEnable' | 'batchRemove') {
  if (result.failed > 0) {
    showToast(t(`platformMembers.${kind}Result`, { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t(`platformMembers.${kind}Success`, { count: result.success }), 'success')
  }
}

onMounted(loadData)
</script>

<style scoped>
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
</style>
