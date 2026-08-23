<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <div class="integration-tabs">
          <button class="btn btn-ghost btn-sm" :class="{ 'is-active': activeTab === 'webhooks' }" :disabled="batchOperating" @click="switchTab('webhooks')">{{ $t('adminIntegrations.tabWebhooks') }}</button>
          <button class="btn btn-ghost btn-sm" :class="{ 'is-active': activeTab === 'apikeys' }" :disabled="batchOperating" @click="switchTab('apikeys')">{{ $t('adminIntegrations.tabApiKeys') }}</button>
        </div>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="openCreate">
          {{ activeTab === 'webhooks' ? $t('adminIntegrations.addWebhook') : $t('adminIntegrations.createKey') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="loadData">{{ $t('adminIntegrations.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminIntegrations.retry') }}</button>
    </div>

    <div v-if="activeSelectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ $t('adminIntegrations.selectedCount', { count: activeSelectedCount }) }}
        <template v-if="batchOperating">
          · {{ $t('adminIntegrations.batchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="clearActiveSelection">
        {{ $t('adminIntegrations.clearSelection') }}
      </button>
      <button class="btn btn-danger btn-sm" type="button" :disabled="loading || batchOperating || activeSelectedCount === 0" @click="batchDeleteActive">
        {{ $t('adminIntegrations.batchDelete', { count: activeSelectedCount }) }}
      </button>
    </div>

    <div v-if="activeTab === 'webhooks'" class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="webhookAllVisibleSelected"
                :indeterminate.prop="webhookPartiallySelected"
                :disabled="loading || batchOperating || webhooks.length === 0"
                :aria-label="$t('adminIntegrations.selectAll')"
                @change="webhookToggleAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminIntegrations.colUrl') }}</th>
            <th>{{ $t('adminIntegrations.colEvents') }}</th>
            <th>{{ $t('adminIntegrations.colStatus') }}</th>
            <th>{{ $t('adminIntegrations.colLastSent') }}</th>
            <th class="col-actions">{{ $t('adminIntegrations.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="6"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="w in webhooks" :key="w.id" :class="{ 'is-selected': webhookIsSelected(w.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="webhookIsSelected(w.id)"
                :disabled="loading || batchOperating"
                :aria-label="$t('adminIntegrations.selectRow')"
                @click="webhookSetSelected(w.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td class="url-cell" :title="w.url">{{ truncate(w.url, 40) }}</td>
            <td><span v-for="e in parseEvents(w.events)" :key="e" class="tag tag-info">{{ e }}</span></td>
            <td>
              <span class="tag" :class="w.active ? 'tag-success' : 'tag-muted'">{{ w.active ? $t('adminIntegrations.enabled') : $t('adminIntegrations.disabled') }}</span>
              <small v-if="w.lastError" class="tag-danger" :title="w.lastError" style="display:block;font-size:10px">{{ $t('adminIntegrations.lastFailed') }}</small>
            </td>
            <td>{{ w.lastSentAt ? formatDateCST(w.lastSentAt) : '-' }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" type="button" :disabled="batchOperating" @click="removeWebhook(w.id)">{{ $t('adminIntegrations.delete') }}</button>
            </td>
          </tr>
          <tr v-if="webhooks.length === 0"><td colspan="6" class="empty-text">{{ $t('adminIntegrations.emptyWebhooks') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="keyAllVisibleSelected"
                :indeterminate.prop="keyPartiallySelected"
                :disabled="loading || batchOperating || apiKeys.length === 0"
                :aria-label="$t('adminIntegrations.selectAll')"
                @change="keyToggleAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminIntegrations.colName') }}</th>
            <th>{{ $t('adminIntegrations.colKey') }}</th>
            <th>{{ $t('adminIntegrations.colStatus') }}</th>
            <th>{{ $t('adminIntegrations.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('adminIntegrations.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="6"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="k in apiKeys" :key="k.id" :class="{ 'is-selected': keyIsSelected(k.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="keyIsSelected(k.id)"
                :disabled="loading || batchOperating"
                :aria-label="$t('adminIntegrations.selectRow')"
                @click="keySetSelected(k.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td>{{ k.name }}</td>
            <td><code class="code-text">{{ k.prefix }}</code></td>
            <td><span class="tag" :class="k.active ? 'tag-success' : 'tag-muted'">{{ k.active ? $t('adminIntegrations.enabled') : $t('adminIntegrations.disabled') }}</span></td>
            <td>{{ formatDateCST(k.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-danger btn-xs" type="button" :disabled="batchOperating" @click="removeApiKey(k.id)">{{ $t('adminIntegrations.delete') }}</button>
            </td>
          </tr>
          <tr v-if="apiKeys.length === 0"><td colspan="6" class="empty-text">{{ $t('adminIntegrations.emptyKeys') }}</td></tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="showCreate" :title="activeTab === 'webhooks' ? $t('adminIntegrations.createWebhookTitle') : $t('adminIntegrations.createKeyTitle')" max-width="520px" hide-actions>
      <form @submit.prevent="handleCreate">
        <div class="modal-form">
          <template v-if="activeTab === 'webhooks'">
            <label>
              <span>{{ $t('adminIntegrations.urlLabel') }}</span>
              <input v-model="webhookForm.url" required maxlength="500" :placeholder="$t('adminIntegrations.urlPlaceholder')" />
            </label>
            <label>
              <span>{{ $t('adminIntegrations.eventsLabel') }}</span>
              <div class="event-checkboxes">
                <label v-for="ev in webhookEvents" :key="ev.value" class="event-checkbox">
                  <input v-model="webhookForm.events" type="checkbox" :value="ev.value" />
                  <span>{{ ev.label }}</span>
                </label>
              </div>
            </label>
          </template>
          <template v-else>
            <label>
              <span>{{ $t('adminIntegrations.keyNameLabel') }}</span>
              <input v-model="apiKeyForm.name" required maxlength="50" :placeholder="$t('adminIntegrations.keyNamePlaceholder')" />
              <small class="field-hint">{{ $t('adminIntegrations.keyNameHint') }}</small>
            </label>
          </template>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreate = false">{{ $t('adminIntegrations.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">{{ submitting ? $t('adminIntegrations.saving') : $t('adminIntegrations.save') }}</button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="showNewKey" :title="$t('adminIntegrations.keyCreatedTitle')" max-width="520px" hide-actions>
      <div class="modal-form">
        <p>{{ $t('adminIntegrations.keyCreatedHint') }}</p>
        <textarea readonly :value="newKey" rows="2" class="code-textarea" @click="copyText(newKey)" />
        <p class="field-hint">{{ $t('adminIntegrations.keyCopyHint') }}</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-sm" @click="copyText(newKey); showNewKey = false">{{ $t('adminIntegrations.keyCopiedClose') }}</button>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { copyWithToast, useToast } from '@usethink/cf-admin-fe/composables'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { useTableSelection } from '@usethink/cf-admin-fe/composables'
import { useAdminBatchOperation } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'
import { formatDateCST } from '@/composables/useFormat'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const activeTab = ref<'webhooks' | 'apikeys'>('webhooks')
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const showCreate = ref(false)
const showNewKey = ref(false)
const newKey = ref('')

const webhooks = ref<any[]>([])
const apiKeys = ref<any[]>([])
const webhookForm = ref({ url: '', events: [] as string[] })
const apiKeyForm = ref({ name: '' })

const webhooksRef = computed(() => webhooks.value)
const apiKeysRef = computed(() => apiKeys.value)
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()

const {
  selectedIds: webhookSelectedIds,
  selectedCount: webhookSelectedCount,
  isSelected: webhookIsSelected,
  setSelected: webhookSetSelected,
  toggleAllVisible: webhookToggleAll,
  clearSelection: webhookClearSelection,
  allVisibleSelected: webhookAllVisibleSelected,
  partiallySelected: webhookPartiallySelected,
} = useTableSelection(webhooksRef, (row) => row.id)

const {
  selectedIds: keySelectedIds,
  selectedCount: keySelectedCount,
  isSelected: keyIsSelected,
  setSelected: keySetSelected,
  toggleAllVisible: keyToggleAll,
  clearSelection: keyClearSelection,
  allVisibleSelected: keyAllVisibleSelected,
  partiallySelected: keyPartiallySelected,
} = useTableSelection(apiKeysRef, (row) => row.id)

const activeSelectedCount = computed(() =>
  activeTab.value === 'webhooks' ? webhookSelectedCount.value : keySelectedCount.value,
)

function clearActiveSelection() {
  if (activeTab.value === 'webhooks') webhookClearSelection()
  else keyClearSelection()
}

function switchTab(tab: 'webhooks' | 'apikeys') {
  if (batchOperating.value || tab === activeTab.value) return
  activeTab.value = tab
}

const webhookEvents = computed(() => [
  { value: 'draw.completed', label: t('adminIntegrations.eventDrawCompleted') },
  { value: 'prize.issued', label: t('adminIntegrations.eventPrizeIssued') },
  { value: 'entry.created', label: t('adminIntegrations.eventEntryCreated') },
])

function parseEvents(raw: any): string[] {
  try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]') } catch { return [] }
}

function truncate(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) + '…' : text
}

async function copyText(text: string) {
  if (!text) return
  await copyWithToast(text, {
    successMessage: t('adminIntegrations.copied'),
    errorMessage: t('adminRedemption.copyFailed'),
  })
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    if (activeTab.value === 'webhooks') {
      const data = await adminRequest<{ webhooks: any[] }>('/api/admin/webhooks')
      webhooks.value = data.webhooks || []
    } else {
      const data = await adminRequest<{ keys: any[] }>('/api/admin/api-keys')
      apiKeys.value = data.keys || []
    }
  } catch (err: any) {
    loadError.value = err.message || t('adminIntegrations.loadFailed')
  } finally {
    loading.value = false
  }
}

watch(activeTab, () => { loadData() })

function openCreate() { showCreate.value = true }

async function handleCreate() {
  submitting.value = true
  try {
    if (activeTab.value === 'webhooks') {
      if (!webhookForm.value.url.trim()) { showToast(t('adminIntegrations.urlRequired'), 'error'); return }
      await adminRequest('/api/admin/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: webhookForm.value.url.trim(), events: webhookForm.value.events }),
      })
      showToast(t('adminIntegrations.webhookAdded'), 'success')
      webhookForm.value = { url: '', events: [] }
    } else {
      if (!apiKeyForm.value.name.trim()) { showToast(t('adminIntegrations.keyNameRequired'), 'error'); return }
      const data = await adminRequest<{ key: string }>('/api/admin/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: apiKeyForm.value.name.trim() }),
      })
      newKey.value = data.key
      showNewKey.value = true
      apiKeyForm.value = { name: '' }
    }
    showCreate.value = false
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminIntegrations.saveFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

async function removeWebhook(id: string) {
  if (batchOperating.value) return
  if (!(await askConfirm(t('adminIntegrations.confirmDeleteWebhook')))) return
  try {
    await adminRequest(`/api/admin/webhooks/${id}`, { method: 'DELETE' })
    showToast(t('adminIntegrations.deleted'), 'success')
    await loadData()
  } catch (err: any) { showToast(err.message || t('adminIntegrations.deleteFailed'), 'error') }
}

async function removeApiKey(id: string) {
  if (batchOperating.value) return
  if (!(await askConfirm(t('adminIntegrations.confirmDeleteKey')))) return
  try {
    await adminRequest(`/api/admin/api-keys/${id}`, { method: 'DELETE' })
    showToast(t('adminIntegrations.deleted'), 'success')
    await loadData()
  } catch (err: any) { showToast(err.message || t('adminIntegrations.deleteFailed'), 'error') }
}

async function batchDeleteActive() {
  if (loading.value || batchOperating.value) return
  if (activeTab.value === 'webhooks') {
    const ids = webhookSelectedIds.value.slice()
    if (ids.length === 0) return
    if (!(await askConfirm(t('adminIntegrations.batchDeleteWebhooksConfirm', { count: ids.length })))) return
    const result = await runSequential(ids, async (id) => {
      await adminRequest(`/api/admin/webhooks/${id}`, { method: 'DELETE' })
    })
    if (!result) return
    toastBatchResult(result)
    webhookClearSelection()
  } else {
    const ids = keySelectedIds.value.slice()
    if (ids.length === 0) return
    if (!(await askConfirm(t('adminIntegrations.batchDeleteKeysConfirm', { count: ids.length })))) return
    const result = await runSequential(ids, async (id) => {
      await adminRequest(`/api/admin/api-keys/${id}`, { method: 'DELETE' })
    })
    if (!result) return
    toastBatchResult(result)
    keyClearSelection()
  }
  await loadData()
}

function toastBatchResult(result: { success: number; failed: number }) {
  if (result.failed > 0) {
    showToast(t('adminIntegrations.batchDeleteResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(t('adminIntegrations.batchDeleteSuccess', { count: result.success }), 'success')
  }
}

onMounted(loadData)
</script>

<style scoped>
.integration-tabs { display: flex; gap: 4px; }
.integration-tabs .is-active { background: var(--admin-accent, #f59e0b); color: #fff; }
.url-cell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.event-checkboxes { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 0; }
.event-checkbox { display: flex; align-items: center; gap: 4px; font-size: 13px; }
.code-text { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; }
.code-textarea { width: 100%; font-family: monospace; background: var(--tg-secondary-bg, #151b28); color: var(--admin-accent, #f59e0b); border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius: 8px; padding: 10px; }
</style>
