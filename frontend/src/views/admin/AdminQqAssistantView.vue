<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <span class="toolbar-title">{{ $t('adminQqAssistant.title') }}</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="openCreateModal">
          {{ $t('adminQqAssistant.addBinding') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadTargets">{{ $t('adminQqAssistant.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadTargets">{{ $t('adminQqAssistant.retry') }}</button>
    </div>

    <div class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminQqAssistant.colGroup') }}</th>
            <th>{{ $t('adminQqAssistant.colGroupId') }}</th>
            <th>{{ $t('adminQqAssistant.colActivity') }}</th>
            <th>{{ $t('adminQqAssistant.colStatus') }}</th>
            <th class="col-actions">{{ $t('adminQqAssistant.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="5"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else-if="targets.length === 0">
          <tr><td :colspan="5" class="empty-row">{{ $t('adminQqAssistant.empty') }}</td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="t in targets" :key="t.id" :class="{ 'is-selected': selectedId === t.id }">
            <td>{{ t.targetName || '-' }}</td>
            <td class="mono">{{ t.targetId }}</td>
            <td>
              <span v-if="t.activeDrawId" class="tag tag-info">{{ t.activeDrawId.slice(0, 8) }}…</span>
              <span v-else class="tag tag-muted">{{ $t('adminQqAssistant.notBound') }}</span>
            </td>
            <td>
              <span
                class="tag pointer"
                :class="t.assistantEnabled ? 'tag-success' : 'tag-muted'"
                :title="t.assistantEnabled ? $t('adminQqAssistant.enabled') : $t('adminQqAssistant.disabled')"
                @click="toggleEnabled(t)"
              >{{ t.assistantEnabled ? $t('adminQqAssistant.enabled') : $t('adminQqAssistant.disabled') }}</span>
            </td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" :title="$t('adminQqAssistant.edit')" @click="openEditModal(t)">{{ $t('adminQqAssistant.edit') }}</button>
              <button class="btn btn-ghost btn-xs" :title="$t('adminQqAssistant.resetSecret')" @click="resetSecret(t)" :disabled="resettingId === t.id">{{ $t('adminQqAssistant.resetSecret') }}</button>
              <button class="btn btn-danger btn-xs" :title="$t('adminQqAssistant.delete')" @click="deleteTarget(t)">{{ $t('adminQqAssistant.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
<!-- 创建 / 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-overlay" @click.self="closeModal">
        <div class="modal-content qq-assistant-modal">
          <div class="modal-header">
            <h3>{{ editingTarget ? $t('adminQqAssistant.editBinding') : $t('adminQqAssistant.addBinding') }}</h3>
            <button class="btn btn-ghost btn-sm" @click="closeModal" type="button" :aria-label="$t('adminQqAssistant.close')">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelGroupId') }} <span class="required">*</span></label>
              <input v-model="form.targetId" class="form-input" :placeholder="$t('adminQqAssistant.placeholderGroupId')" :disabled="!!editingTarget" />
            </div>
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelGroupName') }}</label>
              <input v-model="form.targetName" class="form-input" :placeholder="$t('adminQqAssistant.placeholderGroupName')" />
            </div>
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelActivity') }}</label>
              <select v-model="form.activeDrawId" class="form-select">
                <option value="">{{ $t('adminQqAssistant.noActivity') }}</option>
                <option v-for="d in draws" :key="d.id" :value="d.id">{{ d.title }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>
                {{ $t('adminQqAssistant.labelAdapterBaseUrl') }}
                <span v-if="editingTarget" class="form-hint">{{ $t('adminQqAssistant.hintAdapterBaseUrlEdit') }}</span>
              </label>
              <div v-if="!editingTarget" class="form-hint">{{ $t('adminQqAssistant.hintAdapterBaseUrl') }}</div>
              <input v-model="form.adapterBaseUrl" class="form-input" :placeholder="editingTarget ? $t('adminQqAssistant.placeholderAdapterBaseUrlEdit') : $t('adminQqAssistant.placeholderAdapterBaseUrl')" />
            </div>
            <div v-if="editingTarget" class="form-group">
              <label>{{ $t('adminQqAssistant.labelNewInboundSecret') }}</label>
              <div class="form-hint">{{ $t('adminQqAssistant.hintNewInboundSecret') }}</div>
              <input v-model="form.inboundSecret" class="form-input" autocomplete="new-password" :placeholder="$t('adminQqAssistant.placeholderNewInboundSecret')" />
            </div>
            <fieldset class="form-fieldset">
              <legend>{{ $t('adminQqAssistant.builtinCommands') }}</legend>
              <div class="checkbox-group">
                <label class="checkbox-label"><input type="checkbox" v-model="form.checkinEnabled" /> {{ $t('adminQqAssistant.cmdCheckin') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.spinEnabled" /> {{ $t('adminQqAssistant.cmdSpin') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.shareEnabled" /> {{ $t('adminQqAssistant.cmdShare') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.leaderboardEnabled" /> {{ $t('adminQqAssistant.cmdLeaderboard') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.myPrizeEnabled" /> {{ $t('adminQqAssistant.cmdMyPrize') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.helpEnabled" /> {{ $t('adminQqAssistant.cmdHelp') }}</label>
              </div>
            </fieldset>
          </div>
          <div v-if="inboundSecret" class="modal-body secret-box">
            <p class="secret-label">{{ $t('adminQqAssistant.inboundSecretLabel') }}</p>
            <div class="secret-value">{{ inboundSecret }}</div>
            <p class="secret-hint">{{ $t('adminQqAssistant.inboundSecretHint') }}</p>
            <pre class="config-value">{{ napcatInboundConfig }}</pre>
            <button class="btn btn-ghost btn-xs" type="button" @click="copyInboundConfig">{{ $t('adminQqAssistant.copyConfig') }}</button>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeModal" type="button">{{ $t('adminQqAssistant.cancel') }}</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveTarget">{{ $t('adminQqAssistant.save') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()

interface PlatformTarget {
  id: string
  tenantId: string
  platform: string
  targetId: string
  targetName: string
  activeDrawId: string
  assistantEnabled: number
  builtinCommandsJson: string
}

interface Draw {
  id: string
  title: string
  status: string
}

const loading = ref(false)
const loadError = ref('')
const targets = ref<PlatformTarget[]>([])
const draws = ref<Draw[]>([])
const selectedId = ref('')
const resettingId = ref('')
const saving = ref(false)
const showModal = ref(false)
const editingTarget = ref<PlatformTarget | null>(null)
const inboundSecret = ref('')

const form = ref({
  targetId: '',
  targetName: '',
  activeDrawId: '',
  adapterBaseUrl: '',
  inboundSecret: '',
  checkinEnabled: true,
  spinEnabled: true,
  shareEnabled: true,
  leaderboardEnabled: true,
  myPrizeEnabled: true,
  helpEnabled: true,
})

const napcatInboundConfig = computed(() => {
  const callbackUrl = `${window.location.origin}/api/platform/qq/message`
  return [
    `HTTP 上报地址: ${callbackUrl}`,
    `请求头 Authorization: Bearer ${inboundSecret.value}`,
    `请求头 X-CF-Lottery-Platform-Token: ${inboundSecret.value}`,
  ].join('\n')
})

async function api<T = Record<string, unknown>>(path: string, options?: RequestInit) {
  return adminRequest<T>(`/api/admin${path}`, options)
}

async function loadTargets() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await api<{ items: PlatformTarget[] }>('/platform-targets')
    targets.value = (data.items as PlatformTarget[]) || []
  } catch (err) {
    loadError.value = String(err instanceof Error ? err.message : err)
  } finally {
    loading.value = false
  }
}

async function loadDraws() {
  try {
    const data = await api<{ draws: Draw[] }>('/draws?limit=200')
    draws.value = data.draws || []
  } catch { /* 活动列表加载失败不影响主功能 */ }
}

function resetForm() {
  form.value = {
    targetId: '', targetName: '', activeDrawId: '', adapterBaseUrl: '', inboundSecret: '',
    checkinEnabled: true, spinEnabled: true, shareEnabled: true,
    leaderboardEnabled: true, myPrizeEnabled: true, helpEnabled: true,
  }
  inboundSecret.value = ''
  editingTarget.value = null
}

function fillFormFromTarget(t: PlatformTarget) {
  editingTarget.value = t
  form.value.targetId = t.targetId
  form.value.targetName = t.targetName
  form.value.activeDrawId = t.activeDrawId
  form.value.inboundSecret = ''
  try {
    const cmds = JSON.parse(t.builtinCommandsJson || '{}')
    form.value.checkinEnabled = cmds.checkinEnabled !== false
    form.value.spinEnabled = cmds.spinEnabled !== false
    form.value.shareEnabled = cmds.shareEnabled !== false
    form.value.leaderboardEnabled = cmds.leaderboardEnabled !== false
    form.value.myPrizeEnabled = cmds.myPrizeEnabled !== false
    form.value.helpEnabled = cmds.helpEnabled !== false
  } catch { /* 使用默认值 */ }
}

function openCreateModal() {
  resetForm()
  showModal.value = true
  void loadDraws()
}

function openEditModal(t: PlatformTarget) {
  resetForm()
  fillFormFromTarget(t)
  showModal.value = true
  void loadDraws()
}

function closeModal() { showModal.value = false }

async function saveTarget() {
  saving.value = true
  try {
    const builtinCommands = {
      checkinEnabled: form.value.checkinEnabled,
      spinEnabled: form.value.spinEnabled,
      shareEnabled: form.value.shareEnabled,
      leaderboardEnabled: form.value.leaderboardEnabled,
      myPrizeEnabled: form.value.myPrizeEnabled,
      helpEnabled: form.value.helpEnabled,
    }
    if (editingTarget.value) {
      /* 编辑时：baseUrl 留空则不更新 adapterConfig，填写则覆盖 */
      const editPayload: Record<string, unknown> = {
        targetName: form.value.targetName,
        activeDrawId: form.value.activeDrawId,
        builtinCommands,
      }
      const baseUrl = form.value.adapterBaseUrl.trim()
      if (baseUrl) editPayload.adapterConfig = { baseUrl }
      const newInboundSecret = form.value.inboundSecret.trim()
      if (newInboundSecret) editPayload.inboundSecret = newInboundSecret
      await api(`/platform-targets/${editingTarget.value.id}`, {
        method: 'PUT',
        body: JSON.stringify(editPayload),
      })
      showToast(t('adminQqAssistant.toastUpdated'), 'success')
    } else {
      const adapterConfig = form.value.adapterBaseUrl.trim()
        ? { baseUrl: form.value.adapterBaseUrl.trim() }
        : {}
      const data = await api<{ inboundSecret?: string }>('/platform-targets', {
        method: 'POST',
        body: JSON.stringify({ targetId: form.value.targetId, targetName: form.value.targetName, activeDrawId: form.value.activeDrawId, adapterConfig, ...builtinCommands }),
      })
      inboundSecret.value = String(data.inboundSecret || '')
      showToast(t('adminQqAssistant.toastCreated'), 'success')
    }
    if (!inboundSecret.value) closeModal()
    await loadTargets()
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { saving.value = false }
}
async function deleteTarget(target: PlatformTarget) {
  if (!confirm(t('adminQqAssistant.confirmDelete', { name: target.targetName || target.targetId }))) return
  try {
    await api(`/platform-targets/${target.id}`, { method: 'DELETE' })
    showToast(t('adminQqAssistant.toastDeleted'), 'success')
    await loadTargets()
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

async function toggleEnabled(target: PlatformTarget) {
  try {
    await api(`/platform-targets/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify({ assistantEnabled: !target.assistantEnabled }),
    })
    target.assistantEnabled = target.assistantEnabled ? 0 : 1
    showToast(t('adminQqAssistant.toastToggled'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

async function resetSecret(target: PlatformTarget) {
  resettingId.value = target.id
  try {
    const data = await api<{ inboundSecret?: string }>(`/platform-targets/${target.id}/reset-secret`, { method: 'POST' })
    inboundSecret.value = String(data.inboundSecret || '')
    fillFormFromTarget(target)
    showModal.value = true
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { resettingId.value = '' }
}

async function copyInboundConfig() {
  try {
    await navigator.clipboard.writeText(napcatInboundConfig.value)
    showToast(t('adminQqAssistant.toastCopied'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

onMounted(() => { void loadTargets() })
</script>

<style scoped>
.mono { font-family: monospace; font-size: 13px; }
.empty-row { text-align: center; color: #666; padding: 32px 16px; }
.qq-assistant-modal { max-width: 520px; }
.pointer { cursor: pointer; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--text, #e0e0e0); }
.form-input, .form-select, .form-textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border, #333); border-radius: 6px; background: var(--bg-input, #1a1a2e); color: var(--text, #e0e0e0); font-size: 13px; }
.form-textarea { resize: vertical; min-height: 60px; }
.form-hint { font-size: 11px; color: #888; margin-bottom: 4px; }
.form-fieldset { border: 1px solid var(--border, #333); border-radius: 6px; padding: 8px 12px; margin-top: 8px; }
.form-fieldset legend { font-size: 12px; font-weight: 600; padding: 0 4px; color: #999; }
.checkbox-group { display: flex; flex-wrap: wrap; gap: 8px; }
.checkbox-label { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
.secret-box { background: #1a2a1a; border: 1px solid #2a4a2a; border-radius: 6px; padding: 12px; margin: 8px 0; }
.secret-label { font-size: 12px; color: #4caf50; font-weight: 600; margin-bottom: 4px; }
.secret-value { font-family: monospace; font-size: 14px; padding: 8px; background: #0a1a0a; border-radius: 4px; word-break: break-all; user-select: all; }
.secret-hint { font-size: 11px; color: #888; margin-top: 4px; }
.required { color: #e53935; }
	</style>
