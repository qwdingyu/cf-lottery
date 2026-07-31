<template>
  <div class="admin-page">
    <div class="admin-tab-bar" role="tablist" :aria-label="$t('adminBalance.title')">
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: activeTab === 'accounts' }"
        :aria-selected="activeTab === 'accounts'"
        @click="switchTab('accounts')"
      >
        {{ $t('adminBalance.balanceList') }}
      </button>
      <button
        type="button"
        role="tab"
        class="tab-btn"
        :class="{ active: activeTab === 'ledger' }"
        :aria-selected="activeTab === 'ledger'"
        @click="switchTab('ledger')"
      >
        {{ $t('adminBalance.balanceLog') }}
      </button>
    </div>

    <!-- ════════ 用户余额账户 ════════ -->
    <template v-if="activeTab === 'accounts'">
      <div class="toolbar">
        <div class="filters">
          <input
            v-model="accountFilter.email"
            type="search"
            :placeholder="$t('adminBalance.search')"
            :aria-label="$t('adminBalance.search')"
            @keyup.enter="searchAccounts"
          />
          <label class="filter-check">
            <input v-model="accountFilter.positiveOnly" type="checkbox" @change="searchAccounts" />
            <span>{{ $t('adminBalance.positiveOnly') }}</span>
          </label>
          <button class="btn btn-primary btn-sm" :disabled="accountLoading" @click="searchAccounts">
            {{ accountLoading ? $t('adminBalance.searching') : $t('adminBalance.search') }}
          </button>
        </div>
        <div class="toolbar-actions">
          <button class="btn btn-ghost btn-sm" :disabled="accountLoading" @click="loadAccounts">{{ $t('adminBalance.refresh') }}</button>
          <button class="btn btn-primary btn-sm" @click="openAdjust()">{{ $t('adminBalance.adjust') }}</button>
        </div>
      </div>

      <p class="balance-helper">
        {{ $t('adminBalance.helperText') }}
      </p>

      <div v-if="accountError" class="table-error" role="alert">
        <span>{{ accountError }}</span>
        <button class="btn btn-ghost btn-xs" :disabled="accountLoading" @click="loadAccounts">{{ $t('adminBalance.reload') }}</button>
      </div>

      <div v-if="accountSelectedCount > 0" class="bulk-bar" role="status" aria-live="polite">
        <span>{{ $t('adminBalance.accountSelected', { count: accountSelectedCount }) }}</span>
        <div class="bulk-actions">
          <button class="btn btn-ghost btn-sm" @click="clearAccountSelection">{{ $t('adminBalance.clearSelection') }}</button>
          <button class="btn btn-ghost btn-sm" @click="copySelectedAccounts">{{ $t('adminBalance.copySelected') }}</button>
          <button class="btn btn-primary btn-sm" @click="exportSelectedAccounts">{{ $t('adminBalance.exportSelectedCsv') }}</button>
        </div>
      </div>

      <div class="table-wrap" role="region" :aria-label="$t('adminBalance.tableLabel')" tabindex="0" :aria-busy="accountLoading">
        <table class="admin-table" :aria-label="$t('adminBalance.listLabel')">
          <thead>
            <tr>
              <th class="select-cell">
                <input
                  type="checkbox"
                  :checked="allAccountsSelected"
                  :indeterminate.prop="partialAccountsSelected"
                  :disabled="accountSelectableCount === 0 || accountLoading"
                  :aria-label="$t('adminBalance.selectAll')"
                  @change="toggleAllAccounts(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>{{ $t('adminBalance.colEmail') }}</th>
              <th>{{ $t('adminBalance.colBalance') }}</th>
              <th>{{ $t('adminBalance.colRecharge') }}</th>
              <th>{{ $t('adminBalance.colSpent') }}</th>
              <th>{{ $t('adminBalance.colUpdatedAt') }}</th>
              <th>{{ $t('adminBalance.colAction') }}</th>
            </tr>
          </thead>
          <tbody v-if="accountLoading">
            <tr v-for="i in 5" :key="'ask' + i" class="skeleton-row">
              <td colspan="7"><div class="skeleton-cell" /></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="item in accounts"
              :key="item.email"
              :class="{ 'is-selected': isAccountSelected(item.email) }"
            >
              <td class="select-cell">
                <input
                  type="checkbox"
                  :checked="isAccountSelected(item.email)"
                  :disabled="accountLoading"
                  :aria-label="$t('adminBalance.selectRow', { email: item.email })"
                  @click="setAccountSelected(item.email, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
                />
              </td>
              <td><code>{{ item.email }}</code></td>
              <td :class="item.balanceCents > 0 ? 'is-positive' : ''">{{ formatCents(item.balanceCents) }}</td>
              <td>{{ formatCents(item.totalDepositedCents) }}</td>
              <td>{{ formatCents(item.totalSpentCents) }}</td>
              <td>{{ formatDate(item.updatedAt) }}</td>
              <td class="table-actions">
                <button class="btn btn-ghost btn-xs" @click="viewLedgerFor(item.email)">{{ $t('adminBalance.balanceLog') }}</button>
                <button class="btn btn-ghost btn-xs" @click="openAdjust(item)">{{ $t('adminBalance.adjust') }}</button>
                <button class="btn btn-ghost btn-xs" @click="copyEmail(item.email)">{{ $t('adminBalance.copyEmail') }}</button>
              </td>
            </tr>
            <tr v-if="accounts.length === 0">
              <td colspan="7" class="empty-text">{{ $t('adminBalance.noData') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <AdminPagination
        :page="accountPagination.page.value"
        :total="accountPagination.total.value"
        :total-pages="accountPagination.totalPages.value"
        :limit="accountPagination.limit.value"
        :disabled="accountLoading"
        @prev="accountPagination.prevPage(); loadAccounts()"
        @next="accountPagination.nextPage(); loadAccounts()"
        @jump="accountPagination.setPage($event); loadAccounts()"
        @update:limit="accountPagination.setLimit($event); loadAccounts()"
      />
    </template>

    <!-- ════════ 余额流水 ════════ -->
    <template v-else>
      <div class="toolbar">
        <div class="filters">
          <input
            v-model="ledgerFilter.email"
            type="search"
            :placeholder="$t('adminBalance.search')"
            :title="$t('adminBalance.searchEmail')"
            :aria-label="$t('adminBalance.searchEmail')"
            @keyup.enter="searchLedger"
          />
          <select v-model="ledgerFilter.type" :aria-label="$t('adminBalance.typeSelect')" @change="searchLedger">
            <option value="">{{ $t('adminBalance.typeAll') }}</option>
            <option value="voucher_redeem">{{ $t('adminBalance.typeVoucherRedeem') }}</option>
            <option value="recharge">{{ $t('adminBalance.typeRecharge') }}</option>
            <option value="order_spend">{{ $t('adminBalance.typeOrderSpend') }}</option>
            <option value="refund">{{ $t('adminBalance.typeRefund') }}</option>
            <option value="adjustment">{{ $t('adminBalance.typeAdjustment') }}</option>
          </select>
          <input
            v-model="ledgerFilter.referenceType"
            type="search"
            :placeholder="$t('adminBalance.referenceType')"
            :aria-label="$t('adminBalance.referenceType')"
            @keyup.enter="searchLedger"
          />
          <input
            v-model="ledgerFilter.referenceId"
            type="search"
            :placeholder="$t('adminBalance.referenceId')"
            :aria-label="$t('adminBalance.referenceId')"
            @keyup.enter="searchLedger"
          />
          <button class="btn btn-primary btn-sm" :disabled="ledgerLoading" @click="searchLedger">
            {{ ledgerLoading ? $t('adminBalance.searchingBtn') : $t('adminBalance.searchBtn') }}
          </button>
        </div>
      </div>

      <section v-if="ledgerFilter.email" class="balance-snapshot">
        <div class="snapshot-card snapshot-card--primary">
          <div class="snapshot-label">{{ $t('adminBalance.latestBalance') }}</div>
          <div class="snapshot-value">{{ formatCents(latestBalanceCents) }}</div>
          <div class="snapshot-hint">{{ $t('adminBalance.latestBalanceHint') }}</div>
        </div>
        <div class="snapshot-card">
          <div class="snapshot-label">{{ $t('adminBalance.currentFilter') }}</div>
          <div class="snapshot-value">{{ ledgerPagination.total.value }}</div>
          <div class="snapshot-hint">{{ $t('adminBalance.currentFilterHint') }}</div>
        </div>
        <div class="snapshot-card">
          <div class="snapshot-label">{{ $t('adminBalance.netChange') }}</div>
          <div class="snapshot-value" :class="netChangeCents >= 0 ? 'is-positive' : 'is-negative'">
            {{ formatSignedCents(netChangeCents) }}
          </div>
          <div class="snapshot-hint">{{ $t('adminBalance.netChangeHint') }}</div>
        </div>
      </section>
      <p v-else class="balance-helper">
        {{ $t('adminBalance.ledgerHelperText') }}
      </p>

      <div v-if="ledgerError" class="table-error" role="alert">
        <span>{{ ledgerError }}</span>
        <button class="btn btn-ghost btn-xs" :disabled="ledgerLoading" @click="loadLedger">{{ $t('adminBalance.ledgerReload') }}</button>
      </div>

      <div v-if="ledgerSelectedCount > 0" class="bulk-bar" role="status" aria-live="polite">
        <span>{{ $t('adminBalance.ledgerSelected', { count: ledgerSelectedCount }) }}</span>
        <div class="bulk-actions">
          <button class="btn btn-ghost btn-sm" @click="clearLedgerSelection">{{ $t('adminBalance.clearSelection') }}</button>
          <button class="btn btn-ghost btn-sm" @click="copySelectedTransactions">{{ $t('adminBalance.copySelected') }}</button>
          <button class="btn btn-primary btn-sm" @click="exportSelectedTransactions">{{ $t('adminBalance.exportSelectedCsv') }}</button>
        </div>
      </div>

      <div class="table-wrap" role="region" :aria-label="$t('adminBalance.ledgerTableLabel')" tabindex="0" :aria-busy="ledgerLoading">
        <table class="admin-table" :aria-label="$t('adminBalance.ledgerListLabel')">
          <thead>
            <tr>
              <th class="select-cell">
                <input
                  type="checkbox"
                  :checked="allLedgerSelected"
                  :indeterminate.prop="partialLedgerSelected"
                  :disabled="ledgerSelectableCount === 0 || ledgerLoading"
                  :aria-label="$t('adminBalance.selectAllLedger')"
                  @change="toggleAllLedger(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>ID</th>
              <th>{{ $t('adminBalance.colLedgerEmail') }}</th>
              <th>{{ $t('adminBalance.colLedgerType') }}</th>
              <th>{{ $t('adminBalance.colAmount') }}</th>
              <th>{{ $t('adminBalance.colBalanceAfter') }}</th>
              <th>{{ $t('adminBalance.colLedgerReferenceType') }}</th>
              <th>{{ $t('adminBalance.colLedgerReferenceId') }}</th>
              <th>{{ $t('adminBalance.colNote') }}</th>
              <th>{{ $t('adminBalance.colLedgerTime') }}</th>
            </tr>
          </thead>
          <tbody v-if="ledgerLoading">
            <tr v-for="i in 5" :key="'lsk' + i" class="skeleton-row">
              <td colspan="10"><div class="skeleton-cell" /></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="item in ledgerItems"
              :key="transactionKey(item)"
              :class="{ 'is-selected': isLedgerSelected(transactionKey(item)) }"
            >
              <td class="select-cell">
                <input
                  type="checkbox"
                  :checked="isLedgerSelected(transactionKey(item))"
                  :disabled="ledgerLoading"
                  :aria-label="$t('adminBalance.selectLedgerRow', { id: item.id || item.createdAt || '' })"
                  @click="setLedgerSelected(transactionKey(item), ($event.target as HTMLInputElement).checked, $event.shiftKey)"
                />
              </td>
              <td class="id-cell">{{ item.id || '-' }}</td>
              <td>{{ item.email || '-' }}</td>
              <td>{{ typeText(item.type) }}</td>
              <td :class="Number(item.amountCents || 0) >= 0 ? 'is-positive' : 'is-negative'">
                {{ formatSignedCents(item.amountCents || 0) }}
              </td>
              <td>{{ formatCents(item.balanceAfterCents || 0) }}</td>
              <td>{{ item.referenceType || '-' }}</td>
              <td class="id-cell">
                <RouterLink
                  v-if="item.referenceType === 'order' && item.referenceId"
                  class="admin-deeplink"
                  :to="{ path: '/admin/orders', query: { q: String(item.referenceId).slice(0, 120) } }"
                  :title="$t('adminBalance.searchInOrders', { id: item.referenceId })"
                >
                  {{ item.referenceId }}
                </RouterLink>
                <template v-else>{{ item.referenceId || '-' }}</template>
              </td>
              <td class="note-cell">{{ item.note || '-' }}</td>
              <td>{{ formatDate(item.createdAt) }}</td>
            </tr>
            <tr v-if="ledgerItems.length === 0">
              <td colspan="10" class="empty-text">{{ $t('adminBalance.noLog') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <AdminPagination
        :page="ledgerPagination.page.value"
        :total="ledgerPagination.total.value"
        :total-pages="ledgerPagination.totalPages.value"
        :limit="ledgerPagination.limit.value"
        :disabled="ledgerLoading"
        @prev="ledgerPagination.prevPage(); loadLedger()"
        @next="ledgerPagination.nextPage(); loadLedger()"
        @jump="ledgerPagination.setPage($event); loadLedger()"
        @update:limit="ledgerPagination.setLimit($event); loadLedger()"
      />
    </template>

    <!-- 调账弹窗 -->
    <AdminModal v-model="adjustVisible" :title="$t('adminBalance.adjustModalTitle')" max-width="440px" hide-actions>
      <form class="modal-form adjust-form" @submit.prevent="submitAdjust">
        <label>
          <span>{{ $t('adminBalance.adjustEmail') }}</span>
          <input
            v-model.trim="adjustForm.email"
            type="email"
            required
            maxlength="160"
            placeholder="user@example.com"
            autocomplete="off"
          />
        </label>
        <div class="adjust-direction" role="group" :aria-label="$t('adminBalance.adjustDirectionLabel')">
          <button
            type="button"
            class="dir-btn"
            :class="{ active: adjustForm.direction === 'credit' }"
            @click="adjustForm.direction = 'credit'"
          >
            {{ $t('adminBalance.adjustCredit') }}
          </button>
          <button
            type="button"
            class="dir-btn"
            :class="{ active: adjustForm.direction === 'debit' }"
            @click="adjustForm.direction = 'debit'"
          >
            {{ $t('adminBalance.adjustDebit') }}
          </button>
        </div>
        <label>
          <span>{{ $t('adminBalance.adjustAmountLabel') }}</span>
          <input
            v-model.trim="adjustForm.amountMajor"
            type="text"
            inputmode="decimal"
            required
            :placeholder="$t('adminBalance.adjustAmountPlaceholder')"
            autocomplete="off"
          />
          <small class="field-hint">{{ $t('adminBalance.adjustAmountHint') }}</small>
        </label>
        <label>
          <span>{{ $t('adminBalance.adjustNoteLabel') }}</span>
          <textarea
            v-model.trim="adjustForm.note"
            rows="2"
            required
            minlength="2"
            maxlength="200"
            :placeholder="$t('adminBalance.adjustNotePlaceholder')"
          ></textarea>
        </label>
        <p v-if="adjustPreview" class="adjust-preview">
          {{ $t('adminBalance.adjustPreview', { action: adjustForm.direction === 'credit' ? $t('adminBalance.adjustCredit') : $t('adminBalance.adjustDebit'), amount: adjustPreview, email: adjustForm.email || '…' }) }}
        </p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="adjustSaving" @click="adjustVisible = false">{{ $t('adminBalance.adjustCancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="adjustSaving">
            {{ adjustSaving ? $t('adminBalance.adjustSaving') : $t('adminBalance.adjustConfirm') }}
          </button>
        </div>
      </form>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  fetchAdminBalanceTransactions,
  fetchAdminUserBalances,
  adjustAdminUserBalance,
} from '@/api/admin'
import type {
  AdminBalanceTransaction,
  AdminBalanceTransactionFilter,
  AdminUserBalance,
} from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { downloadCsv } from '@/lib/csv-export'
import i18n from '@/i18n'
import { writeClipboardText } from '@/composables/useClipboard'
import { formatDate } from '@/composables/useFormat'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import { formatMoney, parseMajorToMinor, minorToMajorString } from '@shared/money'

const route = useRoute()
const router = useRouter()
const { showToast } = useToast()
const { token } = useAdminAuth()

type BalanceTab = 'accounts' | 'ledger'
const activeTab = ref<BalanceTab>('accounts')

// ─── 用户余额账户 ───
const accounts = ref<AdminUserBalance[]>([])
const accountLoading = ref(false)
const accountError = ref('')
const accountFilter = reactive({ email: '', positiveOnly: false })
const accountPagination = useTablePagination()
let accountSeq = 0

const {
  selectedIds: accountSelectedIds,
  selectedCount: accountSelectedCount,
  selectableCount: accountSelectableCount,
  allVisibleSelected: allAccountsSelected,
  partiallySelected: partialAccountsSelected,
  isSelected: isAccountSelected,
  setSelected: setAccountSelected,
  toggleAllVisible: toggleAllAccounts,
  clearSelection: clearAccountSelection,
} = useTableSelection(accounts, (item) => item.email)

async function loadAccounts() {
  const sequence = ++accountSeq
  accountLoading.value = true
  accountError.value = ''
  try {
    const res = await fetchAdminUserBalances(token.value, {
      email: accountFilter.email.trim() || undefined,
      positiveOnly: accountFilter.positiveOnly ? '1' : undefined,
      limit: accountPagination.limit.value,
      offset: (accountPagination.page.value - 1) * accountPagination.limit.value,
    })
    if (sequence !== accountSeq) return
    if (accountPagination.setTotal(res.total)) return loadAccounts()
    accounts.value = res.items
    clearAccountSelection()
  } catch (err: any) {
    if (sequence !== accountSeq) return
    accounts.value = []
    clearAccountSelection()
    accountError.value = err.message || '加载用户余额失败'
    showToast(accountError.value, 'error')
  } finally {
    if (sequence === accountSeq) accountLoading.value = false
  }
}

function searchAccounts() {
  accountPagination.page.value = 1
  const query = buildBalanceRouteQuery()
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadAccounts()
    return
  }
  void router.replace({ path: route.path, query })
}

function selectedAccountRows() {
  const selected = new Set(accountSelectedIds.value)
  return accounts.value.filter((item) => selected.has(item.email))
}

async function copySelectedAccounts() {
  const rows = selectedAccountRows()
  if (rows.length === 0) return
  try {
    await writeClipboardText(
      rows
        .map((item) =>
          [
            item.email,
            minorToMajorString(item.balanceCents, 'CNY'),
            minorToMajorString(item.totalDepositedCents, 'CNY'),
            minorToMajorString(item.totalSpentCents, 'CNY'),
            item.updatedAt || '',
          ].join('\t'),
        )
        .join('\n'),
    )
    showToast(`已复制 ${rows.length} 个账户`, 'success')
  } catch {
    showToast('复制失败，请使用导出', 'error')
  }
}

function exportSelectedAccounts() {
  const rows = selectedAccountRows()
  if (rows.length === 0) return
  downloadCsv(`selected-user-balances-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['email', 'balanceCents', 'totalDepositedCents', 'totalSpentCents', 'updatedAt'],
    ...rows.map((item) => [
      item.email,
      String(item.balanceCents),
      String(item.totalDepositedCents),
      String(item.totalSpentCents),
      item.updatedAt || '',
    ]),
  ])
  showToast(i18n.global.t('adminBalance.exportAccountsSuccess', { count: rows.length }), 'success')
}

async function copyEmail(email: string) {
  try {
    await writeClipboardText(email)
    showToast('已复制邮箱', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

function viewLedgerFor(email: string) {
  ledgerFilter.email = email
  ledgerFilter.type = ''
  ledgerFilter.referenceType = ''
  ledgerFilter.referenceId = ''
  ledgerPagination.page.value = 1
  activeTab.value = 'ledger'
  const query = buildBalanceRouteQuery()
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadLedger()
    return
  }
  void router.replace({ path: route.path, query })
}

// ─── 流水 ───
const ledgerItems = ref<AdminBalanceTransaction[]>([])
const ledgerLoading = ref(false)
const ledgerError = ref('')
const ledgerFilter = reactive<AdminBalanceTransactionFilter>({
  email: '',
  type: '',
  referenceType: '',
  referenceId: '',
  offset: 0,
})
const ledgerPagination = useTablePagination()
let ledgerSeq = 0

const {
  selectedIds: ledgerSelectedIds,
  selectedCount: ledgerSelectedCount,
  selectableCount: ledgerSelectableCount,
  allVisibleSelected: allLedgerSelected,
  partiallySelected: partialLedgerSelected,
  isSelected: isLedgerSelected,
  setSelected: setLedgerSelected,
  toggleAllVisible: toggleAllLedger,
  clearSelection: clearLedgerSelection,
} = useTableSelection(ledgerItems, transactionKey)

const latestBalanceCents = computed(() => Number(ledgerItems.value[0]?.balanceAfterCents || 0))
const netChangeCents = computed(() =>
  ledgerItems.value.reduce((sum, item) => sum + Number(item.amountCents || 0), 0),
)

function transactionKey(item: AdminBalanceTransaction) {
  return (
    item.id
    || `${item.email || ''}:${item.type || ''}:${item.referenceType || ''}:${item.referenceId || ''}:${item.createdAt || ''}`
  )
}

async function loadLedger() {
  const sequence = ++ledgerSeq
  ledgerLoading.value = true
  ledgerError.value = ''
  try {
    const res = await fetchAdminBalanceTransactions(token.value, {
      ...ledgerFilter,
      limit: ledgerPagination.limit.value,
      offset: (ledgerPagination.page.value - 1) * ledgerPagination.limit.value,
    })
    if (sequence !== ledgerSeq) return
    if (ledgerPagination.setTotal(res.total)) return loadLedger()
    ledgerItems.value = res.transactions
    clearLedgerSelection()
  } catch (err: any) {
    if (sequence !== ledgerSeq) return
    ledgerItems.value = []
    clearLedgerSelection()
    ledgerError.value = err.message || '加载余额流水失败'
    showToast(ledgerError.value, 'error')
  } finally {
    if (sequence === ledgerSeq) ledgerLoading.value = false
  }
}

function searchLedger() {
  ledgerPagination.page.value = 1
  const query = buildBalanceRouteQuery()
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadLedger()
    return
  }
  void router.replace({ path: route.path, query })
}

function typeText(type?: string) {
  const map: Record<string, string> = {
    voucher_redeem: i18n.global.t('adminBalance.typeVoucherRedeem'),
    recharge: i18n.global.t('adminBalance.typeRecharge'),
    order_spend: i18n.global.t('adminBalance.typeOrderSpend'),
    refund: i18n.global.t('adminBalance.typeRefund'),
    adjustment: i18n.global.t('adminBalance.typeAdjustment'),
  }
  return map[type || ''] || type || '-'
}

function formatCents(cents: number) {
  return formatMoney(Number(cents || 0), 'CNY')
}

function formatSignedCents(cents: number) {
  const value = Number(cents || 0)
  return value > 0 ? `+${formatMoney(value, 'CNY')}` : formatMoney(value, 'CNY')
}

function selectedTransactions() {
  const selected = new Set(ledgerSelectedIds.value)
  return ledgerItems.value.filter((item) => selected.has(transactionKey(item)))
}

function transactionRows(transactions: AdminBalanceTransaction[]) {
  return transactions.map((item) => [
    item.id || '',
    item.email || '',
    typeText(item.type),
    String(item.amountCents ?? ''),
    String(item.balanceAfterCents ?? ''),
    item.referenceType || '',
    item.referenceId || '',
    item.note || '',
    item.createdAt || '',
  ])
}

async function copySelectedTransactions() {
  const transactions = selectedTransactions()
  if (transactions.length === 0) return
  try {
    await writeClipboardText(transactionRows(transactions).map((row) => row.join('\t')).join('\n'))
    showToast(`已复制 ${transactions.length} 条流水`, 'success')
  } catch {
    showToast('复制失败，请手动查看或导出 CSV', 'error')
  }
}

function exportSelectedTransactions() {
  const transactions = selectedTransactions()
  if (transactions.length === 0) return
  downloadCsv(`selected-balance-transactions-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['id', 'email', 'type', 'amountCents', 'balanceAfterCents', 'referenceType', 'referenceId', 'note', 'createdAt'],
    ...transactionRows(transactions),
  ])
  showToast(i18n.global.t('adminBalance.exportTransactionsSuccess', { count: transactions.length }), 'success')
}

function switchTab(tab: BalanceTab) {
  if (activeTab.value === tab) return
  activeTab.value = tab
  const query = buildBalanceRouteQuery()
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    if (tab === 'accounts' && accounts.value.length === 0 && !accountLoading.value) {
      void loadAccounts()
    }
    if (tab === 'ledger' && ledgerItems.value.length === 0 && !ledgerLoading.value) {
      void loadLedger()
    }
    return
  }
  void router.replace({ path: route.path, query })
}

function buildBalanceRouteQuery(): Record<string, string> {
  const query: Record<string, string> = {}
  if (activeTab.value === 'ledger') {
    query.tab = 'ledger'
    if (ledgerFilter.email) query.email = String(ledgerFilter.email).slice(0, 160)
    if (ledgerFilter.type) query.type = String(ledgerFilter.type).slice(0, 40)
    if (ledgerFilter.referenceType) query.referenceType = String(ledgerFilter.referenceType).slice(0, 40)
    if (ledgerFilter.referenceId) query.referenceId = String(ledgerFilter.referenceId).slice(0, 120)
  } else if (accountFilter.email) {
    query.email = String(accountFilter.email).slice(0, 160)
  }
  return query
}

/** 支持订单详情 / 外链 ?tab=ledger&referenceType=order&referenceId=... */
function initFilterFromRoute() {
  const query = route.query
  const tab = String(query.tab || '')
  if (tab === 'ledger') {
    activeTab.value = 'ledger'
    ledgerFilter.email = typeof query.email === 'string' ? query.email.slice(0, 160) : ''
    ledgerFilter.type = typeof query.type === 'string' ? query.type.slice(0, 40) : ''
    ledgerFilter.referenceType = typeof query.referenceType === 'string' ? query.referenceType.slice(0, 40) : ''
    ledgerFilter.referenceId = typeof query.referenceId === 'string' ? query.referenceId.slice(0, 120) : ''
    ledgerPagination.page.value = 1
  } else {
    activeTab.value = 'accounts'
    if (typeof query.email === 'string' && query.email) {
      accountFilter.email = query.email.slice(0, 160)
    }
  }
}

// ─── 调账 ───
const adjustVisible = ref(false)
const adjustSaving = ref(false)
const adjustForm = reactive({
  email: '',
  direction: 'credit' as 'credit' | 'debit',
  amountMajor: '',
  note: '',
})

const adjustPreview = computed(() => {
  try {
    if (!adjustForm.amountMajor.trim()) return ''
    const cents = parseMajorToMinor(adjustForm.amountMajor.trim(), 'CNY')
    if (cents <= 0) return ''
    return formatMoney(cents, 'CNY')
  } catch {
    return ''
  }
})

function openAdjust(item?: AdminUserBalance) {
  adjustForm.email = item?.email || ''
  adjustForm.direction = 'credit'
  adjustForm.amountMajor = ''
  adjustForm.note = ''
  adjustVisible.value = true
}

async function submitAdjust() {
  const email = adjustForm.email.trim().toLowerCase()
  if (!email || !email.includes('@')) {
    showToast('请输入有效邮箱', 'error')
    return
  }
  let amountCents: number
  try {
    amountCents = parseMajorToMinor(adjustForm.amountMajor.trim(), 'CNY')
  } catch {
    showToast('金额格式无效', 'error')
    return
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    showToast('金额必须大于 0', 'error')
    return
  }
  if (adjustForm.direction === 'debit') amountCents = -amountCents

  const note = adjustForm.note.trim()
  if (note.length < 2) {
    showToast('请填写调账备注（至少 2 字）', 'error')
    return
  }

  adjustSaving.value = true
  try {
    const res = await adjustAdminUserBalance(token.value, { email, amountCents, note })
    showToast(res.message || '调账成功', 'success')
    adjustVisible.value = false
    if (activeTab.value === 'accounts') await loadAccounts()
    else await loadLedger()
  } catch (err: any) {
    showToast(err.message || '调账失败', 'error')
  } finally {
    adjustSaving.value = false
  }
}

onMounted(() => {
  initFilterFromRoute()
  if (activeTab.value === 'ledger') {
    loadLedger()
  } else {
    loadAccounts()
  }
})

watch(
  () => route.query,
  () => {
    initFilterFromRoute()
    if (activeTab.value === 'ledger') {
      ledgerPagination.page.value = 1
      loadLedger()
    } else {
      accountPagination.page.value = 1
      loadAccounts()
    }
  },
)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.admin-deeplink {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.admin-deeplink:hover {
  color: var(--admin-accent, #2563eb);
}
/*
 * 共享：admin-tab-bar / balance-helper / filter-check / dir-btn /
 * is-positive / modal-actions / field-hint → admin.css
 * 本页仅保留余额快照与调账预览结构。
 */
.balance-snapshot {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--admin-control-gap, 8px);
  /* 垂直间距交给 .admin-page gap */
  margin: 0;
  flex-shrink: 0;
}

.snapshot-card {
  padding: 12px;
  border-radius: var(--r-lg, 12px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: var(--tg-secondary-bg, #151b28);
}

.snapshot-card--primary {
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.12));
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
}

.snapshot-label {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.snapshot-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--tg-text, #f0f2f5);
}

.snapshot-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.4;
}

.id-cell,
.note-cell {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.adjust-direction {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.adjust-preview {
  margin: 0;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.45;
}

.adjust-preview strong {
  color: var(--admin-accent-text, #fbbf24);
}
</style>
