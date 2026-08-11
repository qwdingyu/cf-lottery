<template>
  <div class="admin-page">
    <h3>{{ $t('platformCleanup.title') }}</h3>
    <p class="field-hint" style="margin-bottom:16px">{{ $t('platformCleanup.desc') }}</p>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" @click="loadStats">{{ $t('platformCleanup.retry') }}</button>
    </div>

    <p v-if="snapshotMeta?.snapshotized" class="field-hint" style="margin-bottom: 12px">
      {{ $t('platformCleanup.snapshotHint', { date: snapshotMeta.snapshotDate || '-', count: snapshotMeta.snapshotTenantCount }) }}
    </p>

    <div class="stats-grid" style="margin-bottom:24px">
      <div v-for="(count, table) in stats" :key="table" class="stat-chip" :class="{ 'stat-zero': count === 0 }">
        <span class="stat-chip-name">{{ table }}</span>
        <span class="stat-chip-count">{{ count === -1 ? 'N/A' : count }}</span>
      </div>
    </div>

    <div class="cleanup-actions">
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadStats">{{ $t('platformCleanup.refreshStats') }}</button>
      <button class="btn btn-danger btn-sm" :disabled="cleaning" @click="cleanTargets(['email_access_codes', 'rate_limit_log', 'audit_logs', 'platform_audit_logs', 'activity_events'])">
        {{ cleaning ? $t('platformCleanup.cleaning') : $t('platformCleanup.cleanLogs') }}
      </button>
    </div>

    <p v-if="cleanResult" class="field-hint" style="margin-top:8px">{{ cleanResult }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const stats = ref<Record<string, number>>({})
const snapshotMeta = ref<{ snapshotDate: string | null; snapshotTenantCount: number; snapshotized: boolean } | null>(null)
const loading = ref(false)
const cleaning = ref(false)
const loadError = ref('')
const cleanResult = ref('')

async function loadStats() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{
      stats: Record<string, number>
      snapshotDate?: string | null
      snapshotTenantCount?: number
      snapshotized?: boolean
    }>('/api/platform/data/stats')
    stats.value = data.stats
    snapshotMeta.value = {
      snapshotDate: data.snapshotDate ?? null,
      snapshotTenantCount: data.snapshotTenantCount ?? 0,
      snapshotized: Boolean(data.snapshotized),
    }
  } catch (err: any) {
    loadError.value = err?.message || t('platformCleanup.loadFailed')
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
    const parts = Object.entries(data.results).map(([k, v]) => t('platformCleanup.rowUnit', { k, v }))
    cleanResult.value = t('platformCleanup.cleaned', { parts: parts.join('，') })
    await loadStats()
  } catch (err: any) {
    cleanResult.value = t('platformCleanup.cleanFailed', { msg: err?.message || t('platformCleanup.unknownError') })
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
