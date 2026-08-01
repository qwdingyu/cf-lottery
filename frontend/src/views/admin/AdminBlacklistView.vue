<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="showAdd = true">添加黑名单</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
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
                {{ operatingId === item.id ? '删除中…' : '删除' }}
              </button>
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
import { adminRequest } from '@/composables/useAdminRequest'

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
    loadError.value = err.message || '加载失败'
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
  if (operatingId.value) return
  operatingId.value = id
  try {
    await adminRequest(`/api/admin/blacklist/${id}`, { method: 'DELETE' })
    showToast('已删除', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '删除失败', 'error')
  } finally {
    operatingId.value = ''
  }
}

onMounted(loadData)
</script>