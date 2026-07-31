<template>
  <!--
    交付信息展示组件，统一渲染卡密和虚拟资料两种模式的交付内容。
    被 OrderView、LookupView、PayModal 共用，消除重复的交付展示代码。
  -->
  <div v-if="hasDelivery" class="delivery-info">
    <!-- 卡密模式 -->
    <div v-if="showCardDelivery && delivery?.accountLabel" class="delivery-row">
      <span class="delivery-label">{{ $t('delivery.accountLabel') }}</span>
      <span class="delivery-value">{{ delivery.accountLabel }}</span>
      <button class="btn-copy" @click="copyText(delivery.accountLabel!, $event)" type="button">{{ $t('toast.copied') }}</button>
    </div>
    <div v-if="showCardDelivery && delivery?.deliverySecret" class="delivery-row">
      <span class="delivery-label">{{ $t('delivery.deliverySecret') }}</span>
      <span class="delivery-value">{{ delivery.deliverySecret }}</span>
      <button class="btn-copy" @click="copyText(delivery.deliverySecret!, $event)" type="button">{{ $t('toast.copied') }}</button>
    </div>

    <!-- 通用虚拟资料字段 -->
    <div v-for="[key, value] in deliveryEntries" :key="key" class="delivery-row">
      <span class="delivery-label">{{ fieldLabel(key) }}</span>
      <span class="delivery-value">{{ value }}</span>
      <button class="btn-copy" @click="copyText(value, $event)" type="button">{{ $t('toast.copied') }}</button>
    </div>

    <!-- 备注 -->
    <div v-if="showCardDelivery && delivery?.deliveryNote" class="delivery-row">
      <span class="delivery-label">{{ $t('delivery.deliveryNote') }}</span>
      <span class="delivery-value">{{ delivery.deliveryNote }}</span>
      <button class="btn-copy" @click="copyText(delivery.deliveryNote!, $event)" type="button">{{ $t('toast.copied') }}</button>
    </div>

    <!-- 卡密列表 -->
    <div v-for="(c, i) in normalizedCards" :key="c.id || i" class="delivery-row">
      <span class="delivery-label">{{ $t('delivery.cardData') }} #{{ i + 1 }}</span>
      <span class="delivery-value">{{ c.cardData }}</span>
      <button class="btn-copy" @click="copyText(c.cardData, $event)" type="button">{{ $t('toast.copied') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { copyText } from '@/composables/useClipboard'
import { fieldLabel, getDeliveryEntries } from '@/composables/useDeliveryDisplay'
import type { Delivery } from '@/types'

const props = defineProps<{
  delivery?: Delivery | null
  cards?: Array<{ id?: string; accountLabel?: string; deliverySecret?: string; deliveryNote?: string; cardData: string }> | null
  fulfillmentMode?: string
}>()

/** 是否有任何交付内容需要展示 */
const hasDelivery = computed(() => {
  if (props.delivery) {
    // 检查是否有任一字段有值
    const delivery = props.delivery as Record<string, unknown>
    for (const val of Object.values(delivery)) {
      if (val) return true
    }
  }
  if (props.cards && props.cards.length > 0) return true
  return false
})

const normalizedCards = computed(() => (props.cards || [])
  .map((card) => ({
    ...card,
    cardData: card.cardData || [card.accountLabel, card.deliverySecret].filter(Boolean).join(' / '),
  }))
  .filter((card) => Boolean(card.cardData)))

const isCardFulfillment = computed(() => props.fulfillmentMode === 'card' || normalizedCards.value.length > 0)
const showCardDelivery = computed(() => normalizedCards.value.length === 0 && isCardFulfillment.value)

/** 非卡密模式的交付字段条目（不含 accountLabel / deliverySecret / deliveryNote） */
const deliveryEntries = computed(() => getDeliveryEntries(
  props.delivery as Record<string, unknown> | undefined | null,
  { includeLegacyDeliveryFields: !isCardFulfillment.value },
))
</script>

<style scoped>
.delivery-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.delivery-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 14px;
}

.delivery-label {
  color: var(--tg-hint);
  flex-shrink: 0;
  min-width: 32px;
}

.delivery-value {
  font-family: var(--font-mono);
  font-weight: 500;
  word-break: break-all;
}

/* 复制按钮 */
.btn-copy {
  flex-shrink: 0;
  padding: 2px 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  transition: background var(--duration-fast) var(--ease-out);
}

.btn-copy:hover {
  background: var(--surface-hover);
}
</style>
