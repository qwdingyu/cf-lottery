<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.tenantId" type="search" placeholder="租户 ID" @keyup.enter="loadData" />
        <input v-model="filter.action" type="search" placeholder="操作类型" @keyup.enter="loadData" />
        <button class="btn btn-primary btn-sm" @click="loadData">查询</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="error" class="table-error" role="alert">
      <span>{{ error }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>租户</th>
            <th>操作人</th>
            <th>操作</th>
            <th>目标类型</th>
            <th>目标 ID</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td class="time-cell">{{ formatTime(log.createdAt) }}</td>
            <td><code class="code-id">{{ log.tenantId?.slice(0, 8) }}…</code></td>
            <td><code class="code-id">{{ log.actorUserId?.slice(0, 8) }}…</code></td>
            <td><span class="tag tag-info">{{ log.action }}</span></td>
            <td>{{ log.targetType }}</td>
            <td><code class="code-id">{{ log.targetId?.slice(0, 12) }}…</code></td>
          </tr>
          <tr v-if="logs.length === 0">
            <td colspan="6" class="empty-text">暂无审计日志</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pagination">
      <button class="btn btn-ghost btn-sm" :disabled="offset <= 0" @click="prevPage">上一页</button>
      <span class="pagination-info">第 {{ page }} 页</span>
      <button class="btn btn-ghost btn-sm" :disabled="logs.length < limit" @click="nextPage">下一页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const loading = ref(false)
const error = ref('')
const logs = ref<any[]>([])
const limit = 50
const offset = ref(0)
const filter = ref({ tenantId: '', action: '' })

const page = computed(() => Math.floor(offset.value / limit) + 1)

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

async function adminFetch<T>(path: string): Promise<T> {
  const token = localStorage.getItem('admin_token') || ''
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json()
  if (!data.ok) throw new Error(data.message || '请求失败')
  return data as T
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset.value) })
    if (filter.value.tenantId) params.set('tenantId', filter.value.tenantId)
    if (filter.value.action) params.set('action', filter.value.action)
    const data = await adminFetch<{ logs: any[] }>(`/api/platform/audit-logs?${params}`)
    logs.value = data.logs || []
  } catch (err: any) {
    error.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function prevPage() { offset.value = Math.max(0, offset.value - limit); loadData() }
function nextPage() { offset.value += limit; loadData() }
</script>

<style scoped>
.time-cell { white-space: nowrap; font-size: 12px; }
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 16px 0; }
.pagination-info { font-size: 13px; color: var(--tg-hint, #9aa4b2); }
</style>