<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status">
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="suspended">已暂停</option>
          <option value="disabled">已禁用</option>
        </select>
        <select v-model="filter.plan">
          <option value="">全部套餐</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
          <option value="enterprise">Enterprise</option>
        </select>
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
            <th>租户名称</th>
            <th>套餐</th>
            <th>状态</th>
            <th>活动数</th>
            <th>参与人数</th>
            <th>创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tenants" :key="t.id">
            <td>{{ t.name }}</td>
            <td><span class="tag tag-info">{{ t.plan }}</span></td>
            <td>
              <span class="tag" :class="t.status === 'active' ? 'tag-success' : 'tag-danger'">
                {{ t.status === 'active' ? '正常' : t.status === 'suspended' ? '已暂停' : '已禁用' }}
              </span>
            </td>
            <td>{{ usageMap[t.id]?.activities ?? '-' }}</td>
            <td>{{ usageMap[t.id]?.participants ?? '-' }}</td>
            <td>{{ formatTime(t.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" @click="showDetail(t)">详情</button>
            </td>
          </tr>
          <tr v-if="tenants.length === 0">
            <td colspan="7" class="empty-text">暂无租户</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pagination">
      <button class="btn btn-ghost btn-sm" :disabled="offset <= 0" @click="prevPage">上一页</button>
      <span class="pagination-info">第 {{ page }} 页</span>
      <button class="btn btn-ghost btn-sm" :disabled="tenants.length < limit" @click="nextPage">下一页</button>
    </div>

    <!-- 租户详情弹窗 -->
    <AdminModal v-model="showDetailModal" :title="'租户详情 - ' + (detailTenant?.name || '')" max-width="640px">
      <div v-if="detailLoading" class="empty-text">加载中…</div>
      <div v-else-if="detailTenant" class="detail-grid">
        <div class="detail-row">
          <span class="detail-label">租户 ID</span>
          <span class="detail-value">{{ detailTenant.id }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">套餐</span>
          <span class="detail-value">{{ detailTenant.plan }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">状态</span>
          <span class="detail-value">{{ detailTenant.status }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">创建时间</span>
          <span class="detail-value">{{ formatTime(detailTenant.createdAt) }}</span>
        </div>
        <div class="detail-row" v-if="detailUsage">
          <span class="detail-label">活动数</span>
          <span class="detail-value">{{ detailUsage.activities }}</span>
        </div>
        <div class="detail-row" v-if="detailUsage">
          <span class="detail-label">参与人数</span>
          <span class="detail-value">{{ detailUsage.participants ?? '暂无快照' }}</span>
        </div>
        <div class="detail-row" v-if="detailUsage">
          <span class="detail-label">事件数</span>
          <span class="detail-value">{{ detailUsage.events ?? '暂无快照' }}</span>
        </div>
        <div class="detail-row" v-if="detailUsage">
          <span class="detail-label">快照日期</span>
          <span class="detail-value">{{ detailUsage.snapshotDate ?? '无快照' }}</span>
        </div>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import AdminModal from '@/components/AdminModal.vue'

const loading = ref(false)
const error = ref('')
const tenants = ref<any[]>([])
const limit = 50
const offset = ref(0)
const usageMap = ref<Record<string, any>>({})

const filter = ref({ status: '', plan: '' })

const page = computed(() => Math.floor(offset.value / limit) + 1)

/** 格式化时间 */
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
    if (filter.value.status) params.set('status', filter.value.status)
    if (filter.value.plan) params.set('plan', filter.value.plan)
    const data = await adminFetch<{ tenants: any[] }>(`/api/platform/tenants?${params}`)
    tenants.value = data.tenants || []
    // 加载租户用量摘要
    for (const t of tenants.value) {
      try {
        const summary = await adminFetch<{ usage: any }>(`/api/platform/tenants/${t.id}/summary`)
        usageMap.value[t.id] = summary.usage || {}
      } catch { /* 单个租户加载失败不影响列表 */ }
    }
  } catch (err: any) {
    error.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function prevPage() { offset.value = Math.max(0, offset.value - limit); loadData() }
function nextPage() { offset.value += limit; loadData() }

// ── 详情弹窗 ──
const showDetailModal = ref(false)
const detailTenant = ref<any>(null)
const detailUsage = ref<any>(null)
const detailLoading = ref(false)

async function showDetail(t: any) {
  detailTenant.value = t
  detailUsage.value = null
  showDetailModal.value = true
  detailLoading.value = true
  try {
    const data = await adminFetch<{ usage: any }>(`/api/platform/tenants/${t.id}/summary`)
    detailUsage.value = data.usage
  } catch { /* 忽略 */ }
  detailLoading.value = false
}
</script>

<style scoped>
.detail-grid { display: flex; flex-direction: column; gap: 12px; }
.detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border, rgba(255,255,255,0.1)); }
.detail-label { font-size: 13px; color: var(--tg-hint, #9aa4b2); }
.detail-value { font-size: 13px; font-weight: 500; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 16px 0; }
.pagination-info { font-size: 13px; color: var(--tg-hint, #9aa4b2); }
</style>