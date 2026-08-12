<template>
  <div class="shop-view">
    <!-- ═══ 店铺头部工具栏 ═══ -->
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

    <!-- ═══ 秒杀英雄横幅（docs/205）：仅当有秒杀活动时展示 ═══ -->
    <div v-if="flashBanner" class="shop-flash-hero" @click="$router.push(flashBanner.href)">
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
    <div v-if="loading" class="skeleton-grid" aria-busy="true">
      <div v-for="i in 4" :key="i" class="skeleton-card">
        <div class="skeleton skeleton-line w-70" />
        <div class="skeleton skeleton-line w-40" />
        <div class="skeleton skeleton-line w-30" />
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

    <!-- ═══ 活动卡片网格 ═══ -->
    <section v-else class="product-grid">
      <div
        v-for="card in cards"
        :key="card.publicSlug"
        class="product-card"
        :class="{ 'card-flash': card.flashSaleEnabled }"
        @click="$router.push(card.href)"
      >
        <!-- ── 秒杀 Ribbon ── -->
        <div v-if="card.flashSaleEnabled" class="flash-ribbon">
          <span class="ribbon-icon">⚡</span>
          <span class="ribbon-text">{{ $t('shop.flashTag') }}</span>
        </div>

        <!-- ── 卡片头部：标签 + 价格 ── -->
        <div class="card-head">
          <span class="badge" :class="card.badge">{{ card.badge === 'flash' ? $t('shop.flashTag') : $t('shop.freeTag') }}</span>
          <span class="price" :class="{ 'price-flash': card.flashSaleEnabled }">{{ card.priceText }}</span>
        </div>

        <!-- ── 标题 ── -->
        <h3 class="card-title">{{ card.title }}</h3>
        <p v-if="card.description" class="card-desc">{{ card.description }}</p>

        <!-- ── 秒杀特有：倒计时 + 进度 + 库存 + 抢购按钮 ── -->
        <template v-if="card.flashSaleEnabled">
          <!-- 场次标签 -->
          <div v-if="card.sessionLabel" class="flash-session-row">
            <span class="flash-session-tag">{{ card.sessionLabel }}</span>
          </div>

          <!-- 倒计时 -->
          <div v-if="card.showCountdown" class="flash-countdown-row">
            <span class="flash-cd-label">
              {{ cardPhase(card) === 'upcoming' ? $t('shop.countdownStartIn') : cardPhase(card) === 'ended' ? $t('shop.countdownEnded') : $t('shop.countdownEndIn') }}
            </span>
            <span
              class="flash-cd-digits"
              :class="{ 'cd-urgent': cardUrgent(card), 'cd-ended': cardPhase(card) === 'ended' }"
            >
              {{ flashCountdown(card) }}
            </span>
          </div>

          <!-- 进度条 -->
          <div v-if="card.showProgress && card.progressPercent > 0" class="flash-progress-wrap">
            <div class="flash-progress-track" role="progressbar" :aria-valuenow="card.progressPercent" aria-valuemin="0" aria-valuemax="100">
              <div class="flash-progress-fill" :style="{ width: card.progressPercent + '%' }" />
            </div>
            <span class="flash-progress-label">{{ $t('shop.grabedPercent', { n: card.progressPercent }) }}</span>
          </div>

          <!-- 库存 -->
          <p v-if="card.showStock && card.remaining != null" class="flash-stock">
            {{ $t('shop.remaining', { n: card.remaining }) }}
          </p>

          <!-- 抢购/查看按钮 -->
          <div class="flash-cta-row">
            <button
              type="button"
              class="flash-grab-btn"
              :class="{ 'flash-grab-soldout': card.phase === 'ended' || (card.remaining != null && card.remaining <= 0) }"
              @click.stop="$router.push(card.href)"
            >
              {{ card.phase === 'ended' || (card.remaining != null && card.remaining <= 0) ? $t('shop.soldOut') : $t('shop.flashCta') }}
            </button>
          </div>
        </template>

        <!-- ── 非秒杀：简洁信息 ── -->
        <template v-else>
          <div class="card-meta-row">
            <span v-if="card.endAt" class="card-meta">{{ $t('shop.endsAt', { time: formatEndTime(card.endAt) }) }}</span>
            <span v-if="card.phase === 'upcoming' && card.startAt" class="card-meta">{{ $t('shop.startsAt', { time: formatEndTime(card.startAt) }) }}</span>
            <span v-else class="card-meta">{{ card.sessionLabel || $t(activityPhaseI18nKey(card.phase)) }}</span>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { buildLandingActivityCard, classifyLandingActivity, activityPhaseI18nKey } from '@/views/landing-activity-feed'
import { formatCountdown, formatEndTime } from '@/views/shop/countdown'
import type { LandingActivityCard } from '@/views/landing-activity-feed'

const { t } = useI18n()
const route = useRoute()
const slug = route.params.storeSlug as string
const loading = ref(true)
const error = ref('')
const activeTab = ref('all')
const store = ref<{ name: string }>({ name: '' })
const activities = ref<any[]>([])

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
    { key: 'flash', label: t('landing.marketFilterFlash'), count: all.filter((a: any) => classifyLandingActivity(a) === 'flash').length },
    { key: 'free', label: t('landing.marketFilterFree'), count: all.filter((a: any) => classifyLandingActivity(a) === 'free').length },
  ]
})

/**
 * 卡片排序：秒杀运行中（最早结束优先）→ 秒杀即将开始 → 免费。
 * 让「最紧急」的秒杀排在最前面，塑造紧迫感促进转化。
 */
const cards = computed(() => {
  let list = activities.value
  if (activeTab.value === 'flash') list = list.filter((a: any) => classifyLandingActivity(a) === 'flash')
  if (activeTab.value === 'free') list = list.filter((a: any) => classifyLandingActivity(a) === 'free')

  const mapped = list.map((a: any) => buildLandingActivityCard(a, t('landing.marketFreePrice')))
  const now = nowMs.value

  mapped.sort((a: LandingActivityCard, b: LandingActivityCard) => {
    // 秒杀优先于免费
    if (a.flashSaleEnabled !== b.flashSaleEnabled) return a.flashSaleEnabled ? -1 : 1

    // 同类型：运行中 > 即将开始 > 已结束
    const phaseA = resolvePhase(a, now)
    const phaseB = resolvePhase(b, now)
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

// ── 秒杀英雄横幅（取最紧急的秒杀活动） ──
const flashBanner = computed(() => {
  const runningFlash = cards.value.filter((c) => c.flashSaleEnabled && resolvePhase(c, nowMs.value) === 'running')
  const upcomingFlash = cards.value.filter((c) => c.flashSaleEnabled && resolvePhase(c, nowMs.value) === 'upcoming')
  if (runningFlash.length === 0 && upcomingFlash.length === 0) return null
  const target = runningFlash.length > 0 ? runningFlash[0] : upcomingFlash[0]
  return { href: target.href }
})

const flashBannerSub = computed(() => {
  const running = cards.value.filter((c) => c.flashSaleEnabled && resolvePhase(c, nowMs.value) === 'running').length
  const upcoming = cards.value.filter((c) => c.flashSaleEnabled && resolvePhase(c, nowMs.value) === 'upcoming').length
  const parts: string[] = []
  if (running > 0) parts.push(t('shop.flashBannerSub', { n: running }))
  if (upcoming > 0) parts.push(t('shop.flashBannerUpcoming', { n: upcoming }))
  return parts.join(' · ') || t('shop.flashBannerTitle')
})

function bannerTarget(): LandingActivityCard | null {
  if (!flashBanner.value) return null
  return cards.value.find((c) => c.href === flashBanner.value!.href) || null
}

const flashBannerLabel = computed(() => {
  const target = bannerTarget()
  if (!target) return ''
  const phase = resolvePhase(target, nowMs.value)
  if (phase === 'ended') return t('shop.countdownEnded')
  if (phase === 'upcoming') return t('shop.countdownStartIn')
  return t('shop.countdownEndIn')
})

const flashBannerDigits = computed(() => {
  const target = bannerTarget()
  if (!target) return ''
  return flashCountdown(target)
})

// ── 阶段 / 倒计时辅助函数 ──
function resolvePhase(card: LandingActivityCard, now: number): 'upcoming' | 'running' | 'ended' {
  const startMs = Date.parse(card.startAt)
  const endMs = Date.parse(card.endAt)
  if (Number.isFinite(startMs) && now < startMs) return 'upcoming'
  if (Number.isFinite(endMs) && now >= endMs) return 'ended'
  return 'running'
}

function cardPhase(card: LandingActivityCard): string {
  return resolvePhase(card, nowMs.value)
}

/** 剩余不足 5 分钟 → 紧急呼吸态，强化「手慢无」 */
function cardUrgent(card: LandingActivityCard): boolean {
  if (resolvePhase(card, nowMs.value) !== 'running') return false
  const endMs = Date.parse(card.endAt)
  if (!Number.isFinite(endMs)) return false
  return endMs - nowMs.value < 300_000
}

function flashCountdown(card: LandingActivityCard): string {
  const phase = resolvePhase(card, nowMs.value)
  if (phase === 'ended') return ''
  const targetMs = phase === 'upcoming' ? Date.parse(card.startAt) : Date.parse(card.endAt)
  if (!Number.isFinite(targetMs)) return ''
  const diff = targetMs - nowMs.value
  if (diff <= 0) return ''
  return formatCountdown(diff)
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

.shop-view { max-width: 960px; margin: 0 auto; padding: 24px; }

/* ── 工具栏 ── */
.shop-toolbar { margin-bottom: 24px; }
.shop-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
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

/* ── 卡片网格 ── */
.product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }

.product-card {
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 16px;
  cursor: pointer;
  background: var(--surface);
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}
.product-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

/* 秒杀卡片：玫红边框 + 渐变底 */
.product-card.card-flash {
  border-color: var(--shop-sale-border);
  background: linear-gradient(180deg, rgba(244, 63, 94, 0.06) 0%, var(--surface) 100%);
}
.product-card.card-flash:hover {
  border-color: var(--shop-sale-strong);
  box-shadow: 0 0 20px rgba(244, 63, 94, 0.15), var(--shadow-md);
}

/* ── 秒杀 Ribbon（右上角） ── */
.flash-ribbon {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 10px 3px 8px;
  border-radius: 0 var(--r-lg) 0 var(--r-md);
  background: linear-gradient(135deg, var(--shop-sale-strong), #be123c);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
  z-index: 1;
}
.ribbon-icon { font-size: 13px; }
.ribbon-text { text-transform: uppercase; letter-spacing: 0.5px; }

/* ── 卡片头部 ── */
.card-head { display: flex; justify-content: space-between; align-items: center; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.badge.flash{background:var(--danger);color:#fff}.badge.free{background:var(--success);color:#fff}
.price { font-weight: 700; font-size: 15px; }
.price-flash { color: var(--shop-sale-strong); font-size: 18px; }

/* ── 标题/描述 ── */
.card-title { margin: 0; font-size: 15px; line-height: 1.4; font-weight: 600; }
.card-desc { margin: 0; font-size: 12px; color: var(--tg-hint); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* ── 秒杀场次 ── */
.flash-session-row { margin: 0; }
.flash-session-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  color: var(--shop-sale-text);
  background: var(--shop-sale-soft);
  border: 1px solid var(--shop-sale-border);
  border-radius: 4px;
  padding: 2px 8px;
}

/* ── 倒计时行 ── */
.flash-countdown-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
  background: var(--danger);
  border-color: var(--danger);
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
}
.flash-progress-track { flex: 1; height: 6px; border-radius: 999px; background: var(--shop-sale-soft); overflow: hidden; }
.flash-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--shop-sale), var(--shop-sale-strong)); transition: width 0.3s ease; }
.flash-progress-label { font-size: 11px; color: var(--tg-hint); white-space: nowrap; }

/* ── 库存文字 ── */
.flash-stock { margin: 0; font-size: 13px; color: var(--shop-sale); text-align: center; font-weight: 600; }

/* ── 抢购按钮 ── */
.flash-cta-row { margin-top: auto; }
.flash-grab-btn {
  width: 100%;
  min-height: 42px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, var(--shop-sale), var(--shop-sale-strong));
  color: #fff;
  font-size: 15px;
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
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.skeleton-card { border: 1px solid var(--border); border-radius: var(--r-lg); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.skeleton-line { height: 12px; background: linear-gradient(90deg, var(--surface) 25%, var(--surface-hover) 50%, var(--surface) 75%); background-size: 200% 100%; animation: shimmer 1.5s ease-in-out infinite; border-radius: var(--r-sm); }
.w-70{width:70%}.w-40{width:40%}.w-30{width:30%}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.empty-state { text-align: center; padding: 48px; color: var(--tg-hint); }

/* ── 响应式 ── */
@media (max-width: 640px) {
  .shop-view { padding: 16px; }
  .shop-flash-hero { flex-wrap: wrap; gap: 8px; }
  .flash-hero-countdown { width: 100%; flex-direction: row; align-items: center; justify-content: space-between; }
}
</style>
