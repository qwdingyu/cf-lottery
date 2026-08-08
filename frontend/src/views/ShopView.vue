<template>
  <div class="shop-view">
    <div class="shop-toolbar">
      <div class="shop-heading">
        <RouterLink to="/" class="shop-home-link">{{ $t('common.backToHome') }}</RouterLink>
        <h1 class="section-title">{{ store.name || $t('shop.title') }}</h1>
        <button class="btn btn-ghost btn-sm" @click="refresh" :disabled="loading">{{ loading ? $t('shop.loading') : $t('shop.refresh') }}</button>
      </div>
      <div class="category-bar" :aria-label="$t('landing.marketFilterAria')">
        <button v-for="tab in tabs" :key="tab.key" class="cat-btn" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">
          {{ tab.label }}<span class="cat-count">{{ tab.count }}</span>
        </button>
      </div>
    </div>
    <div v-if="loading" class="skeleton-grid" aria-busy="true">
      <div v-for="i in 4" :key="i" class="skeleton-card"><div class="skeleton skeleton-line w-70" /><div class="skeleton skeleton-line w-40" /></div>
    </div>
    <div v-else-if="error" class="empty-state" role="alert">
      <p>{{ error }}</p><button class="btn" @click="refresh">{{ $t('shop.refresh') }}</button>
    </div>
    <div v-else-if="cards.length === 0" class="empty-state">
      <p>{{ $t('landing.marketEmptyTitle') }}</p><small>{{ $t('landing.marketEmptyDesc') }}</small>
    </div>
    <section v-else class="product-grid">
      <div v-for="card in cards" :key="card.publicSlug" class="product-card" @click="$router.push(card.href)">
        <div class="card-head">
          <span class="badge" :class="card.paymentMode">{{ card.badge }}</span>
          <span class="price">{{ card.priceText }}</span>
        </div>
        <h3>{{ card.title }}</h3>
        <div v-if="card.progressPercent > 0" class="progress-bar"><div class="progress-fill" :style="{width: card.progressPercent + '%'}" /></div>
        <p class="card-meta">{{ card.sessionLabel || card.phase }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { buildLandingActivityCard, classifyLandingActivity } from '@/views/landing-activity-feed'

const { t } = useI18n()
const route = useRoute()
const slug = route.params.storeSlug as string
const loading = ref(true)
const error = ref('')
const activeTab = ref('all')
const store = ref<{ name: string }>({ name: '' })
const activities = ref<any[]>([])

const tabs = computed(() => {
  const all = activities.value
  return [
    { key: 'all', label: t('landing.marketFilterAll'), count: all.length },
    { key: 'flash', label: t('landing.marketFilterFlash'), count: all.filter((a: any) => classifyLandingActivity(a) === 'flash').length },
    { key: 'free', label: t('landing.marketFilterFree'), count: all.filter((a: any) => classifyLandingActivity(a) === 'free').length },
  ]
})

const cards = computed(() => {
  let list = activities.value
  if (activeTab.value === 'flash') list = list.filter((a: any) => classifyLandingActivity(a) === 'flash')
  if (activeTab.value === 'free') list = list.filter((a: any) => classifyLandingActivity(a) === 'free')
  return list.map((a: any) => buildLandingActivityCard(a, t('landing.marketFreePrice')))
})

async function refresh() {
  loading.value = true; error.value = ''
  try {
    const res = await fetch(`/api/public/shops/${slug}`)
    if (!res.ok) throw new Error(res.status === 404 ? '店铺不存在' : '加载失败')
    const data = await res.json()
    store.value = data.store
    activities.value = data.activities || []
  } catch (e: any) { error.value = e.message }
  finally { loading.value = false }
}

onMounted(refresh)
</script>

<style scoped>
.shop-view { max-width: 960px; margin: 0 auto; padding: 24px; }
.shop-toolbar { margin-bottom: 24px; }
.shop-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.shop-home-link { color: var(--primary); text-decoration: none; font-size: 14px; }
.shop-home-link:hover { text-decoration: underline; }
.section-title { margin: 0; }
.category-bar { display: flex; gap: 6px; }
.cat-btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; }
.cat-btn.active { background: var(--primary); color: #fff; }
.cat-count { font-size: 11px; margin-left: 4px; opacity: .7; }
.product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.product-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; cursor: pointer; }
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.badge.flash,.badge.direct{background:var(--danger);color:#fff}.badge.free,.badge.external{background:var(--success);color:#fff}
.price { font-weight: bold; }
.progress-bar { height: 4px; background: #eee; border-radius: 2px; margin: 8px 0; }
.progress-fill { height: 100%; background: var(--danger); border-radius: 2px; }
.card-meta { font-size: 12px; color: var(--muted); }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.skeleton-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.skeleton-line { height: 10px; background: #eee; border-radius: 4px; margin: 8px 0; }.w-70{width:70%}.w-40{width:40%}
.empty-state { text-align: center; padding: 48px; color: var(--muted); }
</style>