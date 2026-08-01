<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" @change="searchData">
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="suspended">已暂停</option>
          <option value="disabled">已禁用</option>
        </select>
        <select v-model="filter.plan" @change="searchData">
          <option value="">全部套餐</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
          <option value="enterprise">Enterprise</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? '查询中…' : '查询' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
    </div>

    <div class="table-wrap" role="region" aria-label="租户列表" :aria-busy="loading">
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
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="7"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
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
            <td class="time-cell">{{ formatTime(t.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" @click="showDetail(t)">详情</button>
              <button class="btn btn-ghost btn-xs" :title="'复制租户 ID'" @click="copyId(t.id)">复制 ID</button>
            </td>
          </tr>
          <tr v-if="tenants.length === 0">
            <td colspan="8" class="empty-text">暂无租户</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      v-if="pagination.total.value > 0"
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <AdminModal v-model="showDetailModal" :title="'租户详情 - ' + (detailTenant?.name || '')" max-width="640px">
      <div v-if="detailLoading" class="empty-text">加载中…</div>
      <div v-else-if="detailTenant" class="detail-grid">
        <div class="detail-row">
          <span class="detail-label">租户 ID</span>
          <span class="detail-value"><code>{{ detailTenant.id }}</code></span>
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

        <!-- 套餐调整（仅平台 owner 可见的操作区） -->
        <div class="detail-actions">
          <h4 class="detail-actions-title">套餐调整</h4>
          <div class="adjust-row">
            <select v-model="adjustForm.plan" :disabled="adjusting">
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="team">Team</option>
              <option value="enterprise">Enterprise</option>
            </select>
            <select v-model="adjustForm.status" :disabled="adjusting">
              <option value="active">正常</option>
              <option value="suspended">暂停</option>
              <option value="disabled">禁用</option>
            </select>
            <button class="btn btn-primary btn-sm" :disabled="adjusting" @click="handleAdjust">
              {{ adjusting ? '保存中…' : '保存调整' }}
            </button>
          </div>
          <div class="adjust-row">
            <input v-model.number="adjustForm.extraActivityQuota" type="number" min="1" step="1" placeholder="追加活动次数" :disabled="adjusting" />
            <input v-model.number="adjustForm.extraParticipantQuota" type="number" min="1" step="1" placeholder="追加参与人数" :disabled="adjusting" />
          </div>
          <small class="field-hint">套餐和状态即时生效；额外额度为追加（累加）</small>
        </div>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AdminModal from '@/components/AdminModal.vue'
import AdminPagination from '@/components/AdminPagination.vue'
import { adminRequest } from '@/composables/useAdminRequest'
import { useTablePagination } from '@/composables/useTablePagination'

const loading = ref(false)
const loadError = ref('')
const tenants = ref<any[]>([])
const usageMap = ref<Record<string, any>>({})

const filter = ref({ status: '', plan: '' })
const pagination = useTablePagination({ initialLimit: 50 })


function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

function copyId(id: string) {
  navigator.clipboard.writeText(id).catch(() => {})
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams({ limit: String(pagination.limit.value), offset: String((pagination.page.value - 1) * pagination.limit.value) })
    if (filter.value.status) params.set('status', filter.value.status)
    if (filter.value.plan) params.set('plan', filter.value.plan)
    const data = await adminRequest<{ tenants: any[] }>(`/api/platform/tenants?${params}`)
    tenants.value = data.tenants || []
    pagination.setTotal(data.tenants?.length === pagination.limit.value ? pagination.page.value * pagination.limit.value + 1 : (pagination.page.value - 1) * pagination.limit.value + (data.tenants?.length || 0))
    // 并行加载用量摘要
    await Promise.all(tenants.value.map(async (t) => {
      try {
        const summary = await adminRequest<{ usage: any }>(`/api/platform/tenants/${t.id}/summary`)
        usageMap.value[t.id] = summary.usage || {}
      } catch { /* 忽略 */ }
    }))
  } catch (err: any) {
    loadError.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function searchData() { pagination.setPage(1); loadData() }

// ── 详情弹窗 ──
const showDetailModal = ref(false)
const detailTenant = ref<any>(null)
const detailUsage = ref<any>(null)
const detailLoading = ref(false)

async function showDetail(t: any) {
  detailTenant.value = t
  detailUsage.value = null
  // 初始化调整表单
  adjustForm.value = { plan: t.plan || 'free', status: t.status || 'active', extraActivityQuota: 0, extraParticipantQuota: 0 }
  showDetailModal.value = true
  detailLoading.value = true
  try {
    const data = await adminRequest<{ usage: any }>(`/api/platform/tenants/${t.id}/summary`)
    detailUsage.value = data.usage
  } catch { /* 忽略 */ }
  detailLoading.value = false
}

// ── 套餐调整 ──
const adjustForm = ref({ plan: 'free', status: 'active', extraActivityQuota: 0, extraParticipantQuota: 0 })
const adjusting = ref(false)

async function handleAdjust() {
  if (!detailTenant.value || adjusting.value) return
  adjusting.value = true
  try {
    const body: Record<string, unknown> = { plan: adjustForm.value.plan, status: adjustForm.value.status }
    if (adjustForm.value.extraActivityQuota > 0) body.extraActivityQuota = adjustForm.value.extraActivityQuota
    if (adjustForm.value.extraParticipantQuota > 0) body.extraParticipantQuota = adjustForm.value.extraParticipantQuota
    await adminRequest(`/api/platform/tenants/${detailTenant.value.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    showDetailModal.value = false
    await loadData()
  } catch (err: any) {
    loadError.value = err.message || '调整失败'
  } finally {
    adjusting.value = false
  }
}
</script>

<style scoped>
.detail-grid { display: flex; flex-direction: column; gap: 12px; }
.detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border, rgba(255,255,255,0.1)); }
.detail-label { font-size: 13px; color: var(--tg-hint, #9aa4b2); }
.detail-value { font-size: 13px; font-weight: 500; }
.time-cell { white-space: nowrap; font-size: 12px; }
.detail-actions { border-top: 1px solid var(--border, rgba(255,255,255,0.1)); padding-top: 12px; }
.detail-actions-title { font-size: 14px; margin-bottom: 8px; }
.adjust-row { display: flex; gap: 8px; margin-bottom: 8px; }
.adjust-row select, .adjust-row input { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(255,255,255,0.1)); background: var(--tg-bg, #1f2937); color: var(--tg-text, #f3f4f6); }
</style>
