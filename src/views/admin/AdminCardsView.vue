<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <AdminProductSelect v-model="filter.productId" :aria-label="$t('adminCards.colProduct')" @change="searchData" />
        <select v-model="filter.status" :aria-label="$t('adminCards.colStatus')" @change="searchData">
          <option value="">{{ $t('adminCards.statusAll') }}</option>
          <option value="available">{{ $t('adminCards.statusUnused') }}</option>
          <option value="locked">{{ $t('adminCards.statusLocked') }}</option>
          <option value="issued">{{ $t('adminCards.statusUsed') }}</option>
          <option value="disabled">{{ $t('adminCards.statusExpired') }}</option>
        </select>
        <select v-model="filter.batchId" :aria-label="$t('adminCards.colBatch')" @change="searchData">
          <option value="">{{ $t('adminCards.batchAll') }}</option>
          <option v-for="batch in batchOptions" :key="String(batch.id)" :value="batch.id">
            {{ batchLabel(batch) }}
          </option>
        </select>
        <input v-model="filter.buyerEmail" type="search" :placeholder="$t('adminCards.searchBuyerEmail')" :aria-label="$t('adminCards.searchBuyerEmail')" @keyup.enter="searchData" />
        <input v-model="filter.buyerContact" type="search" :placeholder="$t('adminCards.searchBuyerContact')" :aria-label="$t('adminCards.searchBuyerContact')" @keyup.enter="searchData" />
        <input
          v-model="filter.deliverySecret"
          type="search"
          maxlength="120"
          :placeholder="$t('adminCards.searchDelivery')"
          :title="$t('adminCards.searchDeliveryTitle')"
          :aria-label="$t('adminCards.searchDelivery')"
          @keyup.enter="searchData"
        />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminCards.searching') : $t('adminCards.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="generating || importing" @click="openGenerateDialog">{{ $t('adminCards.generateSameCode') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="generating || importing" @click="openImportDialog">{{ $t('adminCards.import') }}</button>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="purgingEmptyBatches || generating || importing"
          :title="$t('adminCards.purgeTitle')"
          @click="purgeEmptyBatches"
        >
          {{ purgingEmptyBatches ? $t('adminCards.purging') : $t('adminCards.purge') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="downloadingTemplate" @click="downloadTemplate">
          {{ downloadingTemplate ? $t('adminCards.downloading') : $t('adminCards.downloadTemplate') }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminCards.reload') }}</button>
    </div>

    <div class="notice-card" role="note">
      <strong>{{ $t('adminCards.noticeTitle') }}</strong>
      <span>{{ $t('adminCards.noticeBody') }}</span>
      <span>{{ $t('adminCards.noticeSearch') }}</span>
    </div>

    <div class="table-command-bar">
      <div class="quick-strip" role="group" :aria-label="$t('adminCards.quickFilter')">
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': filter.status === 'available' && !showSameCodeOnly }"
          @click="filter.status = 'available'; searchData()"
        >
          {{ $t('adminCards.showAvailable') }}
        </button>
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': filter.status === 'disabled' && !showSameCodeOnly }"
          @click="filter.status = 'disabled'; searchData()"
        >
          {{ $t('adminCards.showDisabled') }}
        </button>
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': showSameCodeOnly }"
          @click="toggleSameCodeOnly"
        >
          {{ showSameCodeOnly ? $t('adminCards.showAllStock') : $t('adminCards.showSameCodeOnly') }}
        </button>
      </div>
      <div v-if="selectedCount > 0" class="table-command-actions" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
        <span class="selection-summary">
          {{ batchOperating
            ? $t('adminCards.processing')
            : $t('adminCards.selectedCount', { count: selectedCount, safeCount: selectedSafeDeletableIds.length }) }}
        </span>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">{{ $t('adminCards.clearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedCards">{{ $t('adminCards.copySelected') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedCards">{{ $t('adminCards.exportSelected') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating || selectedDisabledIds.length === 0" @click="batchSetStatus('available')">
          {{ $t('adminCards.batchEnable', { count: selectedDisabledIds.length }) }}
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedAvailableIds.length === 0" @click="batchSetStatus('disabled')">
          {{ $t('adminCards.batchDisable', { count: selectedAvailableIds.length }) }}
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemove">
          {{ $t('adminCards.batchDelete', { count: selectedCount }) }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminCards.tableRegionLabel')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminCards.tableLabel')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                :aria-label="$t('adminCards.selectPageCards')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>ID</th>
            <th>{{ $t('adminCards.colProduct') }}</th>
            <th>{{ $t('adminCards.colBuyer') }}</th>
            <th>{{ $t('adminCards.colCard') }}</th>
            <th>{{ $t('adminCards.colBuyerEmail') }}</th>
            <th>{{ $t('adminCards.colBuyerContact') }}</th>
            <th>{{ $t('adminCards.colExpiresAt') }}</th>
            <th>{{ $t('adminCards.colStatus') }}</th>
            <th>{{ $t('adminCards.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="10"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in visibleItems" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating"
                :aria-label="$t('adminCards.selectRowAria', { id: item.id })"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.id.slice(0, 8) }}</td>
            <td>
              <div class="relation-cell">
                <span>{{ item.productTitle || item.productId || '-' }}</span>
                <small v-if="item.productTitle && item.productId">{{ item.productId }}</small>
              </div>
            </td>
            <td>{{ item.accountLabel || '-' }}</td>
            <td>
              <div class="secret-cell">
                <span>{{ item.deliverySecret || item.deliveryNote || '-' }}</span>
                <span v-if="!item.deliverySecret && item.deliveryNote" class="same-code-tag">{{ $t('adminCards.sameCodeTag') }}</span>
              </div>
            </td>
            <td>{{ item.buyerEmail || '-' }}</td>
            <td>{{ item.buyerContact || '-' }}</td>
            <td>
              <span v-if="item.expiresAt" :class="expiresAtClass(item.expiresAt)">
                {{ expiresAtText(item.expiresAt) }}
              </span>
              <span v-else>-</span>
            </td>
            <td>
              <span class="tag" :class="statusClass(item.status)">
                {{ statusLabel(item.status) }}
              </span>
            </td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" :disabled="batchOperating" @click="copyCard(item)">{{ $t('adminCards.copy') }}</button>
                <button
                  v-if="canToggleStatus(item.status)"
                  class="btn btn-ghost btn-xs"
                  :disabled="batchOperating || updatingId === item.id"
                  @click="updateStatus(item.id, item.status === 'available' ? 'disabled' : 'available')"
                >
                  {{ updatingId === item.id ? $t('adminCards.updating') : (item.status === 'available' ? $t('adminCards.disable') : $t('adminCards.enable')) }}
                </button>
                <span v-else class="muted-text">{{ $t('adminCards.statusMachineManaged') }}</span>
              </div>
            </td>
          </tr>
          <tr v-if="visibleItems.length === 0">
            <td colspan="10" class="empty-text">
              {{ emptyListHint }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading || batchOperating"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <AdminModal v-model="importVisible" :title="$t('adminCards.importTitle')" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="doImport">
        <label>
          <span>{{ $t('adminCards.productLabel') }}</span>
          <AdminProductSelect v-model="importForm.productId" :placeholder="$t('adminCards.productPlaceholder')" required />
        </label>
        <label>
          <span>{{ $t('adminCards.batchName') }}</span>
          <input v-model="importForm.batchName" required />
        </label>
        <label>
          <span>{{ $t('adminCards.cardListLabel') }}</span>
          <textarea v-model="importForm.raw" rows="8" :placeholder="$t('adminCards.cardListPlaceholder')" required></textarea>
        </label>
        <p class="hint">{{ $t('adminCards.importResult', { imported: importResult.imported, skipped: importResult.skipped, errors: importResult.errors.length }) }}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="importing" @click="importVisible = false">{{ $t('adminCards.close') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="importing">
            {{ importing ? $t('adminCards.importingText') : $t('adminCards.importAction') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="generateVisible" :title="$t('adminCards.generateTitle')" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="doGenerate">
        <label>
          <span>{{ $t('adminCards.productLabel') }}</span>
          <AdminProductSelect v-model="generateForm.productId" :placeholder="$t('adminCards.productPlaceholder')" required />
        </label>
        <label>
          <span>{{ $t('adminCards.genericCode') }}</span>
          <input v-model="generateForm.genericCode" required />
        </label>
        <label>
          <span>{{ $t('adminCards.accountLabel') }}</span>
          <input
            v-model="generateForm.accountLabel"
            type="text"
            maxlength="120"
            :placeholder="$t('adminCards.accountLabelPlaceholder')"
            :aria-label="$t('adminCards.accountLabelAria')"
          />
        </label>
        <label>
          <span>{{ $t('adminCards.generateCount') }}</span>
          <input v-model.number="generateForm.count" type="number" min="1" max="1000" required />
        </label>
        <label>
          <span>{{ $t('adminCards.batchName') }}</span>
          <input v-model="generateForm.batchName" required />
        </label>
        <label>
          <span>{{ $t('adminCards.expiresAtLabel') }}</span>
          <input v-model="generateForm.expiresAt" type="datetime-local" :lang="locale" />
        </label>
        <p class="hint">{{ $t('adminCards.generateHint') }}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="generating" @click="generateVisible = false">{{ $t('adminCards.close') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="generating">
            {{ generating ? $t('adminCards.generatingText') : $t('adminCards.generateAction') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog
      v-model="confirmVisible"
      :message="confirmMessage"
      :options="confirmOptionDefs"
      :option-values="confirmOptionValues"
      danger
      @confirm="onConfirm"
      @update:option="setConfirmOption"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { fetchAdminCards, fetchAdminBatches, purgeEmptyAdminBatches, updateAdminCard, importAdminCards, downloadCardImportTemplate, generateAdminGenericCards, batchDisableAdminCards, batchDeleteAdminCards } from '@/api/admin'
import type { AdminCard, AdminCardFilter, AdminBatch, AdminImportCardsPayload, AdminImportCardItem, AdminGenerateGenericCardsPayload } from '@/types/admin'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import { downloadCsv } from '@/lib/csv-export'

const { t, locale } = useI18n()
const { showToast } = useToast()
const { token } = useAdminAuth()

const items = ref<AdminCard[]>([])
const loading = ref(false)
const loadError = ref('')
const batchOperating = ref(false)
const purgingEmptyBatches = ref(false)
const importing = ref(false)
const generating = ref(false)
const downloadingTemplate = ref(false)
const updatingId = ref('')
const showSameCodeOnly = ref(false)
const batchOptions = ref<AdminBatch[]>([])
const filter = reactive<AdminCardFilter>({
  productId: '',
  batchId: '',
  status: '',
  buyerEmail: '',
  buyerContact: '',
  deliverySecret: '',
  genericOnly: false,
  page: 1,
})

const pagination = useTablePagination()

function batchLabel(batch: AdminBatch) {
  const name = batch.name || batch.id || t('adminCards.batchUnnamed')
  const avail = batch.availableCount
  // 优先用当前实表卡数；totalCount 仅为导入时快照，删卡后会虚高
  const total = typeof batch.cardCount === 'number'
    ? batch.cardCount
    : (batch.totalCount ?? batch.count)
  if (typeof avail === 'number' && typeof total === 'number') {
    return `${name}（${t('adminCards.batchLabel', { avail, total })}）`
  }
  return name
}

async function loadBatches() {
  try {
    const res = await fetchAdminBatches(token.value, filter.productId || undefined)
    batchOptions.value = res.results || []
    // 切换商品后若当前 batchId 不在列表中则清空并重查，避免旧批次 + 新商品静默空结果
    if (filter.batchId && !batchOptions.value.some((b) => b.id === filter.batchId)) {
      filter.batchId = ''
      searchData()
    }
  } catch {
    batchOptions.value = []
  }
}

async function purgeEmptyBatches() {
  if (purgingEmptyBatches.value) return
  const scope = filter.productId ? t('adminCards.purgeConfirmScope') : t('adminCards.purgeConfirmScopeAll')
  const ok = await askConfirm(t('adminCards.purgeConfirm', { scope }))
  if (!ok) return
  purgingEmptyBatches.value = true
  try {
    const res = await purgeEmptyAdminBatches(token.value, filter.productId || undefined)
    showToast(res.deleted > 0 ? t('adminCards.purgeSuccess', { count: res.deleted }) : t('adminCards.purgeNoData'), 'success')
    await loadBatches()
  } catch (err: any) {
    showToast(err.message || t('adminCards.purgeFailed'), 'error')
  } finally {
    purgingEmptyBatches.value = false
  }
}

watch(
  () => filter.productId,
  () => {
    void loadBatches()
  },
)

const importVisible = ref(false)
const importForm = reactive<{ productId: string; batchName: string; raw: string }>({
  productId: '',
  batchName: '',
  raw: '',
})
const importResult = reactive({ imported: 0, skipped: 0, errors: [] as string[] })

const generateVisible = ref(false)
const generateForm = reactive<{
  productId: string
  genericCode: string
  accountLabel: string
  count: number
  batchName: string
  expiresAt: string
}>({
  productId: '',
  genericCode: '',
  accountLabel: '',
  count: 1,
  batchName: '',
  expiresAt: '',
})

const visibleItems = computed(() => items.value)

/** 空表提示：有内容关键词时引导运营理解「所见即可搜」与同码叠加 */
const emptyListHint = computed(() => {
  const keyword = (filter.deliverySecret || '').trim()
  if (keyword) {
    return showSameCodeOnly.value
      ? t('adminCards.noMatchSameCode', { keyword })
      : t('adminCards.noMatchGeneral', { keyword })
  }
  if (showSameCodeOnly.value) return t('adminCards.noSameCodeStock')
  return t('adminCards.noData')
})

const {
  selectedIds,
  selectedCount,
  selectableCount,
  allVisibleSelected,
  partiallySelected,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
} = useTableSelection(visibleItems, (row) => row.id)
const selectedAvailableIds = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id) && item.status === 'available').map((item) => item.id)
})
const selectedDisabledIds = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id) && item.status === 'disabled').map((item) => item.id)
})
/** 未勾选「全部删除」时仅允许删除可用/禁用（与后端 SAFE_CARD_DELETE_STATUSES 同步） */
const selectedSafeDeletableIds = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value
    .filter((item) => selected.has(item.id) && canToggleStatus(item.status))
    .map((item) => item.id)
})
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id))
})
const CARD_DELETE_CONFIRM_OPTIONS = [
  {
    key: 'force',
    label: i18n.global.t('adminCards.deleteAllLabel'),
    hint: i18n.global.t('adminCards.deleteAllHint'),
  },
  {
    key: 'unlinkRefs',
    label: i18n.global.t('adminCards.unlinkOrderLabel'),
    hint: i18n.global.t('adminCards.unlinkOrderHint'),
  },
] as const
const {
  confirmVisible,
  confirmMessage,
  confirmOptionDefs,
  confirmOptionValues,
  askConfirm,
  askConfirmWithOptions,
  onConfirm,
  setConfirmOption,
} = useConfirmDialog()
let loadSequence = 0

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminCards(token.value, {
      ...filter,
      page: pagination.page.value,
      limit: pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.results
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || t('adminCards.loadFailed')
    showToast(err.message || t('adminCards.loadFailed'), 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  loadData()
}

function toggleSameCodeOnly() {
  showSameCodeOnly.value = !showSameCodeOnly.value
  filter.genericOnly = showSameCodeOnly.value
  searchData()
}

function openImportDialog() {
  importForm.productId = ''
  importForm.batchName = ''
  importForm.raw = ''
  importResult.imported = 0
  importResult.skipped = 0
  importResult.errors = []
  importVisible.value = true
}

function openGenerateDialog() {
  generateForm.productId = ''
  generateForm.genericCode = ''
  generateForm.accountLabel = ''
  generateForm.count = 1
  generateForm.batchName = ''
  generateForm.expiresAt = ''
  generateVisible.value = true
}

async function doImport() {
  if (importing.value) return
  const lines = importForm.raw.split('\n').filter((line) => line.trim())
  const cards: AdminImportCardItem[] = lines.map((line) => {
    const [accountLabel, deliverySecret, note] = line.split(',')
    return {
      accountLabel: (accountLabel || '').trim(),
      deliverySecret: (deliverySecret || '').trim(),
      deliveryNote: (note || '').trim() || undefined,
    }
  })

  if (cards.length === 0) {
    showToast(t('adminCards.importRequired'), 'error')
    return
  }

  importing.value = true
  try {
    const payload: AdminImportCardsPayload = {
      productId: importForm.productId,
      batchName: importForm.batchName,
      cards,
    }
    const res = await importAdminCards(token.value, payload)
    importResult.imported = res.imported
    importResult.skipped = 0
    importResult.errors = []
    showToast(t('adminCards.importSuccess', { count: res.imported }), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCards.importFailed'), 'error')
  } finally {
    importing.value = false
  }
}

async function doGenerate() {
  if (generating.value) return
  const expiresAt = generateForm.expiresAt ? new Date(generateForm.expiresAt).toISOString() : undefined
  generating.value = true
  try {
    const payload: AdminGenerateGenericCardsPayload = {
      productId: generateForm.productId,
      genericCode: generateForm.genericCode,
      accountLabel: generateForm.accountLabel.trim() || undefined,
      count: generateForm.count,
      batchName: generateForm.batchName,
      expiresAt,
    }
    const res = await generateAdminGenericCards(token.value, payload)
    showToast(t('adminCards.generateSuccess', { count: res.generated }), 'success')
    generateVisible.value = false
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCards.generateFailed'), 'error')
  } finally {
    generating.value = false
  }
}

async function downloadTemplate() {
  if (downloadingTemplate.value) return
  downloadingTemplate.value = true
  try {
    const blob = await downloadCardImportTemplate(token.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cards-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
    showToast(t('adminCards.downloadSuccess'), 'success')
  } catch (err: any) {
    showToast(err.message || t('adminCards.downloadFailed'), 'error')
  } finally {
    downloadingTemplate.value = false
  }
}

async function updateStatus(id: string, status: 'available' | 'disabled') {
  if (updatingId.value) return
  updatingId.value = id
  try {
    await updateAdminCard(token.value, id, { status })
    showToast(t('adminCards.updateSuccess'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCards.updateFailed'), 'error')
  } finally {
    updatingId.value = ''
  }
}

async function batchSetStatus(status: 'available' | 'disabled') {
  const ids = status === 'available' ? selectedDisabledIds.value : selectedAvailableIds.value
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('adminCards.batchOpConfirm', { action: status === 'disabled' ? t('adminCards.disable') : t('adminCards.enable'), count: ids.length })))) return
  batchOperating.value = true
  try {
    const res = await batchDisableAdminCards(token.value, { ids, status })
    showToast(t('adminCards.batchOpSuccess', { action: status === 'disabled' ? t('adminCards.disable') : t('adminCards.enable'), count: res.updated }), 'success')
    clearSelection()
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCards.batchOpFailed'), 'error')
  } finally {
    batchOperating.value = false
  }
}

async function batchRemove() {
  const ids = selectedItems.value.map((item) => item.id)
  if (ids.length === 0 || loading.value || batchOperating.value) return
  const safeCount = selectedSafeDeletableIds.value.length
  const decision = await askConfirmWithOptions(
    i18n.global.t('adminCards.batchDeleteConfirm', { count: ids.length, safeCount }),
    { options: [...CARD_DELETE_CONFIRM_OPTIONS] },
  )
  if (!decision.confirmed) return
  const force = decision.options.force === true
  const unlinkRefs = decision.options.unlinkRefs === true
  batchOperating.value = true
  try {
    const res = await batchDeleteAdminCards(token.value, ids, { force, unlinkRefs })
    const flags = [
      force ? i18n.global.t('adminCards.deleteAllLabel') : i18n.global.t('adminCards.deleteSafe'),
      unlinkRefs ? i18n.global.t('adminCards.unlinkOrderLabel') : i18n.global.t('adminCards.unlinkNone'),
    ].join(' · ')
    showToast(i18n.global.t('adminCards.batchDeleteSuccess', { count: res.deleted, flags }), 'success')
    clearSelection()
    // 删卡可能级联清掉空批次，同步刷新下拉
    void loadBatches()
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCards.batchDeleteFailed'), 'error')
  } finally {
    batchOperating.value = false
  }
}

function cardCopyLine(item: AdminCard) {
  return [item.accountLabel || '', item.deliverySecret || '', item.deliveryNote || ''].join('\t')
}

async function copyCard(item: AdminCard) {
  try {
    await writeClipboardText(item.deliverySecret || item.deliveryNote || item.accountLabel || '')
    showToast(t('adminCards.cardCopied'), 'success')
  } catch {
    showToast(t('adminCards.copyFailed'), 'error')
  }
}

async function copySelectedCards() {
  try {
    await writeClipboardText(selectedItems.value.map(cardCopyLine).join('\n'))
    showToast(t('adminCards.copySuccess', { count: selectedItems.value.length }), 'success')
  } catch {
    showToast(t('adminCards.copyFailed'), 'error')
  }
}

function exportSelectedCards() {
  downloadCsv(`selected-cards-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['id', 'productTitle', 'productId', 'accountLabel', 'deliverySecret', 'deliveryNote', 'status', 'buyerEmail', 'expiresAt'],
    ...selectedItems.value.map((item) => [item.id, item.productTitle || '', item.productId || '', item.accountLabel || '', item.deliverySecret || '', item.deliveryNote || '', item.status || '', item.buyerEmail || '', item.expiresAt || '']),
  ])
  showToast(t('adminCards.exportSuccess', { count: selectedItems.value.length }), 'success')
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    available: t('adminCards.statusAvailable'),
    locked: t('adminCards.statusLocking'),
    issued: t('adminCards.statusIssuedCard'),
    disabled: t('adminCards.statusDisabled'),
  }
  return labels[status || ''] || status || '-'
}

function statusClass(status?: string) {
  if (status === 'available') return 'tag-success'
  if (status === 'locked') return 'tag-warning'
  if (status === 'issued') return 'tag-info'
  return 'tag-muted'
}

function canToggleStatus(status?: string) {
  return status === 'available' || status === 'disabled'
}

function expiresAtClass(expiresAt?: string) {
  if (!expiresAt) return ''
  const diff = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diff < 0) return 'status-error'
  if (diff <= 3) return 'status-error'
  if (diff <= 7) return 'status-warning'
  return 'status-success'
}

function expiresAtText(expiresAt?: string) {
  if (!expiresAt) return '-'
  const diff = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  const dateText = formatDate(expiresAt)
  if (diff < 0) return `${dateText}（${i18n.global.t('adminCards.dateExpired', { days: Math.abs(diff) })}）`
  return `${dateText}（${i18n.global.t('adminCards.dateRemaining', { days: diff })}）`
}

onMounted(() => {
  void loadBatches()
  void loadData()
})
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* notice-card / relation-cell / secret-cell / same-code-tag → admin.css
 * 垂直间距仅靠 .admin-page gap（--admin-stack-gap），禁止 margin-bottom 叠距。
 */
.notice-card strong {
  margin-right: 8px;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.5;
}

@media (max-width: 640px) {
  .notice-card {
    display: none;
  }
}
</style>
