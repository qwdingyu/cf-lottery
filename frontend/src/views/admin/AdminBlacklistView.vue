<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          {{ loading ? $t('adminBlacklist.loading') : $t('adminBlacklist.refresh') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="showAdd = true">{{ $t('adminBlacklist.add') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminBlacklist.retry') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('adminBlacklist.selectedCount', { count: selectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('adminBlacklist.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearSelection">
        {{ $t('adminBlacklist.clearSelection') }}
      </button>
      <button class="btn btn-danger btn-sm" type="button" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemove">
        {{ $t('adminBlacklist.batchDelete', { count: selectedCount }) }}
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
                :disabled="loading || batchOperating || items.length === 0"
                :aria-label="$t('adminBlacklist.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminBlacklist.colEmail') }}</th>
            <th>{{ $t('adminBlacklist.colNote') }}</th>
            <th>{{ $t('adminBlacklist.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('adminBlacklist.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="5"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating"
                :aria-label="$t('adminBlacklist.selectRow')"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td>{{ item.identityValue }}</td>
            <td>{{ item.note || '-' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" type="button" :disabled="operatingId === item.id || batchOperating" @click="handleRemove(item.id)">
                {{ operatingId === item.id ? $t('adminBlacklist.deleting') : $t('adminBlacklist.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="5" class="empty-text">{{ $t('adminBlacklist.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="showAdd" :title="$t('adminBlacklist.addTitle')" max-width="480px" hide-actions>
      <form @submit.prevent="handleAdd">
        <div class="modal-form">
          <label>
            <span>{{ $t('adminBlacklist.emailLabel') }}</span>
            <input v-model="formEmail" type="email" required :placeholder="$t('adminBlacklist.emailPlaceholder')" />
          </label>
          <label>
            <span>{{ $t('adminBlacklist.noteLabel') }}</span>
            <input v-model="formNote" maxlength="200" :placeholder="$t('adminBlacklist.notePlaceholder')" />
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showAdd = false">{{ $t('adminBlacklist.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? $t('adminBlacklist.adding') : $t('adminBlacklist.addBtn') }}
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
import { useToast } from '@/composables/useToast'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import { formatDate } from '@/composables/useFormat'
import AdminModal from '@/components/AdminModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const items = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const operatingId = ref('')
const showAdd = ref(false)
const formEmail = ref('')
const formNote = ref('')

const itemsRef = computed(() => items.value)
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()
const {
  selectedIds,
  selectedCount,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
  allVisibleSelected,
  partiallySelected,
} = useTableSelection(itemsRef, (row) => row.id)

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ items: any[] }>('/api/admin/blacklist')
    items.value = data.items || []
  } catch (err: any) {
    loadError.value = err.message || t('adminBlacklist.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!formEmail.value.includes('@')) {
    showToast(t('adminBlacklist.invalidEmail'), 'error')
    return
  }
  submitting.value = true
  try {
    await adminRequest('/api/admin/blacklist', {
      method: 'POST',
      body: JSON.stringify({ identityValue: formEmail.value.trim(), note: formNote.value.trim() }),
    })
    showToast(t('adminBlacklist.added'), 'success')
    showAdd.value = false
    formEmail.value = ''
    formNote.value = ''
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminBlacklist.addFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

async function handleRemove(id: string) {
  if (operatingId.value || batchOperating.value) return
  if (!(await askConfirm(t('adminBlacklist.deleteConfirm')))) return
  operatingId.value = id
  try {
    await adminRequest(`/api/admin/blacklist/${id}`, { method: 'DELETE' })
    showToast(t('adminBlacklist.deleted'), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminBlacklist.deleteFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

/** 测试清场：多选顺序删，无后端 batch API */
async function batchRemove() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('adminBlacklist.batchDeleteConfirm', { count: ids.length })))) return
  const result = await runSequential(ids, async (id) => {
    await adminRequest(`/api/admin/blacklist/${id}`, { method: 'DELETE' })
  })
  if (!result) return
  if (result.failed > 0) {
    showToast(t('adminBlacklist.batchDeleteResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t('adminBlacklist.batchDeleteSuccess', { count: result.success }), 'success')
  }
  clearSelection()
  await loadData()
}

onMounted(loadData)
</script>
