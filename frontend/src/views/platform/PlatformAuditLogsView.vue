<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="filter.tenantId" type="search" :placeholder="$t('platformAudit.tenantPlaceholder')" @keyup.enter="searchData" />
        <input v-model="filter.action" type="search" :placeholder="$t('platformAudit.actionPlaceholder')" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('platformAudit.searching') : $t('platformAudit.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('platformAudit.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('platformAudit.retry') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformAudit.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('platformAudit.colTime') }}</th>
            <th>{{ $t('platformAudit.colTenant') }}</th>
            <th>{{ $t('platformAudit.colActor') }}</th>
            <th>{{ $t('platformAudit.colAction') }}</th>
            <th>{{ $t('platformAudit.colTargetType') }}</th>
            <th>{{ $t('platformAudit.colTargetId') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="6"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="log in logs" :key="log.id">
            <td class="time-cell">{{ formatTime(log.createdAt) }}</td>
            <td><code class="code-id" :title="log.tenantId" @click="copyText(log.tenantId)">{{ log.tenantId?.slice(0, 8) }}…</code></td>
            <td><code class="code-id" :title="log.actorUserId" @click="copyText(log.actorUserId)">{{ log.actorUserId?.slice(0, 8) }}…</code></td>
            <td><span class="tag tag-info">{{ log.action }}</span></td>
            <td>{{ log.targetType }}</td>
            <td><code class="code-id" :title="log.targetId" @click="copyText(log.targetId)">{{ log.targetId?.slice(0, 12) }}…</code></td>
          </tr>
          <tr v-if="logs.length === 0">
            <td colspan="6" class="empty-text">{{ $t('platformAudit.empty') }}</td>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminPagination from '@usethink/cf-admin-fe/components/AdminPagination.vue'
import { adminRequest } from '@/composables/useAdminRequest'
import { copyWithToast, useTablePagination } from '@usethink/cf-admin-fe/composables'
import { buildAdminOffsetParams } from '@usethink/cf-admin-fe/utils'

const { t } = useI18n()
const loading = ref(false)
const loadError = ref('')
const logs = ref<any[]>([])
const filter = ref({ tenantId: '', action: '' })
const pagination = useTablePagination({ initialLimit: 50 })

function formatTime(iso: string): string {
  if (!iso) return '-'
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

async function copyText(text: string) {
  if (!text) return
  await copyWithToast(text, {
    successMessage: t('lottery.copied'),
    errorMessage: t('platformTenants.copyIdFailed'),
  })
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams(buildAdminOffsetParams(pagination.page.value, pagination.limit.value))
    if (filter.value.tenantId) params.set('tenantId', filter.value.tenantId)
    if (filter.value.action) params.set('action', filter.value.action)
    const data = await adminRequest<{ logs: any[] }>(`/api/platform/audit-logs?${params}`)
    logs.value = data.logs || []
    pagination.setTotal(data.logs?.length === pagination.limit.value ? pagination.page.value * pagination.limit.value + 1 : (pagination.page.value - 1) * pagination.limit.value + (data.logs?.length || 0))
  } catch (err: any) {
    loadError.value = err.message || t('platformAudit.loadFailed')
  } finally {
    loading.value = false
  }
}

function searchData() { pagination.setPage(1); loadData() }

onMounted(loadData)
</script>

<style scoped>
.time-cell { white-space: nowrap; font-size: 12px; }
.code-id { font-family: monospace; font-size: 11px; background: var(--tg-secondary-bg, #151b28); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
.code-id:hover { background: var(--tg-bg, #1f2937); }
</style>
