<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <div class="integration-tabs">
          <button class="btn btn-ghost btn-sm" :class="{ 'is-active': activeTab === 'webhooks' }" @click="activeTab = 'webhooks'">Webhook</button>
          <button class="btn btn-ghost btn-sm" :class="{ 'is-active': activeTab === 'apikeys' }" @click="activeTab = 'apikeys'">API 密钥</button>
        </div>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="openCreate">
          {{ activeTab === 'webhooks' ? '添加 Webhook' : '创建密钥' }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
    </div>

    <!-- Webhook 列表 -->
    <div v-if="activeTab === 'webhooks'" class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>URL</th>
            <th>事件</th>
            <th>状态</th>
            <th>最后发送</th>
            <th class="col-actions">操作</th>
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
              <span class="tag" :class="w.active ? 'tag-success' : 'tag-muted'">{{ w.active ? '启用' : '停用' }}</span>
              <small v-if="w.lastError" class="tag-danger" :title="w.lastError" style="display:block;font-size:10px">最近失败</small>
            </td>
            <td>{{ w.lastSentAt ? formatTime(w.lastSentAt) : '-' }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" @click="removeWebhook(w.id)">删除</button>
            </td>
          </tr>
          <tr v-if="webhooks.length === 0"><td colspan="5" class="empty-text">暂无 Webhook</td></tr>
        </tbody>
      </table>
    </div>

    <!-- API 密钥列表 -->
    <div v-else class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>密钥</th>
            <th>状态</th>
            <th>创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="5"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="k in apiKeys" :key="k.id">
            <td>{{ k.name }}</td>
            <td><code class="code-text">{{ k.prefix || maskKey(k.key) }}</code></td>
            <td><span class="tag" :class="k.active ? 'tag-success' : 'tag-muted'">{{ k.active ? '启用' : '停用' }}</span></td>
            <td>{{ formatTime(k.createdAt) }}</td>
            <td class="col-actions">
              <!-- 密钥以哈希存储，明文仅创建时展示一次，列表不可复制 -->
              <button class="btn btn-danger btn-xs" @click="removeApiKey(k.id)">删除</button>
            </td>
          </tr>
          <tr v-if="apiKeys.length === 0"><td colspan="5" class="empty-text">暂无 API 密钥</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 创建弹窗（Webhook / API Key） -->
    <AdminModal v-model="showCreate" :title="activeTab === 'webhooks' ? '添加 Webhook' : '创建 API 密钥'" max-width="520px">
      <form @submit.prevent="handleCreate">
        <div class="modal-form">
          <template v-if="activeTab === 'webhooks'">
            <label>
              <span>Webhook URL</span>
              <input v-model="webhookForm.url" required maxlength="500" placeholder="https://your-server.com/webhook" />
            </label>
            <label>
              <span>触发事件</span>
              <div class="event-checkboxes">
                <label v-for="ev in WEBHOOK_EVENTS" :key="ev.value" class="event-checkbox">
                  <input v-model="webhookForm.events" type="checkbox" :value="ev.value" />
                  <span>{{ ev.label }}</span>
                </label>
              </div>
            </label>
          </template>
          <template v-else>
            <label>
              <span>密钥名称</span>
              <input v-model="apiKeyForm.name" required maxlength="50" placeholder="如：外部转化回传" />
              <small class="field-hint">用于外部系统调用 /api/integration/* 接口</small>
            </label>
          </template>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreate = false">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">{{ submitting ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </AdminModal>

    <!-- 新密钥展示弹窗（仅创建时显示一次） -->
    <AdminModal v-model="showNewKey" title="密钥已创建" max-width="520px">
      <div class="modal-form">
        <p>请立即复制并妥善保存，密钥只显示这一次：</p>
        <textarea readonly :value="newKey" rows="2" class="code-textarea" @click="copyText(newKey)" />
        <p class="field-hint">点击上方文本框复制</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-sm" @click="copyText(newKey); showNewKey = false">已复制并关闭</button>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AdminModal from '@/components/AdminModal.vue'
import { useToast } from '@/composables/useToast'
import { adminRequest } from '@/composables/useAdminRequest'

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

const WEBHOOK_EVENTS = [
  { value: 'draw.completed', label: '开奖完成' },
  { value: 'prize.issued', label: '奖品发放' },
  { value: 'entry.created', label: '新参与' },
]

function parseEvents(raw: any): string[] {
  try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]') } catch { return [] }
}

function truncate(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) + '…' : text
}

/** 列表仅展示服务端 prefix；兼容旧字段时兜底（不应再收到完整 hash） */
function maskKey(key: string): string {
  if (!key) return '-'
  if (key.startsWith('cl_')) return key.length > 12 ? `${key.slice(0, 10)}…` : key
  return 'cl_••••••••'
}

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

function copyText(text: string) {
  if (text) { navigator.clipboard.writeText(text).catch(() => {}); showToast('已复制', 'success') }
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
    loadError.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function openCreate() { showCreate.value = true }

async function handleCreate() {
  submitting.value = true
  try {
    if (activeTab.value === 'webhooks') {
      if (!webhookForm.value.url.trim()) { showToast('请输入 URL', 'error'); return }
      await adminRequest('/api/admin/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: webhookForm.value.url.trim(), events: webhookForm.value.events }),
      })
      showToast('Webhook 已添加', 'success')
      webhookForm.value = { url: '', events: [] }
    } else {
      if (!apiKeyForm.value.name.trim()) { showToast('请输入密钥名称', 'error'); return }
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
    showToast(err.message || '保存失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function removeWebhook(id: string) {
  if (!window.confirm('确认删除该 Webhook？')) return
  try {
    await adminRequest(`/api/admin/webhooks/${id}`, { method: 'DELETE' })
    showToast('已删除', 'success')
    await loadData()
  } catch (err: any) { showToast(err.message || '删除失败', 'error') }
}

async function removeApiKey(id: string) {
  if (!window.confirm('确认删除该密钥？')) return
  try {
    await adminRequest(`/api/admin/api-keys/${id}`, { method: 'DELETE' })
    showToast('已删除', 'success')
    await loadData()
  } catch (err: any) { showToast(err.message || '删除失败', 'error') }
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