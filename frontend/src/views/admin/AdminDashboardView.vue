<template>
  <div class="admin-page">
    <div class="stats-row">
      <div class="stat-card">
        <span class="stat-value">{{ stats.open }}</span>
        <span class="stat-label">进行中</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.draft }}</span>
        <span class="stat-label">草稿</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.drawn }}</span>
        <span class="stat-label">已开奖</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.recentParticipants }}</span>
        <span class="stat-label">近 7 天参与</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.totalWinners }}</span>
        <span class="stat-label">累计中奖</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ planLabel }}</span>
        <span class="stat-label">当前套餐</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ quotaText }}</span>
        <span class="stat-label">活动用量</span>
      </div>
      <!-- 参与人数用量：后台低频概览允许展示租户级累计 COUNT。
           因 Turso rows read 和请求延迟约束，公开热路径不做租户级实时 COUNT。
           未来强额度/账单通过快照表（定时任务预聚合）自动填充。
           详见 docs/023_Cloudflare免费版与Turso约束下认证和运行安全方案_2026-08-01.md -->
      <div class="stat-card">
        <span class="stat-value">{{ participantQuotaText }}</span>
        <span class="stat-label">参与人数用量</span>
      </div>
    </div>

    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-primary btn-sm" type="button" @click="router.push('/admin/draws')">
          管理活动
        </button>
        <button class="btn btn-ghost btn-sm" type="button" @click="loadData">
          刷新
        </button>
      </div>
    </div>

    <div v-if="recentDraws.length > 0" class="section">
      <h3 class="section-title">最近活动</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>参与人数</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="draw in recentDraws" :key="draw.id">
              <td>{{ draw.title }}</td>
              <td><span class="tag" :class="statusClass(draw.status)">{{ statusLabel(draw.status) }}</span></td>
              <td>{{ draw.entryCount || 0 }}</td>
              <td>{{ formatDate(draw.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'

const router = useRouter()
const { showToast } = useToast()

const stats = ref({
  open: 0,
  draft: 0,
  drawn: 0,
  recentParticipants: 0,
  totalWinners: 0,
  plan: 'free',
  activityUsage: 0,
  activityLimit: 10 as number | null,
  participantUsage: 0,
  participantLimit: null as number | null,
})
const recentDraws = ref<any[]>([])

const planLabelMap: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
}
const planLabel = computed(() => planLabelMap[stats.value.plan] || stats.value.plan)
const quotaText = computed(() =>
  stats.value.activityLimit === null
    ? `${stats.value.activityUsage} / ∞`
    : `${stats.value.activityUsage} / ${stats.value.activityLimit}`,
)
const participantQuotaText = computed(() =>
  stats.value.participantLimit === null
    ? `${stats.value.participantUsage} / ∞`
    : `${stats.value.participantUsage} / ${stats.value.participantLimit}`,
)

function statusLabel(status: string): string {
  const map: Record<string,string> = { draft:'草稿', open:'进行中', paused:'已暂停', drawing:'开奖中', drawn:'已开奖', cancelled:'已取消' };
  return map[status] || status;
}
function statusClass(status: string): string {
  const map: Record<string,string> = { draft:'tag-draft', open:'tag-success', paused:'tag-muted', drawing:'tag-warning', drawn:'tag-info', cancelled:'tag-danger' };
  return map[status] || 'tag-muted';
}

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
  try {
    // 并行加载统计数据
    const [statsData, drawsData] = await Promise.all([
      adminRequest<any>('/api/admin/stats'),
      adminRequest<{ draws: any[] }>('/api/admin/draws'),
    ])
    const draws = drawsData.draws || []
    recentDraws.value = draws.slice(0, 10)
    stats.value = {
      open: statsData.openDraws ?? draws.filter((d: any) => d.status === 'open').length,
      draft: statsData.totalDraws - statsData.openDraws - statsData.drawnDraws,
      drawn: statsData.drawnDraws ?? 0,
      recentParticipants: statsData.recentParticipants ?? 0,
      totalWinners: statsData.totalWinners ?? 0,
      plan: statsData.plan || 'free',
      activityUsage: statsData.usage?.activities ?? statsData.totalDraws ?? 0,
      activityLimit: statsData.limits?.maxActivities ?? null,
      // 后台概览是低频查询，可以显示租户累计参与人数；真正的额度强约束仍等待快照/计数器。
      participantUsage: statsData.usage?.participants ?? statsData.totalParticipants ?? 0,
      participantLimit: statsData.limits?.maxTotalParticipants ?? null,
    }
  } catch (err: any) {
    showToast(err.message || '加载失败', 'error')
  }
}

onMounted(loadData)
</script>

<style scoped>
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px;
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--admin-accent, #f59e0b);
}
.stat-label {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}
.section {
  margin-top: 8px;
}
.section-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
</style>
