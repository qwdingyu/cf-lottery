<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <input v-model="query" type="search" :placeholder="$t('adminStorefronts.searchPlaceholder')" :aria-label="$t('adminStorefronts.searchAriaLabel')" />
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" @click="openEditor()">{{ $t('adminStorefronts.addButton') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">{{ $t('adminStorefronts.reload') }}</button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminStorefronts.tableAriaLabel')" tabindex="0" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminStorefronts.colChannel') }}</th>
            <th>{{ $t('adminStorefronts.colPath') }}</th>
            <th>{{ $t('adminStorefronts.colTemplate') }}</th>
            <th>{{ $t('adminStorefronts.colStatus') }}</th>
            <th>{{ $t('adminStorefronts.colProducts') }}</th>
            <th>{{ $t('adminStorefronts.colOrders') }}</th>
            <th>{{ $t('adminStorefronts.colUpdatedAt') }}</th>
            <th>{{ $t('adminStorefronts.colAction') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 4" :key="i" class="skeleton-row"><td colspan="8"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="item in filteredItems" :key="item.id">
            <td>
              <div class="channel-name">
                <img v-if="item.logoUrl" :src="item.logoUrl" alt="" class="channel-logo" />
                <span>{{ item.name }}</span>
                <span v-if="item.isDefault" class="tag tag-info">{{ $t('adminStorefronts.defaultTag') }}</span>
              </div>
            </td>
            <td><code>{{ item.homePath }}</code></td>
            <td><span class="tag tag-muted">{{ templateLabel(item.templateKey) }}</span></td>
            <td><span class="tag" :class="item.active ? 'tag-success' : 'tag-muted'">{{ item.active ? $t('adminStorefronts.statusActive') : $t('adminStorefronts.statusInactive') }}</span></td>
            <td>{{ item.productCount }}</td>
            <td>{{ item.orderCount }}</td>
            <td>{{ formatDate(item.updatedAt) }}</td>
            <td>
              <div class="table-actions channel-actions">
                <button class="btn btn-ghost btn-xs" type="button" @click="preview(item)">{{ $t('adminStorefronts.actionPreview') }}</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="copyUrl(item)">{{ $t('adminStorefronts.actionCopyUrl') }}</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="openEditor(item)">{{ $t('adminStorefronts.actionEdit') }}</button>
                <button class="btn btn-ghost btn-xs" type="button" @click="openProducts(item)">{{ $t('adminStorefronts.actionSelectProducts') }}（{{ item.productCount }}）</button>
                <button v-if="!item.isDefault" class="btn btn-ghost btn-xs" type="button" @click="makeDefault(item)">{{ $t('adminStorefronts.actionSetDefault') }}</button>
                <button v-if="!item.isDefault" class="btn btn-ghost btn-xs" type="button" @click="toggleActive(item)">{{ item.active ? $t('adminStorefronts.statusInactive') : $t('adminStorefronts.statusActive') }}</button>
                <button v-if="!item.isDefault && item.orderCount === 0" class="btn btn-danger btn-xs" type="button" @click="remove(item)">{{ $t('adminStorefronts.actionDelete') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredItems.length === 0"><td colspan="8" class="empty-text">{{ $t('adminStorefronts.noData') }}</td></tr>
        </tbody>
      </table>
    </div>

    <AdminModal v-model="editorVisible" :title="editingId ? $t('adminStorefronts.modalEditTitle') : $t('adminStorefronts.modalCreateTitle')" max-width="560px" hide-actions>
      <form class="modal-form" @submit.prevent="saveEditor">
        <label>
          <span>{{ $t('adminStorefronts.colName') }}</span>
          <input v-model.trim="form.name" required maxlength="60" autocomplete="off" />
        </label>
        <label>
          <span>{{ $t('adminStorefronts.formSlug') }}</span>
          <input v-model.trim="form.slug" :disabled="Boolean(editingId)" required minlength="2" maxlength="48" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" />
        </label>
        <label>
          <span>{{ $t('adminStorefronts.formTemplate') }}</span>
          <select v-model="form.templateKey">
            <option value="catalog">{{ $t('adminStorefronts.templateCatalog') }}</option>
            <option value="compact">{{ $t('adminStorefronts.templateCompact') }}</option>
          </select>
          <small class="field-hint">{{ $t('adminStorefronts.templateHint') }}</small>
        </label>
        <label>
          <span>{{ $t('adminStorefronts.formLogoUrl') }}</span>
          <input v-model.trim="form.logoUrl" type="text" inputmode="url" maxlength="500" :placeholder="$t('adminStorefronts.logoPlaceholder')" autocomplete="url" />
        </label>
        <div class="image-upload-row">
          <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingLogo }">
            {{ uploadingLogo ? $t('adminStorefronts.uploading') : $t('adminStorefronts.uploadLogo') }}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              :disabled="uploadingLogo"
              @change="uploadLogoImage"
            />
          </label>
          <span class="field-hint">{{ $t('adminStorefronts.uploadHint') }}</span>
        </div>
        <img v-if="form.logoUrl" :src="form.logoUrl" :alt="$t('adminStorefronts.logoPreview')" class="logo-preview" />
        <label>
          <span>{{ $t('adminStorefronts.formSupportEmail') }}</span>
          <input v-model.trim="form.supportEmail" type="email" maxlength="160" autocomplete="email" />
        </label>
        <label>
          <span>{{ $t('adminStorefronts.formSortOrder') }}</span>
          <input v-model.number="form.sortOrder" type="number" min="0" max="99999" step="1" required />
        </label>
        <label v-if="!editingDefault" class="checkbox-label">
          <input v-model="form.active" type="checkbox" />
          <span>{{ $t('adminStorefronts.formActive') }}</span>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" :disabled="saving || uploadingLogo" @click="editorVisible = false">{{ $t('adminStorefronts.cancel') }}</button>
          <button class="btn btn-primary" type="submit" :disabled="saving || uploadingLogo">{{ saving ? $t('adminStorefronts.saving') : $t('adminStorefronts.save') }}</button>
        </div>
      </form>
    </AdminModal>

    <AdminModal v-model="productsVisible" :title="$t('adminStorefronts.productsTitle', { name: currentStorefront?.name || '' })" max-width="760px" hide-actions>
      <div class="mapping-panel">
        <div class="mapping-toolbar">
          <input v-model="productQuery" type="search" :placeholder="$t('adminStorefronts.productSearch')" :aria-label="$t('adminStorefronts.productSearchAriaLabel')" />
          <input
            v-model="buyLinkCampaign"
            type="text"
            maxlength="80"
            :placeholder="$t('adminStorefronts.campaignCode')"
            :title="$t('adminStorefronts.campaignCode')"
            :aria-label="$t('adminStorefronts.campaignCode')"
          />
          <input
            v-model="buyLinkReferral"
            type="text"
            maxlength="80"
            :placeholder="$t('adminStorefronts.referralCode')"
            :title="$t('adminStorefronts.referralCode')"
            :aria-label="$t('adminStorefronts.referralCode')"
          />
          <span class="muted-text">{{ $t('adminStorefronts.selectedCount', { count: selectedProductCount }) }}</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="selectFilteredProducts(true)">{{ $t('adminStorefronts.selectFiltered') }}</button>
          <button class="btn btn-ghost btn-sm" type="button" @click="selectFilteredProducts(false)">{{ $t('adminStorefronts.deselectFiltered') }}</button>
        </div>
        <div v-if="productsLoading" class="empty-text">{{ $t('adminStorefronts.loading') }}</div>
        <div v-else class="mapping-list">
          <div v-for="row in filteredProductRows" :key="row.product.id" class="mapping-row">
            <label class="mapping-product">
              <input v-model="row.selected" type="checkbox" />
              <span>{{ row.product.title }}</span>
              <code>{{ row.product.id }}</code>
            </label>
            <label class="mapping-visible">
              <input v-model="row.visible" type="checkbox" :disabled="!row.selected" />
              <span>{{ $t('adminStorefronts.visible') }}</span>
            </label>
            <label class="mapping-sort">
              <span>{{ $t('adminStorefronts.sortOrder') }}</span>
              <input v-model.number="row.sortOrder" type="number" min="0" max="99999" step="1" :disabled="!row.selected" />
            </label>
            <button
              class="btn btn-ghost btn-xs"
              type="button"
              :title="buyLinkButtonTitle(row)"
              :disabled="!canCopyBuyLink(row)"
              @click="copyProductBuyLink(row)"
            >
              {{ $t('adminStorefronts.buyLink') }}
            </button>
          </div>
          <div v-if="filteredProductRows.length === 0" class="empty-text">{{ $t('adminStorefronts.noProducts') }}</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" :disabled="savingProducts" @click="productsVisible = false">{{ $t('adminStorefronts.cancel') }}</button>
          <button class="btn btn-primary" type="button" :disabled="savingProducts || productsLoading" @click="saveProducts">{{ savingProducts ? $t('adminStorefronts.saving') : $t('adminStorefronts.saveProducts') }}</button>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import {
  createAdminStorefront,
  deleteAdminStorefront,
  fetchAdminProducts,
  fetchAdminStorefront,
  fetchAdminStorefronts,
  replaceAdminStorefrontProducts,
  setAdminDefaultStorefront,
  updateAdminStorefront,
  uploadAdminMediaImage,
} from '@/api/admin'
import type { StorefrontTemplate } from '@/types'
import type { AdminProduct, AdminStorefront } from '@/types/admin'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import { normalizeAttributionCode } from '@/lib/checkout-attribution'
import {
  adminBuyLinkFailureMessage,
  canCopyPersistedStorefrontBuyLink,
  mappingBuyLinkGateMessage,
  resolveAdminBuyLink,
  type MappingBuyLinkPersisted,
} from '@/lib/resolve-admin-buy-link'

type MappingRow = {
  product: AdminProduct
  selected: boolean
  visible: boolean
  sortOrder: number
  /** 打开面板时服务端已落库的映射；null = 当时无映射（未保存的新建不可复制） */
  persisted: MappingBuyLinkPersisted | null
}

const { token } = useAdminAuth()
const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
const route = useRoute()
const items = ref<AdminStorefront[]>([])
const loading = ref(false)
const loadError = ref('')
const query = ref('')
/** 渠道商品映射面板：复制购买链可选归因 */
const buyLinkCampaign = ref('')
const buyLinkReferral = ref('')
const editorVisible = ref(false)
const saving = ref(false)
const uploadingLogo = ref(false)
const editingId = ref('')
const editingDefault = ref(false)
const productsVisible = ref(false)
const productsLoading = ref(false)
const savingProducts = ref(false)
const currentStorefront = ref<AdminStorefront | null>(null)
const productRows = ref<MappingRow[]>([])
const productQuery = ref('')

const form = reactive<{
  slug: string
  name: string
  logoUrl: string
  supportEmail: string
  templateKey: StorefrontTemplate
  active: boolean
  sortOrder: number
}>({
  slug: '',
  name: '',
  logoUrl: '',
  supportEmail: '',
  templateKey: 'compact',
  active: true,
  sortOrder: 100,
})

const filteredItems = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return items.value
  return items.value.filter(item => item.name.toLowerCase().includes(value) || item.slug.toLowerCase().includes(value))
})

const filteredProductRows = computed(() => {
  const value = productQuery.value.trim().toLowerCase()
  if (!value) return productRows.value
  return productRows.value.filter(row => row.product.title.toLowerCase().includes(value) || row.product.id.toLowerCase().includes(value))
})
const selectedProductCount = computed(() => productRows.value.filter(row => row.selected).length)

function templateLabel(templateKey: StorefrontTemplate) {
  return templateKey === 'compact' ? t('adminStorefronts.templateCompact') : t('adminStorefronts.templateCatalog')
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const result = await fetchAdminStorefronts(token.value)
    items.value = result.storefronts
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('adminStorefronts.loadError')
    showToast(loadError.value, 'error')
  } finally {
    loading.value = false
  }
}

async function openProductsFromQuery() {
  const storefrontId = String(route.query.storefrontId || '')
  const productId = String(route.query.productId || '')
  if (!storefrontId && !productId) return
  const target = storefrontId
    ? items.value.find(item => item.id === storefrontId)
    : items.value.find(item => item.isDefault) || items.value[0]
  if (!target) return
  await openProducts(target)
  if (productId) productQuery.value = productId
}

function openEditor(item?: AdminStorefront) {
  editingId.value = item?.id || ''
  editingDefault.value = item?.isDefault || false
  Object.assign(form, item
    ? { slug: item.slug, name: item.name, logoUrl: item.logoUrl, supportEmail: item.supportEmail, templateKey: item.templateKey, active: item.active, sortOrder: item.sortOrder }
    : { slug: '', name: '', logoUrl: '', supportEmail: '', templateKey: 'compact', active: true, sortOrder: 100 })
  editorVisible.value = true
}

async function uploadLogoImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingLogo.value) return

  uploadingLogo.value = true
  try {
    const result = await uploadAdminMediaImage(token.value, file)
    form.logoUrl = result.url
    showToast(t('adminStorefronts.logoUploadSuccess'), 'success')
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('adminStorefronts.logoUploadError'), 'error')
  } finally {
    uploadingLogo.value = false
  }
}

async function saveEditor() {
  if (saving.value || uploadingLogo.value) return
  saving.value = true
  try {
    if (editingId.value) {
      await updateAdminStorefront(token.value, editingId.value, {
        name: form.name,
        logoUrl: form.logoUrl,
        supportEmail: form.supportEmail,
        templateKey: form.templateKey,
        active: editingDefault.value ? true : form.active,
        sortOrder: form.sortOrder,
      })
    } else {
      await createAdminStorefront(token.value, { ...form, slug: form.slug.toLowerCase() })
    }
    editorVisible.value = false
    showToast(t('adminStorefronts.saveSuccess'), 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('adminStorefronts.saveError'), 'error')
  } finally {
    saving.value = false
  }
}

async function loadAllProducts(): Promise<AdminProduct[]> {
  const result: AdminProduct[] = []
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchAdminProducts(token.value, { page, limit: 100 })
    result.push(...response.products)
    if (result.length >= response.total) return result
  }
  throw new Error(t('adminStorefronts.tooManyProducts'))
}

async function openProducts(item: AdminStorefront) {
  currentStorefront.value = item
  productQuery.value = ''
  productRows.value = []
  productsVisible.value = true
  productsLoading.value = true
  try {
    const [detail, products] = await Promise.all([fetchAdminStorefront(token.value, item.id), loadAllProducts()])
    const mapping = new Map(detail.products.map(entry => [entry.productId, entry]))
    productRows.value = products.map((product, index) => {
      const existing = mapping.get(product.id)
      const persisted: MappingBuyLinkPersisted | null = existing
        ? { selected: true, visible: existing.visible !== false }
        : null
      return {
        product,
        selected: Boolean(existing),
        visible: existing?.visible ?? true,
        sortOrder: existing?.sortOrder ?? ((index + 1) * 10),
        persisted,
      }
    }).sort(compareMappingRows)
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('adminStorefronts.loadProductsError'), 'error')
    productsVisible.value = false
  } finally {
    productsLoading.value = false
  }
}

function compareMappingRows(a: MappingRow, b: MappingRow) {
  if (a.selected !== b.selected) return a.selected ? -1 : 1
  if (a.selected && b.selected && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.product.title.localeCompare(b.product.title, 'zh-Hans-CN')
}

function selectFilteredProducts(selected: boolean) {
  for (const row of filteredProductRows.value) row.selected = selected
  productRows.value = productRows.value.slice().sort(compareMappingRows)
}

async function saveProducts() {
  if (!currentStorefront.value || savingProducts.value) return
  savingProducts.value = true
  try {
    const products = productRows.value
      .filter(row => row.selected)
      .map(row => ({ productId: row.product.id, visible: row.visible, sortOrder: row.sortOrder }))
    const visibleProducts = products.filter(product => product.visible)
    // 默认 /shop 是公共商品入口，保存为空会直接呈现空页面。
    // 允许管理员明确确认该结果，但避免筛选或批量操作造成静默下线。
    let allowEmptyDefault = false
    if (currentStorefront.value.isDefault && visibleProducts.length === 0) {
      if (!(await askConfirm(t('adminStorefronts.confirmEmptyDefault')))) return
      allowEmptyDefault = true
    }
    await replaceAdminStorefrontProducts(token.value, currentStorefront.value.id, products, { allowEmptyDefault })
    productsVisible.value = false
    showToast(t('adminStorefronts.productsSaved', { count: products.length }), 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('adminStorefronts.saveProductsError'), 'error')
  } finally {
    savingProducts.value = false
  }
}

function storefrontUrl(item: AdminStorefront) {
  return new URL(item.homePath, window.location.origin).toString()
}

function preview(item: AdminStorefront) {
  window.open(storefrontUrl(item), '_blank', 'noopener,noreferrer')
}

async function copyUrl(item: AdminStorefront) {
  try {
    await writeClipboardText(storefrontUrl(item))
    showToast(t('adminStorefronts.urlCopied'), 'success')
  } catch {
    showToast(t('adminStorefronts.urlCopyFailed'), 'error')
  }
}

/** 仅已落库且可见的映射可复制；草稿相对快照 dirty 时禁用，避免 404 死链投放 */
function mappingBuyLinkGate(row: MappingRow) {
  return canCopyPersistedStorefrontBuyLink({
    channelActive: currentStorefront.value?.active !== false,
    productActive: row.product.active !== false,
    draft: { selected: row.selected, visible: row.visible },
    persisted: row.persisted,
  })
}

function canCopyBuyLink(row: MappingRow): boolean {
  return mappingBuyLinkGate(row).ok
}

function buyLinkButtonTitle(row: MappingRow): string {
  const gate = mappingBuyLinkGate(row)
  if (gate.ok) return t('adminStorefronts.buyLinkTitle')
  return mappingBuyLinkGateMessage(gate.reason)
}

/**
 * 当前渠道内单商品购买链接。
 * 必须先落库（selected+visible 与打开面板时的服务端快照一致）；
 * 商品上架与渠道启用仍走 resolveAdminBuyLink 硬闸门。
 */
async function copyProductBuyLink(row: MappingRow) {
  const channel = currentStorefront.value
  if (!channel) return
  const gate = mappingBuyLinkGate(row)
  if (!gate.ok) {
    showToast(mappingBuyLinkGateMessage(gate.reason), 'error')
    return
  }
  const campaignCode = normalizeAttributionCode(buyLinkCampaign.value)
  const referralCode = normalizeAttributionCode(buyLinkReferral.value)
  const resolved = resolveAdminBuyLink({
    product: {
      id: row.product.id,
      slug: row.product.slug,
      active: row.product.active,
      storefronts: [{ id: channel.id, visible: true }],
    },
    filterStorefrontId: channel.id,
    storefronts: [{
      id: channel.id,
      name: channel.name,
      homePath: channel.homePath,
      active: channel.active,
    }],
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
    const attrHint = [campaignCode && `${t('adminStorefronts.campaignLabel')} ${campaignCode}`, referralCode && `${t('adminStorefronts.referralLabel')} ${referralCode}`]
      .filter(Boolean)
      .join(' · ')
    showToast(
      attrHint
        ? t('adminStorefronts.buyLinkCopiedWithAttr', { storefront: resolved.storefront.name, attribution: attrHint })
        : t('adminStorefronts.buyLinkCopied', { storefront: resolved.storefront.name }),
      'success',
    )
  } catch {
    showToast(t('adminStorefronts.buyLinkCopyFailed'), 'error')
  }
}

async function makeDefault(item: AdminStorefront) {
  if (!(await askConfirm(t('adminStorefronts.confirmSetDefault', { name: item.name })))) return
  try {
    await setAdminDefaultStorefront(token.value, item.id)
    showToast(t('adminStorefronts.defaultSet'), 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('adminStorefronts.defaultSetError'), 'error')
  }
}

async function toggleActive(item: AdminStorefront) {
  const activating = !item.active
  if (!(await askConfirm(activating ? t('adminStorefronts.confirmToggleEnable', { name: item.name }) : t('adminStorefronts.confirmToggleDisable', { name: item.name })))) return
  try {
    await updateAdminStorefront(token.value, item.id, { active: activating })
    showToast(activating ? t('adminStorefronts.channelActivated') : t('adminStorefronts.channelDeactivated'), 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : (activating ? t('adminStorefronts.activateError') : t('adminStorefronts.deactivateError')), 'error')
  }
}

async function remove(item: AdminStorefront) {
  if (!(await askConfirm(t('adminStorefronts.confirmDeleteItem', { name: item.name })))) return
  try {
    await deleteAdminStorefront(token.value, item.id)
    showToast(t('adminStorefronts.deleteSuccess'), 'success')
    await loadData()
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('adminStorefronts.deleteError'), 'error')
  }
}

onMounted(async () => {
  await loadData()
  await openProductsFromQuery()
})
</script>

<style>@import '@/assets/admin.css';</style>
<style scoped>
.channel-name,
.mapping-toolbar,
.mapping-row,
.mapping-product,
.mapping-visible,
.mapping-sort {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
  border-radius: 4px;
}

.channel-actions {
  flex-wrap: wrap;
  gap: 4px;
  min-width: 240px;
}

.logo-preview {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  /* 透明 logo 需要浅底对比，用表面 token 而非整页级 #fff 卡片 */
  background: color-mix(in srgb, #ffffff 88%, var(--tg-secondary-bg, #151b28));
}

/* image-upload-* / field-hint → admin.css */

.mapping-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mapping-toolbar {
  flex-wrap: wrap;
}

.mapping-toolbar input[type='search'] {
  min-width: 220px;
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
}

.mapping-list {
  max-height: 52vh;
  overflow: auto;
  border-block: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}

.mapping-row {
  min-height: 46px;
  padding: 7px 4px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}

.mapping-product {
  min-width: 0;
  flex: 1;
}

.mapping-product span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.mapping-product code {
  color: var(--tg-hint, #9aa4b2);
  font-size: 11px;
}

.mapping-visible {
  flex: 0 0 auto;
}

.mapping-sort input {
  width: 78px;
  padding: 6px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
}

@media (max-width: 680px) {
  .mapping-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .mapping-product {
    flex-basis: 100%;
  }
}
</style>
