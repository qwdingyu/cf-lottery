<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ loading ? $t('adminPrizes.loading') : $t('adminPrizes.refresh') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading" @click="showCreate = true">
          {{ $t('adminPrizes.createPrize') }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminPrizes.retry') }}</button>
    </div>

    <!-- docs/082：奖品多选批量启停 -->
    <div v-if="prizeSelectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="prizeBatchOperating">
      <span class="selection-summary">
        {{ $t('adminPrizes.selectedCount', { count: prizeSelectedCount }) }}
        <template v-if="prizeBatchOperating">
          · {{ $t('adminPrizes.batchProgress', { done: prizeBatchCompleted, total: prizeBatchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || prizeBatchOperating" @click="clearPrizeSelection">
        {{ $t('adminPrizes.clearSelection') }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || prizeBatchOperating || prizeSelectedCount === 0" @click="batchSetPrizeActive(1)">
        {{ $t('adminPrizes.batchEnable', { count: prizeSelectedCount }) }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || prizeBatchOperating || prizeSelectedCount === 0" @click="batchSetPrizeActive(0)">
        {{ $t('adminPrizes.batchDisable', { count: prizeSelectedCount }) }}
      </button>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allPrizesSelected"
                :indeterminate.prop="prizePartiallySelected"
                :disabled="loading || prizeBatchOperating || prizes.length === 0"
                :aria-label="$t('adminPrizes.selectAll')"
                @change="toggleAllPrizes(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminPrizes.colImage') }}</th>
            <th>{{ $t('adminPrizes.colName') }}</th>
            <th>{{ $t('adminPrizes.colType') }}</th>
            <th>{{ $t('adminPrizes.colValue') }}</th>
            <th>{{ $t('adminPrizes.colDesc') }}</th>
            <th>{{ $t('adminPrizes.colPoolLeft') }}</th>
            <th>{{ $t('adminPrizes.colCreatedAt') }}</th>
            <th class="col-actions">{{ $t('adminPrizes.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="prize in prizes" :key="prize.id" :class="{ 'is-selected': isPrizeSelected(prize.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isPrizeSelected(prize.id)"
                :disabled="loading || prizeBatchOperating"
                :aria-label="$t('adminPrizes.selectRow')"
                @click="setPrizeSelected(prize.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
              />
            </td>
            <td>
              <img :src="prizeImageUrl(prize.imageUrl)" :alt="prize.name || $t('adminPrizes.prizeAlt')" class="prize-thumb" />
            </td>
            <td>
              {{ prize.name }}
              <small v-if="prize.fulfillmentNote" class="field-hint" style="display:block;max-width:200px">📋 {{ prize.fulfillmentNote }}</small>
            </td>
            <td>{{ prize.prizeType === 'code' ? $t('adminPrizes.typeCode') : $t('adminPrizes.typeManual') }}</td>
            <td>{{ prize.valueText || '-' }}</td>
            <td>{{ prize.description || '-' }}</td>
            <td>
              <template v-if="prize.prizeType === 'code'">
                <span :class="{ 'tag-danger': codePoolLeft(prize) <= 0, 'tag-success': codePoolLeft(prize) > 0 }">
                  {{ prize.usedCount || 0 }}/{{ prize.totalCount || 0 }}
                </span>
                <small class="field-hint" style="display:block">{{ $t('adminPrizes.leftLabel', { n: codePoolLeft(prize) }) }}</small>
                <!-- 空码池硬提示：卡密奖未灌库 = 中奖发不出，避免「空头支票」 -->
                <small v-if="codePoolLeft(prize) <= 0" class="pool-empty-warn">{{ $t('adminPrizes.poolEmptyWarn') }}</small>
              </template>
              <template v-else>—</template>
            </td>
            <td>{{ prize.createdAt }}</td>
            <td class="col-actions">
              <!-- 卡密主路径：生成置顶主色；导入/查看次之，避免「生成藏在导入 Tab」被误认为功能缺失 -->
              <template v-if="prize.prizeType === 'code'">
                <button
                  class="btn btn-primary btn-xs"
                  type="button"
                  :title="$t('adminPrizes.generateCodesTitle')"
                  @click="showGenerate(prize)"
                >{{ $t('adminPrizes.generateCodes') }}</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="showImport(prize)">{{ $t('adminPrizes.importCodes') }}</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="showCodes(prize)">{{ $t('adminPrizes.viewCodes') }}</button>
              </template>
              <button class="btn btn-ghost btn-xs" type="button" @click="showEdit(prize)">{{ $t('adminPrizes.edit') }}</button>
              <button class="btn btn-ghost btn-xs" type="button" :title="prize.active !== 0 ? $t('adminPrizes.deactivateTitle') : $t('adminPrizes.activateTitle')" @click="toggleActive(prize)">
                {{ prize.active !== 0 ? $t('adminPrizes.deactivate') : $t('adminPrizes.activate') }}
              </button>
            </td>
          </tr>
          <tr v-if="prizes.length === 0">
            <td colspan="9" class="empty-text">{{ $t('adminPrizes.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建奖品弹窗 -->
    <AdminModal hide-actions v-model="showCreate" :title="$t('adminPrizes.createTitle')" max-width="480px">
      <form @submit.prevent="handleCreate">
        <div class="modal-form">
          <label>
            <span>{{ $t('adminPrizes.prizeName') }}</span>
            <input v-model="form.name" required maxlength="100" :placeholder="$t('adminPrizes.namePlaceholder')" />
          </label>
          <label>
            <span>{{ $t('adminPrizes.prizeType') }}</span>
            <select v-model="form.prizeType">
              <option value="code">{{ $t('adminPrizes.typeCodeOption') }}</option>
              <option value="manual_fulfillment">{{ $t('adminPrizes.typeManualOption') }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('adminPrizes.desc') }}</span>
            <textarea v-model="form.description" maxlength="500" rows="2" :placeholder="$t('adminPrizes.descPlaceholder')" />
          </label>
          <label>
            <span>{{ $t('adminPrizes.imageUrl') }}</span>
            <div class="prize-image-editor">
              <img :src="prizeImageUrl(form.imageUrl)" :alt="$t('adminPrizes.previewAlt')" class="prize-preview" />
              <div class="prize-image-fields">
                <div class="image-upload-row">
                  <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingImage }">
                    {{ uploadingImage ? $t('adminPrizes.uploading') : $t('adminPrizes.uploadImage') }}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif"
                      :disabled="uploadingImage"
                      @change="uploadPrizeImage"
                    />
                  </label>
                  <small class="field-hint">{{ $t('adminPrizes.imageHint') }}</small>
                </div>
                <input v-model="form.imageUrl" maxlength="500" :placeholder="$t('adminPrizes.imageUrlPlaceholder')" />
              </div>
            </div>
          </label>
          <label>
            <span>{{ $t('adminPrizes.value') }}</span>
            <input v-model="form.valueText" maxlength="50" :placeholder="$t('adminPrizes.valuePlaceholder')" />
            <small class="field-hint">{{ $t('adminPrizes.valueHint') }}</small>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreate = false">{{ $t('adminPrizes.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? $t('adminPrizes.creating') : $t('adminPrizes.create') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 编辑奖品弹窗（复用创建表单） -->
    <AdminModal hide-actions v-model="showEditModal" :title="$t('adminPrizes.editTitle')" max-width="480px">
      <form @submit.prevent="handleEdit">
        <div class="modal-form">
          <label>
            <span>{{ $t('adminPrizes.prizeName') }}</span>
            <input v-model="editForm.name" required maxlength="100" :placeholder="$t('adminPrizes.namePlaceholder')" />
          </label>
          <label>
            <span>{{ $t('adminPrizes.desc') }}</span>
            <textarea v-model="editForm.description" maxlength="500" rows="2" :placeholder="$t('adminPrizes.descPlaceholder')" />
          </label>
          <label>
            <span>{{ $t('adminPrizes.imageUrl') }}</span>
            <div class="prize-image-editor">
              <img :src="prizeImageUrl(editForm.imageUrl)" :alt="$t('adminPrizes.previewAlt')" class="prize-preview" />
              <div class="prize-image-fields">
                <div class="image-upload-row">
                  <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingImage }">
                    {{ uploadingImage ? $t('adminPrizes.uploading') : $t('adminPrizes.uploadImage') }}
                    <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" :disabled="uploadingImage" @change="uploadEditImage" />
                  </label>
                </div>
                <input v-model="editForm.imageUrl" maxlength="500" :placeholder="$t('adminPrizes.imageUrlPlaceholder')" />
              </div>
            </div>
          </label>
          <label>
            <span>{{ $t('adminPrizes.value') }}</span>
            <input v-model="editForm.valueText" maxlength="50" :placeholder="$t('adminPrizes.valuePlaceholder')" />
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showEditModal = false">{{ $t('adminPrizes.cancel') }}</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? $t('adminPrizes.saving') : $t('adminPrizes.save') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 导入 / 生成卡密弹窗（同一弹窗双 Tab；行上「生成卡密」会默认落在生成 Tab） -->
    <AdminModal
      hide-actions
      v-model="showImportModal"
      :title="importTab === 'generate'
        ? $t('adminPrizes.generateTitle', { name: importPrize?.name || '' })
        : $t('adminPrizes.importTitle', { name: importPrize?.name || '' })"
      max-width="600px"
    >
      <p v-if="importPrize && codePoolLeft(importPrize) <= 0" class="notice-card pool-empty-banner" role="note">
        {{ $t('adminPrizes.poolEmptyModalHint') }}
      </p>
      <div class="tabs" style="margin-bottom:12px">
        <button type="button" class="tab" :class="{ active: importTab === 'generate' }" @click="importTab = 'generate'">{{ $t('adminPrizes.generateTab') }}</button>
        <button type="button" class="tab" :class="{ active: importTab === 'paste' }" @click="importTab = 'paste'">{{ $t('adminPrizes.pasteTab') }}</button>
      </div>

      <div v-if="importTab === 'paste'" class="modal-form">
        <label>
          <span>{{ $t('adminPrizes.codesTextLabel') }}</span>
          <textarea v-model="codesText" rows="8" :placeholder="$t('adminPrizes.codesTextPlaceholder')" />
        </label>
        <p class="field-hint">{{ $t('adminPrizes.codesTextHint') }}</p>
      </div>

      <div v-if="importTab === 'generate'" class="modal-form">
        <label>
          <span>{{ $t('adminPrizes.genCountLabel') }}</span>
          <input v-model.number="genCount" type="number" min="1" max="1000" :placeholder="$t('adminPrizes.genCountPlaceholder')" />
        </label>
        <label>
          <span>{{ $t('adminPrizes.prefixLabel') }}</span>
          <input v-model="genPrefix" maxlength="20" :placeholder="$t('adminPrizes.prefixPlaceholder')" />
          <small class="field-hint">{{ $t('adminPrizes.prefixHint') }}</small>
        </label>
        <label>
          <span>{{ $t('adminPrizes.codeLenLabel') }}</span>
          <input v-model.number="genCodeLen" type="number" min="4" max="32" :placeholder="$t('adminPrizes.codeLenPlaceholder')" />
          <small class="field-hint">{{ $t('adminPrizes.codeLenHint') }}</small>
        </label>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" @click="showImportModal = false">{{ $t('adminPrizes.cancel') }}</button>
        <button v-if="importTab === 'paste'" type="button" class="btn btn-primary btn-sm" :disabled="importing" @click="handleImport">
          {{ importing ? $t('adminPrizes.importing') : $t('adminPrizes.import') }}
        </button>
        <button v-if="importTab === 'generate'" type="button" class="btn btn-primary btn-sm" :disabled="importing" @click="handleGenerate">
          {{ importing ? $t('adminPrizes.generating') : $t('adminPrizes.generate') }}
        </button>
      </div>
    </AdminModal>

    <!-- 查看码弹窗：真多选删除（仅勾选且 available），禁止「本页全部盲删」 -->
    <AdminModal hide-actions v-model="showCodesModal" :title="$t('adminPrizes.codesTitle', { name: codesPrize?.name || '' })" max-width="800px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <select v-model="codesFilter" @change="onCodesFilterChange">
          <option value="">{{ $t('adminPrizes.allStatus') }}</option>
          <option value="available">{{ $t('adminPrizes.available') }}</option>
          <option value="issued">{{ $t('adminPrizes.issued') }}</option>
        </select>
        <input
          v-model="codeSearch"
          type="search"
          :placeholder="$t('adminPrizes.searchCode')"
          :aria-label="$t('adminPrizes.searchCodeAria')"
          style="width:180px;padding:6px 10px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,0.15));background:var(--tg-bg,#1f2937);color:var(--tg-text,#f0f2f5)"
          @keyup.enter="loadCodes(true)"
        />
        <span class="field-hint">{{ $t('adminPrizes.codesSummary', { total: codesTotal, avail: totalAvailable, issued: totalIssued }) }}</span>
        <button class="btn btn-ghost btn-xs" type="button" :disabled="codesLoading || codeBatchOperating" @click="loadCodes(true)">{{ $t('adminPrizes.refresh') }}</button>
        <button class="btn btn-primary btn-xs" type="button" :disabled="codeBatchOperating" @click="exportCodes">{{ $t('adminPrizes.exportCsv') }}</button>
      </div>

      <div v-if="codeSelectedCount > 0" class="table-command-actions bulk-bar" style="margin-bottom:12px" :aria-busy="codeBatchOperating">
        <span class="selection-summary">
          {{ $t('adminPrizes.selectedCount', { count: codeSelectedCount }) }}
          · {{ $t('adminPrizes.selectedDeletableCodes', { count: codeDeletableCount }) }}
          <template v-if="codeBatchOperating">
            · {{ $t('adminPrizes.batchProgress', { done: codeBatchCompleted, total: codeBatchTotal }) }}
          </template>
        </span>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="codeBatchOperating" @click="clearCodeSelection">
          {{ $t('adminPrizes.clearSelection') }}
        </button>
        <button
          class="btn btn-danger btn-sm"
          type="button"
          :disabled="codeBatchOperating || codeDeletableCount === 0"
          @click="batchDeleteSelectedCodes"
        >
          {{ $t('adminPrizes.batchDeleteSelected', { count: codeDeletableCount }) }}
        </button>
      </div>

      <div v-if="codesLoading" class="skeleton-list">
        <div v-for="i in 5" :key="'sk' + i" class="skeleton-line" />
      </div>
      <div v-else-if="codesList.length === 0" class="empty-text">{{ $t('adminPrizes.noCodes') }}</div>
      <div v-else class="table-wrap" style="max-height:400px;overflow-y:auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th class="select-cell">
                <input
                  type="checkbox"
                  :checked="allCodesSelected"
                  :indeterminate.prop="codePartiallySelected"
                  :disabled="codesLoading || codeBatchOperating || codeSelectableCount === 0"
                  :aria-label="$t('adminPrizes.selectAllCodes')"
                  @change="toggleAllCodes(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>{{ $t('adminPrizes.colCode') }}</th>
              <th>{{ $t('adminPrizes.colSecret') }}</th>
              <th>{{ $t('adminPrizes.colStatus') }}</th>
              <th>{{ $t('adminPrizes.colWinner') }}</th>
              <th>{{ $t('adminPrizes.colIssuedAt') }}</th>
              <th class="col-actions">{{ $t('adminPrizes.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in codesList" :key="c.id" :class="{ 'is-selected': isCodeSelected(c.id) }">
              <td class="select-cell">
                <input
                  type="checkbox"
                  :checked="isCodeSelected(c.id)"
                  :disabled="codesLoading || codeBatchOperating || !canDeleteCodeRow(c)"
                  :aria-label="$t('adminPrizes.selectCodeRow')"
                  @click="setCodeSelected(c.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
                />
              </td>
              <td>
                <code class="code-cell">{{ c.code }}</code>
              </td>
              <td>
                <code v-if="c.secret" class="code-cell" style="font-size:11px">{{ c.secret }}</code>
                <span v-else class="field-hint">—</span>
              </td>
              <td>
                <span :class="c.status === 'available' ? 'tag-success' : 'tag-muted'">
                  {{ c.status === 'available' ? $t('adminPrizes.available') : $t('adminPrizes.issued') }}
                </span>
              </td>
              <td>{{ c.winnerId || '—' }}</td>
              <td>{{ c.issuedAt || '—' }}</td>
              <td class="col-actions">
                <button class="btn btn-ghost btn-xs" type="button" @click="copyCode(c.code, c.secret)">{{ $t('adminPrizes.copy') }}</button>
                <button v-if="canDeleteCodeRow(c)" class="btn btn-ghost btn-xs" type="button" style="color:var(--tg-danger)" @click="deleteCode(c)">{{ $t('adminPrizes.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="codesTotal > 50" style="margin-top:8px;display:flex;gap:8px;align-items:center;justify-content:center">
        <button class="btn btn-ghost btn-xs" type="button" :disabled="codesPage <= 0 || codeBatchOperating" @click="codesPage--; loadCodes()">{{ $t('adminPrizes.prevPage') }}</button>
        <span class="field-hint">{{ codesPage * 50 + 1 }}-{{ Math.min((codesPage + 1) * 50, codesTotal) }} / {{ codesTotal }}</span>
        <button class="btn btn-ghost btn-xs" type="button" :disabled="(codesPage + 1) * 50 >= codesTotal || codeBatchOperating" @click="codesPage++; loadCodes()">{{ $t('adminPrizes.nextPage') }}</button>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import { adminRequest } from '@/composables/useAdminRequest'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { canDeletePrizeCode, prizeCodePoolLeft } from './lottery/ops-utils'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const importing = ref(false)
const uploadingImage = ref(false)
const showCreate = ref(false)
const showImportModal = ref(false)
const showEditModal = ref(false)
const editingPrize = ref<any>(null)
const editForm = ref({ name: '', description: '', imageUrl: '', valueText: '' })
const showCodesModal = ref(false)
const codesPrize = ref<any>(null)
const codesList = ref<any[]>([])
const codesLoading = ref(false)
const codesFilter = ref('')
/** 码文本搜索（047 文档 🔴） */
const codeSearch = ref('')
const codesPage = ref(0)
const codesTotal = ref(0)
const totalAvailable = ref(0)
const totalIssued = ref(0)
const importPrize = ref<any>(null)
const codesText = ref('')
const importTab = ref<'paste' | 'generate'>('paste')
const genCount = ref(100)
const genPrefix = ref('')
const genCodeLen = ref(8)
const prizes = ref<any[]>([])

// ── 奖品列表多选（批量启停）──
const prizesRef = computed(() => prizes.value)
const {
  operating: prizeBatchOperating,
  completed: prizeBatchCompleted,
  total: prizeBatchTotal,
  runSequential: runPrizeBatch,
} = useAdminBatchOperation()
const {
  selectedIds: prizeSelectedIds,
  selectedCount: prizeSelectedCount,
  isSelected: isPrizeSelected,
  setSelected: setPrizeSelected,
  toggleAllVisible: toggleAllPrizes,
  clearSelection: clearPrizeSelection,
  allVisibleSelected: allPrizesSelected,
  partiallySelected: prizePartiallySelected,
} = useTableSelection(prizesRef, (row) => row.id)

// ── 码池多选（仅 available 可勾选删除）──
const codesRef = computed(() => codesList.value)
const {
  operating: codeBatchOperating,
  completed: codeBatchCompleted,
  total: codeBatchTotal,
  runSequential: runCodeBatch,
} = useAdminBatchOperation()
const {
  selectedIds: codeSelectedIds,
  selectedCount: codeSelectedCount,
  selectableCount: codeSelectableCount,
  isSelected: isCodeSelected,
  setSelected: setCodeSelected,
  toggleAllVisible: toggleAllCodes,
  clearSelection: clearCodeSelection,
  allVisibleSelected: allCodesSelected,
  partiallySelected: codePartiallySelected,
} = useTableSelection(codesRef, (row) => row.id, {
  isSelectable: (row) => canDeletePrizeCode(String(row.status || '')),
})

const codeDeletableCount = computed(
  () => codesList.value.filter((c) => codeSelectedIds.value.includes(c.id) && canDeletePrizeCode(String(c.status || ''))).length,
)

function canDeleteCodeRow(c: { status?: string }) {
  return canDeletePrizeCode(String(c.status || ''))
}

watch(showCodesModal, (open) => {
  if (!open) clearCodeSelection()
})

const form = ref({
  name: '',
  description: '',
  prizeType: 'code',
  imageUrl: '',
  valueText: '',
})

const DEFAULT_PRIZE_IMAGE = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <rect width="160" height="160" rx="18" fill="#1f2937"/>
  <rect x="43" y="66" width="74" height="54" rx="8" fill="#f59e0b"/>
  <rect x="38" y="52" width="84" height="20" rx="7" fill="#fbbf24"/>
  <path d="M80 52c-18-18-38-8-24 12h24V52Zm0 0c18-18 38-8 24 12H80V52Z" fill="#fde68a"/>
  <path d="M77 52h6v68h-6z" fill="#92400e" opacity=".45"/>
</svg>
`)}`

function prizeImageUrl(url?: string) {
  const trimmed = String(url || '').trim()
  return trimmed || DEFAULT_PRIZE_IMAGE
}

async function uploadPrizeImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingImage.value) return
  if (file.size <= 0) {
    showToast(t('adminPrizes.nonEmptyImage'), 'error')
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast(t('adminPrizes.imageTooLarge'), 'error')
    return
  }

  uploadingImage.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const data = await adminRequest<{ url: string }>('/api/admin/media/images', {
      method: 'POST',
      body,
    })
    form.value.imageUrl = data.url || ''
    showToast(t('adminPrizes.imageUploaded'), 'success')
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.imageUploadFailed'), 'error')
  } finally {
    uploadingImage.value = false
  }
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ prizes: any[] }>('/api/admin/prizes')
    prizes.value = data.prizes || []
  } catch (err: any) {
    loadError.value = err.message || t('adminPrizes.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  submitting.value = true
  try {
    await adminRequest('/api/admin/prizes', {
      method: 'POST',
      body: JSON.stringify(form.value),
    })
    showToast(t('adminPrizes.createSuccess'), 'success')
    showCreate.value = false
    form.value = { name: '', description: '', prizeType: 'code', imageUrl: '', valueText: '' }
    await loadData()
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.createFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

/** 码池剩余；与 ops 无关的行内展示，保持与 used/total 一致 */
function codePoolLeft(prize: { totalCount?: number; usedCount?: number }) {
  return prizeCodePoolLeft(prize)
}

/** 打开导入弹窗（粘贴 Tab） */
function showImport(prize: any) {
  importPrize.value = prize
  codesText.value = ''
  importTab.value = 'paste'
  showImportModal.value = true
}

/**
 * 打开生成弹窗（生成 Tab 优先）。
 * 为什么独立入口：用户常以为「卡密生成被删」——其实藏在导入里的次要 Tab。
 */
function showGenerate(prize: any) {
  importPrize.value = prize
  codesText.value = ''
  importTab.value = 'generate'
  // 空池时给一个更贴合名额的默认量，仍可改
  if (codePoolLeft(prize) <= 0 && (!genCount.value || genCount.value < 1)) {
    genCount.value = 100
  }
  showImportModal.value = true
}

async function showCodes(prize: any) {
  codesPrize.value = prize
  codesFilter.value = ''
  codeSearch.value = ''
  codesPage.value = 0
  totalAvailable.value = 0
  totalIssued.value = 0
  clearCodeSelection()
  showCodesModal.value = true
  await loadCodes()
}

function onCodesFilterChange() {
  clearCodeSelection()
  void loadCodes(true)
}

async function loadCodes(resetPage = false) {
  if (!codesPrize.value) return
  if (resetPage) codesPage.value = 0
  codesLoading.value = true
  try {
    const params = new URLSearchParams()
    if (codesFilter.value) params.set('status', codesFilter.value)
    if (codeSearch.value.trim()) params.set('search', codeSearch.value.trim())
    params.set('limit', '50')
    params.set('offset', String(codesPage.value * 50))
    const data = await adminRequest<any>(`/api/admin/prizes/${codesPrize.value.id}/codes?${params}`)
    codesList.value = data.codes || []
    codesTotal.value = data.total ?? 0
    totalAvailable.value = data.totalAvailable ?? 0
    totalIssued.value = data.totalIssued ?? 0
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.loadFailed'), 'error')
  } finally {
    codesLoading.value = false
  }
}

async function copyCode(code: string, secret?: string) {
  const text = secret ? `${code}:${secret}` : code
  try {
    await navigator.clipboard.writeText(text)
    showToast(t('adminPrizes.copySuccess'), 'success')
  } catch {
    showToast(t('adminPrizes.copyFailed'), 'error')
  }
}

async function deleteCode(code: any) {
  if (!(await askConfirm(t('adminPrizes.deleteConfirm', { code: code.code })))) return
  try {
    await adminRequest(`/api/admin/prizes/codes/${code.id}`, { method: 'DELETE' })
    showToast(t('adminPrizes.deleted'), 'success')
    await loadCodes()
    // 刷新奖品列表（更新码池余量）
    await loadData()
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.deleteFailed'), 'error')
  }
}

async function exportCodes() {
  if (!codesPrize.value) return
  const params = new URLSearchParams()
  if (codesFilter.value) params.set('status', codesFilter.value)
  const token = localStorage.getItem('admin_token') || ''
  const url = `/api/admin/prizes/${codesPrize.value.id}/codes/export?${params}`
  // 直接用 fetch 下载文件，绕过 adminRequest 的 JSON 解析
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) { showToast(t('adminPrizes.exportFailed'), 'error'); return }
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${codesPrize.value.name}-${t('adminPrizes.colPoolLeft')}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

/**
 * 批量删除：仅已勾选且 available。
 * 优先 POST /prizes/codes/batch-delete；失败降级顺序单条 DELETE（docs/082 P2）。
 */
async function batchDeleteSelectedCodes() {
  if (!codesPrize.value || codeBatchOperating.value) return
  const targets = codesList.value.filter(
    (c) => codeSelectedIds.value.includes(c.id) && canDeletePrizeCode(String(c.status || '')),
  )
  if (targets.length === 0) return
  if (!(await askConfirm(t('adminPrizes.batchDeleteSelectedConfirm', { count: targets.length })))) return

  const targetIds = targets.map((c) => c.id as string)
  codeBatchOperating.value = true
  codeBatchCompleted.value = 0
  codeBatchTotal.value = targetIds.length
  let deleted = 0
  let failed = 0
  try {
    const data = await adminRequest<{ deleted: number; failed: number }>(
      '/api/admin/prizes/codes/batch-delete',
      { method: 'POST', body: JSON.stringify({ ids: targetIds }) },
    )
    codeBatchCompleted.value = targetIds.length
    deleted = data.deleted
    failed = data.failed
  } catch {
    codeBatchOperating.value = false
    const result = await runCodeBatch(targetIds, async (id) => {
      await adminRequest(`/api/admin/prizes/codes/${id}`, { method: 'DELETE' })
    })
    if (!result) return
    deleted = result.success
    failed = result.failed
  } finally {
    codeBatchOperating.value = false
  }

  showToast(
    t('adminPrizes.batchDeleteDone', {
      deleted,
      failedText: failed > 0 ? t('adminPrizes.batchDeleteFailedSuffix', { failed }) : '',
    }),
    failed > 0 ? 'error' : 'success',
  )
  clearCodeSelection()
  await loadCodes(true)
  await loadData()
}

/** 批量启停：顺序 PATCH active，测试清场与运营停用脏奖品 */
async function batchSetPrizeActive(active: 0 | 1) {
  if (prizeBatchOperating.value || loading.value) return
  const ids = prizeSelectedIds.value.slice()
  if (ids.length === 0) return
  const okConfirm = await askConfirm(
    active
      ? t('adminPrizes.batchEnableConfirm', { count: ids.length })
      : t('adminPrizes.batchDisableConfirm', { count: ids.length }),
  )
  if (!okConfirm) return
  const result = await runPrizeBatch(ids, async (id) => {
    await adminRequest(`/api/admin/prizes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    })
  })
  if (!result) return
  if (result.failed > 0) {
    showToast(t('adminPrizes.batchActiveResult', { success: result.success, failed: result.failed }), 'error')
  } else {
    showToast(
      active
        ? t('adminPrizes.batchEnableSuccess', { count: result.success })
        : t('adminPrizes.batchDisableSuccess', { count: result.success }),
      'success',
    )
  }
  clearPrizeSelection()
  await loadData()
}

function showEdit(prize: any) {
  editingPrize.value = prize
  editForm.value = {
    name: prize.name || '',
    description: prize.description || '',
    imageUrl: prize.imageUrl || '',
    valueText: prize.valueText || '',
  }
  showEditModal.value = true
}

async function handleEdit() {
  submitting.value = true
  try {
    await adminRequest(`/api/admin/prizes/${editingPrize.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify(editForm.value),
    })
    showToast(t('adminPrizes.saveSuccess'), 'success')
    showEditModal.value = false
    await loadData()
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.saveFailed'), 'error')
  } finally {
    submitting.value = false
  }
}

async function uploadEditImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingImage.value) return
  if (file.size > 2 * 1024 * 1024) { showToast(t('adminPrizes.imageTooLarge'), 'error'); return }
  uploadingImage.value = true
  try {
    const body = new FormData(); body.append('file', file)
    const data = await adminRequest<{ url: string }>('/api/admin/media/images', { method: 'POST', body })
    editForm.value.imageUrl = data.url || ''
    showToast(t('adminPrizes.imageUploadedShort'), 'success')
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.uploadFailed'), 'error')
  } finally { uploadingImage.value = false }
}

async function handleImport() {
  importing.value = true
  try {
    const codes = codesText.value
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [code, secret] = l.split(':')
        return { code: code.trim(), secret: (secret || '').trim() }
      })

    if (codes.length === 0) {
      showToast(t('adminPrizes.atLeastOneCode'), 'error')
      return
    }

    const data = await adminRequest<{ imported?: number; skipped?: number }>(`/api/admin/prizes/${importPrize.value.id}/codes/import`, {
      method: 'POST',
      body: JSON.stringify({ codes }),
    })
    showToast(
      t('adminPrizes.importSuccess', {
        count: data.imported ?? codes.length,
        skippedText: data.skipped ? t('adminPrizes.importSkippedSuffix', { skipped: data.skipped }) : '',
      }),
      'success',
    )
    showImportModal.value = false
    await loadData()
    // 自动打开码池查看
    showCodes(importPrize.value)
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.importFailed'), 'error')
  } finally {
    importing.value = false
  }
}

async function toggleActive(prize: any) {
  try {
    const newActive = prize.active !== 0 ? 0 : 1;
    await adminRequest(`/api/admin/prizes/${prize.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: newActive }),
    });
    prize.active = newActive;
    showToast(newActive ? t('adminPrizes.prizeEnabled') : t('adminPrizes.prizeDisabled'), 'success');
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.opFailed'), 'error');
  }
}

async function handleGenerate() {
  if (!importPrize.value) return
  importing.value = true
  try {
    const data = await adminRequest<{ generated: number }>(`/api/admin/prizes/${importPrize.value.id}/codes/generate`, {
      method: 'POST',
      body: JSON.stringify({
        count: genCount.value || 100,
        prefix: genPrefix.value.trim(),
        codeLength: genCodeLen.value || 8,
      }),
    })
    showToast(t('adminPrizes.generateSuccess', { count: data.generated }), 'success')
    showImportModal.value = false
    await loadData()
    showCodes(importPrize.value)
  } catch (err: any) {
    showToast(err?.message || t('adminPrizes.generateFailed'), 'error')
  } finally {
    importing.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.prize-thumb,
.prize-preview {
  display: block;
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 8px;
  background: var(--tg-secondary-bg, #151b28);
}

.pool-empty-warn {
  display: block;
  margin-top: 2px;
  color: var(--tg-danger, #ef4444);
  font-size: 11px;
  font-weight: 600;
}

.pool-empty-banner {
  margin-bottom: 12px;
  font-size: 13px;
}

.prize-preview {
  width: 72px;
  height: 72px;
  flex: 0 0 auto;
}

.prize-image-editor {
  display: flex;
  gap: 12px;
  align-items: center;
}

.prize-image-fields {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.image-upload-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.image-upload-button {
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.image-upload-button.is-disabled {
  cursor: wait;
  opacity: 0.65;
}

.image-upload-button input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.code-cell { font-size: 13px; font-family: monospace; word-break: break-all; }
</style>
