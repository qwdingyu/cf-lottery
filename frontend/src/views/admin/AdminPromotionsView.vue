<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <p class="toolbar-hint">{{ $t('adminPromotions.toolbarHint') }}</p>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || saving" @click="openCreate">
          {{ $t('adminPromotions.createGroupBuy') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          {{ $t('adminPromotions.reload') }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminPromotions.tableLabel')" tabindex="0">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminPromotions.colName') }}</th>
            <th>{{ $t('adminPromotions.colStatus') }}</th>
            <th>{{ $t('adminPromotions.colRule') }}</th>
            <th>{{ $t('adminPromotions.colInstances') }}</th>
            <th>{{ $t('adminPromotions.colTime') }}</th>
            <th>{{ $t('adminPromotions.colAction') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" class="empty-text">{{ $t('adminPromotions.loading') }}</td>
          </tr>
          <tr v-for="item in promotions" v-else :key="item.id">
            <td>
              <div class="title-cell">{{ item.name }}</div>
              <code>{{ item.id }}</code>
            </td>
            <td><span class="tag" :class="statusClass(item.visibleStatus || item.status)">{{ statusText(item.visibleStatus || item.status) }}</span></td>
            <td>
              {{ $t('adminPromotions.ruleText', {
                count: item.trigger.requiredInvites || 0,
                hours: item.trigger.expireHours || 0,
              }) }}
            </td>
            <td>{{ item.instances }} / {{ item.fulfilledInstances }}</td>
            <td>{{ formatDate(item.startsAt) || '-' }} - {{ formatDate(item.endsAt) || '-' }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" @click="loadInstances(item.id)">{{ $t('adminPromotions.instances') }}</button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || !canToggleActive(item)" @click="setStatus(item, item.status === 'active' ? 'paused' : 'active')">
                  {{ item.status === 'active' ? $t('adminPromotions.pause') : $t('adminPromotions.activate') }}
                </button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || item.status !== 'active' && item.status !== 'paused'" @click="setStatus(item, 'ended')">
                  {{ $t('adminPromotions.end') }}
                </button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || item.status !== 'ended'" @click="setStatus(item, 'archived')">
                  {{ $t('adminPromotions.archive') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loading && promotions.length === 0">
            <td colspan="6" class="empty-text">{{ $t('adminPromotions.noData') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="instances.length" class="admin-section">
      <h2>{{ $t('adminPromotions.instanceTitle') }}</h2>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>{{ $t('adminPromotions.instanceOwner') }}</th>
              <th>{{ $t('adminPromotions.instanceOriginOrder') }}</th>
              <th>{{ $t('adminPromotions.instanceStatus') }}</th>
              <th>{{ $t('adminPromotions.instanceProgress') }}</th>
              <th>{{ $t('adminPromotions.instanceUsageBreakdown') }}</th>
              <th>{{ $t('adminPromotions.instanceReward') }}</th>
              <th>{{ $t('adminPromotions.instanceLatestUsage') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in instances" :key="item.id">
              <td>{{ item.ownerEmail }}</td>
              <td>
                <RouterLink
                  class="admin-deeplink"
                  :to="{ path: '/admin/orders', query: { q: item.originOrderNo || item.originOrderId } }"
                  :title="$t('adminPromotions.searchOriginOrderTitle', { id: item.originOrderNo || item.originOrderId })"
                >
                  {{ item.originOrderNo || item.originOrderId }}
                </RouterLink>
                <div v-if="item.originOrderStatus" class="mini-muted">{{ item.originOrderStatus }}</div>
              </td>
              <td><span class="tag" :class="statusClass(item.status)">{{ statusText(item.status) }}</span></td>
              <td>{{ item.qualifiedCount }} / {{ item.requiredCount }}</td>
              <td>
                {{ $t('adminPromotions.instanceUsageText', {
                  total: item.usageCount || 0,
                  skipped: item.skippedCount || 0,
                  fulfilled: item.fulfilledUsageCount || 0,
                  reversed: item.reversedCount || 0,
                }) }}
              </td>
              <td>{{ formatCents(item.rewardAmountCents) }} {{ item.currency }}</td>
              <td>{{ formatDate(item.latestUsageAt) || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <AdminModal v-model="formVisible" :title="$t('adminPromotions.createGroupBuy')" max-width="560px" hide-actions>
      <form class="modal-form" @submit.prevent="save">
        <label>
          <span>{{ $t('adminPromotions.formName') }}</span>
          <input v-model="form.name" required maxlength="120" />
        </label>
        <label>
          <span>{{ $t('adminPromotions.formStorefrontIds') }}</span>
          <input v-model="form.storefrontIds" :placeholder="$t('adminPromotions.commaPlaceholder')" />
        </label>
        <label>
          <span>{{ $t('adminPromotions.formProductIds') }}</span>
          <input v-model="form.productIds" :placeholder="$t('adminPromotions.commaPlaceholder')" />
        </label>
        <div class="form-grid">
          <label>
            <span>{{ $t('adminPromotions.formRequired') }}</span>
            <input v-model.number="form.requiredInvites" type="number" min="1" max="100" required />
          </label>
          <label>
            <span>{{ $t('adminPromotions.formExpireHours') }}</span>
            <input v-model.number="form.expireHours" type="number" min="1" max="8760" required />
          </label>
        </div>
        <label class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>{{ $t('adminPromotions.formActive') }}</span>
        </label>
        <p class="promotion-field-hint">{{ $t('adminPromotions.formHint') }}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="formVisible = false">{{ $t('adminPromotions.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">{{ saving ? $t('adminPromotions.saving') : $t('adminPromotions.save') }}</button>
        </div>
      </form>
    </AdminModal>
    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useToast } from '@/composables/useToast'
import {
  createAdminGroupBuyPromotion,
  fetchAdminPromotionInstances,
  fetchAdminPromotions,
  updateAdminPromotionStatus,
} from '@/api/admin'
import type { AdminPromotion, AdminPromotionInstance } from '@/types/admin'

const { t } = useI18n()
const { token } = useAdminAuth()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const promotions = ref<AdminPromotion[]>([])
const instances = ref<AdminPromotionInstance[]>([])
const loading = ref(false)
const saving = ref(false)
const formVisible = ref(false)
const form = reactive({
  name: '',
  storefrontIds: 'sf_default',
  productIds: '',
  requiredInvites: 3,
  expireHours: 48,
  active: false,
})

function splitIds(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : ''
}

function formatCents(value: number) {
  return (Number(value || 0) / 100).toFixed(2)
}

function statusText(status: string) {
  return t(`adminPromotions.status.${status}`)
}

function statusClass(status: string) {
  if (status === 'active' || status === 'fulfilled') return 'tag-success'
  if (status === 'paused' || status === 'draft' || status === 'scheduled') return 'tag-warning'
  return 'tag-muted'
}

function canToggleActive(item: AdminPromotion) {
  if (item.visibleStatus === 'expired') return false
  return item.status === 'active' || item.status === 'draft' || item.status === 'paused'
}

async function loadData() {
  loading.value = true
  try {
    promotions.value = (await fetchAdminPromotions(token.value)).promotions || []
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminPromotions.loadFailed'), 'error')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.name = ''
  form.storefrontIds = 'sf_default'
  form.productIds = ''
  form.requiredInvites = 3
  form.expireHours = 48
  form.active = false
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    await createAdminGroupBuyPromotion(token.value, {
      name: form.name.trim(),
      status: form.active ? 'active' : 'draft',
      scope: {
        storefrontIds: splitIds(form.storefrontIds),
        productIds: splitIds(form.productIds),
        emailDomains: [],
      },
      trigger: {
        requiredInvites: Number(form.requiredInvites),
        expireHours: Number(form.expireHours),
        minInviteeOrderAmountCents: 1,
        countUniqueInviteeEmail: true,
      },
      reward: {
        type: 'balance_credit',
        amount: 'origin_order_paid_amount',
        maxRewardCents: 0,
      },
    })
    formVisible.value = false
    showToast(t('adminPromotions.created'), 'success')
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminPromotions.saveFailed'), 'error')
  } finally {
    saving.value = false
  }
}

async function setStatus(item: AdminPromotion, status: AdminPromotion['status']) {
  if (status === 'ended') {
    const ok = await askConfirm(t('adminPromotions.confirmEnd', { name: item.name }))
    if (!ok) return
  }
  if (status === 'archived') {
    const ok = await askConfirm(t('adminPromotions.confirmArchive', { name: item.name }))
    if (!ok) return
  }
  saving.value = true
  try {
    await updateAdminPromotionStatus(token.value, item.id, status)
    showToast(t('adminPromotions.updated'), 'success')
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminPromotions.updateFailed'), 'error')
  } finally {
    saving.value = false
  }
}

async function loadInstances(id: string) {
  try {
    instances.value = (await fetchAdminPromotionInstances(token.value, id)).instances || []
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminPromotions.loadInstancesFailed'), 'error')
  }
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.toolbar-hint,
.promotion-field-hint {
  margin: 0;
  color: var(--text-muted, #94a3b8);
  font-size: 13px;
  line-height: 1.45;
}
.title-cell {
  font-weight: 700;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.admin-deeplink {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.admin-deeplink:hover {
  color: var(--admin-accent, #f59e0b);
}
.mini-muted {
  margin-top: 2px;
  color: var(--text-muted, #94a3b8);
  font-size: 12px;
}
</style>
