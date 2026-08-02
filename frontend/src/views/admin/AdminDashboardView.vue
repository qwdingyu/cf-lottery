<template>
  <div class="admin-page">
    <div class="stats-row">
      <div class="stat-card">
        <span class="stat-value">{{ stats.open }}</span>
        <span class="stat-label">{{ $t('adminDashboard.active') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.draft }}</span>
        <span class="stat-label">{{ $t('adminDashboard.draft') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.drawn }}</span>
        <span class="stat-label">{{ $t('adminDashboard.drawn') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.recentParticipants }}</span>
        <span class="stat-label">{{ $t('adminDashboard.recentParticipants') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ stats.totalWinners }}</span>
        <span class="stat-label">{{ $t('adminDashboard.totalWinners') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ planLabel }}</span>
        <span class="stat-label">{{ $t('adminDashboard.currentPlan') }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">{{ quotaText }}</span>
        <span class="stat-label">{{ $t('adminDashboard.activityQuota') }}</span>
      </div>
      <!-- 参与人数用量：后台低频概览允许展示租户级累计 COUNT。
           因 Turso rows read 和请求延迟约束，公开热路径不做租户级实时 COUNT。
           未来强额度/账单通过快照表（定时任务预聚合）自动填充。
           详见 docs/023_Cloudflare免费版与Turso约束下认证和运行安全方案_2026-08-01.md -->
      <div class="stat-card">
        <span class="stat-value">{{ participantQuotaText }}</span>
        <span class="stat-label">{{ $t('adminDashboard.participantQuota') }}</span>
      </div>
    </div>

    <!-- 待办事项：提示运营者需要处理的事项 -->
    <div v-if="hasTodos" class="todo-panel" role="region" aria-label="待办事项">
      <div class="todo-panel-title">📋 待办事项</div>
      <div class="todo-items">
        <RouterLink v-if="todos.dueDraws > 0" to="/admin/draws" class="todo-item">
          <span class="todo-badge">{{ todos.dueDraws }}</span>
          <span>个定时活动到期待开奖</span>
          <span class="todo-arrow">→</span>
        </RouterLink>
        <RouterLink v-if="todos.failedNotifications > 0" to="/admin/draws" class="todo-item">
          <span class="todo-badge todo-badge-danger">{{ todos.failedNotifications }}</span>
          <span>个中奖通知发送失败</span>
          <span class="todo-arrow">→</span>
        </RouterLink>
      </div>
    </div>

    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-primary btn-sm" type="button" @click="router.push('/admin/draws')">
          {{ $t('adminDashboard.manageActivities') }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" @click="loadData">
          {{ $t('adminDashboard.refresh') }}
        </button>
      </div>
    </div>

    <div v-if="recentDraws.length === 0" class="section">
      <div class="empty-onboard">
        <p>还没有活动？从模板开始，3 分钟搭建第一个活动。</p>
        <button class="btn btn-primary" type="button" @click="router.push('/admin/draws?new=true')">
          选择模板创建活动
        </button>
      </div>
    </div>

    <div v-if="recentDraws.length > 0" class="section">
      <h3 class="section-title">{{ $t('adminDashboard.recentActivities') }}</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>{{ $t('adminDashboard.colName') }}</th>
              <th>{{ $t('adminDashboard.colStatus') }}</th>
              <th>{{ $t('adminDashboard.colParticipants') }}</th>
              <th>{{ $t('adminDashboard.colCreatedAt') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="draw in recentDraws" :key="draw.id" class="clickable-row" @click="router.push('/admin/draws')">
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
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import { adminRequest } from '@/composables/useAdminRequest'

const router = useRouter()
const { t } = useI18n()
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
/** 待办事项（待开奖/通知失败） */
const todos = ref({ dueDraws: 0, failedNotifications: 0 })
const hasTodos = computed(() => todos.value.dueDraws > 0 || todos.value.failedNotifications > 0)

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
  const map: Record<string,string> = {
    draft: t('adminDashboard.draft'),
    open: t('adminDashboard.active'),
    paused: t('lottery.statusPaused'),
    drawing: t('lottery.statusDrawing'),
    drawn: t('adminDashboard.drawn'),
    cancelled: t('lottery.adminDrawCancelled'),
  };
  return map[status] || status;
}
function statusClass(status: string): string {
  const map: Record<string,string> = { draft:'tag-draft', open:'tag-success', paused:'tag-muted', drawing:'tag-warning', drawn:'tag-info', cancelled:'tag-danger' };
  return map[status] || 'tag-muted';
}


async function loadData() {
  try {
    // 并行加载统计数据 + 待办事项（dashboard 端点返回待开奖/通知失败数）
    const [statsData, drawsData, dashboardData] = await Promise.all([
      adminRequest<any>('/api/admin/stats'),
      adminRequest<{ draws: any[] }>('/api/admin/draws'),
      adminRequest<any>('/api/admin/dashboard').catch(() => null),
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
    // 待办事项（dashboard 端点提供）
    todos.value = {
      dueDraws: dashboardData?.dueCount ?? 0,
      failedNotifications: dashboardData?.failedNotifyCount ?? 0,
    }
  } catch (err: any) {
    showToast(err.message || '加载失败', 'error')
  }
}

onMounted(loadData)
</script>

<style scoped>
/* 待办事项面板 */
.todo-panel { margin: 12px 0; padding: 12px 16px; background: var(--tg-secondary-bg, #151b28); border-radius: var(--r-lg, 12px); border: 1px solid var(--border, rgba(255,255,255,0.1)); }
.todo-panel-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.todo-items { display: flex; flex-direction: column; gap: 6px; }
.todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); color: var(--tg-text, #f0f2f5); font-size: 13px; text-decoration: none; transition: background 0.15s; }
.todo-item:hover { background: rgba(245,158,11,0.15); }
.todo-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: var(--admin-accent, #f59e0b); color: #fff; font-size: 12px; font-weight: 700; }
.todo-badge-danger { background: #ef4444; }
.todo-arrow { margin-left: auto; color: var(--tg-hint, #9aa4b2); }

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
