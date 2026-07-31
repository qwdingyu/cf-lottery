<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <p class="toolbar-hint" v-html="$t('adminReferralCodes.helperIntro')" />
        <input
          v-model="filterQ"
          type="search"
          maxlength="40"
          :placeholder="$t('adminReferralCodes.searchPlaceholder')"
          :aria-label="$t('adminReferralCodes.searchAriaLabel')"
          @keyup.enter="applyLocalFilter"
        />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="applyLocalFilter">{{ $t('adminReferralCodes.searchBtn') }}</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || saving" @click="openCreate">{{ $t('adminReferralCodes.createButton') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminReferralCodes.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminReferralCodes.reload') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminReferralCodes.title')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminReferralCodes.title')">
        <thead>
          <tr>
            <th>{{ $t('adminReferralCodes.colCode') }}</th>
            <th>{{ $t('adminReferralCodes.colOwnerContact') }}</th>
            <th>{{ $t('adminReferralCodes.colCommission') }}</th>
            <th :title="$t('adminReferralCodes.colEventsTitle')">{{ $t('adminReferralCodes.colEvents') }}</th>
            <th>{{ $t('adminReferralCodes.colStatus') }}</th>
            <th>{{ $t('adminReferralCodes.colCreatedAt') }}</th>
            <th>{{ $t('adminReferralCodes.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td colspan="7"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in filteredItems" :key="item.code">
            <td class="code-cell"><code>{{ item.code }}</code></td>
            <td>{{ item.ownerContact || '—' }}</td>
            <td class="reward-cell">{{ formatRewardRule(item) }}</td>
            <td>{{ item.useCount ?? 0 }}</td>
            <td>
              <span class="tag" :class="item.active ? 'tag-success' : 'tag-muted'">
                {{ $t(item.active ? 'adminReferralCodes.statusActive' : 'adminReferralCodes.statusInactive') }}
              </span>
            </td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  :title="$t('adminReferralCodes.searchOrdersTitle')"
                  @click="searchOrdersByCode(item.code)"
                >
                  {{ $t('adminReferralCodes.actionSearchOrders') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  :title="$t('adminReferralCodes.searchPaidTitle')"
                  @click="searchPaidOrdersByCode(item.code)"
                >
                  {{ $t('adminReferralCodes.actionSearchPaid') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  :title="$t('adminReferralCodes.copyLinkTitle')"
                  @click="openCopyLink(item.code)"
                >
                  {{ $t('adminReferralCodes.actionCopyLink') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  @click="toggleActive(item)"
                >
                  {{ $t(item.active ? 'adminReferralCodes.actionDisable' : 'adminReferralCodes.actionEnable') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  @click="openEdit(item)"
                >
                  {{ $t('adminReferralCodes.actionEdit') }}
                </button>
                <button
                  class="btn btn-danger btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  @click="remove(item.code)"
                >
                  {{ deletingCode === item.code ? $t('adminReferralCodes.actionDeleting') : $t('adminReferralCodes.actionDelete') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredItems.length === 0">
            <td colspan="6" class="empty-text">
              {{ items.length === 0 ? $t('adminReferralCodes.emptyText') : $t('adminReferralCodes.noMatch') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- P2 性价比：未登记码汇总（只读） -->
    <section v-if="orphanStats.length > 0" class="orphan-panel" :aria-label="$t('adminReferralCodes.orphanSectionTitle')">
      <h3 class="orphan-title">{{ $t('adminReferralCodes.orphanSectionTitle') }}</h3>
      <p class="orphan-hint">{{ $t('adminReferralCodes.orphanSectionHint') }}</p>
      <ul class="orphan-list">
        <li v-for="row in orphanStats" :key="row.referralCode">
          <code>{{ row.referralCode }}</code>
          <span class="orphan-count">{{ row.eventCount }} {{ $t('adminReferralCodes.orphanEventCount') }}</span>
          <button type="button" class="btn btn-ghost btn-xs" @click="searchOrdersByCode(row.referralCode)">{{ $t('adminReferralCodes.actionSearchOrders') }}</button>
          <button type="button" class="btn btn-ghost btn-xs" @click="prefillCreateFromOrphan(row.referralCode)">{{ $t('adminReferralCodes.actionRegister') }}</button>
        </li>
      </ul>
    </section>

    <AdminModal v-model="formVisible" :title="editing ? $t('adminReferralCodes.modalEditTitle') : $t('adminReferralCodes.modalCreateTitle')" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="save">
        <label>
          <span>{{ $t('adminReferralCodes.formCode') }}</span>
          <input
            v-model="form.code"
            :disabled="!!editing"
            required
            minlength="2"
            maxlength="40"
            :placeholder="$t('adminReferralCodes.formCodePlaceholder')"
            :aria-label="$t('adminReferralCodes.formCode')"
          />
          <small class="field-hint">{{ $t('adminReferralCodes.formCodeHint') }}</small>
        </label>
        <label>
          <span>{{ $t('adminReferralCodes.formOwnerContact') }}</span>
          <input
            v-model="form.ownerContact"
            required
            maxlength="120"
            :placeholder="$t('adminReferralCodes.formOwnerContactPlaceholder')"
            :aria-label="$t('adminReferralCodes.formOwnerContact')"
          />
        </label>
        <label>
          <span>{{ $t('adminReferralCodes.formRewardType') }}</span>
          <select v-model="form.rewardType" :aria-label="$t('adminReferralCodes.formRewardType')">
            <option value="none">{{ $t('adminReferralCodes.rewardTypeNone') }}</option>
            <option value="fixed">{{ $t('adminReferralCodes.rewardTypeFixed') }}</option>
            <option value="percent">{{ $t('adminReferralCodes.rewardTypePercent') }}</option>
          </select>
        </label>
        <label v-if="form.rewardType === 'fixed'">
          <span>{{ $t('adminReferralCodes.formRewardFixed') }}</span>
          <input
            v-model.number="form.rewardValue"
            type="number"
            min="1"
            max="100000"
            step="1"
            required
            :aria-label="$t('adminReferralCodes.formRewardFixed')"
          />
          <small class="field-hint">{{ $t('adminReferralCodes.formRewardFixedHint') }}</small>
        </label>
        <label v-if="form.rewardType === 'percent'">
          <span>{{ $t('adminReferralCodes.formRewardPercent') }}</span>
          <input
            v-model.number="form.rewardValue"
            type="number"
            min="1"
            max="100"
            step="1"
            required
            :aria-label="$t('adminReferralCodes.formRewardPercent')"
          />
          <small class="field-hint">{{ $t('adminReferralCodes.formRewardPercentHint') }}</small>
        </label>
        <label class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>{{ $t('adminReferralCodes.formActive') }}</span>
        </label>
        <p class="field-hint reward-note" v-html="$t('adminReferralCodes.formRewardNote')" />
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="formVisible = false">{{ $t('adminReferralCodes.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? $t('adminReferralCodes.saving') : $t('adminReferralCodes.save') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="copyLinkVisible" :title="$t('adminReferralCodes.modalCopyLinkTitle')" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="confirmCopyLink">
        <p class="field-hint" v-html="$t('adminReferralCodes.copyLinkHint')" />
        <label>
          <span>{{ $t('adminReferralCodes.formCode') }}</span>
          <input :value="copyLinkCode" disabled :aria-label="$t('adminReferralCodes.copyLinkCodeAria')" />
        </label>
        <label>
          <span>{{ $t('adminReferralCodes.formStorefront') }}</span>
          <select v-model="copyLinkStorefrontId" :aria-label="$t('adminReferralCodes.formStorefront')">
            <option value="">{{ $t('adminReferralCodes.defaultStorefront') }}</option>
            <option
              v-for="sf in activeStorefronts"
              :key="sf.id"
              :value="sf.id"
            >{{ sf.name }} ({{ sf.homePath || sf.slug || sf.id }})</option>
          </select>
        </label>
        <label>
          <span>{{ $t('adminReferralCodes.formCampaign') }}</span>
          <input
            v-model="copyLinkCampaign"
            maxlength="40"
            :placeholder="$t('adminReferralCodes.campaignPlaceholder')"
            :aria-label="$t('adminReferralCodes.formCampaign')"
          />
        </label>
        <label>
          <span>{{ $t('adminReferralCodes.formProduct') }}</span>
          <input
            v-model="copyLinkProduct"
            maxlength="120"
            :placeholder="$t('adminReferralCodes.productPlaceholder')"
            :aria-label="$t('adminReferralCodes.formProduct')"
          />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" @click="copyLinkVisible = false">{{ $t('adminReferralCodes.cancel') }}</button>
          <button type="button" class="btn btn-ghost" @click="confirmCopyReviewLink">{{ $t('adminReferralCodes.copyReviewLinkBtn') }}</button>
          <button type="submit" class="btn btn-primary">{{ $t('adminReferralCodes.copyLinkBtn') }}</button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  createAdminReferralCode,
  deleteAdminReferralCode,
  fetchAdminReferralCodes,
  fetchAdminReferralUnregisteredStats,
  fetchAdminStorefronts,
  updateAdminReferralCode,
} from '@/api/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { formatMoney } from '@/utils/currency'
import {
  normalizeAttributionCode,
} from '@/lib/checkout-attribution'
import { buildAdminPromotionLink, buildAdminPromotionReviewLink } from '@/lib/admin-promotion-link'
import { SETTLEMENT_ORDER_STATUS_QUERY } from '@shared/admin-order-export'
import type { AdminReferralCode, AdminStorefront } from '@/types/admin'

/** 列表「佣金」列：与表单 fixed/percent/none 对齐的只读文案 */
function formatRewardRule(item: Pick<AdminReferralCode, 'rewardType' | 'rewardValue'>): string {
  const type = item.rewardType
  const value = Number(item.rewardValue || 0)
  if (type === 'fixed') {
    if (!Number.isFinite(value) || value <= 0) return t('adminReferralCodes.rewardFixedUnset')
    return t('adminReferralCodes.rewardFixedValue', { amount: formatMoney(Math.trunc(value), 'CNY') })
  }
  if (type === 'percent') {
    if (!Number.isFinite(value) || value < 1) return t('adminReferralCodes.rewardPercentUnset')
    return t('adminReferralCodes.rewardPercentValue', { percent: Math.trunc(value) })
  }
  return t('adminReferralCodes.rewardAttributionOnly')
}

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { token } = useAdminAuth()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const items = ref<AdminReferralCode[]>([])
const storefronts = ref<AdminStorefront[]>([])
const orphanStats = ref<Array<{ referralCode: string; eventCount: number }>>([])
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const deletingCode = ref('')
const formVisible = ref(false)
const editing = ref<string | null>(null)
const filterQ = ref('')

const form = reactive({
  code: '',
  ownerContact: '',
  active: true,
  rewardType: 'none' as 'none' | 'fixed' | 'percent',
  rewardValue: 0,
})

const copyLinkVisible = ref(false)
const copyLinkCode = ref('')
const copyLinkStorefrontId = ref('')
const copyLinkCampaign = ref('')
const copyLinkProduct = ref('')

const activeStorefronts = computed(() =>
  storefronts.value.filter((s) => s.active),
)

const filteredItems = computed(() => {
  const q = normalizeAttributionCode(filterQ.value)
  if (!q) return items.value
  return items.value.filter((item) => {
    const code = normalizeAttributionCode(item.code)
    const owner = String(item.ownerContact || '').toLowerCase()
    return code.includes(q) || owner.includes(q)
  })
})

/**
 * 从路由 query 同步本地筛选。
 * 必须与订单页 initFilterFromRoute 同构：先按 URL 灌值，**无 q 时清空**，
 * 否则「筛选清空 → replace 掉 query.q」后 filterQ 残留，列表仍按旧关键字过滤。
 */
function initFromRoute() {
  const raw = route.query.q
  if (typeof raw === 'string' && raw.trim()) {
    filterQ.value = raw.trim().slice(0, 40)
  } else {
    // URL 无 q / 空串 / 非 string：本地筛选必须回退为「全部」
    filterQ.value = ''
  }
}

function applyLocalFilter() {
  // 写回 query 便于分享筛选；watch(route.query.q) 会再次 initFromRoute
  const q = filterQ.value.trim().slice(0, 40)
  const query: Record<string, string> = {}
  if (q) query.q = q
  void router.replace({ path: route.path, query })
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const [codesRes, statsRes, sfRes] = await Promise.all([
      fetchAdminReferralCodes(token.value),
      fetchAdminReferralUnregisteredStats(token.value, 30).catch(() => ({ stats: [] as Array<{ referralCode: string; eventCount: number }> })),
      fetchAdminStorefronts(token.value).catch(() => ({ storefronts: [] as AdminStorefront[] })),
    ])
    items.value = codesRes.codes || []
    orphanStats.value = statsRes.stats || []
    storefronts.value = sfRes.storefronts || []
  } catch (err: unknown) {
    items.value = []
    loadError.value = err instanceof Error ? err.message : t('adminReferralCodes.loadError')
    showToast(loadError.value, 'error')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editing.value = null
  form.code = ''
  form.ownerContact = ''
  form.active = true
  form.rewardType = 'none'
  form.rewardValue = 0
  formVisible.value = true
}

function prefillCreateFromOrphan(code: string) {
  editing.value = null
  form.code = normalizeAttributionCode(code)
  form.ownerContact = ''
  form.active = true
  form.rewardType = 'none'
  form.rewardValue = 0
  formVisible.value = true
}

function openEdit(item: AdminReferralCode) {
  editing.value = item.code
  form.code = item.code
  form.ownerContact = item.ownerContact || ''
  form.active = item.active !== false
  form.rewardType =
    item.rewardType === 'fixed' || item.rewardType === 'percent'
      ? item.rewardType
      : 'none'
  form.rewardValue = Number(item.rewardValue || 0)
  formVisible.value = true
}

async function save() {
  if (saving.value) return
  const code = normalizeAttributionCode(form.code)
  const ownerContact = form.ownerContact.trim()
  if (!editing.value && (code.length < 2 || code.length > 40)) {
    showToast(t('adminReferralCodes.validateCodeLength'), 'error')
    return
  }
  if (!ownerContact) {
    showToast(t('adminReferralCodes.validateOwnerContact'), 'error')
    return
  }
  if (form.rewardType === 'fixed' || form.rewardType === 'percent') {
    if (!ownerContact.includes('@')) {
      showToast(t('adminReferralCodes.validateEmail'), 'error')
      return
    }
  }
  if (form.rewardType === 'fixed') {
    if (!Number.isInteger(form.rewardValue) || form.rewardValue <= 0) {
      showToast(t('adminReferralCodes.validateFixedValue'), 'error')
      return
    }
  }
  if (form.rewardType === 'percent') {
    if (!Number.isInteger(form.rewardValue) || form.rewardValue < 1 || form.rewardValue > 100) {
      showToast(t('adminReferralCodes.validatePercentValue'), 'error')
      return
    }
  }
  saving.value = true
  try {
    const rewardType = form.rewardType
    const rewardValue =
      rewardType === 'fixed' || rewardType === 'percent' ? form.rewardValue : 0
    if (editing.value) {
      await updateAdminReferralCode(token.value, editing.value, {
        ownerContact,
        active: form.active,
        rewardType,
        rewardValue,
      })
      showToast(t('adminReferralCodes.updateSuccess'), 'success')
    } else {
      await createAdminReferralCode(token.value, {
        code,
        ownerContact,
        active: form.active,
        rewardType,
        rewardValue,
      })
      showToast(t('adminReferralCodes.createSuccess'), 'success')
    }
    formVisible.value = false
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminReferralCodes.saveFailed'), 'error')
  } finally {
    saving.value = false
  }
}

async function toggleActive(item: AdminReferralCode) {
  if (saving.value) return
  saving.value = true
  try {
    await updateAdminReferralCode(token.value, item.code, {
      active: !item.active,
    })
    showToast(item.active ? t('adminReferralCodes.toggledOff') : t('adminReferralCodes.toggledOn'), 'success')
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminReferralCodes.updateFailed'), 'error')
  } finally {
    saving.value = false
  }
}

async function remove(code: string) {
  if (deletingCode.value) return
  if (!(await askConfirm(t('adminReferralCodes.confirmDelete', { code })))) return
  deletingCode.value = code
  try {
    await deleteAdminReferralCode(token.value, code)
    showToast(t('adminReferralCodes.deleteSuccess'), 'success')
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminReferralCodes.deleteFailed'), 'error')
  } finally {
    deletingCode.value = ''
  }
}

/** 深链：用此码搜订单（与订单页 filter.q 同源） */
function searchOrdersByCode(code: string) {
  const q = String(code || '').trim().slice(0, 120)
  if (!q) return
  void router.push({ path: '/admin/orders', query: { q } })
}

/** L0 人工结算：同码 + paid/issued（勿与 useCount 事件数混淆） */
function searchPaidOrdersByCode(code: string) {
  const q = String(code || '').trim().slice(0, 120)
  if (!q) return
  void router.push({
    path: '/admin/orders',
    query: { q, status: SETTLEMENT_ORDER_STATUS_QUERY },
  })
}

function openCopyLink(code: string) {
  copyLinkCode.value = normalizeAttributionCode(code)
  copyLinkStorefrontId.value = ''
  copyLinkCampaign.value = ''
  copyLinkProduct.value = ''
  copyLinkVisible.value = true
}

/**
 * 复制购买链：仅规范短键 ?ref= / 可选 ?campaign=。
 * 默认 /shop；可选活跃渠道 homePath。
 */
async function confirmCopyLink() {
  const normalized = normalizeAttributionCode(copyLinkCode.value)
  if (!normalized) return
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  let storefront: AdminStorefront | null = null
  if (copyLinkStorefrontId.value) {
    storefront = storefronts.value.find((s) => s.id === copyLinkStorefrontId.value) || null
  }
  const campaign = normalizeAttributionCode(copyLinkCampaign.value)
  const url = buildAdminPromotionLink({
    origin,
    storefront,
    productKey: copyLinkProduct.value,
    campaignCode: campaign || undefined,
    referralCode: normalized,
  })
  try {
    await writeClipboardText(url)
    showToast(t('adminReferralCodes.copyLinkSuccess'), 'success')
    copyLinkVisible.value = false
  } catch {
    showToast(t('adminReferralCodes.copyLinkFailed', { url }), 'error')
  }
}

async function confirmCopyReviewLink() {
  const normalized = normalizeAttributionCode(copyLinkCode.value)
  if (!normalized) return
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const url = buildAdminPromotionReviewLink({
    origin,
    appBasePath: import.meta.env.BASE_URL,
    attributionCode: normalized,
  })
  try {
    await writeClipboardText(url)
    showToast(t('adminReferralCodes.copyReviewLinkSuccess'), 'success')
  } catch {
    showToast(t('adminReferralCodes.copyReviewLinkFailed', { url }), 'error')
  }
}

onMounted(() => {
  initFromRoute()
  void loadData()
})

watch(
  () => route.query.q,
  () => {
    initFromRoute()
  },
)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.toolbar-hint {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-muted, #94a3b8);
  line-height: 1.45;
  max-width: 52rem;
}
.toolbar-hint code {
  font-size: 12px;
}
.reward-note {
  margin: 0 0 8px;
}
.code-cell code {
  white-space: nowrap;
  font-size: 12px;
}
.reward-cell {
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-muted, #94a3b8);
}
.orphan-panel {
  margin-top: 1.5rem;
  padding: 12px 14px;
  border: 1px solid var(--border, #334155);
  border-radius: 8px;
}
.orphan-title {
  margin: 0 0 4px;
  font-size: 14px;
}
.orphan-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-muted, #94a3b8);
}
.orphan-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.orphan-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.orphan-count {
  color: var(--text-muted, #94a3b8);
}
</style>
