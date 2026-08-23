<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="loadData">
          {{ loading ? $t('adminMembers.loading') : $t('adminMembers.refresh') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="showAdd = true">{{ $t('adminMembers.add') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminMembers.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('adminMembers.selectedCount', { count: selectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('adminMembers.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearSelection">
        {{ $t('adminMembers.clearSelection') }}
      </button>
      <button class="btn btn-danger btn-sm" type="button" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemove">
        {{ $t('adminMembers.batchRemove', { count: selectedCount }) }}
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
                :aria-label="$t('adminMembers.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminMembers.colUsername') }}</th>
            <th>{{ $t('adminMembers.colRole') }}</th>
            <th>{{ $t('adminMembers.colJoinedAt') }}</th>
            <th class="col-actions">{{ $t('adminMembers.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="5"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="m in members" :key="m.userId" :class="{ 'is-selected': isSelected(m.userId) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(m.userId)"
                :disabled="loading || batchOperating || !canRemoveMember(m.role)"
                :aria-label="$t('adminMembers.selectRow')"
                @click="setSelected(m.userId, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td>{{ m.username }}</td>
            <td><span class="tag" :class="m.role === 'owner' ? 'tag-info' : 'tag-muted'">{{ m.role }}</span></td>
            <td>{{ formatDateCST(m.createdAt) }}</td>
            <td class="col-actions">
              <button
                v-if="canRemoveMember(m.role)"
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="operatingId === m.userId || batchOperating"
                @click="handleRemove(m.userId)"
              >{{ operatingId === m.userId ? $t('adminMembers.removing') : $t('adminMembers.remove') }}</button>
              <span v-else class="tag tag-muted">{{ $t('adminMembers.ownerLocked') }}</span>
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="5" class="empty-text">{{ $t('adminMembers.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="showAdd" :title="$t('adminMembers.addTitle')" max-width="480px" hide-actions>
      <form @submit.prevent="handleAdd">
        <div class="modal-form">
          <label>
            <span>{{ $t('adminMembers.usernameLabel') }}</span>
            <input v-model="formUsername" type="text" required :placeholder="$t('adminMembers.usernamePlaceholder')" />
            <small class="field-hint">{{ $t('adminMembers.usernameHint') }}</small>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showAdd = false">{{ $t('adminMembers.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? $t('adminMembers.adding') : $t('adminMembers.addBtn') }}
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
import { useToast } from '@usethink/cf-admin-fe/composables'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { useTableSelection } from '@usethink/cf-admin-fe/composables'
import { useAdminBatchOperation } from '@usethink/cf-admin-fe/composables'
import { formatDateCST } from '@/composables/useFormat'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { adminRequest } from '@/composables/useAdminRequest'
import { canRemoveMember } from './lottery/ops-utils'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const members = ref<any[]>([])
const loading = ref(false)
const submitting = ref(false)
const showAdd = ref(false)
const formUsername = ref('')
const loadError = ref('')
const operatingId = ref('')

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
  // owner 是租户安全锚点，不可批量/单条移除
  isSelectable: (row) => canRemoveMember(String(row.role || '')),
})

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ members: any[] }>('/api/admin/members')
    members.value = data.members || []
  } catch (err: any) {
    loadError.value = err.message || t('adminMembers.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!formUsername.value.trim()) return
  submitting.value = true
  try {
    await adminRequest('/api/admin/members', {
      method: 'POST',
      body: JSON.stringify({ username: formUsername.value.trim() }),
    })
    showToast(t('adminMembers.added'), 'success')
    showAdd.value = false
    formUsername.value = ''
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminMembers.addFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

async function handleRemove(userId: string) {
  if (operatingId.value || batchOperating.value) return
  if (!(await askConfirm(t('adminMembers.removeConfirm')))) return
  operatingId.value = userId
  try {
    await adminRequest(`/api/admin/members/${userId}`, { method: 'DELETE' })
    showToast(t('adminMembers.removed'), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminMembers.removeFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

/** 测试清场：多选顺序移除非 owner 成员 */
async function batchRemove() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('adminMembers.batchRemoveConfirm', { count: ids.length })))) return
  const result = await runSequential(ids, async (id) => {
    await adminRequest(`/api/admin/members/${id}`, { method: 'DELETE' })
  })
  if (!result) return
  if (result.failed > 0) {
    showToast(t('adminMembers.batchRemoveResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t('adminMembers.batchRemoveSuccess', { count: result.success }), 'success')
  }
  clearSelection()
  await loadData()
}

onMounted(loadData)
</script>
