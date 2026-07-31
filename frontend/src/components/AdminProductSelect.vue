<template>
  <select
    v-model="model"
    :required="required"
    :disabled="disabled || loading"
    :aria-label="ariaLabel || t('adminProductSelect.search')"
  >
    <option value="">{{ resolvedPlaceholder }}</option>
    <option v-for="product in visibleProducts" :key="product.id" :value="product.id">
      {{ productOptionLabel(product) }}
    </option>
  </select>
</template>

<script setup lang="ts">
/**
 * 管理端商品下拉：根节点就是原生 select，吃 base.css / admin.css（.filters select、.modal-form select）主题，
 * 禁止页面再包一层自造下拉。无 unplugin 自动注册，调用方必须显式 import。
 *
 * 分页策略：
 * - 默认（无 fulfillmentMode）：与历史一致，只拉第 1 页 limit=100
 * - 有 fulfillmentMode（如抽奖 card）：API 每页最多 100，客户端再滤 mode，
 *   必须翻页拉全，否则库存商品落在第 2 页之后时下拉会「选不到奖品」
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchAdminProducts } from '@/api/admin'
import type { AdminProduct } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()

const model = defineModel<string>({ default: '' })

const props = withDefaults(defineProps<{
  /** 空选项文案；不传则用「全部商品」 */
  placeholder?: string
  required?: boolean
  disabled?: boolean
  ariaLabel?: string
  /**
   * 可选：只展示指定履约模式的商品（如抽奖仅支持 card）。
   * 在客户端过滤，避免改动商品列表 API；其它页面不传则行为不变。
   */
  fulfillmentMode?: string
}>(), {
  required: false,
  disabled: false,
})

const { token } = useAdminAuth()
const { showToast } = useToast()
const products = ref<AdminProduct[]>([])
const loading = ref(false)

/** 与后端 admin products 上限对齐（queryInt limit max 100） */
const PAGE_SIZE = 100
/** 防止异常超大目录把管理端打挂；50 页 = 5000 商品，够运营场景 */
const MAX_PAGES = 50

const resolvedPlaceholder = computed(() =>
  props.placeholder?.trim() ? props.placeholder : t('adminProductSelect.all'),
)

const visibleProducts = computed(() => {
  const mode = props.fulfillmentMode?.trim()
  if (!mode) return products.value
  return products.value.filter((p) => (p.fulfillmentMode || 'card') === mode)
})

function productOptionLabel(product: AdminProduct): string {
  const title = product.title || product.id
  // 与历史一致：标题（id）；仅在履约过滤场景（如抽奖 card）附带库存，便于运营核对名额
  if (props.fulfillmentMode && typeof product.stock === 'number') {
    return `${title}（${product.id} · ${product.stock} · ${productStorefrontLabel(product)}）`
  }
  return `${title}（${product.id}）`
}

function productStorefrontLabel(product: AdminProduct): string {
  // 抽奖创建页需要允许选择“未发布到商城但 active 的卡密商品”作为内部奖品。
  // 因此这里不按 storefront 过滤，只在选项文案里标注发布状态，帮助运营识别误发布风险。
  const storefronts = product.storefronts || []
  const published = storefronts.filter((entry) => entry.active !== false && entry.visible !== false)
  if (published.length === 0) return t('adminProductSelect.internalOnly')
  if (published.some((entry) => entry.isDefault === true)) return t('adminProductSelect.publishedDefault')
  return t('adminProductSelect.publishedCount', { count: published.length })
}

async function loadAllProductPages(extra?: { active?: string }): Promise<AdminProduct[]> {
  const collected: AdminProduct[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetchAdminProducts(token.value, {
      page,
      limit: PAGE_SIZE,
      ...(extra?.active ? { active: extra.active } : {}),
    })
    const batch = res.products || []
    collected.push(...batch)
    if (batch.length === 0 || collected.length >= (res.total ?? 0)) {
      return collected
    }
  }
  // 触顶仍未拉完：返回已有数据并提示，避免静默丢商品
  showToast(t('adminProductSelect.truncated'), 'error')
  return collected
}

async function loadProducts() {
  loading.value = true
  try {
    if (!props.fulfillmentMode?.trim()) {
      // 历史行为：单页 100，不做履约过滤的页面保持轻量
      const res = await fetchAdminProducts(token.value, { page: 1, limit: PAGE_SIZE })
      products.value = res.products || []
      return
    }
    // 履约过滤（抽奖等）：翻页拉全 + 仅上架，避免下架商品占选项、漏掉第 2 页起的 card 商品
    products.value = await loadAllProductPages({ active: 'true' })
  } catch {
    products.value = []
    showToast(t('adminProductSelect.noData'), 'error')
  } finally {
    loading.value = false
  }
}

onMounted(loadProducts)
</script>
