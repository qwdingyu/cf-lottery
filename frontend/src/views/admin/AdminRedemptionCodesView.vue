<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="searchQuery" type="search" placeholder="搜索兑换码" @keyup.enter="loadData" />
        <select v-model="statusFilter" @change="loadData">
          <option value="">全部状态</option>
          <option value="active">有效</option>
          <option value="used">已使用</option>
          <option value="expired">已过期</option>
          <option value="disabled">已禁用</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadData">查询</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" @click="showBatch = true">批量生成</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="stat-card">
        <span class="stat-value">{{ stats.total }}</span>
        <span class="stat-label">总生成</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.active }}</span>
        <span class="stat-label">有效</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.used }}</span>
        <span class="stat-label">已使用</span>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
    </div>

    <!-- 兑换码列表 -->
    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>兑换码</th>
            <th>活动次数</th>
            <th>参与人数</th>
            <th>有效期</th>
            <th>状态</th>
            <th>使用次数</th>
            <th>备注</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="8"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="code in codes" :key="code.id">
            <td><code class="code-text">{{ code.code }}</code></td>
            <td>{{ code.activityQuota }}</td>
            <td>{{ code.participantQuota }}</td>
            <td>{{ formatDate(code.expiresAt) }}</td>
            <td><span class="tag" :class="statusClass(code.status)">{{ statusLabel(code.status) }}</span></td>
            <td>{{ code.usedCount }}/{{ code.maxUses }}</td>
            <td>{{ code.note || '-' }}</td>
            <td>{{ formatDate(code.createdAt) }}</td>
          </tr>
          <tr v-if="codes.length === 0">
            <td colspan="8" class="empty-text">暂无兑换码</td>
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

    <!-- 批量生成弹窗 -->
    <AdminModal v-model="showBatch" title="批量生成兑换码" max-width="560px">
      <form @submit.prevent="handleBatch">
        <div class="modal-form">
          <label>
            <span>生成数量</span>
            <input v-model.number="form.count" type="number" min="1" max="100" step="1" required />
            <small class="field-hint">一次最多生成 100 个</small>
          </label>
          <label>
            <span>赠送活动次数</span>
            <input v-model.number="form.activityQuota" type="number" min="0" max="9999" step="1" />
            <small class="field-hint">每个兑换码可创建的活动数量</small>
          </label>
          <label>
            <span>赠送参与人数</span>
            <input v-model.number="form.participantQuota" type="number" min="0" max="999999" step="1" />
            <small class="field-hint">每个兑换码可容纳的参与人数</small>
          </label>
          <label>
            <span>有效天数</span>
            <input v-model.number="form.durationDays" type="number" min="1" max="3650" step="1" />
          </label>
          <label>
            <span>备注</span>
            <input v-model="form.note" maxlength="200" placeholder="用于区分批次" />
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showBatch = false">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? '生成中…' : '生成' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 生成结果弹窗 -->
    <AdminModal v-model="showResult" title="生成成功" max-width="560px">
      <div class="modal-form">
        <p>已生成 <strong>{{ generatedCodes.length }}</strong> 个兑换码：</p>
        <textarea readonly :value="generatedCodes.join('\n')" rows="8" class="code-textarea" />
        <p class="field-hint">每个兑换码赠送 {{ form.activityQuota }} 次活动 + {{ form.participantQuota }} 人参与，有效期 {{ form.durationDays }} 天</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary btn-sm" @click="copyCodes">复制全部</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="showResult = false; showBatch = false; loadData()">关闭</button>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import AdminModal from '@/components/AdminModal.vue'
import AdminPagination from '@/components/AdminPagination.vue'
import { useTablePagination } from '@/composables/useTablePagination'
import { adminRequest } from '@/composables/useAdminRequest'

const { showToast } = useToast()
const codes = ref<any[]>([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const statusFilter = ref('')
const searchQuery = ref('')
const showBatch = ref(false)
const showResult = ref(false)
const generatedCodes = ref<string[]>([])
const pagination = useTablePagination({ initialLimit: 50 })

const stats = ref({ total: 0, active: 0, used: 0 })

const form = ref({
  count: 10,
  activityQuota: 5,
  participantQuota: 200,
  durationDays: 30,
  note: '',
})

function statusLabel(status: string): string {
  const map: Record<string,string> = { active:'有效', used:'已使用', expired:'已过期', disabled:'已禁用' }
  return map[status] || status
}
function statusClass(status: string): string {
  const map: Record<string,string> = { active:'tag-success', used:'tag-muted', expired:'tag-danger', disabled:'tag-muted' }
  return map[status] || 'tag-muted'
}

const PLATFORM_REDEMPTION_CODES_API = '/api/platform/redemption-codes'


async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams({ limit: String(pagination.limit.value), offset: String((pagination.page.value - 1) * pagination.limit.value) })
    if (statusFilter.value) params.set('status', statusFilter.value)
    if (searchQuery.value) params.set('search', searchQuery.value)
    const [data, statsData] = await Promise.all([
      adminRequest<{ codes: any[] }>(`${PLATFORM_REDEMPTION_CODES_API}?${params}`),
      adminRequest<any>(`${PLATFORM_REDEMPTION_CODES_API}/stats`),
    ])
    codes.value = data.codes || []
    stats.value = statsData
    pagination.setTotal(data.codes?.length === pagination.limit.value ? pagination.page.value * pagination.limit.value + 1 : (pagination.page.value - 1) * pagination.limit.value + (data.codes?.length || 0))
  } catch (err: any) {
    loadError.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function handleBatch() {
  if (form.value.activityQuota === 0 && form.value.participantQuota === 0) {
    showToast('活动次数和参与人数不能同时为 0', 'error')
    return
  }
  submitting.value = true
  try {
    const data = await adminRequest<any>(`${PLATFORM_REDEMPTION_CODES_API}/batch`, {
      method: 'POST',
      body: JSON.stringify(form.value),
    })
    generatedCodes.value = data.codes || []
    showResult.value = true
  } catch (err: any) {
    showToast(err.message || '生成失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function copyCodes() {
  try {
    await writeClipboardText(generatedCodes.value.join('\n'))
    showToast('已复制', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

onMounted(loadData)
</script>

<style scoped>
.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; margin-bottom: 12px; }
.stat-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px; background: var(--tg-secondary-bg, #151b28); border-radius: var(--r-lg, 12px); border: 1px solid var(--border, rgba(255,255,255,0.1)); }
.stat-value { font-size: 24px; font-weight: 700; color: var(--admin-accent, #f59e0b); }
.stat-label { font-size: 12px; color: var(--tg-hint, #9aa4b2); }
.code-text { font-family: monospace; font-size: 13px; letter-spacing: 1px; background: var(--tg-bg, #0a0e17); padding: 2px 6px; border-radius: 4px; }
.code-textarea { width: 100%; font-family: monospace; font-size: 13px; background: var(--tg-bg, #0a0e17); color: var(--tg-text, #f0f2f5); border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius: 8px; padding: 8px; }
</style>
