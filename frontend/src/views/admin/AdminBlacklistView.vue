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

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminBlacklist.colEmail') }}</th>
            <th>{{ $t('adminBlacklist.colNote') }}</th>
            <th>{{ $t('adminBlacklist.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('adminBlacklist.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="4"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.id">
            <td>{{ item.identityValue }}</td>
            <td>{{ item.note || '-' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" :disabled="operatingId === item.id" @click="handleRemove(item.id)">
                {{ operatingId === item.id ? $t('adminBlacklist.deleting') : $t('adminBlacklist.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="4" class="empty-text">{{ $t('adminBlacklist.empty') }}</td>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import AdminModal from '@/components/AdminModal.vue'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()
const items = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const operatingId = ref('')
const showAdd = ref(false)
const formEmail = ref('')
const formNote = ref('')


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
  if (operatingId.value) return
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

onMounted(loadData)
</script>
