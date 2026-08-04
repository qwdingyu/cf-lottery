<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          {{ loading ? $t('adminMembers.loading') : $t('adminMembers.refresh') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="showAdd = true">{{ $t('adminMembers.add') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminMembers.retry') }}</button>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminMembers.colUsername') }}</th>
            <th>{{ $t('adminMembers.colRole') }}</th>
            <th>{{ $t('adminMembers.colJoinedAt') }}</th>
            <th class="col-actions">{{ $t('adminMembers.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="4"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="m in members" :key="m.userId">
            <td>{{ m.username }}</td>
            <td><span class="tag" :class="m.role === 'owner' ? 'tag-info' : 'tag-muted'">{{ m.role }}</span></td>
            <td>{{ formatDate(m.createdAt) }}</td>
            <td class="col-actions">
              <button
                v-if="m.role !== 'owner'"
                class="btn btn-ghost btn-xs"
                :disabled="operatingId === m.userId"
                @click="handleRemove(m.userId)"
              >{{ operatingId === m.userId ? $t('adminMembers.removing') : $t('adminMembers.remove') }}</button>
              <span v-else class="tag tag-muted">{{ $t('adminMembers.ownerLocked') }}</span>
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="4" class="empty-text">{{ $t('adminMembers.empty') }}</td>
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
const members = ref<any[]>([])
const loading = ref(false)
const submitting = ref(false)
const showAdd = ref(false)
const formUsername = ref('')
const loadError = ref('')
const operatingId = ref('')


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
  if (operatingId.value) return
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

onMounted(loadData)
</script>
