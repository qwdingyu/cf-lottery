<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" @click="showAdd = true">添加成员</button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>角色</th>
            <th>加入时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.userId">
            <td>{{ m.username }}</td>
            <td><span class="tag" :class="m.role === 'owner' ? 'tag-info' : 'tag-muted'">{{ m.role }}</span></td>
            <td>{{ formatDate(m.createdAt) }}</td>
            <td class="col-actions">
              <button
                v-if="m.role !== 'owner'"
                class="btn btn-ghost btn-xs"
                @click="handleRemove(m.userId)"
              >移除</button>
              <span v-else class="tag tag-muted">不可操作</span>
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="4" class="empty-text">暂无成员</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="showAdd" title="添加成员" max-width="480px">
      <form @submit.prevent="handleAdd">
        <div class="modal-form">
          <label>
            <span>用户名</span>
            <input v-model="formUsername" type="text" required placeholder="输入对方用户名" />
            <small class="field-hint">对方需要先注册账号</small>
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
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import AdminModal from '@/components/AdminModal.vue'

const { showToast } = useToast()
const members = ref<any[]>([])
const loading = ref(false)
const submitting = ref(false)
const showAdd = ref(false)
const formUsername = ref('')

async function adminRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const token = (() => { try { return localStorage.getItem('admin_token') || ''; } catch { return ''; } })();
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || `请求失败: ${res.status}`);
  return data as T;
}

async function loadData() {
  loading.value = true
  try {
    const data = await adminRequest<{ members: any[] }>('/api/admin/members')
    members.value = data.members || []
  } catch (err: any) {
    showToast(err.message || '加载失败', 'error')
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
    showToast('已添加', 'success')
    showAdd.value = false
    formUsername.value = ''
    await loadData()
  } catch (err: any) {
    showToast(err.message || '添加失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function handleRemove(userId: string) {
  try {
    await adminRequest(`/api/admin/members/${userId}`, { method: 'DELETE' })
    showToast('已移除', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '移除失败', 'error')
  }
}

onMounted(loadData)
</script>