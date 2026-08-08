<template>
  <div class="shop-page">
    <div v-if="loading" class="loading">{{ $t('lottery.marketLoading') }}</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else>
      <header class="shop-header">
        <h1>{{ store.name }}</h1>
        <p v-if="store.brand?.description" class="shop-desc">{{ store.brand.description }}</p>
      </header>
      <nav class="shop-tabs" role="tablist" aria-label="活动分类">
        <button v-for="tab in tabs" :key="tab.key" role="tab" :aria-selected="activeTab === tab.key" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
      </nav>
      <div v-if="filtered.length === 0" class="empty">{{ $t('lottery.marketEmptyTitle') }}</div>
      <section v-else class="activity-grid">
        <div v-for="card in filtered" :key="card.publicSlug" class="activity-card" @click="$router.push(`/lottery/${card.publicSlug}`)">
          <div class="card-head">
            <span class="badge" :class="card.activityKind">{{ kindLabel(card.activityKind) }}</span>
            <span v-if="card.flashSale?.paymentRequired" class="price">¥{{ (card.flashSale.priceCents / 100).toFixed(2) }}</span>
            <span v-else class="free-tag">{{ $t('lottery.marketFreePrice') }}</span>
          </div>
          <h3>{{ card.title }}</h3>
          <p class="card-time">{{ fmtDate(card.startAt) }} - {{ fmtDate(card.endAt) }}</p>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'

function fmtDate(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const route = useRoute()
const storeSlug = route.params.storeSlug as string
const loading = ref(true)
const error = ref('')
const activeTab = ref('all')
const store = ref<{ name: string; brand: any; storeSlug: string }>({ name: '', brand: {}, storeSlug: '' })
const activities = ref<any[]>([])

const tabs = [
  { key: 'all', label: '全部' },
  { key: 'claim', label: '限时抢购' },
  { key: 'lottery', label: '大转盘' },
  { key: 'survey', label: '问卷' },
]

const filtered = computed(() => {
  if (activeTab.value === 'all') return activities.value
  return activities.value.filter((a) => a.activityKind === activeTab.value)
})

function kindLabel(kind: string): string {
  const map: Record<string, string> = { lottery: '抽奖', claim: '抢购', survey: '问卷', signup_chain: '接龙', vote: '投票' }
  return map[kind] || kind
}

onMounted(async () => {
  try {
    const res = await fetch(`/api/public/shops/${storeSlug}`)
    if (!res.ok) throw new Error(res.status === 404 ? '店铺不存在' : '加载失败')
    const data = await res.json()
    store.value = data.store
    activities.value = data.activities || []
  } catch (e: any) {
    error.value = e.message
  } finally { loading.value = false }
})
</script>

<style scoped>
.shop-page { max-width: 960px; margin: 0 auto; padding: 24px; }
.shop-header { margin-bottom: 24px; }
.shop-desc { color: var(--muted); font-size: 14px; }
.shop-tabs { display: flex; gap: 8px; margin-bottom: 24px; }
.shop-tabs button { padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; }
.shop-tabs button.active { background: var(--primary); color: #fff; }
.activity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.activity-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; cursor: pointer; }
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.badge.claim { background: var(--danger); color: #fff; }
.badge.lottery { background: var(--primary); color: #fff; }
.price { font-weight: bold; color: var(--danger); }
.free-tag { color: var(--success); font-weight: bold; }
.card-time { font-size: 12px; color: var(--muted); }
</style>