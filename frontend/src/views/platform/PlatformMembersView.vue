<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          {{ loading ? $t('platformMembers.loading') : $t('platformMembers.refresh') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="showAdd = true">{{ $t('platformMembers.add') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('platformMembers.retry') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformMembers.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('platformMembers.colUserId') }}</th>
            <th>{{ $t('platformMembers.colRole') }}</th>
            <th>{{ $t('platformMembers.colStatus') }}</th>
            <th>{{ $t('platformMembers.colJoinedAt') }}</th>
            <th class="col-actions">{{ $t('platformMembers.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="5"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="m in members" :key="m.userId">
            <td><code class="code-id" :title="m.userId" @click="copyText(m.userId)">{{ m.userId.slice(0, 10) }}…</code></td>
            <td>
              <select :value="m.role" :disabled="operatingId === m.userId || m.userId === myUserId" @change="updateRole(m, ($event.target as HTMLSelectElement).value)">
                <option value="platform_owner">Owner</option>
                <option value="platform_operator">Operator</option>
                <option value="platform_support">Support</option>
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
                :disabled="operatingId === m.userId"
                @click="toggleStatus(m)"
              >{{ m.status === 'active' ? $t('platformMembers.disable') : $t('platformMembers.enable') }}</button>
              <button
                v-if="m.userId !== myUserId"
                class="btn btn-danger btn-xs"
                :disabled="operatingId === m.userId"
                @click="handleRemove(m)"
              >{{ $t('platformMembers.remove') }}</button>
              <span v-else class="tag tag-muted">{{ $t('platformMembers.currentUser') }}</span>
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="5" class="empty-text">{{ $t('platformMembers.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@/components/AdminModal.vue'
import { useToast } from '@/composables/useToast'
import { readAdminToken } from '@/composables/useAdminAuth'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()
const members = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const operatingId = ref('')
const showAdd = ref(false)
const formKey = ref('')
const formRole = ref('platform_operator')
const myUserId = ref('')

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) }
  catch { return iso }
}

function copyText(text: string) {
  if (text) navigator.clipboard.writeText(text).catch(() => {})
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
    const data = await adminRequest<{ members: any[] }>('/api/platform/members')
    members.value = data.members || []
  } catch (err: any) {
    loadError.value = err.message || t('platformMembers.loadFailed')
  } finally {
    loading.value = false
  }
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
  if (operatingId.value || role === m.role) return
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
  if (operatingId.value) return
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
  if (operatingId.value) return
  if (!window.confirm(t('platformMembers.removeConfirm', { id: m.userId.slice(0, 10) }))) return
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

onMounted(loadData)
</script>

<style scoped>
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
</style>
