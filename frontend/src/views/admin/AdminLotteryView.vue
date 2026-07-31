<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="statusFilter" :aria-label="$t('lottery.adminStatus')">
          <option value="">{{ $t('lottery.adminStatusAll') }}</option>
          <option value="draft">{{ $t('lottery.adminDrawDraft') }}</option>
          <option value="open">{{ $t('lottery.statusOpen') }}</option>
          <option value="paused">{{ $t('lottery.statusPaused') }}</option>
          <option value="drawing">{{ $t('lottery.statusDrawing') }}</option>
          <option value="drawn">{{ $t('lottery.statusDrawn') }}</option>
          <option value="cancelled">{{ $t('lottery.adminDrawCancelled') }}</option>
        </select>
        <input
          v-model="listQuery"
          type="search"
          :placeholder="$t('lottery.adminSearchPlaceholder')"
          :aria-label="$t('lottery.adminSearchAria')"
        />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ $t('lottery.adminReload') }}
        </button>
        <span
          v-if="hasListFilter"
          class="muted-text"
          style="align-self: center; font-size: 12px"
        >{{ $t('lottery.adminListCount', { shown: filteredDraws.length, total: draws.length }) }}</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || creating" @click="openCreate">
          {{ $t('lottery.adminDrawCreate') }}
        </button>
      </div>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions">
      <span class="selection-summary">
        {{ t('lottery.adminSelectedCount', { count: selectedCount }) }}
      </span>
      <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">
        {{ t('lottery.adminClearSelection') }}
      </button>
      <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCount === 0" @click="batchDeleteDraws">
        {{ t('lottery.adminBatchDelete', { count: selectedCount }) }}
      </button>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">
        {{ $t('lottery.adminReload') }}
      </button>
    </div>

    <div class="notice-card" role="note">
      <strong>{{ $t('lottery.adminNoticeTitle') }}</strong>
      <span>{{ $t('lottery.adminNoticeBody') }}</span>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminLayout.menuLottery')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminLayout.menuLottery')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate="selectedCount > 0 && !allVisibleSelected"
                :disabled="loading || batchOperating"
                :aria-label="$t('lottery.adminSelectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('lottery.adminName') }}</th>
            <th>{{ $t('lottery.product') }}</th>
            <th class="col-status">{{ $t('lottery.adminStatus') }}</th>
            <th class="col-num">{{ $t('lottery.adminEntryCount') }}</th>
            <th class="col-num">{{ $t('lottery.winnerCount') }}</th>
            <th>{{ $t('lottery.adminEntryWindow') }}</th>
            <th>{{ $t('lottery.drawTime') }}</th>
            <th class="col-actions">{{ $t('lottery.adminActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="draw in filteredDraws" :key="draw.id" :class="{ 'is-selected': isSelected(draw.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(draw.id)"
                :disabled="loading || batchOperating || !canDeleteDraw(draw)"
                :aria-label="$t('lottery.adminSelectRow')"
                @change="setSelected(draw.id, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="col-name">
              <div class="relation-cell">
                <span class="draw-name">{{ draw.name }}</span>
                <small v-if="draw.description" class="draw-desc">{{ draw.description }}</small>
                <small
                  v-if="draw.failureReason"
                  class="failure-snippet"
                  :title="draw.failureReason"
                >
                  {{ $t('lottery.adminFailureReason') }}：{{ shortFailure(draw.failureReason) }}
                </small>
              </div>
            </td>
            <td>
              <div class="relation-cell">
                <span>{{ draw.productTitle || draw.productId || '-' }}</span>
                <small v-if="draw.productTitle && draw.productId">{{ draw.productId }}</small>
              </div>
            </td>
            <td class="col-status">
              <div class="time-stack">
                <span class="tag" :class="statusClass(draw.status)">
                  {{ statusLabel(draw.status) }}
                </span>
                <small class="muted-text">{{ visibilityLabel(draw) }}</small>
              </div>
            </td>
            <td class="col-num">
              <div class="time-stack time-stack-end">
                <span>{{ entryProgress(draw) }}</span>
                <small v-if="participantsMeta(draw)">{{ participantsMeta(draw) }}</small>
              </div>
            </td>
            <td class="col-num">
              <div class="time-stack time-stack-end">
                <span>
                  <span v-if="draw.winnerCount !== undefined">{{ draw.winnerCount }}</span>
                  <span v-else class="muted-text">-</span>
                  <span class="muted-text"> / {{ draw.maxWinners }}</span>
                </span>
                <small>{{ $t('lottery.adminWinnersOfMax') }}</small>
              </div>
            </td>
            <td>
              <div class="time-stack">
                <span>{{ formatDate(draw.startTime) }}</span>
                <small>{{ $t('lottery.adminWindowTo') }} {{ formatDate(draw.endTime) }}</small>
              </div>
            </td>
            <td>
              <div class="time-stack">
                <span>{{ formatDate(draw.drawTime) }}</span>
              </div>
            </td>
            <td class="col-actions">
              <div class="table-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="$t('lottery.adminCopyLinkHint')"
                  @click="handleCopyShareLink(draw)"
                >{{ $t('lottery.adminCopyLink') }}</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="$t('lottery.adminOpenPublicHint')"
                  @click="handleOpenPublic(draw)"
                >{{ $t('lottery.adminOpenPublic') }}</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="$t('lottery.adminDuplicateHint')"
                  @click="handleDuplicate(draw)"
                >{{ $t('lottery.adminDuplicate') }}</button>
                <button
                  v-if="draw.status === 'draft'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleEdit(draw)"
                >{{ $t('lottery.adminEdit') }}</button>
                <button
                  v-if="draw.status === 'draft'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleOpen(draw.id)"
                >{{ operatingId === draw.id ? $t('shop.loading') : $t('lottery.adminDrawOpen') }}</button>
                <button
                  v-if="draw.status === 'open'"
                  type="button"
                  class="btn btn-primary btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleDraw(draw)"
                >{{ operatingId === draw.id ? $t('shop.loading') : $t('lottery.adminDrawNow') }}</button>
                <button
                  v-if="draw.status === 'open'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handlePause(draw.id)"
                >{{ operatingId === draw.id ? $t('shop.loading') : $t('lottery.adminPause') }}</button>
                <button
                  v-if="draw.status === 'paused'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleResume(draw.id)"
                >{{ operatingId === draw.id ? $t('shop.loading') : $t('lottery.adminResume') }}</button>
                <button
                  v-if="draw.status === 'drawn'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleToggleVisibility(draw.id, draw.visible)"
                >{{ draw.visible ? $t('lottery.adminHide') : $t('lottery.adminShow') }}</button>
                <button
                  v-if="draw.status === 'drawn' || draw.status === 'drawing'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id || winnersLoading"
                  @click="viewWinners(draw.id)"
                >{{ $t('lottery.checkResult') }}</button>
                <button
                  v-if="draw.status === 'drawing'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleRecover(draw.id)"
                >{{ operatingId === draw.id ? $t('shop.loading') : $t('lottery.adminRecoverDrawing') }}</button>
                <button
                  v-if="draw.status === 'drawn'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleRetryEmail(draw.id)"
                >{{ operatingId === draw.id ? $t('shop.loading') : $t('lottery.adminRetryEmail') }}</button>
                <button
                  v-if="draw.status === 'draft' || draw.status === 'open' || draw.status === 'paused'"
                  type="button"
                  class="btn btn-danger btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleCancel(draw.id)"
                >{{ $t('lottery.adminDrawCancel') }}</button>
                <button
                  v-if="canDeleteDraw(draw)"
                  type="button"
                  class="btn btn-danger btn-xs"
                  :disabled="batchOperating"
                  @click="handleDelete(draw.id)"
                >{{ $t('lottery.adminDrawDelete') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredDraws.length === 0">
            <td colspan="9" class="empty-text">{{ hasListFilter ? $t('lottery.adminNoMatch') : $t('lottery.adminNoData') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建/编辑活动：对齐商品编辑分区布局 + 时间快捷与校验 -->
    <AdminModal
      v-model="showCreateModal"
      :title="isEditing ? $t('lottery.adminDrawEdit') : $t('lottery.adminDrawCreate')"
      max-width="720px"
      hide-actions
    >
      <form class="modal-form lottery-editor-form" @submit.prevent="handleCreate">
        <div class="lottery-editor-scroll">
          <section class="form-section" aria-labelledby="lottery-basic">
            <header class="form-section-head">
              <h4 id="lottery-basic" class="form-section-title">{{ $t('lottery.adminSectionBasic') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionBasicDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>{{ $t('lottery.adminName') }}</span>
                <input
                  v-model="form.name"
                  maxlength="120"
                  required
                  autocomplete="off"
                  :placeholder="$t('lottery.adminNamePlaceholder')"
                />
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.product') }}</span>
                <AdminProductSelect
                  v-model="form.productId"
                  :placeholder="$t('lottery.adminProductPlaceholder')"
                  :aria-label="$t('lottery.product')"
                  fulfillment-mode="card"
                  required
                />
                <small class="field-hint">{{ $t('lottery.adminProductHint') }}</small>
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.adminDescription') }}</span>
                <textarea
                  v-model="form.description"
                  maxlength="500"
                  rows="2"
                  :placeholder="$t('lottery.adminDescriptionPlaceholder')"
                />
              </label>
            </div>
          </section>

          <section class="form-section" aria-labelledby="lottery-time">
            <header class="form-section-head">
              <h4 id="lottery-time" class="form-section-title">{{ $t('lottery.adminSectionTime') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionTimeDesc') }}</p>
            </header>

            <div class="time-preset-row" role="group" :aria-label="$t('lottery.adminTimePresets')">
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('5m')">
                {{ $t('lottery.adminPreset5m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('10m')">
                {{ $t('lottery.adminPreset10m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('20m')">
                {{ $t('lottery.adminPreset20m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('30m')">
                {{ $t('lottery.adminPreset30m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('1h')">
                {{ $t('lottery.adminPreset1h') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('1d')">
                {{ $t('lottery.adminPreset1d') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('3d')">
                {{ $t('lottery.adminPreset3d') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('7d')">
                {{ $t('lottery.adminPreset7d') }}
              </button>
            </div>

            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('lottery.adminStartTime') }}</span>
                <input v-model="form.startTime" type="datetime-local" step="60" :lang="locale" required />
                <small class="field-hint">{{ $t('lottery.adminStartTimeHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.adminEndTime') }}</span>
                <input v-model="form.endTime" type="datetime-local" step="60" :lang="locale" required />
                <small class="field-hint">{{ $t('lottery.adminEndTimeHint') }}</small>
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.drawTime') }}</span>
                <input v-model="form.drawTime" type="datetime-local" step="60" :lang="locale" required />
                <small class="field-hint">{{ $t('lottery.adminDrawTimeHint') }}</small>
              </label>
            </div>

            <p
              class="time-timeline"
              :class="{ 'is-invalid': Boolean(timeOrderError) }"
              role="status"
            >
              <template v-if="timeOrderError">{{ timeOrderError }}</template>
              <template v-else-if="form.startTime && form.endTime && form.drawTime">
                {{ $t('lottery.adminTimeOrderOk') }}
                <strong>{{ formatLocalInput(form.startTime) }}</strong>
                →
                <strong>{{ formatLocalInput(form.endTime) }}</strong>
                →
                <strong>{{ formatLocalInput(form.drawTime) }}</strong>
              </template>
              <template v-else>{{ $t('lottery.adminTimeOrderHint') }}</template>
            </p>
          </section>

          <section class="form-section" aria-labelledby="lottery-prizes">
            <header class="form-section-head">
              <h4 id="lottery-prizes" class="form-section-title">{{ $t('lottery.adminSectionPrizes') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionPrizesDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('lottery.winnerCount') }}</span>
                <input v-model.number="form.maxWinners" type="number" min="1" max="9999" step="1" required />
                <small class="field-hint">{{ $t('lottery.winnerCountHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.maxParticipants') }}</span>
                <input
                  v-model.number="form.maxParticipants"
                  type="number"
                  min="1"
                  max="999999"
                  step="1"
                  :placeholder="$t('lottery.maxParticipantsPlaceholder')"
                />
                <small class="field-hint">{{ $t('lottery.maxParticipantsHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.expectedCount') }}</span>
                <input v-model.number="form.expectedParticipants" type="number" min="0" max="999999" step="1" />
                <small class="field-hint">{{ $t('lottery.expectedCountHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.adminDrawLimitPerEmail') }}</span>
                <!-- 后端 UNIQUE(draw_id,email) 强制 1；只读展示 -->
                <input type="number" :value="1" min="1" max="1" disabled />
                <small class="field-hint">{{ $t('lottery.adminLimitHint') }}</small>
              </label>
              <label class="checkbox-label">
                <input v-model="form.showWinners" type="checkbox" />
                <span>{{ $t('lottery.adminShowWinners') }}</span>
                <small class="field-hint">{{ $t('lottery.adminShowWinnersHint') }}</small>
              </label>
            </div>
          </section>
        </div>

        <div class="lottery-editor-footer modal-actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="creating"
            @click="closeEditor"
          >
            {{ $t('lottery.adminCancel') }}
          </button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="creating || Boolean(timeOrderError)">
            {{ creating ? $t('lottery.adminCreating') : (isEditing ? $t('lottery.adminDrawEdit') : $t('lottery.adminDrawCreate')) }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 中奖结果 -->
    <AdminModal v-model="showWinnersModal" :title="$t('lottery.drawResult')" max-width="720px">
      <div v-if="winnersLoading" class="empty-text">{{ $t('lottery.adminWinnersLoading') }}</div>
      <div v-else>
        <div class="toolbar" style="margin-bottom: 12px">
          <div class="filters">
            <div
              v-if="winnersModalDrawId && winnersEmailFailureCount > 0"
              class="notice-card"
              role="status"
            >
              <strong>{{ $t('lottery.adminEmailFailureSummary', { count: winnersEmailFailureCount }) }}</strong>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="operatingId === winnersModalDrawId"
                @click="handleRetryEmail(winnersModalDrawId)"
              >{{ $t('lottery.adminRetryEmail') }}</button>
            </div>
          </div>
          <div class="toolbar-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="winners.length === 0"
              @click="handleExportWinners"
            >{{ $t('lottery.adminExportWinners') }}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>{{ $t('lottery.adminEmail') }}</th>
                <th>{{ $t('lottery.adminOrderNo') }}</th>
                <th>{{ $t('lottery.adminCards') }}</th>
                <th>{{ $t('lottery.adminEmailStatus') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in winners" :key="w.id">
                <td>{{ w.email }}</td>
                <td>
                  <RouterLink
                    v-if="w.orderNo"
                    class="btn btn-ghost btn-xs"
                    :to="{ path: '/admin/orders', query: { q: String(w.orderNo).slice(0, 120) } }"
                    :title="$t('lottery.adminSearchOrders')"
                  >{{ w.orderNo }}</RouterLink>
                  <span v-else class="muted-text">-</span>
                </td>
                <td>
                  <div class="relation-cell">
                    <span>{{ w.cardAccountLabel || '-' }}</span>
                    <small v-if="w.cardDeliverySecret" class="muted-text">{{ w.cardDeliverySecret }}</small>
                  </div>
                </td>
                <td>
                  <span class="tag" :class="emailStatusClass(w)" :title="w.emailError || undefined">
                    {{ emailStatusLabel(w) }}
                  </span>
                </td>
              </tr>
              <tr v-if="winners.length === 0">
                <td colspan="4" class="empty-text">{{ $t('lottery.adminNoData') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
/**
 * 抽奖管理页。
 * 【样式】只复用 admin.css primitives（tag / table-actions / modal-form / relation-cell /
 * notice-card / filters select / empty-text / table-error / form-section / form-grid），
 * 禁止自造状态 chip 或 warning 按钮变体。
 * 【商品下拉】必须显式 import AdminProductSelect（无组件自动注册）；抽奖仅 card 履约。
 * 【安全】全部走 @/api/admin 的 adminRequest（Bearer），禁止裸 fetch。
 */
import { computed, ref, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useTableSelection } from '@/composables/useTableSelection'
import { formatDate, dateTimeLocalToIso, toDateTimeLocalValue } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import {
  buildLotteryDrawConfirmMessage,
  buildLotteryDuplicateDraft,
  buildLotteryPublicPath,
  buildLotteryPublicShareUrl,
  buildLotteryWinnersCsvRows,
  countLotteryEmailFailures,
  filterAndSortAdminLotteryDraws,
  formatLotteryEntryProgress,
  formatLotteryVisibilityLabel,
} from '@/lib/lottery-ops'
import { downloadCsv } from '@/lib/csv-export'
import AdminModal from '@/components/AdminModal.vue'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import {
  createAdminLotteryDraw,
  fetchAdminLotteryDraws,
  fetchAdminLotteryWinners,
  fetchAdminLottery,
  updateAdminLotteryDraw,
  openAdminLotteryDraw,
  performAdminLotteryDraw,
  cancelAdminLotteryDraw,
  deleteAdminLotteryDraw,
  retryAdminLotteryEmail,
  recoverAdminLotteryDraw,
  type AdminLotteryDraw,
  type AdminLotteryWinner,
} from '@/api/admin'

const { t, locale } = useI18n()
const { showToast } = useToast()
const { token } = useAdminAuth()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const draws = ref<AdminLotteryDraw[]>([])
const statusFilter = ref('')
/** 名称 / 奖品 / id 本地模糊搜索 */
const listQuery = ref('')
const loading = ref(false)
const loadError = ref('')
const showCreateModal = ref(false)
const showWinnersModal = ref(false)
const winners = ref<AdminLotteryWinner[]>([])
const winnersLoading = ref(false)
/** 中奖弹窗对应的活动 id，便于弹窗内一键重发失败邮件 */
const winnersModalDrawId = ref('')
const creating = ref(false)
const operatingId = ref('')
// batchOperating 必须在 useTableSelection 之前声明，确保模板访问时已初始化
const batchOperating = ref(false)
let loadSequence = 0
let winnersStatusTimer: ReturnType<typeof setInterval> | null = null
let winnersStatusRefreshes = 0
let winnersStatusInFlight = false
const MAX_WINNERS_STATUS_REFRESHES = 10

const filteredDraws = computed(() =>
  filterAndSortAdminLotteryDraws(draws.value, {
    status: statusFilter.value,
    query: listQuery.value,
  }),
)

const hasListFilter = computed(
  () => Boolean(String(statusFilter.value || '').trim() || String(listQuery.value || '').trim()),
)

// 多选删除：复用 useTableSelection（与 AdminCardsView 一致）
const visibleItems = computed(() => filteredDraws.value)
const {
  selectedIds,
  selectedCount,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
  allVisibleSelected,
} = useTableSelection(visibleItems, (row) => row.id, {
  isSelectable: canDeleteDraw,
})

const winnersEmailFailureCount = computed(() => countLotteryEmailFailures(winners.value))
const winnersEmailPendingCount = computed(() => winners.value.filter((winner) => Number(winner.emailSent) !== 1 && !winner.emailError).length)

const emptyForm = () => ({
  id: '',
  name: '',
  description: '',
  productId: '',
  startTime: '',
  endTime: '',
  drawTime: '',
  maxWinners: 1,
  maxParticipants: null as number | null,
  expectedParticipants: 0,
  showWinners: true,
})

const form = ref(emptyForm())
const isEditing = ref(false)

/** 后端约束：drawTime > endTime > startTime */
const timeOrderError = computed(() => {
  const start = form.value.startTime
  const end = form.value.endTime
  const draw = form.value.drawTime
  if (!start || !end || !draw) return ''
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  const d = new Date(draw).getTime()
  if (Number.isNaN(s) || Number.isNaN(e) || Number.isNaN(d)) {
    return t('lottery.adminTimeInvalid')
  }
  if (!(s < e && e < d)) {
    return t('lottery.adminTimeOrderError')
  }
  return ''
})

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: 'lottery.adminDrawDraft',
    open: 'lottery.statusOpen',
    paused: 'lottery.statusPaused',
    drawing: 'lottery.statusDrawing',
    drawn: 'lottery.statusDrawn',
    cancelled: 'lottery.adminDrawCancelled',
  }
  return t(map[status] || 'lottery.adminUnknown')
}

/** 与卡密/优惠券一致：共享 .tag*，禁止自造状态 chip */
function statusClass(status: string): string {
  if (status === 'open') return 'tag-success'
  if (status === 'paused') return 'tag-muted'
  if (status === 'drawing') return 'tag-warning'
  if (status === 'drawn') return 'tag-info'
  if (status === 'cancelled') return 'tag-danger'
  return 'tag-muted'
}

function canDeleteDraw(draw: AdminLotteryDraw): boolean {
  return draw.status === 'draft' || draw.status === 'paused' || draw.status === 'drawn' || draw.status === 'cancelled'
}

function emailStatusLabel(w: AdminLotteryWinner): string {
  if (Number(w.emailSent) === 1) return t('lottery.adminEmailSent')
  if (w.emailError) return t('lottery.adminEmailFailed')
  return t('lottery.adminEmailPending')
}

function emailStatusClass(w: AdminLotteryWinner): string {
  if (Number(w.emailSent) === 1) return 'tag-success'
  if (w.emailError) return 'tag-danger'
  return 'tag-warning'
}

function stopWinnersStatusPolling() {
  if (winnersStatusTimer) {
    clearInterval(winnersStatusTimer)
    winnersStatusTimer = null
  }
  winnersStatusRefreshes = 0
  winnersStatusInFlight = false
}

async function refreshWinnersStatus(id: string) {
  if (winnersStatusInFlight || !showWinnersModal.value || winnersModalDrawId.value !== id) return
  winnersStatusInFlight = true
  try {
    const data = await fetchAdminLotteryWinners(requireToken(), id)
    winners.value = data.winners || []
    winnersStatusRefreshes += 1
    if (winnersEmailPendingCount.value === 0 || winnersStatusRefreshes >= MAX_WINNERS_STATUS_REFRESHES) {
      stopWinnersStatusPolling()
    }
  } catch {
    winnersStatusRefreshes += 1
    if (winnersStatusRefreshes >= MAX_WINNERS_STATUS_REFRESHES) {
      stopWinnersStatusPolling()
    }
  } finally {
    winnersStatusInFlight = false
  }
}

function startWinnersStatusPolling(id: string) {
  stopWinnersStatusPolling()
  if (winnersEmailPendingCount.value === 0) return
  // 手动开奖已等待邮件状态写库；这里是 UI 兜底，处理系统开奖或网络延迟后的短暂 pending。
  // 必须有 MAX_WINNERS_STATUS_REFRESHES 上限，避免管理员长开弹窗造成无界轮询。
  winnersStatusTimer = setInterval(() => {
    void refreshWinnersStatus(id)
  }, 2000)
}

function participantsMeta(draw: AdminLotteryDraw): string {
  const parts: string[] = []
  if (draw.expectedParticipants !== undefined && draw.expectedParticipants !== null) {
    parts.push(`${t('lottery.expectedCount')} ${draw.expectedParticipants}`)
  }
  if (draw.maxParticipants) {
    parts.push(`${t('lottery.maxParticipants')} ${draw.maxParticipants}`)
  }
  return parts.join(' · ')
}

function entryProgress(draw: AdminLotteryDraw): string {
  return formatLotteryEntryProgress(draw.entryCount, draw.maxParticipants)
}

function visibilityLabel(draw: AdminLotteryDraw): string {
  return formatLotteryVisibilityLabel(draw.visible, {
    public: t('lottery.adminVisibilityPublic'),
    hidden: t('lottery.adminVisibilityHidden'),
  })
}

function publicShareUrl(drawId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return buildLotteryPublicShareUrl(origin, drawId)
}

async function handleCopyShareLink(draw: AdminLotteryDraw) {
  try {
    await writeClipboardText(publicShareUrl(draw.id))
    showToast(t('lottery.adminLinkCopied'), 'success')
  } catch {
    showToast(t('lottery.adminLinkCopyFailed'), 'error')
  }
}

/** 新标签打开用户端活动页，便于运营自检 */
function handleOpenPublic(draw: AdminLotteryDraw) {
  const path = buildLotteryPublicPath(draw.id)
  if (typeof window !== 'undefined') {
    window.open(path, '_blank', 'noopener,noreferrer')
  }
}

function handleExportWinners() {
  if (winners.value.length === 0) {
    showToast(t('lottery.adminExportWinnersEmpty'), 'error')
    return
  }
  const rows = buildLotteryWinnersCsvRows(winners.value, {
    email: t('lottery.adminEmail'),
    orderNo: t('lottery.adminOrderNo'),
    card: t('lottery.adminCards'),
    emailStatus: t('lottery.adminEmailStatus'),
    sent: t('lottery.adminEmailSent'),
    pending: t('lottery.adminEmailPending'),
    failed: t('lottery.adminEmailFailed'),
  })
  const idPart = (winnersModalDrawId.value || 'winners').slice(0, 40)
  downloadCsv(`lottery-winners-${idPart}-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  showToast(t('lottery.adminExportWinnersDone'), 'success')
}

function handleDuplicate(draw: AdminLotteryDraw) {
  const draft = buildLotteryDuplicateDraft(draw, { nameSuffix: t('lottery.adminDuplicateSuffix'), defaultName: t('lottery.title') })
  form.value = {
    id: '',
    name: draft.name,
    description: draft.description,
    productId: draft.productId,
    startTime: draft.startTime,
    endTime: draft.endTime,
    drawTime: draft.drawTime,
    maxWinners: draft.maxWinners,
    maxParticipants: draft.maxParticipants,
    expectedParticipants: draft.expectedParticipants,
    showWinners: true,
  }
  isEditing.value = false
  showCreateModal.value = true
  showToast(t('lottery.adminDuplicateReady'), 'success')
}

/** 列表内失败原因截断，完整内容放 title；避免 SQL 整段撑爆表格 */
function shortFailure(reason?: string | null): string {
  const text = (reason || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= 96) return text
  return `${text.slice(0, 96)}…`
}

function formatLocalInput(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function roundToMinute(date: Date): Date {
  const next = new Date(date)
  next.setSeconds(0, 0)
  return next
}

function toLocalInput(date: Date): string {
  return toDateTimeLocalValue(date.toISOString())
}

/** 快捷时间：开始=现在，结束=开始+时长，开奖=结束+3 分钟（满足 draw > end > start） */
function applyTimePreset(kind: '5m' | '10m' | '20m' | '30m' | '1h' | '1d' | '3d' | '7d') {
  const start = roundToMinute(new Date())
  const end = new Date(start)
  if (kind === '5m') end.setMinutes(end.getMinutes() + 5)
  else if (kind === '10m') end.setMinutes(end.getMinutes() + 10)
  else if (kind === '20m') end.setMinutes(end.getMinutes() + 20)
  else if (kind === '30m') end.setMinutes(end.getMinutes() + 30)
  else if (kind === '1h') end.setHours(end.getHours() + 1)
  else if (kind === '1d') end.setDate(end.getDate() + 1)
  else if (kind === '3d') end.setDate(end.getDate() + 3)
  else end.setDate(end.getDate() + 7)
  const draw = new Date(end)
  draw.setMinutes(draw.getMinutes() + 3)
  form.value = {
    ...form.value,
    startTime: toLocalInput(start),
    endTime: toLocalInput(end),
    drawTime: toLocalInput(draw),
  }
}

function requireToken(): string {
  if (!token.value) {
    showToast(t('lottery.adminFailed'), 'error')
    throw new Error('missing admin token')
  }
  return token.value
}

function closeEditor() {
  showCreateModal.value = false
  isEditing.value = false
}

function openCreate() {
  const base = emptyForm()
  form.value = base
  isEditing.value = false
  // 默认填 1 天档，避免空白 datetime-local 难用；再保留 emptyForm 的业务默认值
  applyTimePreset('1d')
  form.value = {
    ...form.value,
    id: '',
    name: '',
    description: '',
    productId: '',
    maxWinners: 1,
    maxParticipants: null,
    expectedParticipants: 0,
  }
  showCreateModal.value = true
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchAdminLotteryDraws(requireToken())
    if (sequence !== loadSequence) return
    draws.value = data.draws || []
  } catch (e: any) {
    if (sequence !== loadSequence) return
    draws.value = []
    loadError.value = e?.message || t('lottery.adminLoadFailed')
    showToast(loadError.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function handleOpen(id: string) {
  operatingId.value = id
  try {
    await openAdminLotteryDraw(requireToken(), id)
    // 开启后立刻把投放链接放进剪贴板，少一步手动复制
    try {
      await writeClipboardText(publicShareUrl(id))
      showToast(t('lottery.adminOpenedWithLink'), 'success')
    } catch {
      showToast(t('lottery.adminDrawOpened'), 'success')
    }
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleDraw(draw: AdminLotteryDraw) {
  // 开奖前展示池子/名额/将抽出人数，降低误操作；不改服务端开奖语义
  const summary = buildLotteryDrawConfirmMessage(draw, {
    title: t('lottery.adminConfirmDrawTitle'),
    name: t('lottery.adminConfirmDrawName'),
    pool: t('lottery.adminConfirmDrawPool'),
    quota: t('lottery.adminConfirmDrawQuota'),
    willDraw: t('lottery.adminConfirmDrawWill'),
    product: t('lottery.adminConfirmDrawProduct'),
    emptyPoolWarn: t('lottery.adminConfirmDrawEmptyPool'),
    confirm: t('lottery.adminConfirmDraw'),
  })
  if (!(await askConfirm(summary))) return
  operatingId.value = draw.id
  let drawOk = false
  try {
    await performAdminLotteryDraw(requireToken(), draw.id)
    drawOk = true
    showToast(t('lottery.adminDrawDone'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
  // 与 viewWinners 各自管理 operatingId，避免 finally 互相覆盖导致按钮卡死
  if (drawOk) {
    await viewWinners(draw.id)
  }
}

async function viewWinners(id: string) {
  stopWinnersStatusPolling()
  winnersLoading.value = true
  winners.value = []
  winnersModalDrawId.value = id
  showWinnersModal.value = true
  operatingId.value = id
  try {
    const data = await fetchAdminLotteryWinners(requireToken(), id)
    winners.value = data.winners || []
    startWinnersStatusPolling(id)
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    showWinnersModal.value = false
    winnersModalDrawId.value = ''
  } finally {
    winnersLoading.value = false
    operatingId.value = ''
  }
}

watch(showWinnersModal, (visible) => {
  if (!visible) stopWinnersStatusPolling()
})

onBeforeUnmount(() => {
  stopWinnersStatusPolling()
})

async function handleCancel(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmCancel')))) return
  operatingId.value = id
  try {
    await cancelAdminLotteryDraw(requireToken(), id)
    showToast(t('lottery.adminDrawCancelled'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleDelete(id: string) {
  const draw = draws.value.find((item) => item.id === id)
  if (!draw || !canDeleteDraw(draw)) return
  if (!(await askConfirm(t('lottery.adminConfirmDelete', { name: draw.name, status: statusLabel(draw.status) })))) return
  operatingId.value = id
  try {
    await deleteAdminLotteryDraw(requireToken(), id)
    showToast(t('lottery.adminDrawDeleted'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function batchDeleteDraws() {
  const ids = selectedIds.value
  if (ids.length === 0 || loading.value || batchOperating.value) return
  const selectedDraws = draws.value.filter((draw) => ids.includes(draw.id) && canDeleteDraw(draw))
  if (selectedDraws.length === 0) return
  const drawnCount = selectedDraws.filter((draw) => draw.status === 'drawn').length
  if (!(await askConfirm(t('lottery.adminConfirmBatchDelete', { count: selectedDraws.length, drawnCount })))) return
  batchOperating.value = true
  try {
    let success = 0
    let failed = 0
    for (const id of selectedDraws.map((draw) => draw.id)) {
      try {
        await deleteAdminLotteryDraw(requireToken(), id)
        success++
      } catch {
        failed++
      }
    }
    if (failed > 0) {
      showToast(t('lottery.adminBatchDeleteResult', { success, failed }), 'error')
    } else {
      showToast(t('lottery.adminBatchDeleteSuccess', { count: success }), 'success')
    }
    clearSelection()
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    batchOperating.value = false
  }
}

async function handlePause(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmPause')))) return
  operatingId.value = id
  try {
    await fetchAdminLottery(requireToken(), `lottery/draws/${id}/pause`, 'POST')
    showToast(t('lottery.adminPaused'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleResume(id: string) {
  operatingId.value = id
  try {
    await fetchAdminLottery(requireToken(), `lottery/draws/${id}/resume`, 'POST')
    showToast(t('lottery.adminResumed'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleEdit(draw: AdminLotteryDraw) {
  // 与后端 PATCH 一致：仅 draft 可改配置；paused 需先恢复或复制活动
  if (draw.status !== 'draft') {
    showToast(t('lottery.adminEditNonDraft'), 'error')
    return
  }
  form.value = {
    id: draw.id,
    name: draw.name,
    description: draw.description || '',
    productId: draw.productId,
    startTime: toDateTimeLocalValue(draw.startTime),
    endTime: toDateTimeLocalValue(draw.endTime),
    drawTime: toDateTimeLocalValue(draw.drawTime),
    maxWinners: draw.maxWinners,
    maxParticipants: draw.maxParticipants ?? null,
    expectedParticipants: draw.expectedParticipants ?? 0,
    showWinners: draw.showWinners ? true : false,
  }
  isEditing.value = true
  showCreateModal.value = true
}

async function handleToggleVisibility(id: string, visible: number | undefined) {
  if (!(await askConfirm(t('lottery.adminConfirmToggleVisibility')))) return
  operatingId.value = id
  try {
    await updateAdminLotteryDraw(requireToken(), id, { visible: visible ? 0 : 1 })
    showToast(visible ? t('lottery.adminHidden') : t('lottery.adminShown'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleRetryEmail(id: string) {
  operatingId.value = id
  try {
    const result = await retryAdminLotteryEmail(requireToken(), id)
    if (result.sent > 0 || result.failed === 0) {
      showToast(t('lottery.adminRetrySuccess', { sent: result.sent }), 'success')
    } else {
      showToast(t('lottery.adminRetryFailed', { failed: result.failed }), 'error')
    }
    // 若中奖弹窗正打开同一活动，刷新名单上的发送态
    if (showWinnersModal.value && winnersModalDrawId.value === id) {
      try {
        const data = await fetchAdminLotteryWinners(requireToken(), id)
        winners.value = data.winners || []
      } catch {
        /* 列表刷新失败不阻断主提示 */
      }
    }
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

/**
 * drawing 卡死恢复：走服务端 force heal。
 * 有中奖 → drawn（不二次发卡）；无中奖 → open。
 */
async function handleRecover(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmRecover')))) return
  operatingId.value = id
  try {
    const result = await recoverAdminLotteryDraw(requireToken(), id)
    if (result.healed === 'drawn') {
      showToast(t('lottery.adminRecoverDoneDrawn'), 'success')
    } else {
      showToast(t('lottery.adminRecoverDoneOpen'), 'success')
    }
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleCreate() {
  if (!form.value.name || !form.value.productId || !form.value.startTime || !form.value.endTime || !form.value.drawTime) {
    showToast(t('lottery.adminFillRequired'), 'error')
    return
  }
  if (timeOrderError.value) {
    showToast(timeOrderError.value, 'error')
    return
  }
  creating.value = true
  try {
    const payload = {
      name: form.value.name,
      description: form.value.description,
      productId: form.value.productId,
      startTime: dateTimeLocalToIso(form.value.startTime),
      endTime: dateTimeLocalToIso(form.value.endTime),
      drawTime: dateTimeLocalToIso(form.value.drawTime),
      maxWinners: form.value.maxWinners,
      maxParticipants: form.value.maxParticipants || undefined,
      expectedParticipants: form.value.expectedParticipants,
      showWinners: form.value.showWinners ? 1 : 0,
      limitPerEmail: 1,
    }
    if (isEditing.value && form.value.id) {
      // DevTools 防御：编辑按钮仅 draft 可见，但表单提交时二次校验
      // 从本地列表查找当前活动状态，避免跨状态编辑（如已开奖的活动被篡改 isEditing 后提交）
      const current = draws.value.find((d) => d.id === form.value.id)
      if (current && current.status !== 'draft') {
        showToast(t('lottery.adminEditNonDraft'), 'error')
        closeEditor()
        form.value = emptyForm()
        return
      }
      await updateAdminLotteryDraw(requireToken(), form.value.id, payload)
      showToast(t('lottery.adminDrawUpdated'), 'success')
    } else {
      const created = await createAdminLotteryDraw(requireToken(), payload)
      // 创建成功后复制投放链接（草稿开启前也可预填投放）；复制失败不阻断主流程
      if (created?.id) {
        try {
          await writeClipboardText(publicShareUrl(created.id))
          showToast(t('lottery.adminCreatedWithLink'), 'success')
        } catch {
          showToast(t('lottery.adminDrawCreated'), 'success')
        }
      } else {
        showToast(t('lottery.adminDrawCreated'), 'success')
      }
    }
    closeEditor()
    form.value = emptyForm()
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    creating.value = false
  }
}

onMounted(loadData)
</script>

<style>
@import '@/assets/admin.css';
</style>

<style>
/* 仅本页编辑器结构；颜色/分区 token 仍来自 admin.css，禁止 scoped 以免合约失败 */
.lottery-editor-form {
  gap: 0;
  min-height: 0;
  flex: 1 1 auto;
  max-height: min(78dvh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.lottery-editor-scroll {
  display: flex;
  flex-direction: column;
  gap: var(--admin-card-gap, 12px);
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
  padding-bottom: 4px;
}

.lottery-editor-footer.modal-actions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 0;
  padding-top: 12px;
  border-top: 0.5px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--tg-bg, #0f172a);
  padding-right: 2px;
}

.lottery-editor-footer .btn {
  min-width: 88px;
  max-width: 100%;
}
</style>
