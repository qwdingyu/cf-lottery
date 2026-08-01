<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" @click="showAdd = true">添加黑名单</button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>邮箱</th>
            <th>备注</th>
            <th>添加时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>{{ item.identityValue }}</td>
            <td>{{ item.note || '-' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" @click="handleRemove(item.id)">删除</button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="4" class="empty-text">暂无黑名单</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="showAdd" title="添加黑名单" max-width="480px">
      <form @submit.prevent="handleAdd">
        <div class="modal-form">
          <label>
            <span>邮箱地址</span>
            <input v-model="formEmail" type="email" required placeholder="user@example.com" />
          </label>
          <label>
            <span>备注（可选）</span>
            <input v-model="formNote" maxlength="200" placeholder="添加原因" />
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
const items = ref<any[]>([])
const loading = ref(false)
const submitting = ref(false)
const showAdd = ref(false)
const formEmail = ref('')
const formNote = ref('')

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
    const data = await adminRequest<{ items: any[] }>('/api/admin/blacklist')
    items.value = data.items || []
  } catch (err: any) {
    showToast(err.message || '加载失败', 'error')
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!formEmail.value.includes('@')) {
    showToast('请输入有效的邮箱地址', 'error')
    return
  }
  submitting.value = true
  try {
    await adminRequest('/api/admin/blacklist', {
      method: 'POST',
      body: JSON.stringify({ identityValue: formEmail.value.trim(), note: formNote.value.trim() }),
    })
    showToast('已添加', 'success')
    showAdd.value = false
    formEmail.value = ''
    formNote.value = ''
    await loadData()
  } catch (err: any) {
    showToast(err.message || '添加失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function handleRemove(id: string) {
  try {
    await adminRequest(`/api/admin/blacklist/${id}`, { method: 'DELETE' })
    showToast('已删除', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '删除失败', 'error')
  }
}

onMounted(loadData)
</script>