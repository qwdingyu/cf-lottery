<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <div class="integration-tabs">
          <button class="btn btn-ghost btn-sm" :class="{ 'is-active': activeTab === 'webhooks' }" @click="activeTab = 'webhooks'">{{ $t('adminIntegrations.tabWebhooks') }}</button>
          <button class="btn btn-ghost btn-sm" :class="{ 'is-active': activeTab === 'apikeys' }" @click="activeTab = 'apikeys'">{{ $t('adminIntegrations.tabApiKeys') }}</button>
        </div>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="openCreate">
          {{ activeTab === 'webhooks' ? $t('adminIntegrations.addWebhook') : $t('adminIntegrations.createKey') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminIntegrations.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminIntegrations.retry') }}</button>
    </div>

    <div v-if="activeTab === 'webhooks'" class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminIntegrations.colUrl') }}</th>
            <th>{{ $t('adminIntegrations.colEvents') }}</th>
            <th>{{ $t('adminIntegrations.colStatus') }}</th>
            <th>{{ $t('adminIntegrations.colLastSent') }}</th>
            <th class="col-actions">{{ $t('adminIntegrations.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="5"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="w in webhooks" :key="w.id">
            <td class="url-cell" :title="w.url">{{ truncate(w.url, 40) }}</td>
            <td><span v-for="e in parseEvents(w.events)" :key="e" class="tag tag-info">{{ e }}</span></td>
            <td>
              <span class="tag" :class="w.active ? 'tag-success' : 'tag-muted'">{{ w.active ? $t('adminIntegrations.enabled') : $t('adminIntegrations.disabled') }}</span>
              <small v-if="w.lastError" class="tag-danger" :title="w.lastError" style="display:block;font-size:10px">{{ $t('adminIntegrations.lastFailed') }}</small>
            </td>
            <td>{{ w.lastSentAt ? formatTime(w.lastSentAt) : '-' }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" @click="removeWebhook(w.id)">{{ $t('adminIntegrations.delete') }}</button>
            </td>
          </tr>
          <tr v-if="webhooks.length === 0"><td colspan="5" class="empty-text">{{ $t('adminIntegrations.emptyWebhooks') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminIntegrations.colName') }}</th>
            <th>{{ $t('adminIntegrations.colKey') }}</th>
            <th>{{ $t('adminIntegrations.colStatus') }}</th>
            <th>{{ $t('adminIntegrations.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('adminIntegrations.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="5"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="k in apiKeys" :key="k.id">
            <td>{{ k.name }}</td>
            <td><code class="code-text">{{ k.prefix || maskKey(k.key) }}</code></td>
            <td><span class="tag" :class="k.active ? 'tag-success' : 'tag-muted'">{{ k.active ? $t('adminIntegrations.enabled') : $t('adminIntegrations.disabled') }}</span></td>
            <td>{{ formatTime(k.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-danger btn-xs" @click="removeApiKey(k.id)">{{ $t('adminIntegrations.delete') }}</button>
            </td>
          </tr>
          <tr v-if="apiKeys.length === 0"><td colspan="5" class="empty-text">{{ $t('adminIntegrations.emptyKeys') }}</td></tr>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@/components/AdminModal.vue'
import { useToast } from '@/composables/useToast'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()
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

function maskKey(key: string): string {
  if (!key) return '-'
  if (key.startsWith('cl_')) return key.length > 12 ? `${key.slice(0, 10)}…` : key
  return 'cl_••••••••'
}

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

function copyText(text: string) {
  if (text) { navigator.clipboard.writeText(text).catch(() => {}); showToast(t('adminIntegrations.copied'), 'success') }
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
  if (!window.confirm(t('adminIntegrations.confirmDeleteWebhook'))) return
  try {
    await adminRequest(`/api/admin/webhooks/${id}`, { method: 'DELETE' })
    showToast(t('adminIntegrations.deleted'), 'success')
    await loadData()
  } catch (err: any) { showToast(err.message || t('adminIntegrations.deleteFailed'), 'error') }
}

async function removeApiKey(id: string) {
  if (!window.confirm(t('adminIntegrations.confirmDeleteKey'))) return
  try {
    await adminRequest(`/api/admin/api-keys/${id}`, { method: 'DELETE' })
    showToast(t('adminIntegrations.deleted'), 'success')
    await loadData()
  } catch (err: any) { showToast(err.message || t('adminIntegrations.deleteFailed'), 'error') }
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
