<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" @change="searchData">
          <option value="">{{ $t('platformTenants.allStatus') }}</option>
          <option value="active">{{ $t('platformTenants.statusActive') }}</option>
          <option value="suspended">{{ $t('platformTenants.statusSuspended') }}</option>
          <option value="disabled">{{ $t('platformTenants.statusDisabled') }}</option>
        </select>
        <select v-model="filter.plan" @change="searchData">
          <option value="">{{ $t('platformTenants.allPlans') }}</option>
          <option value="free">{{ $t('platformTenants.planFree') }}</option>
          <option value="pro">{{ $t('platformTenants.planPro') }}</option>
          <option value="team">{{ $t('platformTenants.planTeam') }}</option>
          <option value="enterprise">{{ $t('platformTenants.planEnterprise') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading" @click="searchData">
          {{ loading ? $t('platformTenants.searching') : $t('platformTenants.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ $t('platformTenants.refresh') }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">
        {{ $t('platformTenants.retry') }}
      </button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('platformTenants.tableAria')" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('platformTenants.colName') }}</th>
            <th>{{ $t('platformTenants.colPlan') }}</th>
            <th>{{ $t('platformTenants.colStatus') }}</th>
            <th class="col-num">{{ $t('platformTenants.colActivities') }}</th>
            <th class="col-num">{{ $t('platformTenants.colParticipants') }}</th>
            <th>{{ $t('platformTenants.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('platformTenants.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="7"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="row in tenants" :key="row.id">
            <td class="col-name">
              <div class="relation-cell">
                <span class="draw-name">{{ row.name }}</span>
              </div>
            </td>
            <td><span class="tag tag-info">{{ planLabel(row.plan) }}</span></td>
            <td>
              <span class="tag" :class="statusTagClass(row.status)">{{ statusLabel(row.status) }}</span>
            </td>
            <td class="col-num">{{ usageMap[row.id]?.activities ?? '—' }}</td>
            <td class="col-num">{{ usageMap[row.id]?.participants ?? '—' }}</td>
            <td class="time-cell">{{ formatTime(row.createdAt) }}</td>
            <td class="col-actions">
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" type="button" @click="showDetail(row)">
                  {{ $t('platformTenants.detail') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  :disabled="impersonating"
                  @click="handleImpersonateTenant(row.id)"
                >{{ $t('platformTenants.enterAdmin') }}</button>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  :title="$t('platformTenants.copyIdTitle')"
                  @click="copyId(row.id)"
                >{{ $t('platformTenants.copyId') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="tenants.length === 0">
            <td colspan="7" class="empty-text">{{ $t('platformTenants.empty') }}</td>
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

    <!--
      租户详情：用 admin.css 的 detail-box / detail-section / modal-form，
      避免旧版 detail-grid + 横向挤扁的 select/input（docs/080）。
    -->
    <AdminModal
      v-model="showDetailModal"
      :title="detailModalTitle"
      max-width="560px"
      hide-actions
    >
      <div v-if="detailLoading" class="empty-text">{{ $t('platformTenants.loading') }}</div>
      <div v-else-if="detailTenant" class="detail-box tenant-detail">
        <section class="detail-section" aria-labelledby="tenant-basic-title">
          <h4 id="tenant-basic-title" class="detail-title">{{ $t('platformTenants.sectionBasic') }}</h4>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelId') }}</span>
            <span class="detail-value tenant-id-value">
              <code class="tenant-id-code">{{ detailTenant.id }}</code>
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                :title="$t('platformTenants.copyIdTitle')"
                @click="copyId(detailTenant.id)"
              >{{ $t('platformTenants.copyId') }}</button>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelPlan') }}</span>
            <span class="detail-value">
              <span class="tag tag-info">{{ planLabel(detailTenant.plan) }}</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelStatus') }}</span>
            <span class="detail-value">
              <span class="tag" :class="statusTagClass(detailTenant.status)">{{ statusLabel(detailTenant.status) }}</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelCreatedAt') }}</span>
            <span class="detail-value">{{ formatTime(detailTenant.createdAt) }}</span>
          </div>
        </section>

        <section class="detail-section" aria-labelledby="tenant-usage-title">
          <h4 id="tenant-usage-title" class="detail-title">{{ $t('platformTenants.sectionUsage') }}</h4>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelActivities') }}</span>
            <span class="detail-value">{{ detailUsage?.activities ?? '—' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelParticipants') }}</span>
            <span class="detail-value">{{ detailUsage?.participants ?? $t('platformTenants.noSnapshot') }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelEvents') }}</span>
            <span class="detail-value">{{ detailUsage?.events ?? $t('platformTenants.noSnapshot') }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ $t('platformTenants.labelSnapshotDate') }}</span>
            <span class="detail-value">{{ detailUsage?.snapshotDate ?? $t('platformTenants.noSnapshot') }}</span>
          </div>
        </section>

        <section class="detail-section" aria-labelledby="tenant-adjust-title">
          <h4 id="tenant-adjust-title" class="detail-title">{{ $t('platformTenants.sectionAdjust') }}</h4>
          <div class="modal-form tenant-adjust-form">
            <label>
              <span>{{ $t('platformTenants.adjustPlan') }}</span>
              <select v-model="adjustForm.plan" :disabled="adjusting">
                <option value="free">{{ $t('platformTenants.planFree') }}</option>
                <option value="pro">{{ $t('platformTenants.planPro') }}</option>
                <option value="team">{{ $t('platformTenants.planTeam') }}</option>
                <option value="enterprise">{{ $t('platformTenants.planEnterprise') }}</option>
              </select>
            </label>
            <label>
              <span>{{ $t('platformTenants.adjustStatus') }}</span>
              <select v-model="adjustForm.status" :disabled="adjusting">
                <option value="active">{{ $t('platformTenants.statusActive') }}</option>
                <option value="suspended">{{ $t('platformTenants.statusSuspendOption') }}</option>
                <option value="disabled">{{ $t('platformTenants.statusDisableOption') }}</option>
              </select>
            </label>
            <label>
              <span>{{ $t('platformTenants.extraActivity') }}</span>
              <input
                v-model.number="adjustForm.extraActivityQuota"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                :disabled="adjusting"
                placeholder="0"
              />
            </label>
            <label>
              <span>{{ $t('platformTenants.extraParticipant') }}</span>
              <input
                v-model.number="adjustForm.extraParticipantQuota"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                :disabled="adjusting"
                placeholder="0"
              />
            </label>
          </div>
          <p class="field-hint tenant-adjust-hint">{{ $t('platformTenants.adjustHint') }}</p>
          <div class="tenant-section-actions">
            <button class="btn btn-primary btn-sm" type="button" :disabled="adjusting" @click="handleAdjust">
              {{ adjusting ? $t('platformTenants.saving') : $t('platformTenants.saveAdjust') }}
            </button>
          </div>
        </section>

        <section class="detail-section" aria-labelledby="tenant-impersonate-title">
          <h4 id="tenant-impersonate-title" class="detail-title">{{ $t('platformTenants.sectionImpersonate') }}</h4>
          <p class="field-hint tenant-adjust-hint">{{ $t('platformTenants.impersonateHint') }}</p>
          <div class="tenant-section-actions">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="impersonating"
              @click="handleImpersonate"
            >
              {{ impersonating ? $t('platformTenants.impersonating') : $t('platformTenants.impersonate') }}
            </button>
          </div>
        </section>

        <div class="modal-actions tenant-detail-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="showDetailModal = false">
            {{ $t('platformTenants.close') }}
          </button>
        </div>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
/**
 * 平台租户列表 + 详情调整。
 * docs/080：详情弹窗改为分区卡片 + modal-form 网格，避免控件挤扁；文案走 i18n。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@/components/AdminModal.vue'
import AdminPagination from '@/components/AdminPagination.vue'
import { adminRequest } from '@/composables/useAdminRequest'
import { useTablePagination } from '@/composables/useTablePagination'
import { useToast } from '@/composables/useToast'

const { t, locale } = useI18n()
const { showToast } = useToast()

const loading = ref(false)
const loadError = ref('')
const tenants = ref<any[]>([])
const usageMap = ref<Record<string, any>>({})

const filter = ref({ status: '', plan: '' })
const pagination = useTablePagination({ initialLimit: 50 })

const detailModalTitle = computed(() => {
  const name = detailTenant.value?.name
  if (name) return t('platformTenants.detailTitleNamed', { name })
  return t('platformTenants.detailTitle')
})

function formatTime(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale.value === 'en' ? 'en-US' : 'zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function planLabel(plan: string): string {
  const map: Record<string, string> = {
    free: t('platformTenants.planFree'),
    pro: t('platformTenants.planPro'),
    team: t('platformTenants.planTeam'),
    enterprise: t('platformTenants.planEnterprise'),
  }
  return map[String(plan || '').toLowerCase()] || plan || '—'
}

function statusLabel(status: string): string {
  if (status === 'active') return t('platformTenants.statusActive')
  if (status === 'suspended') return t('platformTenants.statusSuspended')
  if (status === 'disabled') return t('platformTenants.statusDisabled')
  return status || '—'
}

function statusTagClass(status: string): string {
  if (status === 'active') return 'tag-success'
  if (status === 'suspended') return 'tag-warning'
  return 'tag-danger'
}

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    showToast(t('platformTenants.copyIdSuccess'), 'success')
  } catch {
    showToast(t('platformTenants.copyIdFailed'), 'error')
  }
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const params = new URLSearchParams({
      limit: String(pagination.limit.value),
      offset: String((pagination.page.value - 1) * pagination.limit.value),
    })
    if (filter.value.status) params.set('status', filter.value.status)
    if (filter.value.plan) params.set('plan', filter.value.plan)
    const data = await adminRequest<{ tenants: any[] }>(`/api/platform/tenants?${params}`)
    tenants.value = data.tenants || []
    pagination.setTotal(
      data.tenants?.length === pagination.limit.value
        ? pagination.page.value * pagination.limit.value + 1
        : (pagination.page.value - 1) * pagination.limit.value + (data.tenants?.length || 0),
    )
    await Promise.all(tenants.value.map(async (row) => {
      try {
        const summary = await adminRequest<{ usage: any }>(`/api/platform/tenants/${row.id}/summary`)
        usageMap.value[row.id] = summary.usage || {}
      } catch { /* 单租户摘要失败不阻断列表 */ }
    }))
  } catch (err: any) {
    loadError.value = err.message || t('platformTenants.loadFailed')
  } finally {
    loading.value = false
  }
}

function searchData() {
  pagination.setPage(1)
  loadData()
}

const showDetailModal = ref(false)
const detailTenant = ref<any>(null)
const detailUsage = ref<any>(null)
const detailLoading = ref(false)

async function showDetail(row: any) {
  detailTenant.value = row
  detailUsage.value = null
  adjustForm.value = {
    plan: row.plan || 'free',
    status: row.status || 'active',
    extraActivityQuota: 0,
    extraParticipantQuota: 0,
  }
  showDetailModal.value = true
  detailLoading.value = true
  try {
    const data = await adminRequest<{ usage: any }>(`/api/platform/tenants/${row.id}/summary`)
    detailUsage.value = data.usage
  } catch { /* 详情用量可选 */ }
  detailLoading.value = false
}

const adjustForm = ref({
  plan: 'free',
  status: 'active',
  extraActivityQuota: 0,
  extraParticipantQuota: 0,
})
const adjusting = ref(false)

async function handleAdjust() {
  if (!detailTenant.value || adjusting.value) return
  adjusting.value = true
  try {
    const body: Record<string, unknown> = {
      plan: adjustForm.value.plan,
      status: adjustForm.value.status,
    }
    if (adjustForm.value.extraActivityQuota > 0) {
      body.extraActivityQuota = adjustForm.value.extraActivityQuota
    }
    if (adjustForm.value.extraParticipantQuota > 0) {
      body.extraParticipantQuota = adjustForm.value.extraParticipantQuota
    }
    await adminRequest(`/api/platform/tenants/${detailTenant.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    showToast(t('platformTenants.adjustSuccess'), 'success')
    showDetailModal.value = false
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('platformTenants.adjustFailed'), 'error')
  } finally {
    adjusting.value = false
  }
}

const impersonating = ref(false)

/**
 * L3→L2 模拟登录：一次性 token，新标签页打开 /admin?token=...
 * 列表「进入后台」与详情「模拟登录」共用。
 */
async function handleImpersonateTenant(tenantId: string) {
  if (!tenantId || impersonating.value) return
  impersonating.value = true
  try {
    const data = await adminRequest<{ token: string }>(`/api/platform/tenants/${tenantId}/impersonate`, {
      method: 'POST',
    })
    window.open(`/admin?token=${encodeURIComponent(data.token)}`, '_blank')
    showToast(t('platformTenants.impersonateSuccess'), 'success')
  } catch (err: any) {
    showToast(err?.message || t('platformTenants.impersonateFailed'), 'error')
  } finally {
    impersonating.value = false
  }
}

async function handleImpersonate() {
  if (!detailTenant.value) return
  await handleImpersonateTenant(detailTenant.value.id)
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
/* 仅补充本页细节；表单/分区样式优先复用 admin.css 的 .detail-* / .modal-form */
.time-cell {
  white-space: nowrap;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tenant-detail {
  gap: 12px;
}

.tenant-id-value {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 360px);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.tenant-id-code {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
  text-align: right;
  line-height: 1.35;
  color: var(--tg-text, #f0f2f5);
}

/* 两列网格：套餐/状态、两项额度；窄屏变一列 */
.tenant-adjust-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}

.tenant-adjust-form label {
  margin: 0;
}

.tenant-adjust-hint {
  display: block;
  margin: 8px 0 0;
  line-height: 1.45;
}

.tenant-section-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.tenant-detail-footer {
  margin-top: 4px;
  padding-top: 4px;
  justify-content: flex-end;
}

@media (max-width: 520px) {
  .tenant-adjust-form {
    grid-template-columns: 1fr;
  }

  .tenant-id-value {
    justify-content: flex-start;
    max-width: 100%;
  }

  .detail-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .detail-value {
    text-align: left;
  }
}
</style>
