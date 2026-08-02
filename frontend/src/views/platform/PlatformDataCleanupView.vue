<template>
  <div class="admin-page">
    <h3>数据清理</h3>
    <p class="field-hint" style="margin-bottom:16px">清理临时数据和日志，用于重置测试环境或释放 Turso 免费层存储。</p>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" @click="loadStats">重试</button>
    </div>

    <div class="stats-grid" style="margin-bottom:24px">
      <div v-for="(count, table) in stats" :key="table" class="stat-chip" :class="{ 'stat-zero': count === 0 }">
        <span class="stat-chip-name">{{ table }}</span>
        <span class="stat-chip-count">{{ count === -1 ? 'N/A' : count }}</span>
      </div>
    </div>

    <div class="cleanup-actions">
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadStats">刷新统计</button>
      <button class="btn btn-danger btn-sm" :disabled="cleaning" @click="cleanTargets(['email_access_codes', 'rate_limit_log', 'audit_logs', 'platform_audit_logs', 'activity_events'])">
        {{ cleaning ? '清理中...' : '清理日志/验证码/事件' }}
      </button>
    </div>

    <p v-if="cleanResult" class="field-hint" style="margin-top:8px">{{ cleanResult }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminRequest } from '@/composables/useAdminRequest'

const stats = ref<Record<string, number>>({})
const loading = ref(false)
const cleaning = ref(false)
const loadError = ref('')
const cleanResult = ref('')

async function loadStats() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ stats: Record<string, number> }>('/api/platform/data/stats')
    stats.value = data.stats
  } catch (err: any) {
    loadError.value = err?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function cleanTargets(targets: string[]) {
  cleaning.value = true
  cleanResult.value = ''
  try {
    const data = await adminRequest<{ results: Record<string, number> }>('/api/platform/data/cleanup', {
      method: 'POST',
      body: JSON.stringify({ targets }),
    })
    const parts = Object.entries(data.results).map(([k, v]) => `${k}: ${v} 行`)
    cleanResult.value = `已清理：${parts.join('，')}`
    await loadStats()
  } catch (err: any) {
    cleanResult.value = '清理失败: ' + (err?.message || '未知错误')
  } finally {
    cleaning.value = false
  }
}

onMounted(loadStats)
</script>

<style scoped>
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px;
}
.stat-chip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: var(--color-bg-secondary);
  border-radius: 6px;
  font-size: 13px;
}
.stat-chip.stat-zero { opacity: 0.5; }
.stat-chip-name { color: var(--color-text-secondary); }
.stat-chip-count { font-weight: 600; }
.cleanup-actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
