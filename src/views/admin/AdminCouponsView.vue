<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <AdminProductSelect v-model="filter.productId" :aria-label="$t('adminCoupons.ariaLabelProduct')" @change="searchData" />
        <select v-model="filter.status" :aria-label="$t('adminCoupons.ariaLabelStatus')" @change="searchData">
          <option value="">{{ $t('adminCoupons.statusAll') }}</option>
          <option value="active">{{ $t('adminCoupons.activeLabel') }}</option>
          <option value="inactive">{{ $t('adminCoupons.statusInactive') }}</option>
        </select>
        <input v-model="filter.search" type="search" :placeholder="$t('adminCoupons.search')" :aria-label="$t('adminCoupons.search')" @keyup.enter="searchData" />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminCoupons.searching') : $t('adminCoupons.searchBtn') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="saving || generating" @click="openCreate">{{ $t('adminCoupons.create') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="saving || generating" @click="openGenerate">{{ $t('adminCoupons.batchGenerate') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminCoupons.reload') }}</button>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
      <span v-if="batchOperating">{{ $t('adminCoupons.processing') }} {{ batchCompleted }}/{{ batchTotal }}</span>
      <span v-else>{{ $t('adminCoupons.selectedCount', { count: selectedCount }) }}</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">{{ $t('adminCoupons.clearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedCodes">{{ $t('adminCoupons.copySelected') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedCodes">{{ $t('adminCoupons.exportSelected') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(true)">
          {{ $t('adminCoupons.batchEnable') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(false)">
          {{ $t('adminCoupons.batchDisable') }}
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating" @click="batchRemove">
          {{ $t('adminCoupons.batchDelete') }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminCoupons.ariaLabelTable')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminCoupons.title')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                :aria-label="$t('adminCoupons.ariaLabelSelectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminCoupons.colCode') }}</th>
            <th>{{ $t('adminCoupons.colProduct') }}</th>
            <th>{{ $t('adminCoupons.colType') }}</th>
            <th>{{ $t('adminCoupons.colDiscount') }}</th>
            <th>{{ $t('adminCoupons.colUsage') }}</th>
            <th>{{ $t('adminCoupons.colStatus') }}</th>
            <th>{{ $t('adminCoupons.colExpiresAt') }}</th>
            <th>{{ $t('adminCoupons.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.code" :class="{ 'is-selected': isSelected(item.code) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.code)"
                :disabled="loading || batchOperating || deletingCode === item.code"
                :aria-label="$t('adminCoupons.ariaLabelSelectCode', { code: item.code })"
                @click="setSelected(item.code, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.code }}</td>
            <td>
              <div class="relation-cell">
                <span>{{ item.productTitle || item.productId || $t('adminCoupons.appliesAll') }}</span>
                <small v-if="item.productTitle && item.productId">{{ item.productId }}</small>
              </div>
            </td>
            <td>{{ item.discountType === 'percent' ? $t('adminCoupons.typePercent') : $t('adminCoupons.typeFixed') }}</td>
            <td>{{ formatCouponDiscount(item) }}</td>
            <td>
              <span v-if="!item.maxUses" class="tag tag-warning" :title="$t('adminCoupons.hintMaxUses')">
                {{ item.usedCount ?? 0 }} / {{ $t('adminCoupons.unlimited') }}
              </span>
              <span v-else>{{ item.usedCount ?? 0 }} / {{ item.maxUses }}</span>
            </td>
            <td>
              <span class="tag" :class="item.active ? 'tag-success' : 'tag-muted'">
                {{ item.active ? $t('adminCoupons.activeLabel') : $t('adminCoupons.inactiveLabel') }}
              </span>
            </td>
            <td>{{ formatDate(item.expiresAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" :disabled="loading || batchOperating" @click="copyCodes([item.code], $t('adminCoupons.codeCopied'))">{{ $t('adminCoupons.actionCopy') }}</button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || loading || batchOperating || deletingCode === item.code" @click="openEdit(item)">{{ $t('adminCoupons.actionEdit') }}</button>
                <button class="btn btn-danger btn-xs" :disabled="saving || loading || batchOperating || deletingCode === item.code" @click="remove(item.code)">
                  {{ deletingCode === item.code ? $t('adminCoupons.actionDeleting') : $t('adminCoupons.actionDelete') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="9" class="empty-text">{{ $t('adminCoupons.noData') }}</td>
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

    <AdminModal v-model="formVisible" :title="editing ? $t('adminCoupons.modalEditTitle') : $t('adminCoupons.modalCreateTitle')" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="save">
        <label>
          <span>{{ $t('adminCoupons.formCode') }}</span>
          <input v-model="form.code" :disabled="!!editing" :placeholder="$t('adminCoupons.formCodeAuto')" />
        </label>
        <label>
          <span>{{ $t('adminCoupons.formProduct') }}</span>
          <AdminProductSelect v-model="form.productId" :placeholder="$t('adminCoupons.formAllProducts')" />
        </label>
        <label>
          <span>{{ $t('adminCoupons.formDiscountType') }}</span>
          <select
            :value="form.discountType"
            @change="setDiscountType(form, ($event.target as HTMLSelectElement).value)"
          >
            <option value="fixed">{{ $t('adminCoupons.optionFixed') }}</option>
            <option value="percent">{{ $t('adminCoupons.optionPercent') }}</option>
          </select>
        </label>
        <label>
          <span>{{ discountInputLabel(form) }}</span>
          <input
            :value="discountInputValue(form)"
            type="number"
            :min="discountInputMin(form)"
            :max="discountInputMax(form)"
            :step="discountInputStep(form)"
            :placeholder="discountInputPlaceholder(form)"
            required
            @input="setDiscountInputValue(form, ($event.target as HTMLInputElement).value)"
          />
          <small class="field-hint">{{ discountInputHint(form) }}</small>
        </label>
        <label>
          <span>{{ $t('adminCoupons.formMaxUses') }}</span>
          <input v-model.number="form.maxUses" type="number" min="0" step="1" required />
          <small class="field-hint">{{ $t('adminCoupons.hintMaxUses') }}</small>
        </label>
        <label>
          <span>{{ $t('adminCoupons.formExpiresAt') }}</span>
          <input v-model="form.expiresAt" type="datetime-local" :lang="locale" />
        </label>
        <label class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>{{ $t('adminCoupons.formActive') }}</span>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="formVisible = false">{{ $t('adminCoupons.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? $t('adminCoupons.saving') : $t('adminCoupons.save') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="generatedVisible" :title="$t('adminCoupons.modalGeneratedTitle')" max-width="620px" hide-actions>
      <div class="generated-result">
        <p>{{ $t('adminCoupons.generatedResultText', { count: generatedCodes.length }) }}</p>
        <textarea :value="generatedCodes.join('\n')" rows="12" readonly :aria-label="$t('adminCoupons.ariaLabelGeneratedCodes')" />
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="copyCodes(generatedCodes, $t('adminCoupons.allCopied'))">{{ $t('adminCoupons.copyAll') }}</button>
          <button class="btn btn-primary" @click="exportGeneratedCodes">{{ $t('adminCoupons.downloadCsv') }}</button>
          <button class="btn btn-ghost" @click="generatedVisible = false">{{ $t('adminCoupons.close') }}</button>
        </div>
      </div>
    </AdminModal>

    <AdminModal v-model="generateVisible" :title="$t('adminCoupons.modalBatchGenerateTitle')" max-width="520px" hide-actions>
      <form class="modal-form" @submit.prevent="doGenerate">
        <label>
          <span>{{ $t('adminCoupons.formProduct') }}</span>
          <AdminProductSelect v-model="genForm.productId" :placeholder="$t('adminCoupons.formProductPlaceholder')" required />
        </label>
        <label>
          <span>{{ $t('adminCoupons.formPrefix') }}</span>
          <input v-model="genForm.prefix" />
        </label>
        <label>
          <span>{{ $t('adminCoupons.formDiscountType') }}</span>
          <select
            :value="genForm.discountType"
            @change="setDiscountType(genForm, ($event.target as HTMLSelectElement).value)"
          >
            <option value="fixed">{{ $t('adminCoupons.optionFixed') }}</option>
            <option value="percent">{{ $t('adminCoupons.optionPercent') }}</option>
          </select>
        </label>
        <label>
          <span>{{ discountInputLabel(genForm) }}</span>
          <input
            :value="discountInputValue(genForm)"
            type="number"
            :min="discountInputMin(genForm)"
            :max="discountInputMax(genForm)"
            :step="discountInputStep(genForm)"
            :placeholder="discountInputPlaceholder(genForm)"
            required
            @input="setDiscountInputValue(genForm, ($event.target as HTMLInputElement).value)"
          />
          <small class="field-hint">{{ discountInputHint(genForm) }}</small>
        </label>
        <label>
          <span>{{ $t('adminCoupons.formCount') }}</span>
          <input v-model.number="genForm.count" type="number" required />
        </label>
        <label>
          <span>{{ $t('adminCoupons.formMaxUses') }}</span>
          <input v-model.number="genForm.maxUses" type="number" min="0" step="1" required />
          <small class="field-hint">{{ $t('adminCoupons.hintMaxUsesGenerate') }}</small>
        </label>
        <label>
          <span>{{ $t('adminCoupons.formExpiresAt') }}</span>
          <input v-model="genForm.expiresAt" type="datetime-local" :lang="locale" />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="generating" @click="generateVisible = false">{{ $t('adminCoupons.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="generating">
            {{ generating ? $t('adminCoupons.generating') : $t('adminCoupons.generate') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchAdminCoupons, createAdminCoupon, generateAdminCoupons, updateAdminCoupon, deleteAdminCoupon } from '@/api/admin'
import type { AdminCoupon, AdminCouponFilter, AdminCreateCouponBody, AdminGenerateCouponBody } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import { formatDate, toDateTimeLocalValue, dateTimeLocalToIso } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import { downloadCsv } from '@/lib/csv-export'
import { formatMoney, minorToMajorString, parseMajorToMinor } from '@shared/money'

const { t, locale } = useI18n()
const { showToast } = useToast()
const { token } = useAdminAuth()

const items = ref<AdminCoupon[]>([])
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const generating = ref(false)
const deletingCode = ref('')
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()
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
} = useTableSelection(items, (item) => item.code)
const filter = reactive<AdminCouponFilter>({
  productId: '',
  status: '',
  search: '',
  page: 1,
})

const pagination = useTablePagination()

const formVisible = ref(false)
const editing = ref(false)
const form = reactive<AdminCreateCouponBody>({
  productId: '',
  code: '',
  discountType: 'fixed',
  discountValue: 0,
  maxUses: 1,
  active: true,
  expiresAt: '',
})
let editingCode = ''

const generateVisible = ref(false)
const generatedVisible = ref(false)
const generatedCodes = ref<string[]>([])
const genForm = reactive<AdminGenerateCouponBody>({
  productId: '',
  prefix: '',
  discountType: 'fixed',
  discountValue: 0,
  maxUses: 1,
  active: true,
  expiresAt: '',
  count: 10,
})

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminCoupons(token.value, {
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
    loadError.value = err.message || t('adminCoupons.loadFailed')
    showToast(err.message || t('adminCoupons.loadFailed'), 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  loadData()
}

function openCreate() {
  editing.value = false
  editingCode = ''
  Object.assign(form, {
    productId: '',
    code: '',
    discountType: 'fixed',
    discountValue: 0,
    maxUses: 1,
    active: true,
    expiresAt: '',
  })
  formVisible.value = true
}

function openEdit(item: AdminCoupon) {
  editing.value = true
  editingCode = item.code
  Object.assign(form, {
    productId: item.productId || '',
    code: item.code,
    discountType: item.discountType || 'fixed',
    discountValue: item.discountValue || 0,
    // maxUses=0 表示不限：不能用 || 1，否则编辑「不限」码会静默改成 1（V-013 运营事故）
    maxUses: Number.isFinite(Number(item.maxUses)) ? Number(item.maxUses) : 1,
    active: item.active ?? true,
    expiresAt: toDateTimeLocalValue(item.expiresAt),
  })
  formVisible.value = true
}

async function save() {
  if (saving.value) return
  if (!(await validateCouponForm(form))) return
  saving.value = true
  try {
    const payload = couponPayload(form)
    if (editing.value) {
      await updateAdminCoupon(token.value, editingCode, payload)
      showToast(t('adminCoupons.saved'), 'success')
    } else {
      await createAdminCoupon(token.value, payload)
      showToast(t('adminCoupons.created'), 'success')
    }
    formVisible.value = false
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCoupons.saveFailed'), 'error')
  } finally {
    saving.value = false
  }
}

function openGenerate() {
  Object.assign(genForm, {
    productId: '',
    prefix: '',
    discountType: 'fixed',
    discountValue: 0,
    maxUses: 1,
    active: true,
    expiresAt: '',
    count: 10,
  })
  generateVisible.value = true
}

async function doGenerate() {
  if (generating.value) return
  if (!(await validateCouponForm(genForm))) return
  generating.value = true
  try {
    const res = await generateAdminCoupons(token.value, couponPayload(genForm))
    generatedCodes.value = res.codes
    showToast(t('adminCoupons.generated', { count: res.codes.length }), 'success')
    generateVisible.value = false
    generatedVisible.value = true
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCoupons.generateFailed'), 'error')
  } finally {
    generating.value = false
  }
}

async function copyCodes(codes: string[], successMessage: string) {
  if (codes.length === 0) return
  try {
    await writeClipboardText(codes.join('\n'))
    showToast(successMessage, 'success')
  } catch {
    showToast(t('adminCoupons.copyFailed'), 'error')
  }
}

function copySelectedCodes() {
  return copyCodes([...selectedIds.value], t('adminCoupons.selectedCopied', { count: selectedIds.value.length }))
}

function exportSelectedCodes() {
  const selected = new Set(selectedIds.value)
  const rows = items.value.filter((item) => selected.has(item.code))
  downloadCsv(`selected-coupons-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['code', 'productTitle', 'productId', 'discountType', 'discountValue', 'maxUses', 'usedCount', 'active', 'expiresAt'],
    // maxUses/usedCount 必须用 Number 再 String：|| '' 会把合法的 0（不限）抹成空串（V-013）
    ...rows.map((item) => [
      item.code,
      item.productTitle || '',
      item.productId || '',
      item.discountType || '',
      String(Number(item.discountValue) || 0),
      String(Number.isFinite(Number(item.maxUses)) ? Number(item.maxUses) : ''),
      String(Number.isFinite(Number(item.usedCount)) ? Number(item.usedCount) : 0),
      String(item.active ?? true),
      item.expiresAt || '',
    ]),
  ])
  showToast(t('adminCoupons.exported', { count: rows.length }), 'success')
}

function exportGeneratedCodes() {
  downloadCsv(`generated-coupons-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['code'],
    ...generatedCodes.value.map((code) => [code]),
  ])
  showToast(t('adminCoupons.fileDownloaded'), 'success')
}

type CouponForm = AdminCreateCouponBody | AdminGenerateCouponBody

function normalizeDiscountType(value: string): CouponForm['discountType'] {
  return value === 'percent' ? 'percent' : 'fixed'
}

function setDiscountType(target: CouponForm, value: string) {
  target.discountType = normalizeDiscountType(value)
  target.discountValue = 0
}

function discountInputLabel(target: CouponForm) {
  return target.discountType === 'percent' ? t('adminCoupons.formPercentAmount') : t('adminCoupons.formFixedAmount')
}

function discountInputPlaceholder(target: CouponForm) {
  return target.discountType === 'percent'
    ? t('adminCoupons.placeholderPercent')
    : t('adminCoupons.placeholderFixed')
}

function discountInputMin(target: CouponForm) {
  return target.discountType === 'percent' ? 1 : 0.01
}

function discountInputMax(target: CouponForm) {
  return target.discountType === 'percent' ? 100 : 1000
}

function discountInputStep(target: CouponForm) {
  return target.discountType === 'percent' ? 1 : 0.01
}

function discountInputValue(target: CouponForm) {
  const value = Number(target.discountValue || 0)
  if (value <= 0) return ''
  return target.discountType === 'percent' ? String(value) : minorToMajorString(value, 'CNY')
}

function setDiscountInputValue(target: CouponForm, rawValue: string) {
  if (target.discountType === 'percent') {
    const value = Number(rawValue)
    target.discountValue = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
    return
  }
  try {
    target.discountValue = parseMajorToMinor(rawValue, 'CNY')
  } catch {
    target.discountValue = 0
  }
}

function discountInputHint(target: CouponForm) {
  if (target.discountType === 'percent') {
    if (!target.discountValue) return t('adminCoupons.hintPercentEmpty')
    return formatPercentDiscount(target.discountValue)
  }
  if (!target.discountValue) return t('adminCoupons.hintFixedEmpty')
  return t('adminCoupons.hintCurrentFixed', { amount: formatMoney(target.discountValue, 'CNY') })
}

function formatPercentDiscount(value: number) {
  const percent = Math.max(1, Math.min(100, Math.round(Number(value || 0))))
  if (percent >= 100) return t('adminCoupons.percentFree')
  const payPercent = 100 - percent
  const discountName = Number.isInteger(payPercent / 10)
    ? `${payPercent / 10}${t('adminCoupons.percentOff')}`
    : `${(payPercent / 10).toFixed(1)}${t('adminCoupons.percentOff')}`
  return t('adminCoupons.percentFormat', { percent, payPercent, discountName })
}

function formatCouponDiscount(item: Pick<AdminCoupon, 'discountType' | 'discountValue'>) {
  const value = Number(item.discountValue || 0)
  if (item.discountType === 'percent') return formatPercentDiscount(value)
  return t('adminCoupons.formatFixed', { amount: formatMoney(value, 'CNY') })
}

async function validateCouponForm(target: CouponForm): Promise<boolean> {
  if (target.discountType === 'percent' && (target.discountValue < 1 || target.discountValue > 100)) {
    showToast(t('adminCoupons.validatePercentRange'), 'error')
    return false
  }
  if (target.discountType === 'fixed' && target.discountValue < 1) {
    showToast(t('adminCoupons.validateFixedMin'), 'error')
    return false
  }
  const maxUses = Number(target.maxUses)
  if (!Number.isInteger(maxUses) || maxUses < 0) {
    showToast(t('adminCoupons.validateMaxUses'), 'error')
    return false
  }
  // V-013：maxUses=0 合法但高风险（尤其全额折扣），强制运营二次确认
  if (maxUses === 0) {
    const ok = await askConfirm(t('adminCoupons.confirmMaxUsesZero'))
    if (!ok) return false
  }
  return true
}

function couponPayload<T extends CouponForm>(target: T): T {
  const maxUses = Number(target.maxUses)
  return {
    ...target,
    // 规范化：非法/空回落 1，0 保留为不限
    maxUses: Number.isInteger(maxUses) && maxUses >= 0 ? maxUses : 1,
    expiresAt: dateTimeLocalToIso(target.expiresAt),
  }
}

async function remove(code: string) {
  if (deletingCode.value || batchOperating.value) return
  if (!(await askConfirm(t('adminCoupons.confirmDeleteSingle')))) return
  deletingCode.value = code
  try {
    await deleteAdminCoupon(token.value, code)
    showToast(t('adminCoupons.deleted'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminCoupons.deleteFailed'), 'error')
  } finally {
    deletingCode.value = ''
  }
}

async function batchSetActive(active: boolean) {
  const codes = [...selectedIds.value]
  if (codes.length === 0 || loading.value || batchOperating.value) return
  const key = active ? 'confirmBatchEnable' : 'confirmBatchDisable'
  if (!(await askConfirm(t(`adminCoupons.${key}`, { count: codes.length })))) return
  const result = await runSequential(codes, async (code) => {
    await updateAdminCoupon(token.value, code, { active })
  })
  if (!result) return
  const resultKey = active ? 'batchEnableResult' : 'batchDisableResult'
  showToast(t(`adminCoupons.${resultKey}`, { success: result.success, failed: result.failed }), result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

async function batchRemove() {
  const codes = [...selectedIds.value]
  if (codes.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('adminCoupons.confirmBatchDelete', { count: codes.length })))) return
  const result = await runSequential(codes, async (code) => {
    await deleteAdminCoupon(token.value, code)
  })
  if (!result) return
  showToast(t('adminCoupons.batchDeleteResult', { success: result.success, failed: result.failed }), result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

onMounted(loadData)
</script>

<style>@import '@/assets/admin.css';</style>
<!-- modal-actions / relation-cell / generated-result → admin.css -->
