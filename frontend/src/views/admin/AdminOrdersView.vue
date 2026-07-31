<template>
  <div class="admin-page">
    <div class="tabs" role="tablist" :aria-label="$t('adminOrders.title')">
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'all'"
        :class="{ active: activeTab === 'all' }"
        @click="switchTab('all')"
      >
        {{ $t('adminOrders.statusAll') }}
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'pending'"
        :class="{ active: activeTab === 'pending' }"
        @click="switchTab('pending')"
      >
        {{ $t('adminOrders.statusPending') }}
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'paid'"
        :class="{ active: activeTab === 'paid' }"
        @click="switchTab('paid')"
      >
        {{ $t('adminOrders.statusPaid') }}
      </button>
      <button
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeTab === 'abnormal'"
        :class="{ active: activeTab === 'abnormal' }"
        @click="switchTab('abnormal')"
      >
        {{ $t('adminOrders.statusAbnormal') }}
      </button>
    </div>
    <p class="tab-hint">{{ tabHint }}</p>
    <div class="toolbar">
      <div class="filters">
        <select v-model="filter.status" :aria-label="$t('adminOrders.colStatus')" @change="searchData">
          <option value="">{{ $t('adminOrders.statusAll') }}</option>
          <option value="pending">{{ $t('adminOrders.statusPending') }}</option>
          <option value="paid">{{ $t('adminOrders.statusPaid') }}</option>
          <option value="issued">{{ $t('adminOrders.statusIssued') }}</option>
          <option :value="SETTLEMENT_ORDER_STATUS_QUERY">{{ $t('adminOrders.statusSettled') }}</option>
          <option value="expired">{{ $t('adminOrders.statusExpired') }}</option>
          <option value="failed">{{ $t('adminOrders.statusFailed') }}</option>
          <option value="canceled">{{ $t('adminOrders.statusCancelled') }}</option>
          <option value="closed">{{ $t('adminOrders.statusClosed') }}</option>
          <option value="refunded">{{ $t('adminOrders.statusRefunded') }}</option>
        </select>
        <AdminProductSelect v-model="filter.productId" :aria-label="$t('adminOrders.colProduct')" @change="searchData" />
        <select v-model="filter.orderSource" :aria-label="$t('adminOrders.colSource')" @change="searchData">
          <option value="">{{ $t('adminOrders.sourceAll') }}</option>
          <option value="storefront">{{ $t('adminOrders.sourceStorefront') }}</option>
          <option value="coupon_redeem">{{ $t('adminOrders.sourceCoupon') }}</option>
          <option value="telegram">{{ $t('adminOrders.sourceTelegram') }}</option>
          <option value="lottery">{{ $t('adminOrders.sourceLottery') }}</option>
        </select>
        <select v-model="filter.storefrontId" :aria-label="$t('adminOrders.colStorefront')" @change="searchData">
          <option value="">{{ $t('adminOrders.storefrontAll') }}</option>
          <option v-for="storefront in storefronts" :key="storefront.id" :value="storefront.id">{{ storefront.name }}</option>
        </select>
        <input
          v-model="filter.q"
          type="search"
          maxlength="120"
          :placeholder="$t('adminOrders.search')"
          :title="$t('adminOrders.searchTitle')"
          :aria-label="$t('adminOrders.search')"
          @keyup.enter="searchData"
        />
        <select v-model="filter.paymentMethod" :aria-label="$t('adminOrders.paymentMethod')" @change="searchData">
          <option value="">{{ $t('adminOrders.paymentAll') }}</option>
          <option value="online">{{ $t('adminOrders.paymentOnline') }}</option>
          <option value="offline">{{ $t('adminOrders.paymentOffline') }}</option>
          <option value="balance">{{ $t('adminOrders.paymentBalance') }}</option>
          <option value="lottery">{{ $t('adminOrders.paymentLottery') }}</option>
        </select>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminOrders.searching') : $t('adminOrders.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" @click="exportCsv">{{ $t('adminOrders.actionExportCsv') }}</button>
        <button class="btn btn-ghost btn-sm" @click="exportFinance">{{ $t('adminOrders.actionExportFinance') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="notifying" @click="notifyLowStock">
          {{ notifying ? $t('adminOrders.sending') : $t('adminOrders.notifyLowStock') }}
        </button>
      </div>
    </div>

    <div class="table-command-bar">
      <div class="action-strip" role="group" :aria-label="$t('adminOrders.quickView')">
        <button
          type="button"
          class="action-chip"
          :class="{ 'is-active': activeTab === 'pending' }"
          @click="switchTab('pending')"
        >
          {{ $t('adminOrders.statusPending') }} {{ items.filter((item) => item.status === 'pending').length }}
        </button>
        <button
          type="button"
          class="action-chip"
          :class="{ 'is-active': activeTab === 'paid' }"
          @click="switchTab('paid')"
        >
          {{ $t('adminOrders.statusPaid') }} {{ items.filter((item) => item.status === 'paid').length }}
        </button>
        <button
          type="button"
          class="action-chip"
          :class="{ 'is-active': activeTab === 'abnormal' }"
          @click="switchTab('abnormal')"
        >
          {{ $t('adminOrders.statusAbnormal') }} {{ items.filter((item) => ABNORMAL_ORDER_STATUS_SET.has(normalizeOrderStatus(item.status))).length }}
        </button>
      </div>
      <div v-if="selectedCount > 0" class="table-command-actions" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
        <span class="selection-summary">
          {{ batchOperating
            ? $t('adminOrders.batchProgress', { completed: batchCompleted, total: batchTotal })
            : $t('adminOrders.selectionSummary', { count: selectedCount, safe: selectedSafeDeletableOrders.length }) }}
        </span>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">{{ $t('adminOrders.clearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedOrders">{{ $t('adminOrders.copySelected') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedCsv">{{ $t('adminOrders.exportSelected') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="batchResendEmail">{{ $t('adminOrders.batchResendEmail') }}</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCancelableOrders.length === 0" @click="batchCancelPending">
          {{ $t('adminOrders.batchCancel', { count: selectedCancelableOrders.length }) }}
        </button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCount === 0" @click="batchRemoveOrders">
          {{ $t('adminOrders.batchDelete', { count: selectedCount }) }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminOrders.reload') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminOrders.tableRegionLabel')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminOrders.tableLabel')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                :aria-label="$t('adminOrders.selectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminOrders.colOrderNo') }}</th>
            <th>{{ $t('adminOrders.colProduct') }}</th>
            <!-- 入口类型 + 店面快照；有活动/推荐码时另起一行（不改写 orderSource 主文案） -->
            <th :title="$t('adminOrders.colSourceAttributionTitle')">{{ $t('adminOrders.colSourceAttribution') }}</th>
            <th>{{ $t('adminOrders.colAmount') }}</th>
            <th>{{ $t('adminOrders.colStatus') }}</th>
            <th>{{ $t('adminOrders.colPaymentMethod') }}</th>
            <th>{{ $t('adminOrders.colPaymentRef') }}</th>
            <th>{{ $t('adminOrders.colContact') }}</th>
            <th>{{ $t('adminOrders.colCreatedAt') }}</th>
            <th>{{ $t('adminOrders.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="11"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in items" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating"
                :aria-label="$t('adminOrders.selectRow', { orderNo: item.orderNo || item.id })"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.orderNo }}</td>
            <td>{{ item.productTitle || item.productId }}</td>
            <td>
              <span>{{ orderSourceText(item) }}</span>
              <div v-if="item.orderSource === 'storefront'" class="muted-text">{{ storefrontSnapshotText(item) }}</div>
              <!-- 归因标签：稀疏展示；主文案仍是 orderSource，不是活动码 -->
              <div
                v-if="item.campaignCode || item.referralCode"
                class="order-attribution-line"
                :title="attributionText(item)"
              >
                <span
                  v-if="item.campaignCode"
                  class="tag tag-muted order-attr-tag"
                  :title="$t('adminOrders.campaignTagTitle', { code: item.campaignCode })"
                >{{ $t('adminOrders.campaignTag') }} <code>{{ item.campaignCode }}</code></span>
                <span
                  v-if="item.referralCode"
                  class="tag tag-muted order-attr-tag"
                  :title="$t('adminOrders.referralTagTitle', { code: item.referralCode })"
                >{{ $t('adminOrders.referralTag') }} <code>{{ item.referralCode }}</code></span>
              </div>
            </td>
            <td>{{ formatOrderMoney(item.amountCents ?? 0, item.currency) }}</td>
            <td>
              <span class="tag" :class="statusClass(item.status)">{{ statusText(item.status) }}</span>
            </td>
            <td>{{ paymentMethodText(item) }}</td>
            <td class="id-cell" :title="item.paymentRef || ''">{{ item.paymentRef || '-' }}</td>
            <td>
              <span v-if="item.buyerEmail" class="tag tag-muted" style="margin-right:4px">{{ item.buyerEmail }}</span>
              <span>{{ item.buyerContact || '-' }}</span>
            </td>
            <td>{{ formatDate(item.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-ghost btn-xs" @click="viewDetail(item)">{{ $t('adminOrders.actionDetail') }}</button>
                <button
                  v-if="canManualConfirmPayment(item)"
                  class="btn btn-primary btn-xs"
                  :disabled="markingPaidId === item.id || cancelingId === item.id"
                  @click="markPaid(item.id)"
                >
                  {{ markingPaidId === item.id ? $t('adminOrders.actionMarkingPaid') : $t('adminOrders.actionMarkPaid') }}
                </button>
                <button
                  v-if="item.status === 'pending'"
                  class="btn btn-danger btn-xs"
                  :disabled="markingPaidId === item.id || cancelingId === item.id"
                  @click="cancel(item.id)"
                >
                  {{ cancelingId === item.id ? $t('adminOrders.actionCanceling') : $t('adminOrders.actionCancelOrder') }}
                </button>
                <button
                  v-if="item.status === 'paid'"
                  class="btn btn-primary btn-xs"
                  :disabled="retryingFulfillmentId === item.id"
                  @click="retryFulfillment(item.id)"
                >
                  {{ retryingFulfillmentId === item.id ? $t('adminOrders.actionRetrying') : $t('adminOrders.actionRetryDelivery') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  @click="openCustomerServiceMenu(item.id)"
                >
                  {{ $t('adminOrders.actionCustomerService') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="11" class="empty-text">{{ $t('adminOrders.noData') }}</td>
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

    <AdminModal v-model="detailVisible" :title="$t('adminOrders.detailTitle')" max-width="760px">
      <div v-if="currentOrder" class="detail-box order-detail-box">
        <!-- 顶栏：3 Tab（不随内容滚动）；说明用 title 避免再占纵向高度 -->
        <div class="order-detail-chrome">
          <div
            class="tabs order-detail-section-tabs"
            role="tablist"
            :aria-label="$t('adminOrders.detailSectionLabel')"
          >
            <button
              v-for="section in ORDER_DETAIL_SECTIONS"
              :id="`order-detail-tab-${section.id}`"
              :key="section.id"
              type="button"
              class="tab"
              role="tab"
              :title="$t('adminOrders.detailSection' + section.id.charAt(0).toUpperCase() + section.id.slice(1) + 'Desc')"
              :aria-selected="detailSection === section.id"
              :aria-controls="`order-detail-panel-${section.id}`"
              :class="{ active: detailSection === section.id }"
              @click="selectOrderDetailSection(section.id)"
            >
              {{ $t('adminOrders.detailSection' + section.id.charAt(0).toUpperCase() + section.id.slice(1)) }}
              <span
                v-if="orderDetailTabBadges[section.id]"
                class="order-detail-tab-badge"
              >{{ orderDetailTabBadges[section.id] }}</span>
            </button>
          </div>
        </div>

        <!-- 固定高度滚动区：内容多少不改变弹窗高度 -->
        <div ref="orderDetailScrollRef" class="order-detail-scroll">
          <!-- 概要：交易 + 买家 + 来源 -->
          <div
            v-show="detailSection === 'summary'"
            id="order-detail-panel-summary"
            class="detail-section order-detail-panel"
            role="tabpanel"
            aria-labelledby="order-detail-tab-summary"
          >
            <div class="detail-title detail-title-sub">{{ $t('adminOrders.detailTransaction') }}</div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailOrderNo') }}</span><span class="detail-value">{{ currentOrder.orderNo }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailProduct') }}</span><span class="detail-value">{{ currentOrder.productTitle || currentOrder.productId }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailQuantity') }}</span><span class="detail-value">{{ currentOrder.quantity || 1 }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailAmount') }}</span><span class="detail-value">{{ formatOrderMoney(currentOrder.amountCents ?? 0, currentOrder.currency) }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailStatus') }}</span><span class="detail-value">{{ statusText(currentOrder.status) }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailFulfillmentMode') }}</span><span class="detail-value">{{ currentOrder.fulfillmentMode || '-' }}</span></div>
            <div class="detail-row">
              <span class="detail-label">{{ $t('adminOrders.detailDeliveryVisibility') }}</span>
              <span class="detail-value">{{ deliveryVisibilityText(currentOrder.deliveryVisibility) }}</span>
            </div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailPaymentMethod') }}</span><span class="detail-value">{{ paymentMethodText(currentOrder) }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailPaymentRef') }}</span><span class="detail-value">{{ currentOrder.paymentRef || '-' }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailCreatedAt') }}</span><span class="detail-value">{{ formatDate(currentOrder.createdAt) }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailPaidAt') }}</span><span class="detail-value">{{ formatDate(currentOrder.paidAt) }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailIssuedAt') }}</span><span class="detail-value">{{ formatDate(currentOrder.issuedAt) }}</span></div>

            <div class="detail-title detail-title-sub">{{ $t('adminOrders.detailBuyer') }}</div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailEmail') }}</span><span class="detail-value">{{ currentOrder.buyerEmail || '-' }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailContact') }}</span><span class="detail-value">{{ currentOrder.buyerContact || '-' }}</span></div>
            <template v-if="currentOrder.fulfillmentInput">
              <div class="detail-row">
                <span class="detail-label">{{ currentOrder.fulfillmentInput.label }}</span>
                <span class="detail-value">{{ currentOrder.fulfillmentInput.value }}</span>
              </div>
              <div class="detail-actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="copyFulfillmentInput">{{ $t('adminOrders.detailCopyFulfillmentInput') }}</button>
              </div>
            </template>

            <div class="detail-title detail-title-sub">{{ $t('adminOrders.detailAttribution') }}</div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailOrderSource') }}</span><span class="detail-value">{{ orderSourceText(currentOrder) }}</span></div>
            <div v-if="currentOrder.orderSource === 'storefront'" class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailChannelSnapshot') }}</span><span class="detail-value">{{ storefrontSnapshotText(currentOrder) }}</span></div>
            <div v-if="currentOrder.storefrontId" class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailChannelId') }}</span><span class="detail-value">{{ currentOrder.storefrontId }}</span></div>
            <div class="detail-row">
              <span class="detail-label">{{ $t('adminOrders.detailCampaignCode') }}</span>
              <span class="detail-value">
                <template v-if="currentOrder.campaignCode">
                  <code>{{ currentOrder.campaignCode }}</code>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs detail-deeplink"
                    :title="$t('adminOrders.searchOrdersByCampaign')"
                    @click="searchOrdersByAttribution(currentOrder.campaignCode)"
                  >{{ $t('adminOrders.detailSearchOrders') }}</button>
                </template>
                <template v-else>-</template>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ $t('adminOrders.detailReferralCode') }}</span>
              <span class="detail-value">
                <template v-if="currentOrder.referralCode">
                  <code>{{ currentOrder.referralCode }}</code>
                  <span
                    class="tag tag-muted referral-registry-tag"
                    :title="referralRegistryHintTitle(currentOrder.referralRegistryStatus)"
                  >{{ referralRegistryHintLabel(currentOrder.referralRegistryStatus) }}</span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs detail-deeplink"
                    :title="$t('adminOrders.searchOrdersByReferral')"
                    @click="searchOrdersByAttribution(currentOrder.referralCode)"
                  >{{ $t('adminOrders.detailSearchOrders') }}</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs detail-deeplink"
                    :title="$t('adminOrders.openReferralPage')"
                    @click="openReferralCodesForCode(currentOrder.referralCode)"
                  >{{ $t('adminOrders.detailReferralCodePage') }}</button>
                </template>
                <template v-else>-</template>
              </span>
            </div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailCouponCode') }}</span><span class="detail-value">{{ currentOrder.couponCode || '-' }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailClientIp') }}</span><span class="detail-value">{{ orderClientIpText(currentOrder) }}</span></div>
            <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailUserAgent') }}</span><span class="detail-value">{{ currentOrder.userAgent || '-' }}</span></div>
          </div>

          <!-- 履约：交付 + L1 佣金 -->
          <div
            v-show="detailSection === 'fulfillment'"
            id="order-detail-panel-fulfillment"
            class="detail-section order-detail-panel"
            role="tabpanel"
            aria-labelledby="order-detail-tab-fulfillment"
          >
            <div class="detail-title detail-title-sub">{{ $t('adminOrders.detailDeliveryAndItems') }}</div>
            <template v-if="currentOrder.items && currentOrder.items.length">
              <div class="detail-row" v-for="item in currentOrder.items" :key="item.id">
                <span class="detail-label">{{ item.productTitle || item.productId }}</span>
                <span class="detail-value">x{{ item.quantity }} · {{ formatOrderMoney(item.amountCents, currentOrder.currency) }}</span>
              </div>
            </template>
            <template v-if="hasOrderDelivery">
              <DeliveryInfo :delivery="currentOrder.delivery" :cards="currentOrder.cards" :fulfillment-mode="currentOrderFulfillmentMode" />
              <div class="detail-actions">
                <button v-if="deliveryCopyText" class="btn btn-ghost btn-sm" @click="copyDelivery($event)">{{ $t('adminOrders.detailCopyDelivery') }}</button>
              </div>
            </template>
            <template v-if="currentOrder.cards && currentOrder.cards.length > 1">
              <div class="detail-title detail-title-sub">{{ $t('adminOrders.detailCardList') }}</div>
              <div class="detail-row" v-for="(card, index) in currentOrder.cards" :key="card.id || index">
                <span class="detail-label">{{ $t('adminOrders.detailCardItem', { index: index + 1 }) }}</span>
                <span class="detail-value">{{ card.cardData || card.deliverySecret || '-' }}</span>
              </div>
            </template>
            <div
              v-if="!hasOrderDelivery && !(currentOrder.items && currentOrder.items.length) && !(currentOrder.cards && currentOrder.cards.length)"
              class="detail-row"
            >
              <span class="detail-value muted-text">{{ $t('adminOrders.detailNoDelivery') }}</span>
            </div>

            <div class="detail-title detail-title-sub">{{ $t('adminOrders.detailReferralCommission') }}</div>
            <div v-if="referralRewardLoading" class="detail-row">
              <span class="detail-value">{{ $t('adminOrders.detailReferralLoading') }}</span>
            </div>
            <template v-else-if="referralReward">
              <div class="detail-row">
                <span class="detail-label">{{ $t('adminOrders.detailReferralStatus') }}</span>
                <span class="detail-value">
                  <span class="tag" :class="referralRewardStatusClass(referralReward.status)">{{ referralRewardStatusText(referralReward.status) }}</span>
                  <span v-if="referralReward.skipReason" class="muted-text"> · {{ referralReward.skipReason }}</span>
                </span>
              </div>
              <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailReferralOwner') }}</span><span class="detail-value">{{ referralReward.ownerEmail || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailReferralAmount') }}</span><span class="detail-value">{{ formatOrderMoney(referralReward.amountCents ?? 0, referralReward.currency || 'CNY') }}</span></div>
              <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailReferralCode') }}</span><span class="detail-value"><code>{{ referralReward.referralCode || '-' }}</code></span></div>
              <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailReferralGrantedAt') }}</span><span class="detail-value">{{ formatDate(referralReward.grantedAt) }}</span></div>
              <div class="detail-row"><span class="detail-label">{{ $t('adminOrders.detailReferralReversedAt') }}</span><span class="detail-value">{{ formatDate(referralReward.reversedAt) }}</span></div>
            </template>
            <div v-else class="detail-row">
              <span class="detail-value muted-text">{{ $t('adminOrders.detailReferralNoData') }}</span>
            </div>
            <p class="order-detail-hint">{{ $t('adminOrders.detailFooterHint') }}</p>
          </div>

          <!-- 事件 -->
          <div
            v-show="detailSection === 'events'"
            id="order-detail-panel-events"
            class="detail-section order-detail-panel"
            role="tabpanel"
            aria-labelledby="order-detail-tab-events"
          >
            <template v-if="currentOrder.events && currentOrder.events.length">
              <div class="detail-row" v-for="event in currentOrder.events" :key="event.id">
                <span class="detail-label">{{ formatDate(event.createdAt) }}</span>
                <span class="detail-value event-value">
                  <span class="tag" :class="eventTypeClass(event.type)">{{ eventTypeText(event.type) }}</span>
                  <span>{{ event.message || '-' }}</span>
                </span>
              </div>
            </template>
            <div v-else class="detail-row">
              <span class="detail-value muted-text">{{ $t('adminOrders.detailNoEvents') }}</span>
            </div>
          </div>
        </div>

        <!-- 操作条常驻底栏：跨 tab 可见，不随内容滚动 -->
        <div class="detail-actions order-detail-actions">
          <button
            v-if="currentOrder.status === 'paid'"
            class="btn btn-primary btn-sm"
            :disabled="retryingFulfillmentId === currentOrder.id"
            @click="retryFulfillment(currentOrder.id)"
          >
            {{ retryingFulfillmentId === currentOrder.id ? $t('adminOrders.actionRetrying') : $t('adminOrders.actionRetryDelivery') }}
          </button>
          <button v-if="currentOrder.status === 'paid'" class="btn btn-ghost btn-sm" @click="openFulfillmentProgressDialog(currentOrder.id)">{{ $t('adminOrders.detailFulfillmentProgress') }}</button>
          <button class="btn btn-primary btn-sm" :disabled="resendingEmailId === currentOrder.id" @click="resendEmail(currentOrder.id)">
            {{ resendingEmailId === currentOrder.id ? $t('adminOrders.detailResendingEmail') : $t('adminOrders.detailResendEmail') }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="openEmailLogsForOrder(currentOrder)">{{ $t('adminOrders.detailEmailLogs') }}</button>
          <button
            v-if="currentOrder.paymentMethod === 'balance'"
            class="btn btn-ghost btn-sm"
            type="button"
            @click="openBalanceLedgerForOrder(currentOrder)"
          >
            {{ $t('adminOrders.detailBalanceLedger') }}
          </button>
          <button
            v-if="canRetryReferralReward"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="retryingReferralRewardId === currentOrder.id"
            @click="retryReferralReward(currentOrder.id)"
          >
            {{ retryingReferralRewardId === currentOrder.id ? $t('adminOrders.detailRetryRewardRetrying') : $t('adminOrders.detailRetryReward') }}
          </button>
          <button
            v-if="canMarkOrderRefunded"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="markingRefundedId === currentOrder.id"
            @click="markOrderRefunded(currentOrder.id)"
          >
            {{ markingRefundedId === currentOrder.id ? $t('adminOrders.detailMarkingRefunded') : $t('adminOrders.detailMarkRefunded') }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="savingCompensation" @click="openCompensationDialog(currentOrder.id)">{{ $t('adminOrders.detailCompensationNote') }}</button>
        </div>
      </div>
    </AdminModal>

    <AdminModal v-model="fulfillmentProgressVisible" :title="$t('adminOrders.fulfillmentProgressTitle')" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="submitFulfillmentProgress">
        <label>
          <span>{{ $t('adminOrders.fulfillmentProgressStage') }}</span>
          <select v-model="fulfillmentProgressStage">
            <option v-for="option in fulfillmentProgressOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>
          <span>{{ $t('adminOrders.fulfillmentProgressSupplierRef') }}</span>
          <input v-model.trim="supplierOrderRef" maxlength="120" :placeholder="$t('adminOrders.fulfillmentProgressSupplierRefPlaceholder')" />
        </label>
        <label>
          <span>{{ $t('adminOrders.fulfillmentProgressNote') }}</span>
          <textarea v-model.trim="fulfillmentProgressNote" rows="4" maxlength="500" :placeholder="$t('adminOrders.fulfillmentProgressNotePlaceholder')"></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="savingFulfillmentProgress" @click="fulfillmentProgressVisible = false">{{ $t('adminOrders.cancelModal') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="savingFulfillmentProgress">
            {{ savingFulfillmentProgress ? $t('adminOrders.saving') : $t('adminOrders.saveProgress') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="compensationVisible" :title="$t('adminOrders.compensationTitle')" max-width="480px" hide-actions>
      <form class="modal-form" @submit.prevent="submitCompensation">
        <label>
          <span>{{ $t('adminOrders.compensationNote') }}</span>
          <textarea v-model="compensationNote" rows="4" :placeholder="$t('adminOrders.compensationNotePlaceholder')" required></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="savingCompensation" @click="compensationVisible = false">{{ $t('adminOrders.cancelModal') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="savingCompensation">
            {{ savingCompensation ? $t('adminOrders.submitting') : $t('adminOrders.submit') }}
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
import { ref, reactive, onMounted, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  fetchAdminOrders,
  fetchAdminOrder,
  fetchAdminStorefronts,
  markAdminOrderPaid,
  retryAdminOrderFulfillment,
  updateAdminOrderFulfillmentProgress,
  cancelAdminOrder,
  batchDeleteAdminOrders,
  downloadAdminOrdersExport,
  downloadAdminFinanceExport,
  notifyAdminLowStock,
  resendAdminOrderEmail,
  addAdminOrderCompensationNote,
  fetchAdminOrderReferralReward,
  markAdminOrderRefunded,
  retryAdminOrderReferralReward,
} from '@/api/admin'
import type { AdminOrder, AdminOrderFilter, AdminReferralReward, AdminStorefront } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import { formatDate, statusLabel } from '@/composables/useFormat'
import { copyText, writeClipboardText } from '@/composables/useClipboard'
import { fieldLabel, getDeliveryEntries } from '@/composables/useDeliveryDisplay'
import { downloadCsv } from '@/lib/csv-export'
import { formatMoney } from '@shared/money'
import {
  DEFAULT_ORDER_DETAIL_SECTION_ID,
  ORDER_DETAIL_SECTIONS,
  resolveOrderDetailSectionId,
  type OrderDetailSectionId,
} from './order-detail-sections'
import {
  ABNORMAL_ORDER_STATUSES,
  isPaidLikeOrderStatus,
  isSafeDeleteOrderStatus,
  isSettlementOrderStatusFilter,
  normalizeOrderStatus,
} from '@shared/order-status'
import {
  ADMIN_ORDER_EXPORT_CSV_HEADERS,
  SETTLEMENT_ORDER_STATUS_QUERY,
} from '@shared/admin-order-export'
import i18n from '@/i18n'

const ABNORMAL_ORDER_STATUS_SET = new Set<string>(ABNORMAL_ORDER_STATUSES)
const ABNORMAL_ORDER_STATUS_FILTER = [...ABNORMAL_ORDER_STATUSES]
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import AdminProductSelect from '@/components/AdminProductSelect.vue'
import DeliveryInfo from '@/components/DeliveryInfo.vue'
import {
  DEFAULT_FULFILLMENT_PROGRESS_STAGE,
  FULFILLMENT_PROGRESS_OPTIONS,
  fulfillmentProgressEventLabel,
  type FulfillmentProgressStage,
} from '@shared/fulfillment-progress'

const route = useRoute()
const router = useRouter()
const { showToast } = useToast()
const { token } = useAdminAuth()

function formatOrderMoney(amountCents: number, currency?: string) {
  try {
    return formatMoney(amountCents, currency || 'CNY')
  } catch {
    return `${currency || 'UNKNOWN'} ${amountCents}（${i18n.global.t('adminOrders.currencyError')}）`
  }
}

// 标签页：全部 / 待支付 / 待交付 / 售后异常（失败/取消/关闭/过期/退款）
// 这里的异常集合要和后端订单终态同步，否则运营会漏看关闭、退款等需要人工判断的订单。
type TabKey = 'all' | 'pending' | 'paid' | 'abnormal'
const activeTab = ref<TabKey>('all')

const items = ref<AdminOrder[]>([])
const storefronts = ref<AdminStorefront[]>([])
const loading = ref(false)
const loadError = ref('')
const notifying = ref(false)
const markingPaidId = ref('')
const retryingFulfillmentId = ref('')
const cancelingId = ref('')
const resendingEmailId = ref('')
const markingRefundedId = ref('')
const retryingReferralRewardId = ref('')
const referralReward = ref<AdminReferralReward | null>(null)
const referralRewardLoading = ref(false)
const savingCompensation = ref(false)
const fulfillmentProgressVisible = ref(false)
const savingFulfillmentProgress = ref(false)
const fulfillmentProgressOptions = computed(() => FULFILLMENT_PROGRESS_OPTIONS.map((option) => ({
  value: option.value,
  label: i18n.global.t(`adminOrders.fulfillmentProgressStages.${option.value}`, {}, { default: option.label }),
})))
const fulfillmentProgressStage = ref<FulfillmentProgressStage>(DEFAULT_FULFILLMENT_PROGRESS_STAGE)
const supplierOrderRef = ref('')
const fulfillmentProgressNote = ref('')
let fulfillmentProgressOrderId: string | null = null
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
} = useTableSelection(items, (item) => item.id)
const filter = reactive<AdminOrderFilter>({
  status: '',
  productId: '',
  q: '',
  paymentMethod: '',
  orderSource: '',
  storefrontId: '',
  page: 1,
})

const pagination = useTablePagination()
const selectedOrders = computed(() => {
  const selected = new Set(selectedIds.value)
  return items.value.filter((item) => selected.has(item.id))
})
const selectedCancelableOrders = computed(() => selectedOrders.value.filter((item) => item.status === 'pending'))
/** 未勾选「全部删除」时后端允许的安全终态（与 shared SAFE_DELETE_ORDER_STATUSES 同步，含历史 cancelled） */
const selectedSafeDeletableOrders = computed(() => selectedOrders.value.filter((item) => (
  isSafeDeleteOrderStatus(item.status)
)))
const ORDER_DELETE_CONFIRM_OPTIONS = [
  {
    key: 'force',
    label: i18n.global.t('adminOrders.deleteAllLabel'),
    hint: i18n.global.t('adminOrders.deleteAllHint'),
  },
  {
    key: 'unlinkRefs',
    label: i18n.global.t('adminOrders.unlinkOrderLabel'),
    hint: i18n.global.t('adminOrders.unlinkOrderHint'),
  },
] as const
let loadSequence = 0

// 从路由 query 初始化筛选条件（支持从 Dashboard 跳转）
function initFilterFromRoute() {
  const query = route.query
  activeTab.value = 'all'
  filter.status = ''
  filter.productId = ''
  filter.q = ''
  filter.paymentMethod = ''
  filter.orderSource = ''
  filter.storefrontId = ''
  if (query.tab) {
    const tab = String(query.tab) as TabKey
    if (tab === 'all' || tab === 'pending' || tab === 'paid' || tab === 'abnormal') {
      activeTab.value = tab
    }
  }
  if (!query.status && activeTab.value !== 'all') {
    if (activeTab.value === 'pending') {
      filter.status = 'pending'
    } else if (activeTab.value === 'paid') {
      filter.status = 'paid'
    } else if (activeTab.value === 'abnormal') {
      filter.status = ABNORMAL_ORDER_STATUS_FILTER
    }
  }
  if (query.status) {
    const status = String(query.status)
    if (status.includes(',')) {
      const parts = status.split(',').map((item) => item.trim()).filter(Boolean)
      // 结算口径 paid+issued：保持逗号串，便于状态下拉回显「已成交（结算）」
      filter.status = isSettlementOrderStatusFilter(parts)
        ? SETTLEMENT_ORDER_STATUS_QUERY
        : parts
    } else {
      filter.status = status
    }
  }
  if (query.paymentMethod) {
    filter.paymentMethod = String(query.paymentMethod)
  }
  if (query.q) {
    // 与后端 buildOrderConditions / 输入 maxlength 对齐，避免路由深链超长 LIKE
    filter.q = String(query.q).slice(0, 120)
  }
  if (query.productId) {
    filter.productId = String(query.productId)
  }
  if (query.orderSource) {
    filter.orderSource = String(query.orderSource)
  }
  if (query.storefrontId) {
    filter.storefrontId = String(query.storefrontId)
  }
}

function switchTab(tab: TabKey) {
  activeTab.value = tab
  filter.productId = ''
  filter.q = ''
  filter.paymentMethod = ''
  pagination.page.value = 1

  if (tab === 'all') {
    filter.status = ''
  } else if (tab === 'pending') {
    filter.status = 'pending'
  } else if (tab === 'paid') {
    filter.status = 'paid'
  } else if (tab === 'abnormal') {
    filter.status = ABNORMAL_ORDER_STATUS_FILTER
  }
  searchData()
}

const tabHint = computed(() => {
  const hints: Record<TabKey, string> = {
    all: i18n.global.t('adminOrders.tabHintAll'),
    pending: i18n.global.t('adminOrders.tabHintPending'),
    paid: i18n.global.t('adminOrders.tabHintPaid'),
    abnormal: i18n.global.t('adminOrders.tabHintAbnormal'),
  }
  return hints[activeTab.value]
})

const detailVisible = ref(false)
const currentOrder = ref<AdminOrder | null>(null)
/** 详情 3 Tab（概要 / 履约 / 事件）；打开订单时重置为概要 */
const detailSection = ref<OrderDetailSectionId>(DEFAULT_ORDER_DETAIL_SECTION_ID)
/** 分区内容滚动容器：切 Tab / 打开时回到顶部 */
const orderDetailScrollRef = ref<HTMLElement | null>(null)

function selectOrderDetailSection(id: OrderDetailSectionId) {
  detailSection.value = resolveOrderDetailSectionId(id)
}

async function resetOrderDetailScroll() {
  await nextTick()
  if (orderDetailScrollRef.value) orderDetailScrollRef.value.scrollTop = 0
}

/** Tab 角标：状态 / 交付或佣金提示 / 事件条数 */
const orderDetailTabBadges = computed(() => {
  const order = currentOrder.value
  const badges: Partial<Record<OrderDetailSectionId, string>> = {}
  if (!order) return badges

  badges.summary = statusText(order.status)

  const itemN = order.items?.length ?? 0
  const cardN = order.cards?.length ?? 0
  if (referralReward.value?.status) {
    const st = referralReward.value.status
    const short: Record<string, string> = {
      pending: '待',
      granting: '中',
      granted: '入',
      skipped: '跳',
      failed: '败',
      reversing: '冲',
      reversed: '已冲',
      reverse_failed: '冲败',
    }
    badges.fulfillment = short[st] || '佣'
  } else if (cardN > 0) {
    badges.fulfillment = String(Math.min(cardN, 99))
  } else if (hasOrderDelivery.value || itemN > 0 || order.referralCode) {
    badges.fulfillment = '·'
  }

  if (order.events && order.events.length > 0) {
    badges.events = String(Math.min(order.events.length, 99))
  }
  return badges
})

/** paid|issued：可标记站外退款并冲正佣金（与后端 mark-refunded CAS 同源） */
const canMarkOrderRefunded = computed(() => isPaidLikeOrderStatus(currentOrder.value?.status))

/** skipped/failed/pending 或尚无台账时可重试发奖；granted 等终态由后端 409 拒绝 */
const canRetryReferralReward = computed(() => {
  const order = currentOrder.value
  if (!order || !isPaidLikeOrderStatus(order.status)) return false
  const st = referralReward.value?.status
  if (!st) return Boolean(order.referralCode)
  return ['pending', 'skipped', 'failed'].includes(st)
})

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

// 客服动作：打开菜单（后续可扩展为下拉或弹窗）
function openCustomerServiceMenu(orderId: string) {
  // 当前直接打开详情，已在详情中提供“重发邮件 / 补偿备注”
  const item = items.value.find((entry) => entry.id === orderId)
  if (item) viewDetail(item)
}

const compensationVisible = ref(false)
const compensationNote = ref('')
let compensationOrderId: string | null = null

const currentOrderFulfillmentMode = computed(() => {
  // 后台详情优先展示订单明细快照，避免商品后来改交付模式后误导客服处理历史订单。
  const firstItem = currentOrder.value?.items?.find(item => item.fulfillmentMode)
  return firstItem?.fulfillmentMode || currentOrder.value?.fulfillmentMode || (currentOrder.value?.cards?.length ? 'card' : '')
})

const isCurrentOrderCardDelivery = computed(() => currentOrderFulfillmentMode.value === 'card' || Boolean(currentOrder.value?.cards?.length))

const hasOrderDelivery = computed(() => Boolean(
  (currentOrder.value?.delivery && Object.values(currentOrder.value.delivery).some(Boolean)) ||
  (currentOrder.value?.cards && currentOrder.value.cards.length > 0),
))

const deliveryCopyText = computed(() => {
  if (!currentOrder.value?.delivery) return ''
  const delivery = currentOrder.value.delivery
  const lines: string[] = []
  if (isCurrentOrderCardDelivery.value) {
    if (delivery.accountLabel) lines.push(`${i18n.global.t('adminOrders.deliveryAccountLabel')}：${delivery.accountLabel}`)
    if (delivery.deliverySecret) lines.push(`${i18n.global.t('adminOrders.deliverySecretLabel')}：${delivery.deliverySecret}`)
    if (delivery.deliveryNote) lines.push(`${i18n.global.t('adminOrders.deliveryNoteLabel')}：${delivery.deliveryNote}`)
  } else {
    getDeliveryEntries(delivery as Record<string, unknown>, { includeLegacyDeliveryFields: true })
      .forEach(([key, value]) => lines.push(`${fieldLabel(key)}：${value}`))
  }
  return lines.join('\n')
})

async function resendEmail(id: string) {
  if (resendingEmailId.value) return
  resendingEmailId.value = id
  try {
    const res = await resendAdminOrderEmail(token.value, id)
    showToast(res.message || i18n.global.t('adminOrders.resendSuccess'), 'success')
    // 重发成功后刷新详情，展示 email_resent / 最新 email_logs 关联事件（V-012）
    if (currentOrder.value?.id === id) {
      try {
        await refreshOrderDetail(id)
      } catch {
        // 列表 toast 已成功；详情刷新失败不阻断
      }
    }
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.resendFailed'), 'error')
    // 失败也可能已写 email_failed：尽量刷新事件时间线
    if (currentOrder.value?.id === id) {
      try {
        await refreshOrderDetail(id)
      } catch {
        // ignore
      }
    }
  } finally {
    resendingEmailId.value = ''
  }
}

function copyDelivery(event: Event) {
  if (!deliveryCopyText.value) return
  copyText(deliveryCopyText.value, event)
  showToast(i18n.global.t('adminOrders.copyDeliverySuccess'), 'success')
}

async function copyFulfillmentInput() {
  const input = currentOrder.value?.fulfillmentInput
  if (!input) return
  try {
    await writeClipboardText(input.value)
    showToast(i18n.global.t('adminOrders.copyFulfillmentSuccess'), 'success')
  } catch {
    showToast(i18n.global.t('adminOrders.copyFulfillmentFailed'), 'error')
  }
}

function openCompensationDialog(id: string) {
  compensationOrderId = id
  compensationNote.value = ''
  compensationVisible.value = true
}

function openFulfillmentProgressDialog(id: string) {
  if (savingFulfillmentProgress.value) return
  fulfillmentProgressOrderId = id
  fulfillmentProgressStage.value = DEFAULT_FULFILLMENT_PROGRESS_STAGE
  supplierOrderRef.value = ''
  fulfillmentProgressNote.value = ''
  fulfillmentProgressVisible.value = true
}

async function submitFulfillmentProgress() {
  if (savingFulfillmentProgress.value || !fulfillmentProgressOrderId) return
  const supplierRef = supplierOrderRef.value.trim()
  const note = fulfillmentProgressNote.value.trim()
  if (!supplierRef && !note) {
    showToast(i18n.global.t('adminOrders.fulfillmentProgressRequired'), 'error')
    return
  }

  savingFulfillmentProgress.value = true
  const orderId = fulfillmentProgressOrderId
  try {
    const res = await updateAdminOrderFulfillmentProgress(token.value, orderId, {
      stage: fulfillmentProgressStage.value,
      supplierOrderRef: supplierRef || undefined,
      note: note || undefined,
    })
    showToast(res.message || i18n.global.t('adminOrders.fulfillmentProgressSuccess'), 'success')
    fulfillmentProgressVisible.value = false
    fulfillmentProgressOrderId = null
    if (currentOrder.value?.id === orderId) {
      const detail = await fetchAdminOrder(token.value, orderId)
      currentOrder.value = detail.order
    }
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.fulfillmentProgressFailed'), 'error')
  } finally {
    savingFulfillmentProgress.value = false
  }
}

async function submitCompensation() {
  if (savingCompensation.value) return
  if (!compensationOrderId) return
  const note = compensationNote.value.trim()
  if (!note) return
  savingCompensation.value = true
  try {
    const res = await addAdminOrderCompensationNote(token.value, compensationOrderId, { note })
    showToast(res.message || i18n.global.t('adminOrders.compensationSuccess'), 'success')
    compensationVisible.value = false
    compensationOrderId = null
    compensationNote.value = ''
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.compensationFailed'), 'error')
  } finally {
    savingCompensation.value = false
  }
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminOrders(token.value, {
      ...filter,
      page: pagination.page.value,
      limit: pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.orders
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || i18n.global.t('adminOrders.loadFailed')
    showToast(err.message || i18n.global.t('adminOrders.loadFailed'), 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function searchData() {
  pagination.page.value = 1
  const query: Record<string, string> = {}
  if (activeTab.value !== 'all') query.tab = activeTab.value
  const status = Array.isArray(filter.status) ? filter.status.join(',') : filter.status
  if (status) query.status = status
  if (filter.productId) query.productId = filter.productId
  if (filter.q) query.q = filter.q
  if (filter.paymentMethod) query.paymentMethod = filter.paymentMethod
  if (filter.orderSource) query.orderSource = filter.orderSource
  if (filter.storefrontId) query.storefrontId = filter.storefrontId
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadData()
    return
  }
  void router.replace({ path: route.path, query })
}

async function loadReferralRewardForOrder(orderId: string) {
  referralRewardLoading.value = true
  try {
    const res = await fetchAdminOrderReferralReward(token.value, orderId)
    if (currentOrder.value?.id === orderId) {
      referralReward.value = res.reward
    }
  } catch {
    if (currentOrder.value?.id === orderId) {
      referralReward.value = null
    }
  } finally {
    referralRewardLoading.value = false
  }
}

async function refreshOrderDetail(orderId: string) {
  const detail = await fetchAdminOrder(token.value, orderId)
  if (currentOrder.value?.id === orderId) {
    currentOrder.value = detail.order
  }
  await loadReferralRewardForOrder(orderId)
}

async function viewDetail(item: AdminOrder) {
  try {
    const res = await fetchAdminOrder(token.value, item.id)
    currentOrder.value = res.order
    referralReward.value = null
    detailSection.value = DEFAULT_ORDER_DETAIL_SECTION_ID
    detailVisible.value = true
    await resetOrderDetailScroll()
    await loadReferralRewardForOrder(item.id)
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.detailLoadFailed'), 'error')
  }
}

// 非法 detailSection 回落概要；切 Tab 时内容区回到顶部
watch(detailSection, (id) => {
  const next = resolveOrderDetailSectionId(id)
  if (next !== id) {
    detailSection.value = next
    return
  }
  void resetOrderDetailScroll()
})

function referralRewardStatusText(status?: string) {
  const map: Record<string, string> = {
    pending: i18n.global.t('adminOrders.referralStatusPending'),
    granting: i18n.global.t('adminOrders.referralStatusGranting'),
    granted: i18n.global.t('adminOrders.referralStatusGranted'),
    skipped: i18n.global.t('adminOrders.referralStatusSkipped'),
    failed: i18n.global.t('adminOrders.referralStatusFailed'),
    reversing: i18n.global.t('adminOrders.referralStatusReversing'),
    reversed: i18n.global.t('adminOrders.referralStatusReversed'),
    reverse_failed: i18n.global.t('adminOrders.referralStatusReverseFailed'),
  }
  return map[status || ''] || status || '-'
}

function referralRewardStatusClass(status?: string) {
  if (!status) return 'tag-muted'
  if (['granted'].includes(status)) return 'tag-success'
  if (['failed', 'reverse_failed'].includes(status)) return 'tag-danger'
  if (['reversed', 'skipped'].includes(status)) return 'tag-muted'
  if (['granting', 'reversing', 'pending'].includes(status)) return 'tag-warning'
  return 'tag-info'
}

async function markOrderRefunded(id: string) {
  if (markingRefundedId.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.confirmRefundTitle')))) return
  markingRefundedId.value = id
  try {
    const res = await markAdminOrderRefunded(token.value, id, { note: 'admin_ui_refund' })
    const rev = res.reverse?.outcome || ''
    const groupBuyFailed = Number(res.groupBuyReverse?.failed || 0)
    const groupBuyReversed = Number(res.groupBuyReverse?.reversed || 0)
    const groupBuyAlready = Number(res.groupBuyReverse?.alreadyReversed || 0)
    showToast(
      groupBuyFailed > 0
        ? i18n.global.t('adminOrders.refundGroupBuyReverseFailed', { count: groupBuyFailed })
        : groupBuyReversed > 0 || groupBuyAlready > 0
          ? i18n.global.t('adminOrders.refundGroupBuyReversed', { count: groupBuyReversed + groupBuyAlready })
          : rev === 'reversed'
            ? i18n.global.t('adminOrders.refundResultReversed')
            : rev === 'noop'
              ? i18n.global.t('adminOrders.refundResultNoop', { reason: res.reverse?.reason || 'noop' })
              : rev === 'reverse_failed'
                ? i18n.global.t('adminOrders.refundResultReverseFailed', { reason: res.reverse?.reason || 'reverse_failed' })
                : i18n.global.t('adminOrders.refundResultDefault', { result: rev || 'ok' }),
      rev === 'reverse_failed' || rev === 'failed' || groupBuyFailed > 0 ? 'error' : 'success',
    )
    await refreshOrderDetail(id)
    await loadData()
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.refundFailed'), 'error')
  } finally {
    markingRefundedId.value = ''
  }
}

async function retryReferralReward(id: string) {
  if (retryingReferralRewardId.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.confirmRetryReferralReward')))) return
  retryingReferralRewardId.value = id
  try {
    const res = await retryAdminOrderReferralReward(token.value, id)
    const outcome = res.result?.outcome || ''
    showToast(
      outcome === 'granted'
        ? i18n.global.t('adminOrders.retryRewardResult', { amount: formatOrderMoney(res.result?.amountCents ?? 0, 'CNY') })
        : outcome === 'skipped'
          ? i18n.global.t('adminOrders.retryRewardSkipped', { reason: res.result?.reason || 'skipped' })
          : outcome === 'exists'
            ? i18n.global.t('adminOrders.retryRewardExists', { status: res.result?.status || 'exists' })
            : outcome === 'failed'
              ? i18n.global.t('adminOrders.retryRewardFailed', { message: res.result?.message || 'failed' })
              : i18n.global.t('adminOrders.retryRewardDefault', { outcome: outcome || 'ok' }),
      outcome === 'failed' ? 'error' : 'success',
    )
    await refreshOrderDetail(id)
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.retryRewardError'), 'error')
  } finally {
    retryingReferralRewardId.value = ''
  }
}

/** 运营深链：订单详情 → 邮件投递记录（按 orderId 模糊搜） */
function openEmailLogsForOrder(order: AdminOrder) {
  const search = String(order.id || order.orderNo || '').trim().slice(0, 200)
  if (!search) {
    showToast(i18n.global.t('adminOrders.detailOpenEmailLogs'), 'error')
    return
  }
  void router.push({ path: '/admin/email-logs', query: { search } })
}

/** 运营深链：余额支付订单 → 余额流水（referenceType=order + referenceId） */
function openBalanceLedgerForOrder(order: AdminOrder) {
  const referenceId = String(order.id || '').trim().slice(0, 120)
  if (!referenceId) {
    showToast(i18n.global.t('adminOrders.detailOpenEmailLogs'), 'error')
    return
  }
  const query: Record<string, string> = {
    tab: 'ledger',
    referenceType: 'order',
    referenceId,
  }
  const email = String(order.buyerEmail || '').trim().slice(0, 160)
  if (email) query.email = email
  void router.push({ path: '/admin/balance', query })
}

/** 运营深链：用活动码/推荐码字符串筛选订单列表（与搜索框 q 同源） */
function searchOrdersByAttribution(code: string | undefined) {
  const q = String(code || '').trim().slice(0, 120)
  if (!q) {
    showToast(i18n.global.t('adminOrders.searchOrdersNoCode'), 'error')
    return
  }
  detailVisible.value = false
  void router.push({ path: '/admin/orders', query: { q } })
}

/** 运营深链：订单详情 → 推荐码管理页（按码搜索登记信息） */
function openReferralCodesForCode(code: string | undefined) {
  const q = String(code || '').trim().slice(0, 40)
  if (!q) {
    showToast(i18n.global.t('adminOrders.openReferralNoCode'), 'error')
    return
  }
  void router.push({ path: '/admin/referral-codes', query: { q } })
}

async function markPaid(id: string) {
  if (markingPaidId.value || cancelingId.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.markPaidConfirm')))) return
  markingPaidId.value = id
  try {
    await markAdminOrderPaid(token.value, id)
    showToast(i18n.global.t('adminOrders.markPaidSuccess'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.operationFailed'), 'error')
  } finally {
    markingPaidId.value = ''
  }
}

async function retryFulfillment(id: string) {
  if (retryingFulfillmentId.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.confirmRetryFulfillment')))) return
  retryingFulfillmentId.value = id
  try {
    const res = await retryAdminOrderFulfillment(token.value, id)
    showToast(res.message || i18n.global.t('adminOrders.fulfillmentSuccess'), 'success')
    detailVisible.value = false
    currentOrder.value = null
    await loadData()
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.fulfillmentFailed'), 'error')
  } finally {
    retryingFulfillmentId.value = ''
  }
}

function canManualConfirmPayment(order: AdminOrder) {
  return order.status === 'pending' && order.paymentMethod === 'offline'
}

function orderSourceText(order: AdminOrder) {
  if (order.orderSource === 'coupon_redeem') return i18n.global.t('adminOrders.orderSourceCouponRedeem')
  if (order.orderSource === 'telegram') return i18n.global.t('adminOrders.orderSourceTelegram')
  if (order.orderSource === 'lottery') return i18n.global.t('adminOrders.orderSourceLottery')
  return i18n.global.t('adminOrders.orderSourceStorefront')
}

function paymentMethodText(order: AdminOrder) {
  const method = String(order.paymentMethod || '').trim()
  const provider = String(order.paymentProvider || '').trim()
  if (method === 'lottery' || provider === 'lottery' || order.orderSource === 'lottery') return i18n.global.t('adminOrders.paymentLottery')
  if (method === 'online') return i18n.global.t('adminOrders.paymentOnline')
  if (method === 'offline') return i18n.global.t('adminOrders.paymentOffline')
  if (method === 'balance') return i18n.global.t('adminOrders.paymentBalance')
  if (method === 'free') return i18n.global.t('adminOrders.paymentFree')
  return method || '-'
}

function storefrontSnapshotText(order: AdminOrder) {
  const name = order.storefrontNameSnapshot || i18n.global.t('adminOrders.storefrontSnapshotUnknown')
  return order.storefrontSlugSnapshot ? `${name} (${order.storefrontSlugSnapshot})` : name
}

/**
 * 列表归因可读摘要（title / 无障碍；DOM 用标签展示）。
 * 空码不参与；不改变 orderSource 主文案。
 */
function attributionText(order: AdminOrder) {
  const parts: string[] = []
  if (order.campaignCode) parts.push(i18n.global.t('adminOrders.attributionCampaign', { code: order.campaignCode }))
  if (order.referralCode) parts.push(i18n.global.t('adminOrders.attributionReferral', { code: order.referralCode }))
  return parts.join(' · ')
}

/**
 * 订单详情展示客户端 IP 明文。
 *
 * 语义分支（勿混为一谈）：
 * - storefront / redeem 等：多为买家侧 CF-Connecting-IP（运营排障主路径）
 * - telegram：Webhook 请求的出口 IP，**通常是 Telegram 基础设施**，不是买家设备公网 IP
 * - 历史单：仅有 ip_hash 时不可逆还原，明示「未存明文」
 */
function orderClientIpText(order: AdminOrder) {
  const plain = String(order.clientIp || '').trim()
  if (plain) {
    // TG 单：避免运营把渠道侧 IP 当成用户 IP 做风控结论
    if (order.orderSource === 'telegram') {
      return i18n.global.t('adminOrders.clientIpTelegram', { ip: plain })
    }
    return plain
  }
  // 有 hash 无明文 = 迁移前旧单
  if (order.ipHash) return i18n.global.t('adminOrders.clientIpHashOnly')
  return i18n.global.t('adminOrders.clientIpNone')
}

/** 推荐码登记状态：只读提示，不挡交易 */
function referralRegistryHintLabel(status: AdminOrder['referralRegistryStatus']) {
  switch (status) {
    case 'active':
      return i18n.global.t('adminOrders.registryStatusActive')
    case 'inactive':
      return i18n.global.t('adminOrders.registryStatusInactive')
    case 'unregistered':
      return i18n.global.t('adminOrders.registryStatusUnregistered')
    default:
      return ''
  }
}

function referralRegistryHintTitle(status: AdminOrder['referralRegistryStatus']) {
  switch (status) {
    case 'active':
      return i18n.global.t('adminOrders.registryTitleActive')
    case 'inactive':
      return i18n.global.t('adminOrders.registryTitleInactive')
    case 'unregistered':
      return i18n.global.t('adminOrders.registryTitleUnregistered')
    default:
      return ''
  }
}

async function cancel(id: string) {
  if (markingPaidId.value || cancelingId.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.cancelConfirm')))) return
  cancelingId.value = id
  try {
    await cancelAdminOrder(token.value, id)
    showToast(i18n.global.t('adminOrders.cancelSuccess'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.operationFailed'), 'error')
  } finally {
    cancelingId.value = ''
  }
}

async function batchCancelPending() {
  const orders = selectedCancelableOrders.value
  if (orders.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.batchCancelConfirm', { count: orders.length })))) return
  const result = await runSequential(orders, async (order) => {
    await cancelAdminOrder(token.value, order.id)
  })
  if (!result) return
  showToast(i18n.global.t('adminOrders.batchCancelResult', { success: result.success, failed: result.failed }), result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems.map((order) => order.id)
}

async function batchResendEmail() {
  const orders = selectedOrders.value
  if (orders.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.batchResendConfirm', { count: orders.length })))) return
  const result = await runSequential(orders, async (order) => {
    await resendAdminOrderEmail(token.value, order.id)
  })
  if (!result) return
  showToast(i18n.global.t('adminOrders.batchResendResult', { success: result.success, failed: result.failed }), result.failed ? 'error' : 'success')
  selectedIds.value = result.failedItems.map((order) => order.id)
  // 若当前详情在批量集合内，刷新事件时间线（email_resent / email_failed）
  const openId = currentOrder.value?.id
  if (openId && orders.some((order) => order.id === openId)) {
    try {
      await refreshOrderDetail(openId)
    } catch {
      // 批量 toast 已反馈；详情刷新失败不阻断
    }
  }
}

async function batchRemoveOrders() {
  const orders = selectedOrders.value
  if (orders.length === 0 || loading.value || batchOperating.value) return
  const safeCount = selectedSafeDeletableOrders.value.length
  const decision = await askConfirmWithOptions(
    i18n.global.t('adminOrders.confirmBatchDeleteAdmin', { count: orders.length, safeCount }),
    { options: [...ORDER_DELETE_CONFIRM_OPTIONS] },
  )
  if (!decision.confirmed) return
  const force = decision.options.force === true
  const unlinkRefs = decision.options.unlinkRefs === true
  batchOperating.value = true
  batchCompleted.value = 0
  batchTotal.value = orders.length
  try {
    const result = await batchDeleteAdminOrders(
      token.value,
      orders.map((order) => order.id),
      { force, unlinkRefs },
    )
    batchCompleted.value = result.deleted
    const flags = [
      force ? i18n.global.t('adminOrders.statusForceDelete') : i18n.global.t('adminOrders.statusTerminalOnly'),
      unlinkRefs ? i18n.global.t('adminOrders.statusLinked') : i18n.global.t('adminOrders.statusUnlinked'),
    ].join(' · ')
    showToast(i18n.global.t('adminOrders.batchDeleteResult', { count: result.deleted, flags }), 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.batchDeleteFailed'), 'error')
  } finally {
    batchOperating.value = false
  }
}

/** 列表行 → 导出单元格（缺省空串；productTitle 回退 productId） */
function orderExportCell(order: AdminOrder, key: (typeof ADMIN_ORDER_EXPORT_CSV_HEADERS)[number]): string {
  switch (key) {
    case 'productTitle':
      return order.productTitle || order.productId || ''
    case 'storefrontId':
      return order.storefrontId || ''
    case 'storefrontNameSnapshot':
      return order.storefrontNameSnapshot || ''
    case 'storefrontSlugSnapshot':
      return order.storefrontSlugSnapshot || ''
    case 'amountCents':
      return String(order.amountCents ?? '')
    case 'discountCents':
      return String(order.discountCents ?? '')
    case 'orderSource':
      return orderSourceText(order)
    case 'status':
      return statusText(order.status)
    case 'paymentMethod':
      return paymentMethodText(order)
    case 'accountLabel':
      return order.accountLabel || order.delivery?.accountLabel || ''
    case 'deliveryNote':
      return order.deliveryNote || order.delivery?.deliveryNote || ''
    case 'batchId':
      // 列表可能未带批次元数据；完整履约列请用服务端「导出 CSV」
      return order.batchId || ''
    default: {
      const value = order[key as keyof AdminOrder]
      if (value == null) return ''
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value)
      }
      return ''
    }
  }
}

function exportSelectedCsv() {
  const orders = selectedOrders.value
  if (orders.length === 0) return
  // 表头与 shared/admin-order-export + 服务端 /orders/export 同源
  const headers = [...ADMIN_ORDER_EXPORT_CSV_HEADERS]
  const rows = orders.map((order) => headers.map((key) => orderExportCell(order, key)))
  downloadCsv(`selected-orders-${new Date().toISOString().slice(0, 10)}.csv`, [headers, ...rows])
  showToast(i18n.global.t('adminOrders.exportSelectedSuccess', { count: orders.length }), 'success')
}

async function copySelectedOrders() {
  const orders = selectedOrders.value
  if (orders.length === 0) return
  // TSV：订单号 / 商品 / 联系 / 金额 / 状态 / 流水 / 活动 / 推荐 / 支付时间（人工结算粘贴表）
  const lines = orders.map((order) => [
    order.orderNo || '',
    order.productTitle || order.productId || '',
    order.buyerEmail || order.buyerContact || '',
    String(order.amountCents ?? ''),
    order.status || '',
    order.paymentRef || '',
    order.campaignCode || '',
    order.referralCode || '',
    order.paidAt || '',
  ].join('\t'))
  try { await writeClipboardText(lines.join('\n')); showToast(i18n.global.t('adminOrders.copySelectedSuccess', { count: orders.length }), 'success') }
  catch { showToast(i18n.global.t('adminOrders.copySelectedFailed'), 'error') }
}

async function exportCsv() {
  try {
    const blob = await downloadAdminOrdersExport(token.value, {
      status: filter.status,
      productId: filter.productId,
      q: filter.q,
      paymentMethod: filter.paymentMethod,
      orderSource: filter.orderSource,
      storefrontId: filter.storefrontId,
      format: 'csv',
      limit: 1000,
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'orders.csv'
    a.click()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.exportFailed'), 'error')
  }
}

async function exportFinance() {
  try {
    const blob = await downloadAdminFinanceExport(token.value, {
      status: filter.status,
      productId: filter.productId,
      q: filter.q,
      paymentMethod: filter.paymentMethod,
      orderSource: filter.orderSource,
      storefrontId: filter.storefrontId,
      format: 'csv',
      limit: 2000,
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `finance-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast(i18n.global.t('adminOrders.exportFinanceSuccess'), 'success')
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.exportFailed'), 'error')
  }
}

async function notifyLowStock() {
  if (notifying.value) return
  if (!(await askConfirm(i18n.global.t('adminOrders.notifyLowStockConfirm')))) return
  notifying.value = true
  try {
    const res = await notifyAdminLowStock(token.value, {})
    if (res.sent) {
      showToast(i18n.global.t('adminOrders.notifyLowStockSent', { count: res.count }), 'success')
    } else {
      showToast(res.message || i18n.global.t('adminOrders.notifyLowStockNone'), 'info')
    }
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminOrders.notifyLowStockFailed'), 'error')
  } finally {
    notifying.value = false
  }
}

function statusClass(status?: string) {
  const map: Record<string, string> = {
    pending: 'tag-muted',
    paid: 'tag-success',
    issued: 'tag-success',
    expired: 'tag-muted',
    failed: 'tag-danger',
    canceled: 'tag-muted',
    closed: 'tag-muted',
    refunded: 'tag-danger',
  }
  return map[normalizeOrderStatus(status)] || 'tag-muted'
}

function statusText(status?: string) {
  return statusLabel(status || '')
}

/** 订单级交付可见性快照文案（非商品当前配置） */
function deliveryVisibilityText(value?: string | null) {
  if (value === 'email_only') return i18n.global.t('adminOrders.deliveryVisibilityEmailOnly')
  if (value === 'web_and_email') return i18n.global.t('adminOrders.deliveryVisibilityWebAndEmail')
  return value ? String(value) : '—'
}

function eventTypeText(type: string) {
  const map: Record<string, string> = {
    notification_failed: i18n.global.t('adminOrders.eventNotificationFailed'),
    email_failed: i18n.global.t('adminOrders.eventEmailFailed'),
    email_resent: i18n.global.t('adminOrders.eventEmailResent'),
    issue_failed: i18n.global.t('adminOrders.eventIssueFailed'),
    callback_issue_failed: i18n.global.t('adminOrders.eventCallbackIssueFailed'),
    callback_issue_exception: i18n.global.t('adminOrders.eventCallbackIssueException'),
    payment_rejected: i18n.global.t('adminOrders.eventPaymentRejected'),
    callback_rejected: i18n.global.t('adminOrders.eventCallbackRejected'),
    callback_amount_mismatch: i18n.global.t('adminOrders.eventCallbackAmountMismatch'),
    paid: i18n.global.t('adminOrders.eventPaid'),
    issued: i18n.global.t('adminOrders.eventIssued'),
    redeemed: i18n.global.t('adminOrders.eventRedeemed'),
    expired: i18n.global.t('adminOrders.eventExpired'),
    canceled: i18n.global.t('adminOrders.eventCanceled'),
    closed: i18n.global.t('adminOrders.eventClosed'),
    refunded: i18n.global.t('adminOrders.eventRefunded'),
  }
  return map[type] || fulfillmentProgressEventLabel(type) || type
}

function eventTypeClass(type: string) {
  if (type.includes('failed') || type.includes('exception') || type.includes('rejected') || type.includes('mismatch')) return 'tag-danger'
  if (['paid', 'issued', 'redeemed', 'email_resent'].includes(type)) return 'tag-success'
  if (['expired', 'canceled', 'closed'].includes(type)) return 'tag-muted'
  return 'tag-info'
}

onMounted(async () => {
  initFilterFromRoute()
  try {
    storefronts.value = (await fetchAdminStorefronts(token.value)).storefronts
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载展示渠道失败', 'error')
  }
  loadData()
})

watch(
  () => route.query,
  () => {
    pagination.page.value = 1
    initFilterFromRoute()
    loadData()
  },
)
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
/* tabs / action-chip / detail-* 由 admin.css；此处仅订单页专属 */
.event-value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.tab-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

/*
 * 订单详情：3 Tab + 固定高度滚动区
 * 高度用 height（非仅 max-height），内容少时弹窗也不「越来越矮」。
 */
.order-detail-box {
  flex: 1 1 auto;
  min-height: 0;
  height: min(72dvh, 640px);
  max-height: min(72dvh, 640px);
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
}

.order-detail-chrome {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}

.order-detail-section-tabs {
  flex-shrink: 0;
  flex-wrap: nowrap;
  overflow-x: auto;
  padding-bottom: 2px;
  margin: 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}

.order-detail-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25em;
  max-width: 5.5em;
  margin-left: 2px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--tg-hint, #9aa4b2);
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab.active .order-detail-tab-badge,
.tab[aria-selected='true'] .order-detail-tab-badge {
  color: #fff7ed;
  background: rgba(255, 255, 255, 0.12);
}

.order-detail-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 2px 4px;
  display: flex;
  flex-direction: column;
  gap: 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-gutter: stable;
}

.order-detail-panel {
  margin: 0;
}

.order-detail-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.detail-title-sub {
  margin-top: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--tg-hint, #9aa4b2);
}

.order-detail-panel > .detail-title-sub:first-child {
  margin-top: 0;
}

.detail-actions,
.order-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--admin-inline-gap, 8px);
  margin-top: var(--admin-stack-gap, 8px);
}

.order-detail-actions {
  flex: 0 0 auto;
  margin-top: 0;
  padding-top: 10px;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}

@media (max-width: 640px) {
  .order-detail-box {
    height: min(78dvh, 580px);
    max-height: min(78dvh, 580px);
  }
}

.referral-registry-tag {
  margin-left: 6px;
  font-size: 11px;
  vertical-align: middle;
}

/* 列表归因：与渠道 muted 灰字区分，便于扫表识别活动/推荐码 */
.order-attribution-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
  max-width: 14rem;
}

.order-attr-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.order-attr-tag code {
  font-size: 11px;
  font-weight: 600;
  color: var(--tg-text, #e8edf5);
}

.detail-deeplink {
  margin-left: 4px;
  vertical-align: middle;
}

/* detail-json 由 admin.css 提供 */

@media (max-width: 640px) {
  /* 小屏保留顶部 Tab，隐藏重复的快捷 chip 条 */
  .tab-hint,
  .action-strip {
    display: none;
  }
}
</style>
