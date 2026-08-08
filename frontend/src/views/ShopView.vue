<template>
  <div class="shop-page">
    <div v-if="loading" class="loading">{{ $t('lottery.marketLoading') }}</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else>
      <header class="shop-header">
        <h1>{{ store.name }}</h1>
        <p v-if="store.brand?.description">{{ store.brand.description }}</p>
      </header>
      <div v-if="activities.length === 0" class="empty">{{ $t('lottery.marketEmptyTitle') }}</div>
      <section v-else class="activity-grid">
        <div v-for="card in activities" 
             :key="card.publicSlug" 
             class="activity-card"
             @click="$router.push(`/lottery/${card.publicSlug}`)"
        >
          <h3>{{ card.title }}</h3>
          <p v-if="card.flashSale?.paymentRequired">
            <span class="price">{{ card.flashSale.priceCents ? `¥${(card.flashSale.priceCents / 100).toFixed(2)}` : '' }}</span>
          </p>
          <span class="tag">{{ card.activityKind }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const storeSlug = route.params.storeSlug as string
const loading = ref(true)
const error = ref('')
const store = ref<{ name: string; brand: any; storeSlug: string }>({ name: '', brand: {}, storeSlug: '' })
const activities = ref<any[]>([])

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
.shop-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
.shop-header { margin-bottom: 32px; }
.activity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.activity-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; cursor: pointer; }
.activity-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
.tag { font-size: 12px; color: var(--muted); }
.price { font-weight: bold; color: var(--danger); }
</style>