<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input
          v-model="filter.q"
          type="search"
          :placeholder="$t('adminProducts.search')"
          :aria-label="$t('adminProducts.search')"
          @keyup.enter="searchData"
        />
        <select v-model="filter.active" :aria-label="$t('adminProducts.colStatus')" @change="searchData">
          <option value="">{{ $t('adminProducts.statusAll') }}</option>
          <option value="true">{{ $t('adminProducts.statusActive') }}</option>
          <option value="false">{{ $t('adminProducts.statusInactive') }}</option>
        </select>
        <select v-model="filter.category" :aria-label="$t('adminProducts.colCategory')" @change="searchData">
          <option value="">{{ $t('adminProducts.categoryAll') }}</option>
          <option v-for="category in categoryOptions" :key="category.id" :value="category.name">
            {{ category.name }}
          </option>
        </select>
        <select v-model="filter.storefrontId" :aria-label="$t('adminProducts.colStorefront')" @change="searchData">
          <option value="">{{ $t('adminProducts.storefrontAll') }}</option>
          <option v-for="storefront in storefronts" :key="storefront.id" :value="storefront.id">{{ storefront.name }}</option>
        </select>
        <input
          v-model="buyLinkCampaign"
          type="text"
          maxlength="80"
          :placeholder="$t('adminProducts.campaignPlaceholder')"
          :title="$t('adminProducts.campaignTitle')"
          :aria-label="$t('adminProducts.campaignPlaceholder')"
          class="filter-input-sm"
        />
        <input
          v-model="buyLinkReferral"
          type="text"
          maxlength="80"
          :placeholder="$t('adminProducts.referralPlaceholder')"
          :title="$t('adminProducts.referralTitle')"
          :aria-label="$t('adminProducts.referralPlaceholder')"
          class="filter-input-sm"
        />
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="searchData">
          {{ loading ? $t('adminProducts.searching') : $t('adminProducts.search') }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">{{ $t('adminProducts.refresh') }}</button>
        <button class="btn btn-primary btn-sm" @click="openDialog()">{{ $t('adminProducts.add') }}</button>
      </div>
    </div>

    <div class="table-command-bar">
      <div class="quick-strip" role="group" :aria-label="$t('adminProducts.quickFilter')">
        <button
          type="button"
          class="quick-chip"
          :class="{ 'is-active': filter.stock === 'low' }"
          @click="toggleLowStock"
        >
          {{ filter.stock === 'low' ? $t('adminProducts.showAllStock') : $t('adminProducts.lowStockOnly') }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminProducts.reload') }}</button>
    </div>

    <div class="sort-context" role="status">
      <span v-if="activeStorefrontName">
        {{ $t('adminProducts.sortContext', { name: activeStorefrontName }) }}
      </span>
      <span v-else>
        {{ $t('adminProducts.sortHint') }}
      </span>
    </div>

    <div v-if="selectedCount > 0" class="bulk-bar" role="status" aria-live="polite" :aria-busy="loading || batchOperating">
      <span v-if="batchOperating">{{ $t('adminProducts.bulkProcessing', { completed: batchCompleted, total: batchTotal }) }}</span>
      <span v-else>{{ $t('adminProducts.bulkSelected', { count: selectedCount }) }}</span>
      <div class="bulk-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">{{ $t('adminProducts.clearSelection') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="copySelectedProducts">{{ $t('adminProducts.copySelected') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="exportSelectedProducts">{{ $t('adminProducts.exportSelected') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(true)">{{ $t('adminProducts.batchSell') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="batchSetActive(false)">{{ $t('adminProducts.batchUnlist') }}</button>
        <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating" @click="batchRemove">
          {{ $t('adminProducts.batchDelete') }}
        </button>
      </div>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminProducts.tableAriaLabel')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminProducts.tableAriaLabelList')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="selectableCount === 0 || loading || batchOperating"
                :aria-label="$t('adminProducts.selectAllAria')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('adminProducts.colName') }}</th>
            <th>{{ $t('adminProducts.colImage') }}</th>
            <th>{{ $t('adminProducts.colId') }}</th>
            <th>{{ $t('adminProducts.colCategory') }}</th>
            <th>{{ $t('adminProducts.colPrice') }}</th>
            <th>{{ $t('adminProducts.colStock') }}</th>
            <th>{{ $t('adminProducts.colPurchased') }}</th>
            <th>{{ $t('adminProducts.colFulfillment') }}</th>
            <th>{{ $t('adminProducts.colLimit') }}</th>
            <th>{{ $t('adminProducts.colPeriod') }}</th>
            <th>{{ $t('adminProducts.colStorefront') }}</th>
            <th>{{ $t('adminProducts.colStatus') }}</th>
            <th>{{ $t('adminProducts.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td colspan="14"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in visibleItems" :key="item.id" :class="{ 'is-selected': isSelected(item.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(item.id)"
                :disabled="loading || batchOperating || deletingId === item.id"
                :aria-label="$t('adminProducts.selectRowAria', { title: item.title })"
                @click="setSelected(item.id, ($event.target as HTMLInputElement).checked, $event.shiftKey)"
              />
            </td>
            <td>{{ item.title }}</td>
            <td class="cover-cell">
              <img
                v-if="item.coverUrl && !brokenCoverIds[item.id]"
                :src="item.coverUrl"
                :alt="$t('adminProducts.coverAlt', { title: item.title })"
                class="product-cover-thumb"
                loading="lazy"
                @error="markCoverBroken(item.id)"
              />
              <span v-else class="cover-placeholder">{{ $t('adminProducts.noCover') }}</span>
            </td>
            <td>{{ item.id }}</td>
            <td>{{ item.category || '-' }}</td>
            <td>{{ formatProductMoney(item) }}</td>
            <td>{{ item.stock ?? '-' }}</td>
            <td>{{ item.purchasedCount ?? 0 }}</td>
            <td>
              <div class="mode-cell">
                <span>{{ fulfillmentModeText(item.fulfillmentMode) }}</span>
                <span class="mode-tag" :class="item.issueMode === 'manual' ? 'mode-tag-warn' : 'mode-tag-success'">
                  {{ item.issueMode === 'manual' ? $t('adminProducts.issueManual') : $t('adminProducts.issueAuto') }}
                </span>
                <span v-if="item.deliveryVisibility === 'email_only'" class="mode-tag mode-tag-info">{{ $t('adminProducts.deliveryEmailOnly') }}</span>
                <span class="mode-tag">{{ stockDisplayModeText(item.stockDisplayMode) }}</span>
              </div>
            </td>
            <td>{{ purchaseLimitText(item.purchaseLimit) }}</td>
            <td>
              <span class="tag" :class="purchaseLimitPeriodClass(item)">
                {{ purchaseLimitPeriodText(item) }}
              </span>
            </td>
            <td>
              <div v-if="productStorefronts(item).length" class="channel-tags">
                <span
                  v-for="storefront in productStorefronts(item)"
                  :key="storefront.id"
                  class="tag tag-info channel-sort-tag"
                  :class="{ 'tag-muted': storefront.visible === false }"
                  :title="storefront.visible === false ? $t('adminProducts.channelHiddenTitle') : $t('adminProducts.channelSortTitle')"
                >
                  {{ storefront.name || storefrontName(storefront.id) }}
                  <small>{{ $t('adminProducts.sortOrderLabel', { order: storefront.sortOrder ?? '-' }) }}</small>
                  <small v-if="storefront.visible === false">{{ $t('adminProducts.hidden') }}</small>
                </span>
              </div>
              <span v-else class="tag tag-warning">{{ $t('adminProducts.unpublished') }}</span>
              <label v-if="filter.storefrontId && currentStorefrontMapping(item)" class="channel-inline-sort">
                <span>{{ $t('adminProducts.currentChannelSort') }}</span>
                <input
                  type="number"
                  min="0"
                  max="99999"
                  step="1"
                  :value="currentStorefrontMapping(item)?.sortOrder ?? 100"
                  :disabled="savingSortKey === storefrontSortKey(item) || loading || batchOperating"
                  @change="saveCurrentStorefrontSort(item, ($event.target as HTMLInputElement).value)"
                  @keyup.enter="saveCurrentStorefrontSort(item, ($event.target as HTMLInputElement).value)"
                />
              </label>
            </td>
            <td>
              <span class="tag product-status" :class="item.active ? 'tag-success' : 'tag-muted'">
                {{ item.active ? $t('adminProducts.statusActive') : $t('adminProducts.statusInactive') }}
              </span>
            </td>
            <td>
              <div class="table-actions">
                <label
                  class="status-switch"
                  :class="{
                    'is-on': item.active,
                    'is-disabled': saving || loading || batchOperating || togglingActiveId === item.id || deletingId === item.id || ((item.currency || 'CNY') !== 'CNY' && !item.active),
                  }"
                  :title="((item.currency || 'CNY') !== 'CNY' && !item.active) ? $t('adminProducts.nonCnyOnlyInactive') : (item.active ? $t('adminProducts.clickToUnlist') : $t('adminProducts.clickToSell'))"
                >
                  <input
                    type="checkbox"
                    role="switch"
                    :checked="item.active"
                    :disabled="saving || loading || batchOperating || togglingActiveId === item.id || deletingId === item.id || ((item.currency || 'CNY') !== 'CNY' && !item.active)"
                    :aria-label="item.active ? $t('adminProducts.unlistAria', { title: item.title }) : $t('adminProducts.sellAria', { title: item.title })"
                    @click.prevent="toggleProductActive(item)"
                  />
                  <span class="status-switch-track" aria-hidden="true">
                    <span class="status-switch-thumb" />
                  </span>
                  <span class="status-switch-text">{{ togglingActiveId === item.id ? '…' : (item.active ? $t('adminProducts.statusActive') : $t('adminProducts.statusInactive')) }}</span>
                </label>
                <button class="btn btn-ghost btn-xs" :title="$t('adminProducts.duplicateTitle')" :disabled="saving || loading || batchOperating || duplicatingId === item.id" @click="duplicateProductRow(item)">
                  {{ duplicatingId === item.id ? $t('adminProducts.duplicating') : $t('adminProducts.actionCopy') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :title="item.active === false ? $t('adminProducts.buyLinkDisabledTitle') : $t('adminProducts.buyLinkTitle')"
                  :disabled="saving || loading || batchOperating || item.active === false"
                  @click="copyProductBuyLink(item)"
                >
                  {{ $t('adminProducts.buyLink') }}
                </button>
                <button class="btn btn-ghost btn-xs" :disabled="saving || loading || batchOperating || deletingId === item.id" @click="openDialog(item)">{{ $t('adminProducts.actionEdit') }}</button>
                <button class="btn btn-danger btn-xs" :disabled="saving || loading || batchOperating || deletingId === item.id" @click="remove(item.id)">
                  {{ deletingId === item.id ? $t('adminProducts.deleting') : $t('adminProducts.actionDelete') }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="visibleItems.length === 0">
            <td colspan="14" class="empty-text">{{ $t('adminProducts.noData') }}</td>
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

    <AdminModal v-model="dialogVisible" :title="editing ? $t('adminProducts.editTitle') : $t('adminProducts.addTitle')" max-width="720px" hide-actions>
      <form class="modal-form product-editor-form" @submit.prevent="save">
        <div class="product-editor-scroll">
          <!-- 基本信息：名称 / 分类 / 说明 -->
          <section class="form-section" aria-labelledby="pe-basic">
            <header class="form-section-head">
              <h4 id="pe-basic" class="form-section-title">{{ $t('adminProducts.sectionBasic') }}</h4>
              <p class="form-section-desc">{{ $t('adminProducts.sectionBasicDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>{{ $t('adminProducts.fieldName') }}</span>
                <input v-model="form.title" required maxlength="120" autocomplete="off" />
              </label>
              <label>
                <span>{{ $t('adminProducts.fieldCategory') }}</span>
                <input v-model="form.category" list="product-category-options" :placeholder="$t('adminProducts.categoryPlaceholder')" />
                <datalist id="product-category-options">
                  <option v-for="category in categoryOptions" :key="category.id" :value="category.name" />
                </datalist>
              </label>
              <label class="field-span-2">
                <span>{{ $t('adminProducts.fieldDescription') }}</span>
                <textarea
                  v-model="form.description"
                  rows="3"
                  maxlength="500"
                  :placeholder="$t('adminProducts.descriptionPlaceholder')"
                ></textarea>
                <small class="field-hint">{{ $t('adminProducts.descriptionHint') }}</small>
              </label>
            </div>
          </section>

          <!-- 图片与定价 -->
          <section class="form-section" aria-labelledby="pe-media">
            <header class="form-section-head">
              <h4 id="pe-media" class="form-section-title">{{ $t('adminProducts.sectionMedia') }}</h4>
              <p class="form-section-desc">{{ $t('adminProducts.sectionMediaDesc') }}</p>
            </header>
            <div class="media-price-layout">
              <div class="cover-panel">
                <div class="cover-preview-frame" :class="{ 'has-image': Boolean(form.coverUrl) && !coverPreviewFailed }">
                  <img
                    v-if="form.coverUrl && !coverPreviewFailed"
                    :src="form.coverUrl"
                    :alt="$t('adminProducts.coverAlt', { title: form.title || '' })"
                    class="cover-preview"
                    @error="coverPreviewFailed = true"
                  />
                  <div v-else class="cover-empty">
                    <span>{{ coverPreviewFailed ? $t('adminProducts.coverLoadFailed') : $t('adminProducts.noCover2') }}</span>
                    <small v-if="coverPreviewFailed">{{ $t('adminProducts.coverUrlCheckHint') }}</small>
                  </div>
                </div>
                <div class="image-upload-row">
                  <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingCover }">
                    {{ uploadingCover ? $t('adminProducts.uploading') : $t('adminProducts.uploadCover') }}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif"
                      :disabled="uploadingCover"
                      @change="uploadCoverImage"
                    />
                  </label>
                  <small class="field-hint">{{ $t('adminProducts.uploadHint') }}</small>
                </div>
                <label>
                  <span>{{ $t('adminProducts.fieldCoverUrl') }}</span>
                  <input
                    v-model.trim="form.coverUrl"
                    type="text"
                    inputmode="url"
                    maxlength="500"
                    :placeholder="$t('adminProducts.coverUrlPlaceholder')"
                    autocomplete="url"
                  />
                  <small class="field-hint">{{ $t('adminProducts.coverUrlHint') }}</small>
                </label>
              </div>

              <div class="price-panel">
                <div class="form-grid two-cols">
                  <label>
                    <span>{{ $t('adminProducts.fieldCurrency') }}</span>
                    <select v-model="form.currency">
                      <option v-for="currency in currencyOptions" :key="currency.code" :value="currency.code">
                        {{ currency.code }} · {{ currency.name }}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>{{ $t('adminProducts.fieldPrice', { unit: priceInputUnit }) }}</span>
                    <input
                      v-model.trim="form.priceMajor"
                      type="text"
                      :inputmode="currentCurrencyMeta.exponent === 0 ? 'numeric' : 'decimal'"
                      :placeholder="currentCurrencyMeta.exponent === 0 ? $t('adminProducts.pricePlaceholderNumeric') : $t('adminProducts.pricePlaceholderDecimal')"
                      required
                    />
                  </label>
                  <label class="field-span-2">
                    <span>{{ $t('adminProducts.fieldOriginalPrice', { unit: priceInputUnit }) }}</span>
                    <input
                      v-model.trim="form.originalPriceMajor"
                      type="text"
                      :inputmode="currentCurrencyMeta.exponent === 0 ? 'numeric' : 'decimal'"
                      :placeholder="currentCurrencyMeta.exponent === 0 ? $t('adminProducts.originalPricePlaceholderNumeric') : $t('adminProducts.originalPricePlaceholderDecimal')"
                    />
                  </label>
                </div>
                <p v-if="pricePreview" class="price-preview-line">
                  {{ $t('adminProducts.pricePreviewLabel') }} <strong>{{ pricePreview }}</strong>
                  <template v-if="originalPricePreview">
                    <span class="price-preview-original">{{ originalPricePreview }}</span>
                    <span v-if="promoPreviewHint" class="price-preview-save">{{ promoPreviewHint }}</span>
                  </template>
                </p>
                <small class="field-hint">{{ currencyPaymentHint }}</small>
                <small class="field-hint">{{ $t('adminProducts.originalPriceHint') }}</small>
                <p v-if="isFreeProductPrice" class="inline-callout">
                  {{ $t('adminProducts.freeProductHint') }}
                </p>
              </div>
            </div>
          </section>

          <!-- 限时营销展示：只增加前台紧迫感，不改变商品价格和下单金额 -->
          <section class="form-section" aria-labelledby="pe-marketing">
            <header class="form-section-head">
              <h4 id="pe-marketing" class="form-section-title">{{ $t('adminProducts.sectionMarketing') }}</h4>
              <p class="form-section-desc">{{ $t('adminProducts.sectionMarketingDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('adminProducts.fieldMarketingBadge') }}</span>
                <input
                  v-model.trim="form.marketingBadge"
                  maxlength="40"
                  :placeholder="$t('adminProducts.marketingBadgePlaceholder')"
                />
              </label>
              <label>
                <span>{{ $t('adminProducts.fieldMarketingEndsAt') }}</span>
                <input v-model="form.marketingEndsAtLocal" type="datetime-local" :lang="locale" />
              </label>
            </div>
            <label class="checkbox-label">
              <input v-model="form.showRecentBuyers" type="checkbox" />
              <span>{{ $t('adminProducts.fieldShowRecentBuyers') }}</span>
            </label>
            <p class="inline-callout">
              {{ $t('adminProducts.marketingDisplayWarning') }}
            </p>
          </section>

          <!-- 交付与履约 -->
          <section class="form-section" aria-labelledby="pe-fulfill">
            <header class="form-section-head">
              <h4 id="pe-fulfill" class="form-section-title">{{ $t('adminProducts.sectionFulfillment') }}</h4>
              <p class="form-section-desc">{{ $t('adminProducts.sectionFulfillmentDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('adminProducts.fieldFulfillmentMode') }}</span>
                <select v-model="form.fulfillmentMode">
                  <option v-for="option in fulfillmentModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <small class="field-hint">{{ fulfillmentModeGuide }}</small>
              </label>
              <label>
                <span>{{ $t('adminProducts.fieldDeliveryVisibility') }}</span>
                <select v-model="form.deliveryVisibility">
                  <option v-for="option in deliveryVisibilityOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <small class="field-hint">{{ $t('adminProducts.deliveryVisibilityHint') }}</small>
              </label>
              <label>
                <span>{{ $t('adminProducts.fieldFulfillmentInputType') }}</span>
                <select v-model="form.fulfillmentInputType" @change="handleFulfillmentInputTypeChange">
                  <option v-for="option in fulfillmentInputOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <small class="field-hint">{{ $t('adminProducts.fulfillmentInputTypeHint') }}</small>
              </label>
              <label v-if="form.fulfillmentMode !== 'card'" class="field-span-2">
                <span>{{ $t('adminProducts.fieldSalesCopy') }}</span>
                <textarea v-model="form.salesCopy" rows="2" :placeholder="$t('adminProducts.salesCopyPlaceholder')"></textarea>
              </label>
            </div>
            <div v-if="form.fulfillmentInputType !== 'none'" class="fulfillment-input-box">
              <div class="form-grid two-cols">
                <label>
                  <span>{{ $t('adminProducts.fieldInputLabel') }}</span>
                  <input v-model.trim="form.fulfillmentInputLabel" maxlength="80" :placeholder="$t('adminProducts.inputLabelPlaceholder')" />
                </label>
                <label>
                  <span>{{ $t('adminProducts.fieldInputHint') }}</span>
                  <input v-model.trim="form.fulfillmentInputHint" maxlength="200" :placeholder="$t('adminProducts.inputHintPlaceholder')" />
                </label>
              </div>
              <label class="checkbox-label">
                <input v-model="form.fulfillmentInputRequired" type="checkbox" />
                <span>{{ $t('adminProducts.inputRequiredLabel') }}</span>
              </label>
            </div>
          </section>

          <!-- 库存、限购与上架 -->
          <section class="form-section" aria-labelledby="pe-stock">
            <header class="form-section-head">
              <h4 id="pe-stock" class="form-section-title">{{ $t('adminProducts.sectionStock') }}</h4>
              <p class="form-section-desc">{{ $t('adminProducts.sectionStockDesc') }}</p>
            </header>
            <div
              v-if="editing && form.fulfillmentMode === 'card' && editingStock !== undefined"
              class="stock-hint"
            >
              <span class="stock-hint-label">{{ $t('adminProducts.availableStock', { stock: editingStock }) }}</span>
              <span class="stock-hint-desc">{{ $t('adminProducts.stockHint') }}</span>
            </div>
            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('adminProducts.fieldStockDisplayMode') }}</span>
                <select v-model="form.stockDisplayMode">
                  <option v-for="option in stockDisplayModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
              <label>
                <span>{{ $t('adminProducts.fieldPurchaseLimit') }}</span>
                <input
                  v-model.trim="form.purchaseLimit"
                  type="number"
                  min="0"
                  :placeholder="isFreeProductPrice ? $t('adminProducts.purchaseLimitFreePlaceholder') : $t('adminProducts.purchaseLimitPlaceholder')"
                />
                <small v-if="isFreeProductPrice" class="field-help">
                  {{ $t('adminProducts.purchaseLimitFreeHint') }}
                </small>
              </label>
              <label>
                <span>{{ $t('adminProducts.fieldPurchaseLimitPeriod') }}</span>
                <select v-model="form.purchaseLimitPeriod" :disabled="!isFreeProductPrice">
                  <option value="lifetime">{{ $t('adminProducts.periodLifetime') }}</option>
                  <option value="daily">{{ $t('adminProducts.periodDaily') }}</option>
                </select>
                <small class="field-help">
                  {{ $t('adminProducts.periodHint') }}
                </small>
              </label>
            </div>
            <div class="toggle-row">
              <label class="checkbox-label">
                <input v-model="form.purchaseLimitDisplay" type="checkbox" />
                <span>{{ $t('adminProducts.showPurchaseLimit') }}</span>
              </label>
              <label class="checkbox-label">
                <input v-model="form.active" type="checkbox" :disabled="form.currency !== 'CNY'" />
                <span>{{ $t('adminProducts.publishLabel', { currencyNote: form.currency !== 'CNY' ? '（' + $t('adminProducts.cnyOnlyNote') + '）' : '' }) }}</span>
              </label>
            </div>
          </section>

          <fieldset class="storefront-fieldset">
            <legend>{{ $t('adminProducts.publishToStorefronts') }}</legend>
            <label class="checkbox-label">
              <input v-model="internalOnlyProduct" type="checkbox" />
              <span>{{ $t('adminProducts.internalOnlyLabel') }}</span>
            </label>
            <small class="field-hint">{{ $t('adminProducts.internalOnlyHint') }}</small>
            <div class="storefront-check-grid">
              <label v-for="storefront in storefronts" :key="storefront.id" class="checkbox-label">
                <input v-model="form.storefrontIds" type="checkbox" :value="storefront.id" />
                <span>{{ storefront.name }}{{ storefront.isDefault ? $t('adminProducts.defaultSuffix') : '' }}</span>
              </label>
            </div>
            <small v-if="form.storefrontIds.length === 0" class="field-hint">{{ $t('adminProducts.noStorefrontHint') }}</small>
            <small v-else-if="isFreeProductPrice" class="field-help field-help-danger">{{ $t('adminProducts.freePublishedWarning') }}</small>
          </fieldset>
        </div>

        <div class="product-editor-footer modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="saving || uploadingCover" @click="dialogVisible = false">{{ $t('adminProducts.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving || uploadingCover">
            {{ saving ? $t('adminProducts.saving') : $t('adminProducts.save') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchAdminProducts, fetchAdminProductCategories, fetchAdminStorefronts, createAdminProductCategory, createAdminProduct, duplicateAdminProduct, updateAdminProduct, updateAdminStorefrontProduct, deleteAdminProduct, uploadAdminMediaImage } from '@/api/admin'
import type { AdminProduct, AdminProductCategory, AdminProductFilter, AdminStorefront } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useTablePagination } from '@/composables/useTablePagination'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useTableSelection } from '@/composables/useTableSelection'
import { useAdminBatchOperation } from '@/composables/useAdminBatchOperation'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import AdminPagination from '@/components/AdminPagination.vue'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { downloadCsv } from '@/lib/csv-export'
import { normalizeAttributionCode } from '@/lib/checkout-attribution'
import {
  adminBuyLinkFailureMessage,
  resolveAdminBuyLink,
} from '@/lib/resolve-admin-buy-link'
import {
  CURRENCY_CODES,
  formatMoney,
  getCurrencyMeta,
  minorToMajorString,
  normalizeCurrencyCode,
  parseMajorToMinor,
  type CurrencyCode,
} from '@shared/money'
import { FULFILLMENT_INPUT_OPTIONS } from '@shared/fulfillment-input'
import {
  DELIVERY_VISIBILITY_OPTIONS,
  FULFILLMENT_MODE_OPTIONS,
  STOCK_DISPLAY_MODE_OPTIONS,
} from '@shared/product-contract'

const { showToast } = useToast()
const { token } = useAdminAuth()
const { locale } = useI18n()
const route = useRoute()
const router = useRouter()

const items = ref<AdminProduct[]>([])
const categoryOptions = ref<AdminProductCategory[]>([])
const storefronts = ref<AdminStorefront[]>([])
const loading = ref(false)
const filter = reactive<AdminProductFilter>({
  q: '',
  active: '',
  category: '',
  stock: '',
  storefrontId: '',
  page: 1,
  limit: 20,
})
/** 复制购买链可选归因（仅前端拼 URL，不入库） */
const buyLinkCampaign = ref('')
const buyLinkReferral = ref('')

const pagination = useTablePagination()

const dialogVisible = ref(false)
const editing = ref(false)
const saving = ref(false)
const loadError = ref('')
const deletingId = ref('')
const duplicatingId = ref('')
const togglingActiveId = ref('')
const savingSortKey = ref('')
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential,
} = useAdminBatchOperation()
/** 当前编辑商品的库存（仅展示，不可编辑） */
const editingStock = ref<number | undefined>(undefined)
type ProductForm = {
  title: string
  description: string
  coverUrl: string
  priceMajor: string
  /** 划线原价主单位；空字符串 = 不设置促销 */
  originalPriceMajor: string
  /** 限时营销角标，仅用于前台展示，不参与支付 */
  marketingBadge: string
  /** datetime-local 输入值；保存时规范为 ISO 字符串 */
  marketingEndsAtLocal: string
  /** 最近成交人数展示，只用于前台信任感，不参与报价 */
  showRecentBuyers: boolean
  currency: CurrencyCode
  category: string
  fulfillmentMode: string
  deliveryVisibility: NonNullable<AdminProduct['deliveryVisibility']>
  stockDisplayMode: NonNullable<AdminProduct['stockDisplayMode']>
  salesCopy: string
  fulfillmentInputType: NonNullable<AdminProduct['fulfillmentInputType']>
  fulfillmentInputLabel: string
  fulfillmentInputHint: string
  fulfillmentInputRequired: boolean
  purchaseLimit: string
  purchaseLimitPeriod: 'lifetime' | 'daily'
  purchaseLimitDisplay: boolean
  active: boolean
  storefrontIds: string[]
}

const form = reactive<ProductForm>({
  title: '',
  description: '',
  coverUrl: '',
  priceMajor: '0.00',
  originalPriceMajor: '',
  marketingBadge: '',
  marketingEndsAtLocal: '',
  showRecentBuyers: false,
  currency: 'CNY' as CurrencyCode,
  category: '',
  fulfillmentMode: 'card',
  deliveryVisibility: 'web_and_email',
  stockDisplayMode: 'exact',
  salesCopy: '',
  fulfillmentInputType: 'none',
  fulfillmentInputLabel: '',
  fulfillmentInputHint: '',
  fulfillmentInputRequired: false,
  purchaseLimit: '',
  purchaseLimitPeriod: 'lifetime',
  purchaseLimitDisplay: false,
  active: true,
  storefrontIds: [],
})
const brokenCoverIds = ref<Record<string, boolean>>({})
const coverPreviewFailed = ref(false)
const uploadingCover = ref(false)
let editingId = ''

const currencyOptions = CURRENCY_CODES.map((code) => getCurrencyMeta(code))
const localizedOption = (scope: string, option: { value: string; label: string }) => ({
  value: option.value,
  label: i18n.global.t(`${scope}.${option.value}`, {}, { default: option.label }),
})
const fulfillmentModeOptions = computed(() => FULFILLMENT_MODE_OPTIONS.map((option) => localizedOption('adminProducts.fulfillmentModes', option)))
const deliveryVisibilityOptions = computed(() => DELIVERY_VISIBILITY_OPTIONS.map((option) => localizedOption('adminProducts.deliveryVisibilities', option)))
const fulfillmentInputOptions = computed(() => FULFILLMENT_INPUT_OPTIONS.map((option) => localizedOption('adminProducts.fulfillmentInputTypes', option)))
const stockDisplayModeOptions = computed(() => STOCK_DISPLAY_MODE_OPTIONS.map((option) => localizedOption('adminProducts.stockDisplayModes', option)))
const currentCurrencyMeta = computed(() => getCurrencyMeta(form.currency))
const priceInputUnit = computed(() => {
  if (form.currency === 'CNY') return i18n.global.t('adminProducts.currencyCNY')
  if (form.currency === 'JPY') return i18n.global.t('adminProducts.currencyJPY')
  if (form.currency === 'KRW') return i18n.global.t('adminProducts.currencyKRW')
  return form.currency
})
const pricePreview = computed(() => {
  try {
    return formatMoney(parseMajorToMinor(form.priceMajor, form.currency), form.currency)
  } catch {
    return ''
  }
})
const originalPricePreview = computed(() => {
  const raw = form.originalPriceMajor.trim()
  if (!raw) return ''
  try {
    const price = parseMajorToMinor(form.priceMajor, form.currency)
    const original = parseMajorToMinor(raw, form.currency)
    if (original <= 0 || original <= price) return ''
    return formatMoney(original, form.currency)
  } catch {
    return ''
  }
})
const promoPreviewHint = computed(() => {
  const raw = form.originalPriceMajor.trim()
  if (!raw) return ''
  try {
    const price = parseMajorToMinor(form.priceMajor, form.currency)
    const original = parseMajorToMinor(raw, form.currency)
    if (original <= price) return i18n.global.t('adminProducts.discountInvalid')
    const save = original - price
    return `· ${i18n.global.t('adminProducts.discountSave', { amount: formatMoney(save, form.currency) })}`
  } catch {
    return ''
  }
})
const isFreeProductPrice = computed(() => {
  try {
    return parseMajorToMinor(form.priceMajor, form.currency) === 0
  } catch {
    return false
  }
})

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
const internalOnlyProduct = computed({
  get: () => form.storefrontIds.length === 0,
  set: (value: boolean) => {
    if (value) {
      // 运营勾选“内部/抽奖奖品”时只清空发布渠道，不改变 active。
      // active 仍表示后台可用和库存可发；是否出现在 /shop 只由 storefrontIds 控制。
      form.storefrontIds = []
      return
    }
    // 取消内部用途时恢复到默认商城，避免运营以为已发布但实际仍无渠道。
    form.storefrontIds = storefronts.value.filter(item => item.isDefault).map(item => item.id)
  },
})
const currencyPaymentHint = computed(() => form.currency === 'CNY'
  ? `金额会按 ${currentCurrencyMeta.value.exponent} 位小数精确保存；数据库继续使用兼容字段 priceCents，实际语义为币种最小单位。`
  : `${form.currency} 已建立输入和展示规则，但当前支付、余额、充值和固定通用优惠仍仅支持 CNY；该商品只能保存为下架草稿。`)

const fulfillmentModeGuide = computed(() => {
  const mode = form.fulfillmentMode || 'card'
  const guides: Record<string, string> = {
    card: i18n.global.t('adminProducts.modeCard'),
    virtual: i18n.global.t('adminProducts.modeVirtual'),
    link: i18n.global.t('adminProducts.modeLink'),
    code: i18n.global.t('adminProducts.modeCode'),
    invite: i18n.global.t('adminProducts.modeInvite'),
  }
  return guides[mode] || i18n.global.t('adminProducts.modeDefault')
})

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

const visibleItems = computed(() => {
  return items.value
})
const activeStorefrontName = computed(() => {
  if (!filter.storefrontId) return ''
  return storefrontName(filter.storefrontId)
})
const selectedItems = computed(() => {
  const selected = new Set(selectedIds.value)
  return visibleItems.value.filter((item) => selected.has(item.id))
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

let loadSequence = 0

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchAdminProducts(token.value, {
      ...filter,
      page: pagination.page.value,
      limit: pagination.limit.value,
    })
    if (sequence !== loadSequence) return
    if (pagination.setTotal(res.total)) return loadData()
    items.value = res.products
    brokenCoverIds.value = {}
    clearSelection()
  } catch (err: any) {
    if (sequence !== loadSequence) return
    items.value = []
    clearSelection()
    loadError.value = err.message || '加载商品失败'
    showToast(err.message || '加载商品失败', 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadCategories() {
  try {
    const res = await fetchAdminProductCategories(token.value)
    categoryOptions.value = res.categories
  } catch (err: any) {
    showToast(err.message || '加载分类失败', 'error')
  }
}

async function loadStorefronts() {
  try {
    storefronts.value = (await fetchAdminStorefronts(token.value)).storefronts
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载展示渠道失败', 'error')
  }
}

function storefrontName(id: string) {
  return storefronts.value.find(item => item.id === id)?.name || id
}

function productStorefronts(item: AdminProduct): NonNullable<AdminProduct['storefronts']> {
  if (item.storefronts?.length) return item.storefronts
  return (item.storefrontIds || []).map(id => ({ id, name: storefrontName(id), visible: true, sortOrder: undefined }))
}

/**
 * 复制用户侧购买链接：闸门集中在 resolveAdminBuyLink（上架 + 可见映射 + 活跃渠道）。
 * 禁止静默改道到其他渠道。
 */
async function copyProductBuyLink(item: AdminProduct) {
  const campaignCode = normalizeAttributionCode(buyLinkCampaign.value)
  const referralCode = normalizeAttributionCode(buyLinkReferral.value)
  const resolved = resolveAdminBuyLink({
    product: {
      id: item.id,
      slug: item.slug,
      active: item.active,
      storefronts: productStorefronts(item).map(entry => ({
        id: entry.id,
        name: entry.name,
        visible: entry.visible,
      })),
      storefrontIds: item.storefrontIds,
    },
    filterStorefrontId: filter.storefrontId,
    storefronts: storefronts.value.map(entry => ({
      id: entry.id,
      name: entry.name,
      homePath: entry.homePath,
      active: entry.active,
    })),
    origin: window.location.origin,
    attribution: {
      campaignCode: campaignCode || undefined,
      referralCode: referralCode || undefined,
    },
  })
  if (!resolved.ok) {
    showToast(adminBuyLinkFailureMessage(resolved.reason), 'error')
    return
  }
  try {
    await writeClipboardText(resolved.url)
    const attrHint = [campaignCode && `活动 ${campaignCode}`, referralCode && `推荐 ${referralCode}`]
      .filter(Boolean)
      .join(' · ')
    showToast(
      attrHint
        ? `已复制购买链接（${resolved.storefront.name} · ${attrHint}）`
        : `已复制购买链接（${resolved.storefront.name}）`,
      'success',
    )
  } catch {
    showToast('复制购买链接失败', 'error')
  }
}

function currentStorefrontMapping(item: AdminProduct) {
  if (!filter.storefrontId) return undefined
  return productStorefronts(item).find(storefront => storefront.id === filter.storefrontId)
}

function storefrontSortKey(item: AdminProduct) {
  return `${filter.storefrontId}:${item.id}`
}

async function saveCurrentStorefrontSort(item: AdminProduct, rawValue: string) {
  const storefrontId = filter.storefrontId
  const mapping = currentStorefrontMapping(item)
  if (!storefrontId || !mapping) return
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) {
    showToast('排序值必须是数字', 'error')
    return
  }
  const sortOrder = Math.trunc(parsed)
  if (sortOrder < 0 || sortOrder > 99999) {
    showToast('排序值必须在 0 到 99999 之间', 'error')
    return
  }
  if (sortOrder === mapping.sortOrder) return
  const key = storefrontSortKey(item)
  savingSortKey.value = key
  try {
    await updateAdminStorefrontProduct(token.value, storefrontId, item.id, { sortOrder })
    mapping.sortOrder = sortOrder
    showToast('渠道排序已保存', 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '保存渠道排序失败', 'error')
  } finally {
    if (savingSortKey.value === key) savingSortKey.value = ''
  }
}

async function toggleProductActive(item: AdminProduct) {
  if (togglingActiveId.value || loading.value || batchOperating.value || saving.value || deletingId.value === item.id) return
  const nextActive = !item.active
  const currency = item.currency || 'CNY'
  if (nextActive && currency !== 'CNY') {
    showToast('当前支付链路仅支持 CNY，非 CNY 商品只能保持下架', 'error')
    return
  }
  togglingActiveId.value = item.id
  try {
    await updateAdminProduct(token.value, item.id, { active: nextActive })
    item.active = nextActive
    showToast(nextActive ? '已上架' : '已下架', 'success')
  } catch (err: any) {
    showToast(err.message || (nextActive ? '上架失败' : '下架失败'), 'error')
  } finally {
    if (togglingActiveId.value === item.id) togglingActiveId.value = ''
  }
}

async function ensureCategoryExists() {
  const name = (form.category || '').trim()
  if (!name) return
  if (categoryOptions.value.some(category => category.name === name)) return
  await createAdminProductCategory(token.value, { name })
  await loadCategories()
}

function searchData() {
  pagination.page.value = 1
  const query: Record<string, string> = {}
  if (filter.q) query.q = filter.q
  if (filter.active) query.active = filter.active
  if (filter.category) query.category = filter.category
  if (filter.stock) query.stock = filter.stock
  if (filter.storefrontId) query.storefrontId = filter.storefrontId
  const target = router.resolve({ path: route.path, query }).fullPath
  if (target === route.fullPath) {
    void loadData()
    return
  }
  void router.replace({ path: route.path, query })
}

function toggleLowStock() {
  if (filter.stock === 'low') {
    filter.stock = ''
  } else {
    filter.stock = 'low'
    // 与运营台 lowStock=true 跳转一致：默认只看上架商品
    if (!filter.active) filter.active = 'true'
  }
  searchData()
}

function initFilterFromRoute() {
  filter.q = String(route.query.q || '')
  filter.active = String(route.query.active || '')
  filter.category = String(route.query.category || '')
  filter.stock = String(route.query.stock || '')
  filter.storefrontId = String(route.query.storefrontId || '')
  if (route.query.lowStock === 'true') {
    filter.active = 'true'
    filter.stock = 'low'
  }
}

function openDialog(item?: AdminProduct) {
  if (item) {
    let currency: CurrencyCode
    try {
      currency = normalizeCurrencyCode(item.currency || 'CNY')
    } catch {
      showToast(`商品 ${item.id} 的币种配置无效，请先通过数据修复工具处理`, 'error')
      return
    }
    editing.value = true
    editingId = item.id
    editingStock.value = item.stock
    Object.assign(form, {
      title: item.title,
      description: item.description || '',
      coverUrl: item.coverUrl || '',
      priceMajor: minorToMajorString(item.priceCents, currency),
      originalPriceMajor: item.originalPriceCents != null && item.originalPriceCents > 0
        ? minorToMajorString(item.originalPriceCents, currency)
        : '',
      marketingBadge: item.marketingBadge || '',
      marketingEndsAtLocal: isoToDatetimeLocal(item.marketingEndsAt),
      showRecentBuyers: Number(item.showRecentBuyers || 0) === 1,
      currency,
      category: item.category || '',
      fulfillmentMode: item.fulfillmentMode || 'card',
      deliveryVisibility: item.deliveryVisibility || 'web_and_email',
      stockDisplayMode: item.stockDisplayMode || 'exact',
      salesCopy: item.salesCopy || '',
      fulfillmentInputType: item.fulfillmentInputType || 'none',
      fulfillmentInputLabel: item.fulfillmentInputLabel || '',
      fulfillmentInputHint: item.fulfillmentInputHint || '',
      fulfillmentInputRequired: item.fulfillmentInputRequired ?? false,
      purchaseLimit: item.purchaseLimit == null ? '' : String(item.purchaseLimit),
      purchaseLimitPeriod: item.purchaseLimitPeriod === 'daily' ? 'daily' : 'lifetime',
      purchaseLimitDisplay: item.purchaseLimitDisplay === true,
      active: item.active !== false,
      storefrontIds: item.storefrontIds || [],
    })
  } else {
    editing.value = false
    editingId = ''
    editingStock.value = undefined
    Object.assign(form, {
      title: '',
      description: '',
      coverUrl: '',
      priceMajor: '0.00',
      originalPriceMajor: '',
      marketingBadge: '',
      marketingEndsAtLocal: '',
      showRecentBuyers: false,
      currency: 'CNY',
      category: '',
      fulfillmentMode: 'card',
      deliveryVisibility: 'web_and_email',
      stockDisplayMode: 'exact',
      salesCopy: '',
      fulfillmentInputType: 'none',
      fulfillmentInputLabel: '',
      fulfillmentInputHint: '',
      fulfillmentInputRequired: false,
      // 新建表单默认价虽是 0，限购仍留空：付费改价后不会误带「每人 1 件」；
      // 免费商品在保存时由 normalizedPurchaseLimit / 后端 effectivePurchaseLimit 兜底为 1。
      purchaseLimit: '',
      purchaseLimitPeriod: 'lifetime',
      purchaseLimitDisplay: false,
      active: true,
      storefrontIds: storefronts.value.filter(item => item.isDefault).map(item => item.id),
    })
  }
  coverPreviewFailed.value = false
  dialogVisible.value = true
}

function normalizedPurchaseLimit(): number | null {
  const raw = String(form.purchaseLimit || '').trim()
  if (!raw) {
    // 仅免费商品：未填写时保存为 1（与后端 effectivePurchaseLimitForProduct 一致）。
    // 付费商品空限购表示不限，禁止把「新建默认 1」套到所有商品上。
    try {
      if (parseMajorToMinor(form.priceMajor, form.currency) === 0) return 1
    } catch {
      /* ignore parse error; save() will surface price errors */
    }
    return null
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  const value = Math.trunc(parsed)
  return value > 0 ? value : null
}

async function uploadCoverImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingCover.value) return

  uploadingCover.value = true
  try {
    const result = await uploadAdminMediaImage(token.value, file)
    form.coverUrl = result.url
    coverPreviewFailed.value = false
    showToast('商品图片已上传', 'success')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '图片上传失败', 'error')
  } finally {
    uploadingCover.value = false
  }
}

async function save() {
  if (saving.value || uploadingCover.value) return
  let priceCents: number
  let originalPriceCents: number | null = null
  try {
    priceCents = parseMajorToMinor(form.priceMajor, form.currency)
  } catch (err) {
    showToast(err instanceof Error ? `价格格式无效：${err.message}` : '价格格式无效', 'error')
    return
  }
  const originalRaw = form.originalPriceMajor.trim()
  if (originalRaw) {
    try {
      originalPriceCents = parseMajorToMinor(originalRaw, form.currency)
    } catch (err) {
      showToast(err instanceof Error ? `划线原价格式无效：${err.message}` : '划线原价格式无效', 'error')
      return
    }
    if (originalPriceCents <= 0) {
      originalPriceCents = null
    } else if (originalPriceCents <= priceCents) {
      showToast('划线原价必须高于现价', 'error')
      return
    }
  }
  if (form.currency !== 'CNY' && form.active) {
    showToast('当前支付链路仅支持 CNY，非 CNY 商品必须保持下架', 'error')
    return
  }
  const marketingEndsAt = datetimeLocalToIso(form.marketingEndsAtLocal)
  if (form.marketingEndsAtLocal && !marketingEndsAt) {
    showToast(i18n.global.t('adminProducts.marketingEndsInvalid'), 'error')
    return
  }
  if (priceCents === 0 && form.storefrontIds.length > 0) {
    // 0 元 + 任何展示渠道 = 用户可在前台免费领取。
    // 这里必须二次确认，防止抽奖奖品误发布到默认 /shop 造成公开领取。
    const storefrontNames = form.storefrontIds.map(storefrontName).join('、')
    const confirmed = await askConfirm(i18n.global.t('adminProducts.confirmFreePublished', { storefronts: storefrontNames }))
    if (!confirmed) return
  }
  saving.value = true
  try {
    await ensureCategoryExists()
    const purchaseLimit = normalizedPurchaseLimit()
    const payload: Partial<AdminProduct> & Pick<AdminProduct, 'title' | 'priceCents'> = {
      title: form.title,
      description: form.description,
      coverUrl: form.coverUrl,
      priceCents,
      originalPriceCents,
      marketingBadge: form.marketingBadge,
      marketingEndsAt,
      showRecentBuyers: form.showRecentBuyers ? 1 : 0,
      currency: form.currency,
      category: form.category,
      fulfillmentMode: form.fulfillmentMode,
      deliveryVisibility: form.deliveryVisibility,
      stockDisplayMode: form.stockDisplayMode,
      salesCopy: form.salesCopy,
      fulfillmentInputType: form.fulfillmentInputType,
      fulfillmentInputLabel: form.fulfillmentInputLabel,
      fulfillmentInputHint: form.fulfillmentInputHint,
      fulfillmentInputRequired: form.fulfillmentInputRequired,
      purchaseLimit,
      purchaseLimitPeriod: isFreeProductPrice.value ? form.purchaseLimitPeriod : 'lifetime',
      purchaseLimitDisplay: purchaseLimit !== null && form.purchaseLimitDisplay,
      active: form.active,
    }
    if (editing.value) {
      await updateAdminProduct(token.value, editingId, { ...payload, storefrontIds: form.storefrontIds })
      showToast('已保存', 'success')
    } else {
      const res = await createAdminProduct(token.value, { ...payload, storefrontIds: form.storefrontIds })
      showToast(`已创建，系统编号：${res.productId}`, 'success')
    }
    dialogVisible.value = false
    loadCategories()
    loadData()
  } catch (err: any) {
    showToast(err.message || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

function handleFulfillmentInputTypeChange() {
  if (form.fulfillmentInputType === 'none') {
    form.fulfillmentInputLabel = ''
    form.fulfillmentInputHint = ''
    form.fulfillmentInputRequired = false
    return
  }
  if (!form.fulfillmentInputLabel.trim()) form.fulfillmentInputLabel = ''
  form.fulfillmentInputRequired = true
}

async function remove(id: string) {
  if (deletingId.value || batchOperating.value) return
  if (!(await askConfirm(i18n.global.t('adminProducts.confirmDelete')))) return
  deletingId.value = id
  try {
    await deleteAdminProduct(token.value, id)
    showToast(i18n.global.t('adminProducts.deleted'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || i18n.global.t('adminProducts.deleteFailed'), 'error')
  } finally {
    deletingId.value = ''
  }
}

async function batchSetActive(active: boolean) {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(i18n.global.t('adminProducts.confirmBatchToggle', { action: active ? i18n.global.t('adminProducts.actionSell') : i18n.global.t('adminProducts.actionUnlist'), count: ids.length })))) return
  const result = await runSequential(ids, async (id) => {
    await updateAdminProduct(token.value, id, { active })
  })
  if (!result) return
  showToast(i18n.global.t('adminProducts.batchToggleResult', { action: active ? i18n.global.t('adminProducts.actionSell') : i18n.global.t('adminProducts.actionUnlist'), success: result.success, failed: result.failed }), result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

async function batchRemove() {
  const ids = selectedIds.value.slice()
  if (ids.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(i18n.global.t('adminProducts.confirmBatchDelete')))) return
  const result = await runSequential(ids, async (id) => {
    deletingId.value = id
    await deleteAdminProduct(token.value, id)
  })
  deletingId.value = ''
  if (!result) return
  showToast(`批量删除完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? 'error' : 'success')
  await loadData()
  selectedIds.value = result.failedItems
}

function productLine(item: AdminProduct) {
  const currency = item.currency || 'CNY'
  return [item.id, item.title, item.category || '', minorToMajorString(item.priceCents, currency), currency, String(item.stock ?? ''), String(item.purchasedCount ?? 0), item.active ? '上架' : '下架'].join('\t')
}

function markCoverBroken(id: string) {
  brokenCoverIds.value = { ...brokenCoverIds.value, [id]: true }
}

async function duplicateProductRow(item: AdminProduct) {
  if (duplicatingId.value || saving.value || loading.value || batchOperating.value) return
  duplicatingId.value = item.id
  try {
    const res = await duplicateAdminProduct(token.value, item.id)
    showToast(`已拷贝为新商品：${res.productId}`, 'success')
    await loadData()
  } catch (err: any) {
    showToast(err.message || '拷贝商品失败', 'error')
  } finally {
    duplicatingId.value = ''
  }
}

async function copySelectedProducts() {
  try { await writeClipboardText(selectedItems.value.map(productLine).join('\n')); showToast(i18n.global.t('adminProducts.copySuccess', { count: selectedItems.value.length }), 'success') }
  catch { showToast(i18n.global.t('adminProducts.copyFailed'), 'error') }
}

function exportSelectedProducts() {
  downloadCsv(`selected-products-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['id', 'title', 'category', 'priceCents', 'currency', 'stock', 'purchasedCount', 'fulfillmentMode', 'purchaseLimit', 'purchaseLimitPeriod', 'purchaseLimitDisplay', 'active'],
    ...selectedItems.value.map((item) => [item.id, item.title, item.category || '', String(item.priceCents), item.currency || 'CNY', String(item.stock ?? ''), String(item.purchasedCount ?? 0), item.fulfillmentMode || '', String(item.purchaseLimit ?? ''), item.purchaseLimitPeriod || 'lifetime', String(item.purchaseLimitDisplay === true), String(item.active ?? true)]),
  ])
  showToast(i18n.global.t('adminProducts.exportSuccess', { count: selectedItems.value.length }), 'success')
}

function fulfillmentModeText(mode?: string) {
  if (!mode) return '-'
  return i18n.global.t(`adminProducts.fulfillmentModes.${mode}`, {}, { default: mode })
}

function stockDisplayModeText(mode?: AdminProduct['stockDisplayMode']) {
  const value = mode || 'exact'
  return i18n.global.t(`adminProducts.stockDisplayModes.${value}`, {}, { default: i18n.global.t('adminProducts.stockDisplayModes.exact') })
}

function purchaseLimitText(limit?: number | null) {
  if (limit == null || limit === undefined) return '-'
  if (limit <= 0) return '-'
  return `${limit} 次`
}

function purchaseLimitPeriodText(item: AdminProduct) {
  if ((item.priceCents || 0) !== 0) return '总限'
  return item.purchaseLimitPeriod === 'daily' ? '每日' : '总限'
}

function purchaseLimitPeriodClass(item: AdminProduct) {
  if ((item.priceCents || 0) === 0 && item.purchaseLimitPeriod === 'daily') return 'tag-info'
  return 'tag-muted'
}

function formatProductMoney(item: AdminProduct) {
  try {
    return formatMoney(item.priceCents, item.currency || 'CNY')
  } catch {
    return `${item.currency || 'UNKNOWN'} ${item.priceCents}（配置异常）`
  }
}

onMounted(() => {
  initFilterFromRoute()
  loadCategories()
  loadStorefronts()
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

watch(
  () => form.currency,
  (currency) => {
    if (currency !== 'CNY') form.active = false
    if (getCurrencyMeta(currency).exponent === 0 && form.priceMajor.includes('.')) {
      form.priceMajor = /^\d+\.0+$/.test(form.priceMajor)
        ? form.priceMajor.split('.')[0]
        : '0'
    }
  },
)

watch(() => form.coverUrl, () => {
  coverPreviewFailed.value = false
})
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.cover-cell {
  width: 68px;
}

.product-cover-thumb {
  display: block;
  object-fit: cover;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  background: var(--tg-secondary-bg, #151b28);
}

/* ── 商品编辑弹窗：分区、双列、固定脚部 ── */
.product-editor-form {
  gap: 0;
  min-height: 0;
  flex: 1 1 auto;
  max-height: min(78dvh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.product-editor-scroll {
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

.form-section {
  display: flex;
  flex-direction: column;
  gap: var(--admin-card-gap, 10px);
  padding: var(--admin-card-pad, 12px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, rgba(0, 0, 0, 0.18));
}

.form-section-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  margin-bottom: 2px;
}

.form-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--tg-text, #e5e7eb);
}

.form-section-desc {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--tg-hint, #9ca3af);
}

.form-grid {
  display: grid;
  gap: 10px 12px;
}

.form-grid.two-cols {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.form-grid .field-span-2 {
  grid-column: 1 / -1;
}

.product-editor-form :deep(.field-hint),
.product-editor-form .field-hint {
  display: block;
  margin-top: 2px;
  color: var(--tg-hint, #9ca3af);
  font-size: 11px;
  line-height: 1.4;
  font-weight: 400;
}

.media-price-layout {
  display: grid;
  grid-template-columns: minmax(160px, 0.9fr) minmax(0, 1.2fr);
  gap: var(--admin-card-gap, 12px);
  align-items: start;
}

.cover-panel,
.price-panel {
  display: flex;
  flex-direction: column;
  gap: var(--admin-inline-gap, 8px);
  min-width: 0;
}

.cover-preview-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--r-md, 8px);
  border: 0.5px dashed var(--border, rgba(255, 255, 255, 0.2));
  background: var(--tg-bg, #0b1220);
  overflow: hidden;
}

.cover-preview-frame.has-image {
  border-style: solid;
}

.cover-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: none;
  border-radius: 0;
  background: transparent;
}

.cover-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px;
  color: var(--tg-hint, #9ca3af);
  font-size: 12px;
  text-align: center;
}

.cover-empty small {
  font-size: 11px;
  opacity: 0.85;
}

/* image-upload-* → admin.css */

.product-cover-thumb {
  width: 48px;
  height: 48px;
}

.cover-placeholder {
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
  white-space: nowrap;
}

.price-preview-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--tg-text, #e5e7eb);
}

.price-preview-line strong {
  font-weight: 600;
  color: var(--admin-accent-text, #fbbf24);
}

.price-preview-original {
  margin-left: 8px;
  color: var(--tg-hint, #9ca3af);
  text-decoration: line-through;
}

.price-preview-save {
  margin-left: 6px;
  color: var(--admin-success, #6ee7b7);
  font-weight: 600;
}

.inline-callout {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-md, 8px);
  background: var(--admin-accent-soft, rgba(245, 158, 11, 0.12));
  border: 1px solid var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  color: var(--tg-text, #f0f2f5);
  font-size: 11px;
  line-height: 1.45;
}

.fulfillment-input-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--r-md, 8px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: var(--tg-bg, rgba(0, 0, 0, 0.15));
}

.toggle-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 18px;
}

.storefront-check-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}

.product-editor-footer.modal-actions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 0;
  padding-top: 12px;
  border-top: 0.5px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--tg-bg, #0f172a);
}

@media (max-width: 640px) {
  .form-grid.two-cols,
  .media-price-layout {
    grid-template-columns: 1fr;
  }

  .form-section {
    padding: 10px;
  }
}

.sort-context {
  margin: -4px 0 10px;
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
  line-height: 1.5;
}

.mode-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.channel-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 120px;
}

.channel-sort-tag {
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  white-space: nowrap;
}

.channel-sort-tag small {
  font-size: 11px;
  opacity: 0.8;
}

.channel-inline-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  white-space: nowrap;
}

.channel-inline-sort input {
  width: 68px;
  min-height: 28px;
  padding: 3px 6px;
  color: var(--tg-text, #e5e7eb);
  background: var(--tg-secondary-bg, #111827);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.18));
  border-radius: 6px;
  caret-color: var(--admin-accent, #f59e0b);
}

.channel-inline-sort input:focus {
  border-color: var(--admin-accent, #f59e0b);
}

.channel-inline-sort input:disabled {
  opacity: 0.65;
  cursor: wait;
}

.product-status {
  min-width: 42px;
  justify-content: center;
  border-radius: 6px;
  padding-inline: 8px;
}

.storefront-fieldset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 10px 12px 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, rgba(0, 0, 0, 0.18));
}

.storefront-fieldset legend {
  padding: 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--tg-text, #e5e7eb);
}

.field-help-danger {
  color: var(--danger, #ef4444);
}

.mode-tag {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: var(--r-full, 999px);
  font-size: 11px;
  line-height: 1.4;
  border: 0.5px solid transparent;
  white-space: nowrap;
}

.mode-tag-success {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.2);
}

.mode-tag-warn {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.22);
}

.mode-tag-info {
  color: #38bdf8;
  background: rgba(14, 165, 233, 0.12);
  border-color: rgba(14, 165, 233, 0.22);
}

/* 库存只读提示行（页面专属样式） */
.stock-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: rgba(245, 158, 11, 0.08);
  border-radius: var(--r-md, 8px);
  font-size: 12px;
}

.stock-hint-label {
  font-weight: 600;
  color: var(--tg-text, #f0f2f5);
}

.stock-hint-desc {
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
}
</style>
