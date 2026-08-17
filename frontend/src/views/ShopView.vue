<template>
  <div class="shop-view">
    <!-- ═══ 店铺头部工具栏 ═══ -->
    <div class="shop-toolbar">
      <div class="shop-heading">
        <RouterLink to="/" class="shop-home-link">{{ $t('common.backToHome') }}</RouterLink>
        <div class="shop-title-block">
          <h1 class="section-title">{{ store.name || $t('shop.title') }}</h1>
          <span v-if="cards.length" class="shop-activity-count">{{ $t('shop.activityCount', { n: cards.length }) }}</span>
        </div>
        <button class="btn btn-ghost btn-sm" @click="refresh" :disabled="loading">{{ loading ? $t('shop.loading') : $t('shop.refresh') }}</button>
      </div>
      <div class="category-bar" :aria-label="$t('landing.marketFilterAria')">
        <button v-for="tab in tabs" :key="tab.key" class="cat-btn" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">
          {{ tab.label }}<span class="cat-count">{{ tab.count }}</span>
        </button>
      </div>
    </div>

    <!-- ═══ 秒杀英雄横幅（docs/205）：仅当有秒杀活动时展示 ═══ -->
    <div v-if="flashBanner" class="shop-flash-hero" role="button" tabindex="0" :aria-label="$t('shop.flashBannerTitle')" @click="$router.push(flashBanner.href)" @keydown.enter.prevent="$router.push(flashBanner.href)" @keydown.space.prevent="$router.push(flashBanner.href)">
      <div class="flash-hero-badge">⚡</div>
      <div class="flash-hero-body">
        <span class="flash-hero-title">{{ $t('shop.flashBannerTitle') }}</span>
        <span class="flash-hero-sub">{{ flashBannerSub }}</span>
      </div>
      <div class="flash-hero-countdown">
        <span class="flash-hero-label">{{ flashBannerLabel }}</span>
        <span class="flash-hero-digits">{{ flashBannerDigits }}</span>
      </div>
    </div>

    <!-- ═══ 加载 / 空态 / 错误 ═══ -->
    <div v-if="loading" class="skeleton-list" aria-busy="true">
      <div v-for="i in 3" :key="i" class="skeleton-row">
        <div class="skeleton-media" />
        <div class="skeleton-body">
          <div class="skeleton-line w-25" />
          <div class="skeleton-line w-70" />
          <div class="skeleton-line w-90" />
          <div class="skeleton-line w-45" />
        </div>
        <div class="skeleton-side">
          <div class="skeleton-line w-60" />
          <div class="skeleton-block" />
        </div>
      </div>
    </div>
    <div v-else-if="error" class="empty-state" role="alert">
      <p>{{ error }}</p>
      <button class="btn" @click="refresh">{{ $t('shop.refresh') }}</button>
    </div>
    <div v-else-if="cards.length === 0" class="empty-state">
      <p>{{ $t('landing.marketEmptyTitle') }}</p>
      <small>{{ $t('landing.marketEmptyDesc') }}</small>
    </div>

    <!-- ═══ 活动列表（横向一行一个） ═══ -->
    <section v-else class="shop-sections">
      <div v-if="flashCards.length" class="shop-section">
        <div class="shop-section-heading">
          <div>
            <h2>{{ $t('shop.flashSectionTitle') }}</h2>
            <p>{{ $t('shop.flashSectionDesc') }}</p>
          </div>
          <span class="section-count">{{ flashCards.length }}</span>
        </div>
        <div class="activity-list">
          <div
            v-for="card in flashCards"
            :key="card.publicSlug"
            class="activity-row activity-row-flash"
            role="link"
            tabindex="0"
            :aria-label="card.title"
            @click="$router.push(card.href)"
            @keydown.enter.prevent="$router.push(card.href)"
            @keydown.space.prevent="$router.push(card.href)"
          >
            <div class="activity-row-media" :class="{ 'activity-row-media-empty': !card.imageUrl }">
              <img v-if="card.imageUrl" :src="card.imageUrl" :alt="card.title" loading="lazy" />
              <span v-else>{{ $t('shop.activityPlaceholder') }}</span>
            </div>
            <div class="activity-row-body">
              <div class="card-tags">
                <span class="card-tag card-tag-flash">{{ $t('shop.flashTag') }}</span>
                <span class="card-tag card-tag-urgent">{{ card.phase === 'running' ? $t('shop.flashRush') : $t('shop.flashHurry') }}</span>
                <span class="card-tag card-tag-phase">{{ $t(activityPhaseI18nKey(card.phase)) }}</span>
                <span v-if="card.sessionLabel" class="card-tag">{{ card.sessionLabel }}</span>
                <span v-if="card.remaining != null" class="card-tag">{{ $t('shop.remaining', { n: card.remaining }) }}</span>
              </div>
              <h3 class="card-title">{{ card.title }}</h3>
              <p v-if="card.description" class="card-desc">{{ card.description }}</p>
              <div v-if="card.showCountdown" class="flash-countdown-row">
                <span class="flash-cd-label">
                  {{ card.phase === 'upcoming' ? $t('shop.countdownStartIn') : card.phase === 'ended' ? $t('shop.countdownEnded') : $t('shop.countdownEndIn') }}
                </span>
                <span
                  class="flash-cd-digits"
                  :class="{ 'cd-urgent': cardUrgent(card), 'cd-ended': card.phase === 'ended' }"
                >
                  {{ flashCountdown(card) }}
                </span>
              </div>
              <div v-if="card.showProgress && card.progressPercent > 0" class="flash-progress-wrap">
                <div class="flash-progress-track" role="progressbar" :aria-label="$t('shop.grabedPercent', { n: card.progressPercent })" :aria-valuenow="card.progressPercent" aria-valuemin="0" aria-valuemax="100">
                  <div class="flash-progress-fill" :style="{ width: card.progressPercent + '%' }" />
                </div>
                <span class="flash-progress-label">{{ $t('shop.grabedPercent', { n: card.progressPercent }) }}</span>
              </div>
            </div>
            <div class="activity-row-side">
              <div class="activity-row-price">
                <span class="price" :class="{ 'price-flash': card.flashSaleEnabled }">{{ card.priceText }}</span>
              </div>
              <button
                type="button"
                class="activity-row-btn flash-grab-btn"
                :class="{ 'flash-grab-soldout': card.phase === 'ended' || (card.remaining != null && card.remaining <= 0) }"
                @click.stop="$router.push(card.href)"
              >
                {{ card.phase === 'ended' || (card.remaining != null && card.remaining <= 0) ? $t('shop.soldOut') : $t('shop.flashCta') }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="freeCards.length" class="shop-section regular-section">
        <div class="shop-section-heading">
          <div>
            <h2>{{ $t('shop.otherSectionTitle') }}</h2>
            <p>{{ $t('shop.otherSectionDesc') }}</p>
          </div>
          <span class="section-count">{{ freeCards.length }}</span>
        </div>
        <div class="activity-list">
          <div
            v-for="card in freeCards"
            :key="card.publicSlug"
            class="activity-row"
            role="link"
            tabindex="0"
            :aria-label="card.title"
            @click="$router.push(card.href)"
            @keydown.enter.prevent="$router.push(card.href)"
            @keydown.space.prevent="$router.push(card.href)"
          >
            <div class="activity-row-media" :class="{ 'activity-row-media-empty': !card.imageUrl }">
              <img v-if="card.imageUrl" :src="card.imageUrl" :alt="card.title" loading="lazy" />
              <span v-else>{{ $t('shop.activityPlaceholder') }}</span>
            </div>
            <div class="activity-row-body">
              <div class="card-tags">
                <span class="card-tag card-tag-free">{{ $t('shop.freeTag') }}</span>
                <span class="card-tag card-tag-phase">{{ $t(activityPhaseI18nKey(card.phase)) }}</span>
                <span v-if="card.sessionLabel" class="card-tag">{{ card.sessionLabel }}</span>
              </div>
              <h3 class="card-title">{{ card.title }}</h3>
              <p v-if="card.description" class="card-desc">{{ card.description }}</p>
              <div class="card-meta-row">
                <span v-if="card.endAt" class="card-meta">{{ $t('shop.endsAt', { time: formatEndTime(card.endAt) }) }}</span>
                <span v-if="card.phase === 'upcoming' && card.startAt" class="card-meta">{{ $t('shop.startsAt', { time: formatEndTime(card.startAt) }) }}</span>
                <span v-else class="card-meta">{{ card.sessionLabel || $t(activityPhaseI18nKey(card.phase)) }}</span>
              </div>
            </div>
            <div class="activity-row-side">
              <div class="activity-row-price">
                <span class="price">{{ card.priceText }}</span>
              </div>
              <button type="button" class="activity-row-btn activity-row-btn-ghost" @click.stop="$router.push(card.href)">
                {{ $t('shop.viewActivity') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { buildLandingActivityCard, classifyLandingActivity, activityPhaseI18nKey, resolveLandingActivityPhase } from '@/views/landing-activity-feed'
import type { LandingActivityCard, LandingHomeActivity } from '@/views/landing-activity-feed'
import { formatCountdown, formatEndTime } from '@/views/shop/countdown'

/** 紧急态阈值：距结束不足 5 分钟 → 白字红底呼吸动画 */
const URGENT_THRESHOLD_MS = 5 * 60 * 1000

const { t } = useI18n()
const route = useRoute()
const slug = route.params.storeSlug as string
const loading = ref(true)
const error = ref('')
const activeTab = ref('all')
const store = ref<{ name: string }>({ name: '' })
const activities = ref<LandingHomeActivity[]>([])

// 统一倒计时时钟（每秒更新一次，驱动所有卡片的倒计时）
const nowMs = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  ticker = setInterval(() => { nowMs.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (ticker) clearInterval(ticker)
  ticker = null
})

// 分类标签
const tabs = computed(() => {
  const all = activities.value
  return [
    { key: 'all', label: t('landing.marketFilterAll'), count: all.length },
    { key: 'flash', label: t('landing.marketFilterFlash'), count: all.filter((a) => classifyLandingActivity(a) === 'flash').length },
    { key: 'free', label: t('landing.marketFilterFree'), count: all.filter((a) => classifyLandingActivity(a) === 'free').length },
  ]
})

/**
 * 卡片排序：秒杀（运行中→即将开始→已结束）整体排在免费前面，
 * 再按结束时间升序（越早结束越靠前，制造紧迫感）。让「最紧急」的秒杀排在最前。
 */
const cards = computed(() => {
  let list = activities.value
  if (activeTab.value === 'flash') list = list.filter((a) => classifyLandingActivity(a) === 'flash')
  if (activeTab.value === 'free') list = list.filter((a) => classifyLandingActivity(a) === 'free')

  const now = nowMs.value
  const mapped = list.map((a) => buildLandingActivityCard(a, t('landing.marketFreePrice'), now))

  mapped.sort((a: LandingActivityCard, b: LandingActivityCard) => {
    // 秒杀优先于免费
    if (a.flashSaleEnabled !== b.flashSaleEnabled) return a.flashSaleEnabled ? -1 : 1

    // 同类型：运行中 > 即将开始 > 已结束
    const phaseA = resolveLandingActivityPhase(a, now)
    const phaseB = resolveLandingActivityPhase(b, now)
    const order: Record<string, number> = { running: 0, upcoming: 1, ended: 2 }
    const diff = (order[phaseA] ?? 9) - (order[phaseB] ?? 9)
    if (diff !== 0) return diff

    // 同阶段：最快结束的优先
    const endA = Date.parse(a.endAt)
    const endB = Date.parse(b.endAt)
    if (Number.isFinite(endA) && Number.isFinite(endB)) return endA - endB
    return 0
  })

  return mapped
})

const flashCards = computed(() => cards.value.filter((card) => card.flashSaleEnabled))
const freeCards = computed(() => cards.value.filter((card) => !card.flashSaleEnabled))

// ── 秒杀英雄横幅（取最紧急的秒杀活动） ──
const flashBanner = computed<LandingActivityCard | null>(() => {
  const running = cards.value.find((c) => c.flashSaleEnabled && resolveLandingActivityPhase(c, nowMs.value) === 'running')
  if (running) return running
  return cards.value.find((c) => c.flashSaleEnabled && resolveLandingActivityPhase(c, nowMs.value) === 'upcoming') || null
})

/** 一次遍历统计秒杀活动数量，供横幅副标题使用 */
const flashBannerSub = computed(() => {
  let running = 0
  let upcoming = 0
  for (const c of cards.value) {
    if (!c.flashSaleEnabled) continue
    const phase = resolveLandingActivityPhase(c, nowMs.value)
    if (phase === 'running') running++
    else if (phase === 'upcoming') upcoming++
  }
  const parts: string[] = []
  if (running > 0) parts.push(t('shop.flashBannerSub', { n: running }))
  if (upcoming > 0) parts.push(t('shop.flashBannerUpcoming', { n: upcoming }))
  return parts.join(' · ') || t('shop.flashBannerTitle')
})

const flashBannerLabel = computed(() => {
  const target = flashBanner.value
  if (!target) return ''
  const phase = resolveLandingActivityPhase(target, nowMs.value)
  if (phase === 'ended') return t('shop.countdownEnded')
  if (phase === 'upcoming') return t('shop.countdownStartIn')
  return t('shop.countdownEndIn')
})

const flashBannerDigits = computed(() => {
  const target = flashBanner.value
  if (!target) return ''
  return flashCountdown(target)
})

// ── 辅助函数 ──

/** 剩余不足 5 分钟 → 紧急呼吸态，强化「手慢无」 */
function cardUrgent(card: LandingActivityCard): boolean {
  if (resolveLandingActivityPhase(card, nowMs.value) !== 'running') return false
  const endMs = Date.parse(card.endAt)
  if (!Number.isFinite(endMs)) return false
  return endMs - nowMs.value < URGENT_THRESHOLD_MS
}

function flashCountdown(card: LandingActivityCard): string {
  const phase = resolveLandingActivityPhase(card, nowMs.value)
  if (phase === 'ended') return ''
  const targetMs = phase === 'upcoming' ? Date.parse(card.startAt) : Date.parse(card.endAt)
  if (!Number.isFinite(targetMs)) return ''
  const diff = targetMs - nowMs.value
  if (diff <= 0) return ''
  return formatCountdown(diff, t('shop.day'))
}

async function refresh() {
  loading.value = true; error.value = ''
  try {
    const res = await fetch(`/api/public/shops/${slug}`)
    if (!res.ok) throw new Error(res.status === 404 ? t('shop.notFound') : t('shop.loadFailed'))
    const data = await res.json()
    store.value = data.store
    activities.value = data.activities || []
  } catch (e: any) { error.value = e.message }
  finally { loading.value = false }
}

onMounted(refresh)
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   店铺首页 — 秒杀化升级（docs/205）
   使用现有主题变量（--shop-sale* / --tg-* / --surface* / --border），不破坏全局样式。
   ══════════════════════════════════════════════════════════ */

.shop-view { max-width: 1120px; margin: 0 auto; padding: 24px; }

/* ── 工具栏 ── */
.shop-toolbar { margin-bottom: 24px; }
.shop-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.shop-title-block { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.shop-activity-count { color: var(--tg-hint); font-size: 12px; white-space: nowrap; }
.shop-home-link { color: var(--tg-link); text-decoration: none; font-size: 14px; }
.shop-home-link:hover { text-decoration: underline; }
.section-title { margin: 0; }
.category-bar { display: flex; gap: 6px; }
.cat-btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; color: var(--tg-hint); }
.cat-btn.active { background: var(--tg-btn); color: #fff; }
.cat-count { font-size: 11px; margin-left: 4px; opacity: .7; }

/* ── 秒杀英雄横幅 ── */
.shop-flash-hero {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding: 14px 18px;
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, var(--shop-sale-soft) 0%, rgba(244, 63, 94, 0.28) 100%);
  border: 1px solid var(--shop-sale-border);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.shop-flash-hero:hover {
  background: linear-gradient(135deg, rgba(244, 63, 94, 0.22) 0%, rgba(244, 63, 94, 0.35) 100%);
}
.shop-flash-hero:focus-visible {
  outline: 2px solid var(--shop-sale, #e11d48);
  outline-offset: 2px;
}
.flash-hero-badge {
  flex-shrink: 0;
  font-size: 28px;
  line-height: 1;
  animation: pulseBadge 2s ease-in-out infinite;
}
@keyframes pulseBadge {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.12); }
}
.flash-hero-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.flash-hero-title {
  font-weight: 700;
  font-size: 16px;
  color: var(--shop-sale-text);
}
.flash-hero-sub {
  font-size: 12px;
  color: var(--tg-hint);
}
.flash-hero-countdown {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.flash-hero-label {
  font-size: 11px;
  color: var(--tg-hint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.flash-hero-digits {
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  font-weight: 800;
  color: var(--shop-sale-strong);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

/* ── 横向促销列表 ── */
.shop-sections { display: flex; flex-direction: column; gap: 28px; }
.shop-section-heading { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.shop-section-heading h2 { margin: 0; font-size: 18px; line-height: 1.3; }
.shop-section-heading p { margin: 4px 0 0; color: var(--tg-hint); font-size: 12px; }
.section-count { min-width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: var(--shop-sale-soft); color: var(--shop-sale-strong); font-size: 12px; font-weight: 700; }
.regular-section .section-count { background: var(--surface-2); color: var(--tg-hint); }
.activity-list { display: flex; flex-direction: column; gap: 12px; }
.activity-row {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 172px;
  gap: 16px;
  align-items: stretch;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.activity-row:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.activity-row:focus-visible {
  outline: 2px solid var(--tg-link);
  outline-offset: 2px;
}
.activity-row-flash {
  border-color: var(--shop-sale-border);
  background: linear-gradient(180deg, rgba(244, 63, 94, 0.06) 0%, var(--surface) 100%);
}
.activity-row-flash:hover {
  border-color: var(--shop-sale-strong);
  box-shadow: 0 0 18px rgba(244, 63, 94, 0.12), var(--shadow-md);
}
.activity-row-media {
  width: 100%;
  min-height: 128px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 12px;
  background: var(--surface-2);
}
.activity-row-media img { width: 100%; height: 100%; object-fit: contain; }
.activity-row-media-empty { color: var(--tg-hint); font-size: 12px; }
.activity-row-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.activity-row-side {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  padding-left: 4px;
}
.activity-row-price { text-align: right; }
.activity-row-btn {
  min-width: 132px;
  width: 100%;
}
.activity-row-btn-ghost {
  min-height: 42px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
  color: var(--tg-text);
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.activity-row-btn-ghost:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
}

.card-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.card-tag {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--tg-hint);
  font-size: 12px;
  font-weight: 700;
}
.card-tag-flash { background: rgba(244, 63, 94, 0.14); color: var(--shop-sale-strong); }
.card-tag-urgent { background: rgba(239, 68, 68, 0.16); color: #f87171; }
.card-tag-free { background: rgba(34, 197, 94, 0.14); color: #22c55e; }
.card-tag-phase { background: rgba(59, 130, 246, 0.14); color: #60a5fa; }
.price { font-weight: 800; font-size: 24px; line-height: 1.1; }
.price-flash { color: var(--shop-sale-strong); font-size: 26px; }

/* ── 标题/描述 ── */
.card-title { margin: 0; font-size: 18px; line-height: 1.25; font-weight: 800; }
.card-desc { margin: 0; font-size: 13px; color: var(--tg-hint); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }

/* ── 倒计时行 ── */
.flash-countdown-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 2px;
}
.flash-cd-label {
  font-size: 12px;
  color: var(--tg-hint);
  white-space: nowrap;
}
.flash-cd-digits {
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 800;
  color: var(--shop-sale-strong);
  background: var(--shop-sale-soft);
  border: 1px solid var(--shop-sale-border);
  border-radius: 6px;
  padding: 2px 10px;
  letter-spacing: 1px;
  line-height: 1.5;
}
/* 紧急态：不足 5 分钟，白字红底呼吸 */
.flash-cd-digits.cd-urgent {
  color: #fff;
  background: var(--danger, #e11d48);
  border-color: var(--danger, #e11d48);
  animation: cdPulse 1s ease-in-out infinite;
}
.flash-cd-digits.cd-ended {
  color: var(--tg-hint);
  background: var(--surface-2);
  border-color: var(--border);
  animation: none;
}
@keyframes cdPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* ── 进度条 ── */
.flash-progress-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: -2px;
}
.flash-progress-track { flex: 1; height: 6px; border-radius: 999px; background: var(--shop-sale-soft); overflow: hidden; }
.flash-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--shop-sale), var(--shop-sale-strong)); transition: width 0.3s ease; }
.flash-progress-label { font-size: 11px; color: var(--tg-hint); white-space: nowrap; }

.flash-stock { margin: 0; font-size: 13px; color: var(--shop-sale); text-align: center; font-weight: 600; }

/* ── 抢购按钮 ── */
.flash-cta-row { margin-top: auto; }
.flash-grab-btn {
  min-height: 42px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, var(--shop-sale), var(--shop-sale-strong));
  color: #fff;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  letter-spacing: 0.5px;
}
.flash-grab-btn:hover {
  opacity: 0.92;
  transform: scale(1.02);
}
.flash-grab-btn:active {
  transform: scale(0.98);
}
.flash-grab-soldout {
  background: var(--surface-2);
  color: var(--tg-hint);
  cursor: default;
}
.flash-grab-soldout:hover {
  opacity: 1;
  transform: none;
}

/* ── 非秒杀元信息行 ── */
.card-meta-row { margin-top: auto; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.card-meta { font-size: 12px; color: var(--tg-hint); }

/* ── 骨架屏 / 空态 ── */
.skeleton-list { display: flex; flex-direction: column; gap: 12px; }
.skeleton-row {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 172px;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}
.skeleton-media,
.skeleton-block,
.skeleton-line {
  background: linear-gradient(90deg, var(--surface) 25%, var(--surface-hover) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
.skeleton-media { min-height: 160px; border-radius: 12px; }
.skeleton-body { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
.skeleton-side { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; gap: 12px; }
.skeleton-line { height: 12px; background: linear-gradient(90deg, var(--surface) 25%, var(--surface-hover) 50%, var(--surface) 75%); background-size: 200% 100%; border-radius: var(--r-sm); animation: shimmer 1.5s ease-in-out infinite; }
.skeleton-block { width: 132px; height: 42px; border-radius: var(--r-lg); }
.w-25{width:25%}.w-40{width:40%}.w-45{width:45%}.w-60{width:60%}.w-70{width:70%}.w-90{width:90%}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.empty-state { text-align: center; padding: 48px; color: var(--tg-hint); }

/* ── 响应式 ── */
@media (max-width: 640px) {
  .shop-view { padding: 16px; }
  .shop-heading { align-items: flex-start; flex-wrap: wrap; }
  .shop-title-block { flex: 1; }
  .category-bar { width: 100%; overflow-x: auto; padding-bottom: 2px; }
  .cat-btn { flex: 0 0 auto; }
  .shop-flash-hero { flex-wrap: wrap; gap: 8px; }
  .flash-hero-countdown { width: 100%; flex-direction: row; align-items: center; justify-content: space-between; }
  .activity-row { grid-template-columns: 92px minmax(0, 1fr); gap: 12px; }
  .activity-row-media { min-height: 84px; border-radius: var(--r-md); }
  .skeleton-row { grid-template-columns: 92px minmax(0, 1fr); gap: 12px; }
  .skeleton-media { min-height: 84px; border-radius: var(--r-md); }
  .skeleton-side {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
  }
  .activity-row-side {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
    padding-left: 0;
  }
  .activity-row-btn { min-width: 120px; width: auto; }
  .activity-row-price { text-align: left; }
  .price { font-size: 21px; }
  .card-title { font-size: 16px; }
}

/* ── 无障碍：减少动画 ── */
@media (prefers-reduced-motion: reduce) {
  .flash-hero-badge,
  .flash-cd-digits.cd-urgent,
  .skeleton-line,
  .skeleton-media,
  .skeleton-block,
  .activity-row { animation: none !important; transition: none !important; }
  .shop-flash-hero,
  .flash-grab-btn { transition: none !important; }
}
</style>
