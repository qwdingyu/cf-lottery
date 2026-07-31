<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <p class="toolbar-hint" v-html="$t('adminCampaigns.toolbarHint')" />
        <input
          v-model="filterQ"
          type="search"
          maxlength="40"
          :placeholder="$t('adminCampaigns.searchPlaceholder')"
          :aria-label="$t('adminCampaigns.searchAriaLabel')"
          @keyup.enter="applyLocalFilter"
        />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="applyLocalFilter">{{ $t('adminCampaigns.searchBtn') }}</button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || saving" @click="openCreate">{{ $t('adminCampaigns.createButton') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminCampaigns.reload') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminCampaigns.reload') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminCampaigns.tableRegionLabel')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminCampaigns.tableLabel')">
        <thead>
          <tr>
            <th>{{ $t('adminCampaigns.colCode') }}</th>
            <th>{{ $t('adminCampaigns.colName') }}</th>
            <th>{{ $t('adminCampaigns.colStatus') }}</th>
            <th>{{ $t('adminCampaigns.colStartsAt') }}</th>
            <th>{{ $t('adminCampaigns.colEndsAt') }}</th>
            <th>{{ $t('adminCampaigns.colCreatedAt') }}</th>
            <th>{{ $t('adminCampaigns.colAction') }}</th>
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
            <td>{{ item.name || $t('adminCampaigns.noName') }}</td>
            <td>
              <span class="tag" :class="item.active ? 'tag-success' : 'tag-muted'">
            {{ item.active ? $t('adminCampaigns.statusActive') : $t('adminCampaigns.statusInactive') }}
          </span>
            </td>
            <td>{{ formatDate(item.startsAt) || '—' }}</td>
            <td>{{ formatDate(item.endsAt) || '—' }}</td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  :title="$t('adminCampaigns.searchOrdersTitle')"
                  @click="searchOrdersByCode(item.code)"
                >
                  {{ $t('adminCampaigns.actionSearchOrders') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  :title="$t('adminCampaigns.searchPaidTitle')"
                  @click="searchPaidOrdersByCode(item.code)"
                >
                  {{ $t('adminCampaigns.actionSearchPaid') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  :title="$t('adminCampaigns.copyLinkTitle')"
                  @click="openCopyLink(item.code)"
                >
                  {{ $t('adminCampaigns.actionCopyLink') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  @click="toggleActive(item)"
                >
                  {{ item.active ? $t('adminCampaigns.actionDisable') : $t('adminCampaigns.actionEnable') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  @click="openEdit(item)"
                >
                  {{ $t('adminCampaigns.actionEdit') }}
                </button>
                <button
                  class="btn btn-danger btn-xs"
                  :disabled="loading || saving || deletingCode === item.code"
                  @click="remove(item.code)"
                >
                  {{ deletingCode === item.code ? $t('adminCampaigns.deleting') : $t('adminCampaigns.actionDelete') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredItems.length === 0">
            <td colspan="7" class="empty-text">
              {{ items.length === 0 ? $t('adminCampaigns.noData') : $t('adminCampaigns.noMatch') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="formVisible" :title="editing ? $t('adminCampaigns.editTitle') : $t('adminCampaigns.createTitle')" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="save">
        <label>
          <span>{{ $t('adminCampaigns.formCode') }}</span>
          <input
            v-model="form.code"
            :disabled="!!editing"
            required
            minlength="2"
            maxlength="40"
            :placeholder="$t('adminCampaigns.formCodePlaceholder')"
            :aria-label="$t('adminCampaigns.formCodeAriaLabel')"
          />
          <small class="field-hint">{{ $t('adminCampaigns.formCodeHint') }}</small>
        </label>
        <label>
          <span>{{ $t('adminCampaigns.formName') }}</span>
          <input
            v-model="form.name"
            required
            maxlength="120"
            :placeholder="$t('adminCampaigns.formNamePlaceholder')"
            :aria-label="$t('adminCampaigns.formNameAriaLabel')"
          />
        </label>
        <label class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>{{ $t('adminCampaigns.formActive') }}</span>
        </label>
        <label>
          <span>{{ $t('adminCampaigns.formStartsAt') }}</span>
          <input v-model="form.startsAtLocal" type="datetime-local" :lang="locale" :aria-label="$t('adminCampaigns.formStartsAtAriaLabel')" />
        </label>
        <label>
          <span>{{ $t('adminCampaigns.formEndsAt') }}</span>
          <input v-model="form.endsAtLocal" type="datetime-local" :lang="locale" :aria-label="$t('adminCampaigns.formEndsAtAriaLabel')" />
        </label>
        <!-- 与工具栏、docs/054 一致：表单内再强调一次，避免只改日期却以为会拒单 -->
        <p class="field-hint" v-html="$t('adminCampaigns.formDatesHint')" />
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="formVisible = false">{{ $t('adminCampaigns.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? $t('adminCampaigns.saving') : $t('adminCampaigns.save') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="copyLinkVisible" :title="$t('adminCampaigns.copyLinkModalTitle')" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="confirmCopyLink">
        <p class="field-hint" v-html="$t('adminCampaigns.copyLinkHint')" />
        <label>
          <span>{{ $t('adminCampaigns.formCode') }}</span>
          <input :value="copyLinkCode" disabled :aria-label="$t('adminCampaigns.formCodeReadonlyAria')" />
        </label>
        <label>
          <span>{{ $t('adminCampaigns.copyLinkChannel') }}</span>
          <select v-model="copyLinkStorefrontId" :aria-label="$t('adminCampaigns.copyLinkChannelAria')">
            <option value="">{{ $t('adminCampaigns.copyLinkDefaultChannel') }}</option>
            <option
              v-for="sf in activeStorefronts"
              :key="sf.id"
              :value="sf.id"
            >{{ sf.name }} ({{ sf.homePath || sf.slug || sf.id }})</option>
          </select>
        </label>
        <label>
          <span>{{ $t('adminCampaigns.copyLinkReferral') }}</span>
          <input
            v-model="copyLinkReferral"
            maxlength="40"
            :placeholder="$t('adminCampaigns.copyLinkReferralPlaceholder')"
            :aria-label="$t('adminCampaigns.copyLinkReferralAria')"
          />
        </label>
        <label>
          <span>{{ $t('adminCampaigns.copyLinkProduct') }}</span>
          <input
            v-model="copyLinkProduct"
            maxlength="120"
            :placeholder="$t('adminCampaigns.copyLinkProductPlaceholder')"
            :aria-label="$t('adminCampaigns.copyLinkProductAria')"
          />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" @click="copyLinkVisible = false">{{ $t('adminCampaigns.cancel') }}</button>
          <button type="button" class="btn btn-ghost" @click="confirmCopyReviewLink">{{ $t('adminCampaigns.copyReviewLinkBtn') }}</button>
          <button type="submit" class="btn btn-primary">{{ $t('adminCampaigns.copyLinkBtn') }}</button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  createAdminCampaign,
  deleteAdminCampaign,
  fetchAdminCampaigns,
  fetchAdminStorefronts,
  updateAdminCampaign,
} from '@/api/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import {
  normalizeAttributionCode,
} from '@/lib/checkout-attribution'
import { buildAdminPromotionLink, buildAdminPromotionReviewLink } from '@/lib/admin-promotion-link'
import { SETTLEMENT_ORDER_STATUS_QUERY } from '@shared/admin-order-export'
import type { AdminCampaign, AdminStorefront } from '@/types/admin'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const { token } = useAdminAuth()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const items = ref<AdminCampaign[]>([])
const storefronts = ref<AdminStorefront[]>([])
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const deletingCode = ref('')
const formVisible = ref(false)
const editing = ref<string | null>(null)
const filterQ = ref('')

const form = reactive({
  code: '',
  name: '',
  active: true,
  startsAtLocal: '',
  endsAtLocal: '',
})

const copyLinkVisible = ref(false)
const copyLinkCode = ref('')
const copyLinkStorefrontId = ref('')
const copyLinkReferral = ref('')
const copyLinkProduct = ref('')

const activeStorefronts = computed(() => storefronts.value.filter((s) => s.active))

function isoToDatetimeLocal(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function datetimeLocalToIso(value: string) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

const filteredItems = computed(() => {
  const q = normalizeAttributionCode(filterQ.value)
  if (!q) return items.value
  return items.value.filter((item) => {
    const code = normalizeAttributionCode(item.code)
    const name = String(item.name || '').toLowerCase()
    return code.includes(q) || name.includes(q)
  })
})

/**
 * 从路由 query 同步本地筛选。
 * 无 q 时必须清空 filterQ，避免 URL 已去掉筛选条件但表格仍按旧关键字过滤。
 */
function initFromRoute() {
  const raw = route.query.q
  if (typeof raw === 'string' && raw.trim()) {
    filterQ.value = raw.trim().slice(0, 40)
  } else {
    filterQ.value = ''
  }
}

function applyLocalFilter() {
  const q = filterQ.value.trim().slice(0, 40)
  const query: Record<string, string> = {}
  if (q) query.q = q
  void router.replace({ path: route.path, query })
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const [campRes, sfRes] = await Promise.all([
      fetchAdminCampaigns(token.value),
      fetchAdminStorefronts(token.value).catch(() => ({ storefronts: [] as AdminStorefront[] })),
    ])
    items.value = campRes.campaigns || []
    storefronts.value = sfRes.storefronts || []
  } catch (err: unknown) {
    items.value = []
    loadError.value = err instanceof Error ? err.message : t('adminCampaigns.loadFailed')
    showToast(loadError.value, 'error')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editing.value = null
  form.code = ''
  form.name = ''
  form.active = true
  form.startsAtLocal = ''
  form.endsAtLocal = ''
  formVisible.value = true
}

function openEdit(item: AdminCampaign) {
  editing.value = item.code
  form.code = item.code
  form.name = item.name || ''
  form.active = item.active !== false
  form.startsAtLocal = isoToDatetimeLocal(item.startsAt)
  form.endsAtLocal = isoToDatetimeLocal(item.endsAt)
  formVisible.value = true
}

async function save() {
  if (saving.value) return
  const code = normalizeAttributionCode(form.code)
  const name = form.name.trim()
  if (!editing.value && (code.length < 2 || code.length > 40)) {
    showToast(t('adminCampaigns.codeLengthError'), 'error')
    return
  }
  if (!name) {
    showToast(t('adminCampaigns.nameRequired'), 'error')
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      await updateAdminCampaign(token.value, editing.value, {
        name,
        active: form.active,
        startsAt: datetimeLocalToIso(form.startsAtLocal),
        endsAt: datetimeLocalToIso(form.endsAtLocal),
      })
      showToast(t('adminCampaigns.updated'), 'success')
    } else {
      await createAdminCampaign(token.value, {
        code,
        name,
        active: form.active,
        startsAt: datetimeLocalToIso(form.startsAtLocal),
        endsAt: datetimeLocalToIso(form.endsAtLocal),
      })
      showToast(t('adminCampaigns.created'), 'success')
    }
    formVisible.value = false
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminCampaigns.saveFailed'), 'error')
  } finally {
    saving.value = false
  }
}

async function toggleActive(item: AdminCampaign) {
  if (saving.value) return
  saving.value = true
  try {
    await updateAdminCampaign(token.value, item.code, {
      active: !item.active,
    })
    showToast(item.active ? t('adminCampaigns.disabled') : t('adminCampaigns.enabled'), 'success')
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminCampaigns.updateFailed'), 'error')
  } finally {
    saving.value = false
  }
}

async function remove(code: string) {
  if (deletingCode.value) return
  if (!(await askConfirm(t('adminCampaigns.confirmDelete', { code })))) return
  deletingCode.value = code
  try {
    await deleteAdminCampaign(token.value, code)
    showToast(t('adminCampaigns.deleted'), 'success')
    await loadData()
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : t('adminCampaigns.deleteFailed'), 'error')
  } finally {
    deletingCode.value = ''
  }
}

function searchOrdersByCode(code: string) {
  const q = String(code || '').trim().slice(0, 120)
  if (!q) return
  void router.push({ path: '/admin/orders', query: { q } })
}

/** L0 渠道复盘：同码 + paid/issued */
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
  copyLinkReferral.value = ''
  copyLinkProduct.value = ''
  copyLinkVisible.value = true
}

async function confirmCopyLink() {
  const normalized = normalizeAttributionCode(copyLinkCode.value)
  if (!normalized) return
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  let storefront: AdminStorefront | null = null
  if (copyLinkStorefrontId.value) {
    storefront = storefronts.value.find((s) => s.id === copyLinkStorefrontId.value) || null
  }
  const referral = normalizeAttributionCode(copyLinkReferral.value)
  const url = buildAdminPromotionLink({
    origin,
    storefront,
    productKey: copyLinkProduct.value,
    campaignCode: normalized,
    referralCode: referral || undefined,
  })
  try {
    await writeClipboardText(url)
    showToast(t('adminCampaigns.linkCopied'), 'success')
    copyLinkVisible.value = false
  } catch {
    showToast(t('adminCampaigns.linkCopyFailed') + url, 'error')
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
    showToast(t('adminCampaigns.reviewLinkCopied'), 'success')
  } catch {
    showToast(t('adminCampaigns.reviewLinkCopyFailed') + url, 'error')
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
.code-cell code {
  white-space: nowrap;
  font-size: 12px;
}
</style>
