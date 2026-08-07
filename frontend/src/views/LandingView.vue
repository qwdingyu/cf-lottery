<template>
  <div class="landing-page">
    <nav class="landing-nav">
      <RouterLink to="/" class="nav-brand">{{ $t('landing.navBrand') }}</RouterLink>
      <div class="nav-actions">
        <template v-if="isLoggedIn">
          <RouterLink to="/admin" class="nav-link nav-link-primary">{{ $t('landing.enterAdmin') }}</RouterLink>
          <button type="button" class="nav-link" @click="handleLogout">{{ $t('landing.logout') }}</button>
        </template>
        <RouterLink v-else to="/admin/login" class="nav-link nav-link-primary">{{ $t('landing.login') }}</RouterLink>
      </div>
    </nav>

    <main>
      <section class="market-hero">
        <div class="market-hero-copy">
          <p class="market-eyebrow">{{ $t('landing.marketEyebrow') }}</p>
          <h1>{{ $t('landing.marketHeroTitle') }}</h1>
          <p class="market-subtitle">{{ $t('landing.marketHeroSubtitle') }}</p>
          <div class="market-actions">
            <a href="#public-activities" class="btn btn-primary btn-lg">{{ $t('landing.marketBrowseCta') }}</a>
            <RouterLink to="/admin/register" class="btn btn-ghost btn-lg">{{ $t('landing.registerCta') }}</RouterLink>
          </div>
          <dl class="market-stats" :aria-label="$t('landing.marketStatsAria')">
            <div>
              <dt>{{ publicCards.length }}</dt>
              <dd>{{ $t('landing.marketStatsPublic') }}</dd>
            </div>
            <div>
              <dt>{{ flashCards.length }}</dt>
              <dd>{{ $t('landing.marketStatsFlash') }}</dd>
            </div>
            <div>
              <dt>{{ freeCards.length }}</dt>
              <dd>{{ $t('landing.marketStatsFree') }}</dd>
            </div>
          </dl>
        </div>

        <aside class="market-panel" :aria-busy="activitiesLoading">
          <div class="market-panel-head">
            <span>{{ $t('landing.marketPanelTitle') }}</span>
            <button type="button" class="panel-refresh" :disabled="activitiesLoading" @click="loadHomeActivities">
              {{ activitiesLoading ? $t('landing.marketLoading') : $t('landing.marketRefresh') }}
            </button>
          </div>
          <div v-if="activitiesLoading" class="hero-skeleton-list" aria-hidden="true">
            <div v-for="i in 3" :key="i" class="hero-skeleton-item" />
          </div>
          <div v-else-if="featuredCards.length" class="featured-stack">
            <RouterLink
              v-for="card in featuredCards"
              :key="card.publicSlug"
              :to="card.href"
              class="featured-card"
            >
              <div class="featured-media" :class="{ 'featured-media-empty': !card.imageUrl }">
                <img v-if="card.imageUrl" :src="card.imageUrl" :alt="card.title" />
                <span v-else>{{ card.badge === 'flash' ? 'SALE' : 'FREE' }}</span>
              </div>
              <div class="featured-body">
                <div class="card-tags">
                  <span class="card-tag" :class="'card-tag-' + card.badge">
                    {{ card.badge === 'flash' ? $t('landing.marketFlashTag') : $t('landing.marketFreeTag') }}
                  </span>
                  <span class="card-tag card-tag-phase">{{ $t(activityPhaseI18nKey(card.phase)) }}</span>
                  <span class="card-tag card-tag-payment">{{ $t(paymentModeI18nKey(card.paymentMode)) }}</span>
                  <span class="card-tag">{{ $t(eligibilityModeI18nKey(card.eligibilityMode)) }}</span>
                  <span v-if="card.sessionLabel" class="card-tag">{{ card.sessionLabel }}</span>
                </div>
                <strong>{{ card.title }}</strong>
                <div class="featured-bottom">
                  <span class="card-price">{{ card.priceText }}</span>
                  <span v-if="card.remaining != null" class="card-stock">{{ $t('landing.marketRemaining', { n: card.remaining }) }}</span>
                </div>
              </div>
            </RouterLink>
          </div>
          <div v-else class="market-empty">
            <strong>{{ $t('landing.marketEmptyTitle') }}</strong>
            <p>{{ $t('landing.marketEmptyDesc') }}</p>
            <RouterLink to="/admin/register" class="btn btn-primary btn-sm">{{ $t('landing.ctaButton') }}</RouterLink>
          </div>
        </aside>
      </section>

      <section id="public-activities" class="activity-market">
        <div class="section-head">
          <div>
            <p class="market-eyebrow">{{ $t('landing.marketSectionEyebrow') }}</p>
            <h2>{{ $t('landing.marketSectionTitle') }}</h2>
            <p>{{ $t('landing.marketSectionDesc') }}</p>
          </div>
          <div class="activity-filters" role="tablist" :aria-label="$t('landing.marketFilterAria')">
            <button type="button" role="tab" :aria-selected="activityFilter === 'all'" :class="{ active: activityFilter === 'all' }" @click="activityFilter = 'all'">{{ $t('landing.marketFilterAll') }}</button>
            <button type="button" role="tab" :aria-selected="activityFilter === 'flash'" :class="{ active: activityFilter === 'flash' }" @click="activityFilter = 'flash'">{{ $t('landing.marketFilterFlash') }}</button>
            <button type="button" role="tab" :aria-selected="activityFilter === 'free'" :class="{ active: activityFilter === 'free' }" @click="activityFilter = 'free'">{{ $t('landing.marketFilterFree') }}</button>
          </div>
        </div>

        <div v-if="activitiesLoading" class="activity-grid" aria-hidden="true">
          <div v-for="i in 6" :key="i" class="activity-card activity-card-skeleton" />
        </div>
        <div v-else-if="activitiesError" class="market-error" role="alert">
          <span>{{ activitiesError }}</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="loadHomeActivities">{{ $t('landing.marketRetry') }}</button>
        </div>
        <div v-else-if="filteredCards.length" class="activity-grid">
          <RouterLink
            v-for="card in filteredCards"
            :key="card.publicSlug"
            :to="card.href"
            class="activity-card"
          >
            <div class="activity-media" :class="{ 'activity-media-empty': !card.imageUrl }">
              <img v-if="card.imageUrl" :src="card.imageUrl" :alt="card.title" />
              <span v-else>{{ card.badge === 'flash' ? 'SALE' : 'FREE' }}</span>
            </div>
            <div class="activity-body">
              <div class="card-tags">
                <span class="card-tag" :class="'card-tag-' + card.badge">
                  {{ card.badge === 'flash' ? $t('landing.marketFlashTag') : $t('landing.marketFreeTag') }}
                </span>
                <span class="card-tag card-tag-phase">{{ $t(activityPhaseI18nKey(card.phase)) }}</span>
                <span class="card-tag card-tag-payment">{{ $t(paymentModeI18nKey(card.paymentMode)) }}</span>
                <span class="card-tag">{{ $t(eligibilityModeI18nKey(card.eligibilityMode)) }}</span>
                <span v-if="card.sessionLabel" class="card-tag">{{ card.sessionLabel }}</span>
                <span v-if="card.remaining != null" class="card-tag">{{ $t('landing.marketRemaining', { n: card.remaining }) }}</span>
              </div>
              <h3>{{ card.title }}</h3>
              <p v-if="card.description">{{ card.description }}</p>
              <div v-if="card.badge === 'flash'" class="progress-row">
                <div class="progress-track" role="progressbar" :aria-valuenow="card.progressPercent" aria-valuemin="0" aria-valuemax="100">
                  <span :style="{ width: card.progressPercent + '%' }" />
                </div>
                <small>{{ $t('landing.marketClaimed', { n: card.progressPercent }) }}</small>
              </div>
              <div class="activity-bottom">
                <strong class="card-price">{{ card.priceText }}</strong>
                <span class="card-cta">{{ card.badge === 'flash' ? $t('landing.marketGrabCta') : $t('landing.marketJoinCta') }}</span>
              </div>
            </div>
          </RouterLink>
        </div>
        <div v-else class="market-empty market-empty-wide">
          <strong>{{ $t('landing.marketNoFilterTitle') }}</strong>
          <p>{{ $t('landing.marketNoFilterDesc') }}</p>
          <RouterLink to="/admin/register" class="btn btn-primary btn-sm">{{ $t('landing.ctaButton') }}</RouterLink>
        </div>
      </section>

      <section class="merchant-strip">
        <div>
          <p class="market-eyebrow">{{ $t('landing.merchantEyebrow') }}</p>
          <h2>{{ $t('landing.merchantTitle') }}</h2>
          <p>{{ $t('landing.merchantDesc') }}</p>
        </div>
        <div class="merchant-steps">
          <span>{{ $t('landing.merchantStep1') }}</span>
          <span>{{ $t('landing.merchantStep2') }}</span>
          <span>{{ $t('landing.merchantStep3') }}</span>
        </div>
      </section>

      <section class="landing-cta">
        <h2>{{ $t('landing.ctaTitle') }}</h2>
        <p>{{ $t('landing.ctaDesc') }}</p>
        <RouterLink to="/admin/register" class="btn btn-primary btn-lg">{{ $t('landing.ctaButton') }}</RouterLink>
      </section>
    </main>

    <footer class="landing-footer">
      <div class="footer-main">
        <span>{{ $t('landing.footerCopyright') }}</span>
        <span class="footer-dot">·</span>
        <span>{{ $t('landing.footerByPrefix') }} <a href="https://eforge.xyz">eforge.xyz</a>{{ $t('landing.footerBySuffix') }}</span>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@usethink/cf-admin-fe/composables'
import {
  activityPhaseI18nKey,
  buildLandingActivityCard,
  eligibilityModeI18nKey,
  paymentModeI18nKey,
  type LandingActivityCard,
  type LandingHomeActivity,
} from './landing-activity-feed'

const router = useRouter()
const { t } = useI18n()
const { isLoggedIn, clearToken } = useAdminAuth()
const { showToast } = useToast()

const activitiesLoading = ref(false)
const activitiesError = ref('')
const homeActivities = ref<LandingHomeActivity[]>([])
const activityFilter = ref<'all' | 'flash' | 'free'>('all')

const publicCards = computed<LandingActivityCard[]>(() =>
  homeActivities.value.map((activity) => buildLandingActivityCard(activity, t('landing.marketFreePrice'))),
)
const flashCards = computed(() => publicCards.value.filter((card) => card.badge === 'flash'))
const freeCards = computed(() => publicCards.value.filter((card) => card.badge === 'free'))
const featuredCards = computed(() => publicCards.value.slice(0, 3))
const filteredCards = computed(() => {
  if (activityFilter.value === 'flash') return flashCards.value
  if (activityFilter.value === 'free') return freeCards.value
  return publicCards.value
})

async function loadHomeActivities() {
  activitiesLoading.value = true
  activitiesError.value = ''
  try {
    const res = await fetch('/api/public/home-activities?limit=12', { credentials: 'same-origin' })
    const body = await res.json().catch(() => null) as { ok?: boolean; activities?: LandingHomeActivity[]; message?: string } | null
    if (!res.ok || !body?.ok) {
      activitiesError.value = body?.message || t('landing.marketLoadFailed')
      return
    }
    homeActivities.value = Array.isArray(body.activities) ? body.activities : []
  } catch {
    activitiesError.value = t('landing.marketLoadFailed')
  } finally {
    activitiesLoading.value = false
  }
}

/** 首页退出：完整业务会话（admin + 参与 + cf-auth 临时键） */
function handleLogout() {
  clearToken()
  showToast(t('landing.loggedOut'), 'success')
  void router.replace('/')
}

onMounted(() => {
  void loadHomeActivities()
})
</script>

<style scoped>
.landing-page {
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  color: var(--tg-text);
}
.landing-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 64px;
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--tg-bg, #0a0e17) 94%, transparent);
  backdrop-filter: blur(10px);
}
.nav-brand,
.nav-link {
  color: inherit;
  text-decoration: none;
}
.nav-brand {
  font-size: 18px;
  font-weight: 800;
}
.nav-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.nav-link {
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 8px;
  background: transparent;
  color: var(--tg-hint);
  cursor: pointer;
  font-family: inherit;
}
.nav-link-primary {
  color: #0f172a;
  border-color: transparent;
  background: #fbbf24;
  font-weight: 700;
}
.market-hero {
  min-height: calc(100dvh - 88px);
  display: grid;
  grid-template-columns: minmax(0, .94fr) minmax(420px, 1fr);
  gap: 32px;
  align-items: center;
  padding: 24px 0 36px;
}
.market-hero-copy h1 {
  margin: 0;
  max-width: 720px;
  font-size: clamp(38px, 6vw, 72px);
  line-height: .98;
  letter-spacing: 0;
}
.market-eyebrow {
  margin: 0 0 12px;
  color: #fbbf24;
  font-size: 13px;
  font-weight: 800;
}
.market-subtitle {
  margin: 18px 0 0;
  max-width: 610px;
  color: var(--tg-hint);
  font-size: 17px;
  line-height: 1.65;
}
.market-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}
.btn-lg {
  min-height: 48px;
  padding: 13px 24px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  font-weight: 800;
}
.market-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 30px 0 0;
  max-width: 520px;
}
.market-stats div {
  padding: 14px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px;
  background: rgba(255,255,255,.04);
}
.market-stats dt {
  font-size: 26px;
  font-weight: 900;
}
.market-stats dd {
  margin: 2px 0 0;
  color: var(--tg-hint);
  font-size: 12px;
}
.market-panel,
.activity-market,
.merchant-strip,
.landing-cta {
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px;
  background: rgba(255,255,255,.04);
}
.market-panel {
  padding: 16px;
}
.market-panel-head,
.section-head,
.activity-bottom,
.featured-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.market-panel-head {
  margin-bottom: 12px;
  color: rgba(255,255,255,.82);
  font-weight: 800;
}
.panel-refresh,
.activity-filters button {
  min-height: 36px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 8px;
  background: rgba(255,255,255,.04);
  color: var(--tg-hint);
  cursor: pointer;
}
.panel-refresh {
  padding: 0 10px;
}
.featured-stack {
  display: grid;
  gap: 10px;
}
.featured-card {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 12px;
  padding: 10px;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  background: rgba(0,0,0,.18);
  border: 1px solid rgba(255,255,255,.08);
}
.featured-card:hover,
.activity-card:hover {
  border-color: rgba(251,191,36,.5);
  transform: translateY(-1px);
}
.featured-media,
.activity-media {
  overflow: hidden;
  border-radius: 8px;
  background: rgba(255,255,255,.08);
}
.featured-media {
  aspect-ratio: 1 / 1;
}
.featured-media img,
.activity-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.featured-media-empty,
.activity-media-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255,255,255,.72);
  font-weight: 900;
  letter-spacing: .08em;
}
.featured-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
}
.featured-body strong,
.activity-body h3 {
  overflow-wrap: anywhere;
}
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.card-tag {
  min-height: 22px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,.08);
  color: var(--tg-hint);
  font-size: 12px;
}
.card-tag-flash {
  color: #fecdd3;
  background: rgba(244,63,94,.2);
}
.card-tag-free {
  color: #bbf7d0;
  background: rgba(34,197,94,.16);
}
.card-tag-payment {
  color: #fde68a;
  background: rgba(251,191,36,.14);
}
.card-tag-phase {
  color: #bfdbfe;
  background: rgba(59,130,246,.16);
}
.card-price {
  color: #fb7185;
  font-size: 22px;
  font-weight: 900;
}
.card-stock {
  color: var(--tg-hint);
  font-size: 12px;
}
.market-empty,
.market-error {
  padding: 22px;
  border-radius: 8px;
  background: rgba(0,0,0,.16);
  color: var(--tg-hint);
}
.market-empty strong {
  display: block;
  margin-bottom: 6px;
  color: rgba(255,255,255,.86);
}
.market-empty p {
  margin: 0 0 14px;
}
.hero-skeleton-list,
.activity-grid {
  display: grid;
  gap: 14px;
}
.hero-skeleton-item,
.activity-card-skeleton {
  min-height: 116px;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.12), rgba(255,255,255,.05));
  background-size: 200% 100%;
  animation: marketShimmer 1.2s linear infinite;
}
.activity-market {
  padding: 24px;
  margin-top: 18px;
}
.section-head {
  align-items: flex-end;
  margin-bottom: 20px;
}
.section-head h2 {
  margin: 0;
  font-size: 28px;
}
.section-head p:not(.market-eyebrow) {
  margin: 8px 0 0;
  color: var(--tg-hint);
}
.activity-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.activity-filters button {
  padding: 0 12px;
}
.activity-filters button.active {
  color: #0f172a;
  background: #fbbf24;
  border-color: transparent;
  font-weight: 800;
}
.activity-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.activity-card {
  min-width: 0;
  border-radius: 8px;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  border: 1px solid rgba(255,255,255,.1);
  background: rgba(0,0,0,.18);
  transition: transform .18s ease, border-color .18s ease;
}
.activity-media {
  aspect-ratio: 4 / 3;
  border-radius: 0;
}
.activity-body {
  padding: 14px;
}
.activity-body h3 {
  margin: 10px 0 6px;
  font-size: 17px;
  line-height: 1.35;
}
.activity-body p {
  min-height: 40px;
  margin: 0 0 12px;
  color: var(--tg-hint);
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.progress-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: center;
  margin: 8px 0 14px;
}
.progress-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(251,113,133,.18);
  overflow: hidden;
}
.progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #fb7185, #f43f5e);
}
.progress-row small {
  color: #fecdd3;
  font-size: 12px;
}
.card-cta {
  min-height: 34px;
  padding: 7px 12px;
  border-radius: 8px;
  color: #0f172a;
  background: #fbbf24;
  font-size: 13px;
  font-weight: 900;
  white-space: nowrap;
}
.market-empty-wide {
  text-align: center;
}
.merchant-strip {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, .9fr);
  gap: 24px;
  align-items: center;
  margin-top: 18px;
  padding: 24px;
}
.merchant-strip h2,
.landing-cta h2 {
  margin: 0;
  font-size: 28px;
}
.merchant-strip p:not(.market-eyebrow),
.landing-cta p {
  margin: 10px 0 0;
  color: var(--tg-hint);
  line-height: 1.6;
}
.merchant-steps {
  display: grid;
  gap: 10px;
}
.merchant-steps span {
  padding: 12px 14px;
  border-radius: 8px;
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.82);
  font-weight: 700;
}
.landing-cta {
  margin-top: 18px;
  padding: 34px 24px;
  text-align: center;
}
.landing-cta .btn {
  margin-top: 20px;
}
.landing-footer {
  padding: 34px 0;
  text-align: center;
}
.footer-main {
  color: var(--tg-hint);
  font-size: 13px;
}
.footer-dot {
  margin: 0 8px;
}
.footer-main a {
  color: var(--tg-link);
}

@keyframes marketShimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

@media (max-width: 920px) {
  .market-hero,
  .merchant-strip {
    grid-template-columns: 1fr;
  }
  .market-hero {
    min-height: auto;
    padding-top: 40px;
  }
  .activity-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .landing-page {
    width: min(100% - 20px, 1180px);
  }
  .market-hero-copy h1 {
    font-size: 36px;
  }
  .market-actions,
  .section-head,
  .activity-bottom {
    align-items: stretch;
    flex-direction: column;
  }
  .market-actions .btn,
  .activity-filters button {
    width: 100%;
  }
  .market-stats {
    grid-template-columns: 1fr;
  }
  .featured-card {
    grid-template-columns: 82px 1fr;
  }
  .activity-market,
  .merchant-strip {
    padding: 16px;
  }
  .activity-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero-skeleton-item,
  .activity-card-skeleton {
    animation: none;
  }
  .featured-card:hover,
  .activity-card:hover {
    transform: none;
  }
}
</style>
