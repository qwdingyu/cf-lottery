<template>
  <Teleport to="body">
    <transition name="confirm-fade">
      <div
        v-if="visible && product"
        class="confirm-overlay"
        role="presentation"
        @click.self="emitClose"
      >
        <div
          ref="sheetEl"
          class="confirm-sheet"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <button
            ref="closeBtnEl"
            class="confirm-close"
            type="button"
            :aria-label="$t('checkout.done')"
            @click="emitClose"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>

          <div class="confirm-hero">
            <div class="confirm-cover">
              <img
                v-if="product.coverUrl && !imageFailed"
                :src="product.coverUrl"
                :alt="displayTitle"
                @error="imageFailed = true"
              />
              <span v-else class="confirm-cover-fallback" aria-hidden="true">&#x1F4E6;</span>
              <span v-if="isSoldOut" class="confirm-badge sold">{{ $t('productCard.outOfStock') }}</span>
              <span v-else-if="showsLowStock" class="confirm-badge low">{{ $t('productCard.lowStock') }}</span>
            </div>
            <div class="confirm-meta">
              <h2 :id="titleId" class="confirm-title">{{ displayTitle }}</h2>
              <div
                class="confirm-price-row"
                :aria-label="$t('productConfirm.ariaPrice', { price: priceDisplay.priceLabel, original: priceDisplay.originalLabel })"
              >
                <span
                  class="confirm-price"
                  :class="{
                    free: product.priceCents === 0,
                    sale: priceDisplay.hasDiscount && product.priceCents > 0,
                  }"
                >
                  {{ priceDisplay.priceLabel }}
                </span>
                <span v-if="priceDisplay.hasDiscount" class="confirm-original">{{ priceDisplay.originalLabel }}</span>
                <span v-if="priceDisplay.saveLabel" class="confirm-save">{{ priceDisplay.saveLabel }}</span>
              </div>
              <div v-if="stockLabel || purchaseLimitLabel" class="confirm-stock-row">
                <span v-if="stockLabel" class="confirm-stock" :class="{ out: isSoldOut, low: showsLowStock && !isSoldOut }">
                  {{ isSoldOut ? $t('productCard.outOfStock') : stockLabel }}
                </span>
                <span v-if="purchaseLimitLabel" class="confirm-stock limit">{{ purchaseLimitLabel }}</span>
              </div>
              <div v-if="marketingDisplay.visible" class="confirm-marketing">
                <span class="confirm-marketing-badge">{{ marketingDisplay.label }}</span>
              </div>
            </div>
          </div>

          <div v-if="tags.length" class="confirm-tags" :aria-label="$t('productConfirm.ariaTags')">
            <span v-for="tag in tags" :key="tag" class="confirm-tag">{{ tag }}</span>
          </div>

          <!-- 仅公开 description；salesCopy 为交付内容，店面 API 会剥离，确认层绝不可展示 -->
          <div v-if="bodyText" class="confirm-desc-wrap">
            <p class="confirm-desc" :class="{ expanded: descExpanded }">{{ bodyText }}</p>
            <button
              v-if="descNeedsToggle"
              type="button"
              class="confirm-desc-toggle"
              @click="descExpanded = !descExpanded"
            >
              {{ descExpanded ? $t('productConfirm.cancel') : $t('productConfirm.expand') }}
            </button>
          </div>
          <p v-else class="confirm-desc muted">{{ $t('productConfirm.confirmPrompt') }}</p>

          <div class="confirm-actions">
            <button
              ref="buyBtnEl"
              class="btn btn-primary confirm-buy"
              type="button"
              :disabled="isSoldOut"
              @click="emit('buy')"
            >
              {{ isSoldOut ? $t('productConfirm.soldOut') : (product.priceCents === 0 ? $t('checkout.freeClaim') : $t('shop.buy')) }}
            </button>
            <button
              class="btn btn-ghost confirm-copy"
              type="button"
              :disabled="copying"
              @click="emit('copy')"
            >
              {{ copying ? $t('productConfirm.copied') : (hasReferral ? $t('productConfirm.shareEarn') : $t('productConfirm.copyLink')) }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Product } from '@/types'
import {
  productIsSoldOut,
  productPurchaseLimitLabel,
  productShowsLowStock,
  productStockLabel,
} from '@/lib/storefront-stock'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/body-scroll-lock'
import { buildListPriceDisplay } from '@/lib/product-price-display'
import { formatMarketingCountdown } from '@/lib/marketing-countdown'
import { useNow } from '@/composables/useNow'
import { getMemberShareReferralCode } from '@/lib/member-share-referral'

const { nowMs } = useNow()

const hasReferral = computed(() => Boolean(getMemberShareReferralCode()))

const props = withDefaults(defineProps<{
  visible: boolean
  product: Product | null
  copying?: boolean
}>(), {
  copying: false,
})

const { t } = useI18n()
const emit = defineEmits<{
  close: []
  buy: []
  copy: []
}>()

const titleId = 'product-confirm-title'
const imageFailed = ref(false)
const sheetEl = ref<HTMLElement | null>(null)
const closeBtnEl = ref<HTMLButtonElement | null>(null)
const buyBtnEl = ref<HTMLButtonElement | null>(null)
/** 长描述默认折叠行数；超过约 8 行提供展开（不新开路由） */
const descExpanded = ref(false)
const DESC_FOLD_CHARS = 220

let previousActive: HTMLElement | null = null
/** 本实例是否已向共享 body 锁 acquire 过（防重复 lock/unlock） */
let holdsBodyScrollLock = false

watch(() => props.product?.coverUrl, () => {
  imageFailed.value = false
})

watch(() => props.product?.id, () => {
  descExpanded.value = false
})

function acquireBodyScrollLock() {
  if (holdsBodyScrollLock) return
  lockBodyScroll()
  holdsBodyScrollLock = true
}

function releaseBodyScrollLock() {
  if (!holdsBodyScrollLock) return
  unlockBodyScroll()
  holdsBodyScrollLock = false
}

function restoreFocus() {
  const target = previousActive
  previousActive = null
  if (target && typeof target.focus === 'function') {
    try {
      target.focus({ preventScroll: true })
    } catch {
      // ignore focus restore failures (detached nodes)
    }
  }
}

function onKeydown(event: KeyboardEvent) {
  if (!props.visible) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  // 轻量焦点圈：Tab 只在 sheet 内可聚焦控件间循环
  if (event.key !== 'Tab' || !sheetEl.value) return
  const focusable = sheetEl.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (event.shiftKey) {
    if (active === first || !sheetEl.value.contains(active)) {
      event.preventDefault()
      last.focus()
    }
  } else if (active === last || !sheetEl.value.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.visible, async (open) => {
  if (open) {
    previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
    acquireBodyScrollLock()
    window.addEventListener('keydown', onKeydown, true)
    await nextTick()
    // 可购优先主按钮；售罄聚焦关闭，避免焦点落在禁用购买上
    const preferred = props.product && !productIsSoldOut(props.product)
      ? buyBtnEl.value
      : closeBtnEl.value
    preferred?.focus({ preventScroll: true })
  } else {
    window.removeEventListener('keydown', onKeydown, true)
    releaseBodyScrollLock()
    restoreFocus()
  }
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true)
  releaseBodyScrollLock()
})

const displayTitle = computed(() => {
  const p = props.product
  if (!p) return ''
  return p.name || p.title || t('shop.title')
})

const isSoldOut = computed(() => (props.product ? productIsSoldOut(props.product) : true))
const stockLabel = computed(() => (props.product ? productStockLabel(props.product) : ''))
const purchaseLimitLabel = computed(() => (props.product ? productPurchaseLimitLabel(props.product) : ''))
const showsLowStock = computed(() => (props.product ? productShowsLowStock(props.product) : false))
const priceDisplay = computed(() => {
  const p = props.product
  if (!p) {
    return buildListPriceDisplay(0, 'CNY', null)
  }
  return buildListPriceDisplay(p.priceCents, p.currency, p.originalPriceCents)
})

/**
 * 确认层正文：仅公开 description。
 * salesCopy 在后端 toStorefrontProduct 中剥离，属交付/私链内容，绝不可在支付前展示。
 */
const bodyText = computed(() => {
  const p = props.product
  if (!p) return ''
  const desc = typeof p.description === 'string' ? p.description.trim() : ''
  return desc
})

const descNeedsToggle = computed(() => {
  const text = bodyText.value
  if (!text) return false
  // 多段或超长：提供展开，避免确认层被长文占满首屏主按钮
  return text.length > DESC_FOLD_CHARS || text.split('\n').length > 6
})

const tags = computed(() => {
  const p = props.product
  if (!p) return [] as string[]
  const list: string[] = []
  const fulfillmentMap: Record<string, string> = {
    card: t('productConfirm.fulfillmentCard'),
    virtual: t('productConfirm.fulfillmentVirtual'),
    link: t('productConfirm.fulfillmentLink'),
    code: t('productConfirm.fulfillmentCode'),
    invite: t('productConfirm.fulfillmentInvite'),
  }
  if (p.fulfillmentMode && fulfillmentMap[p.fulfillmentMode]) {
    list.push(fulfillmentMap[p.fulfillmentMode])
  } else {
    list.push(t('productConfirm.fulfillmentGeneric'))
  }
  list.push(p.issueMode === 'manual' ? t('productConfirm.issueManual') : t('productConfirm.issueAuto'))
  if (p.category) list.push(p.category)
  return list
})

const marketingDisplay = computed(() => {
  const p = props.product
  if (!p) return { visible: false, badge: '', countdown: '', label: '' }
  const badge = String(p.marketingBadge || '').trim()
  const endsAt = String(p.marketingEndsAt || '').trim()
  const countdown = endsAt ? formatMarketingCountdown(endsAt, nowMs.value, t) : ''
  if (endsAt && !countdown) return { visible: false, badge: '', countdown: '', label: '' }
  const label = countdown ? `${badge || t('productCard.marketingBadgeDefault')} · ${countdown}` : (badge || t('productCard.marketingBadgeDefault'))
  return {
    visible: Boolean(badge || countdown),
    badge: badge || t('productCard.marketingBadgeDefault'),
    countdown,
    label,
  }
})

function emitClose() {
  emit('close')
}
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
  background: color-mix(in srgb, #080c14 52%, transparent);
  backdrop-filter: blur(2px);
}

.confirm-sheet {
  position: relative;
  width: min(100%, 420px);
  max-height: min(88vh, 640px);
  overflow: auto;
  padding: 18px 16px 16px;
  border-radius: 16px 16px 12px 12px;
  border: 0.5px solid var(--border);
  background: var(--tg-secondary-bg, #151b28);
  color: var(--tg-text);
  box-shadow: 0 12px 40px color-mix(in srgb, #000 35%, transparent);
  outline: none;
}

@media (min-width: 720px) {
  .confirm-overlay {
    align-items: center;
  }

  .confirm-sheet {
    border-radius: 16px;
  }
}

.confirm-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 999px;
  background: var(--surface, rgba(255, 255, 255, 0.06));
  color: var(--tg-hint);
  cursor: pointer;
}

.confirm-close:hover {
  color: var(--tg-text);
  background: var(--surface-hover, rgba(255, 255, 255, 0.1));
}

.confirm-close:focus-visible,
.confirm-buy:focus-visible,
.confirm-copy:focus-visible {
  outline: 2px solid var(--tg-btn, var(--tg-button, #2aabee));
  outline-offset: 2px;
}

.confirm-hero {
  display: flex;
  gap: 12px;
  padding-right: 28px;
  margin-bottom: 12px;
}

.confirm-cover {
  position: relative;
  flex: 0 0 88px;
  width: 88px;
  height: 88px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface, rgba(255, 255, 255, 0.04));
  border: 0.5px solid var(--border);
}

.confirm-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.confirm-cover-fallback {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 28px;
}

.confirm-badge {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
}

.confirm-badge.sold {
  background: color-mix(in srgb, var(--admin-danger, #ef4444) 92%, #000);
  color: #fff;
}

.confirm-badge.low {
  background: color-mix(in srgb, #f59e0b 92%, #fff);
  color: #1a1200;
}

.confirm-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  justify-content: center;
}

.confirm-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.3;
  word-break: break-word;
}

.confirm-price-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.confirm-price {
  font-size: 22px;
  font-weight: 800;
  color: var(--tg-btn, var(--tg-button, #2aabee));
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.confirm-price.free {
  color: var(--admin-success, #6ee7b7);
}

/* 确认层促销现价：与卡片同一成交色（付费促销）；限免仍用 free 绿 */
.confirm-price.sale {
  color: var(--shop-sale, #fb7185);
}

.confirm-original {
  font-size: 14px;
  font-weight: 500;
  color: color-mix(in srgb, var(--tg-hint) 90%, transparent);
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
}

.confirm-save {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--r-full);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--shop-sale-text, #fecdd3);
  background: var(--shop-sale-soft, rgba(244, 63, 94, 0.16));
  border: 0.5px solid var(--shop-sale-border, rgba(244, 63, 94, 0.42));
}

.confirm-stock-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.confirm-stock {
  font-size: 12px;
  color: var(--tg-hint);
  line-height: 1.3;
}

.confirm-stock.out { color: var(--admin-danger, #ef4444); }
.confirm-stock.low { color: #f59e0b; }
.confirm-stock.limit {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--surface, rgba(255, 255, 255, 0.06));
}

.confirm-marketing {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.confirm-marketing-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.3;
}

.confirm-marketing-badge {
  font-weight: 700;
  color: var(--shop-sale-text, #fecdd3);
  background: var(--shop-sale-soft, rgba(244, 63, 94, 0.16));
  border: 0.5px solid var(--shop-sale-border, rgba(244, 63, 94, 0.42));
}

.confirm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.confirm-tag {
  padding: 3px 8px;
  border-radius: 999px;
  border: 0.5px solid var(--border);
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--tg-hint);
  font-size: 12px;
  line-height: 1.3;
}

.confirm-desc-wrap {
  margin: 0 0 14px;
  min-width: 0;
}

.confirm-desc {
  margin: 0;
  max-height: 10.5em;
  overflow: auto;
  font-size: 13px;
  line-height: 1.55;
  color: var(--tg-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-desc.expanded {
  max-height: min(42vh, 280px);
}

.confirm-desc.muted {
  margin: 0 0 14px;
  color: var(--tg-hint);
  max-height: none;
  overflow: visible;
}

.confirm-desc-toggle {
  margin-top: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--tg-btn, var(--tg-button, #2aabee));
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  line-height: 1.3;
}

.confirm-desc-toggle:hover {
  text-decoration: underline;
}

.confirm-desc-toggle:focus-visible {
  outline: 2px solid var(--tg-btn, var(--tg-button, #2aabee));
  outline-offset: 2px;
  border-radius: 4px;
}

.confirm-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.confirm-buy,
.confirm-copy {
  width: 100%;
  min-height: 42px;
  font-size: 15px;
  font-weight: 600;
}

.confirm-buy:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.confirm-copy {
  font-weight: 500;
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}

.confirm-fade-enter-active .confirm-sheet,
.confirm-fade-leave-active .confirm-sheet {
  transition: transform 0.2s ease;
}

.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}

.confirm-fade-enter-from .confirm-sheet,
.confirm-fade-leave-to .confirm-sheet {
  transform: translateY(12px);
}
</style>
