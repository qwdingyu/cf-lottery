<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="showAdd = true">添加成员</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
    </div>

    <div class="table-wrap" role="region" aria-label="平台成员" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>用户 ID</th>
            <th>角色</th>
            <th>状态</th>
            <th>加入时间</th>
            <th class="col-actions">操作</th>
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
                {{ m.status === 'active' ? '正常' : '已禁用' }}
              </span>
            </td>
            <td>{{ formatTime(m.createdAt) }}</td>
            <td class="col-actions">
              <button
                v-if="m.userId !== myUserId"
                class="btn btn-ghost btn-xs"
                :disabled="operatingId === m.userId"
                @click="toggleStatus(m)"
              >{{ m.status === 'active' ? '禁用' : '启用' }}</button>
              <button
                v-if="m.userId !== myUserId"
                class="btn btn-danger btn-xs"
                :disabled="operatingId === m.userId"
                @click="handleRemove(m)"
              >移除</button>
              <span v-else class="tag tag-muted">当前用户</span>
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="5" class="empty-text">暂无平台成员</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="showAdd" title="添加平台成员" max-width="480px">
      <form @submit.prevent="handleAdd">
        <div class="modal-form">
          <label>
            <span>用户名或邮箱</span>
            <input v-model="formKey" required maxlength="120" placeholder="输入已注册的用户名或邮箱" />
            <small class="field-hint">用户必须已注册，才能加入平台运营团队</small>
          </label>
          <label>
            <span>角色</span>
            <select v-model="formRole">
              <option value="platform_operator">Operator（查看租户/发行兑换码）</option>
              <option value="platform_owner">Owner（全部管理权限）</option>
              <option value="platform_support">Support（只读支持）</option>
            </select>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showAdd = false">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? '添加中…' : '添加' }}
          </button>
        </div>
      </form>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AdminModal from '@/components/AdminModal.vue'
import { useToast } from '@/composables/useToast'
import { readAdminToken } from '@/composables/useAdminAuth'
import { adminRequest } from '@/composables/useAdminRequest'

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
  try { return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) }
  catch { return iso }
}

function copyText(text: string) {
  if (text) navigator.clipboard.writeText(text).catch(() => {})
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    // 解析当前用户 ID（JWT payload，用于标记"当前用户"不可操作）
    try {
      const token = readAdminToken()
      const payload = JSON.parse(atob(token.split('.')[1]))
      myUserId.value = payload.sub || ''
    } catch { /* 忽略 */ }
    const data = await adminRequest<{ members: any[] }>('/api/platform/members')
    members.value = data.members || []
  } catch (err: any) {
    loadError.value = err.message || '加载失败'
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
    showToast('成员已添加', 'success')
    showAdd.value = false
    formKey.value = ''
    await loadData()
  } catch (err: any) {
    showToast(err.message || '添加失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function updateRole(m: any, role: string) {
  if (operatingId.value || role === m.role) return
  operatingId.value = m.userId
  try {
    await adminRequest(`/api/platform/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify({ role }) })
    showToast('角色已更新', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '更新失败', 'error')
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
    showToast(status === 'active' ? '已启用' : '已禁用', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '操作失败', 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleRemove(m: any) {
  if (operatingId.value) return
  if (!window.confirm(`确认移除平台成员 ${m.userId.slice(0, 10)}…？`)) return
  operatingId.value = m.userId
  try {
    await adminRequest(`/api/platform/members/${m.userId}`, { method: 'DELETE' })
    showToast('已移除', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '移除失败', 'error')
  } finally {
    operatingId.value = ''
  }
}

onMounted(loadData)
</script>

<style scoped>
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
</style>