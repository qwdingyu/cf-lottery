<template>
  <div class="landing-page">
    <!-- 顶部导航 -->
    <nav class="landing-nav">
      <span class="nav-brand">{{ $t('landing.navBrand') }}</span>
      <RouterLink to="/admin/login" class="nav-link">{{ $t('landing.login') }}</RouterLink>
    </nav>

    <!-- Hero -->
    <header class="landing-hero">
      <h1 class="hero-title">{{ $t('landing.heroTitle1') }}<br>{{ $t('landing.heroTitle2') }}</h1>
      <p class="hero-subtitle">{{ $t('landing.heroSubtitle') }}</p>
      <div class="hero-actions">
        <RouterLink to="/admin/register" class="btn btn-primary btn-lg">{{ $t('landing.registerCta') }}</RouterLink>
        <RouterLink to="/lottery/demo" class="btn btn-ghost btn-lg">{{ $t('landing.viewDemo') }}</RouterLink>
        <p class="hero-note">{{ $t('landing.heroNote') }}</p>
      </div>
    </header>

    <!-- 创建流程 -->
    <section class="landing-section">
      <h2 class="section-title">{{ $t('landing.stepsTitle') }}</h2>
      <div class="steps-grid">
        <div class="step-card">
          <div class="step-number">1</div>
          <h3>{{ $t('landing.step1Title') }}</h3>
          <p>{{ $t('landing.step1Desc') }}</p>
        </div>
        <div class="step-card">
          <div class="step-number">2</div>
          <h3>{{ $t('landing.step2Title') }}</h3>
          <p>{{ $t('landing.step2Desc') }}</p>
        </div>
        <div class="step-card">
          <div class="step-number">3</div>
          <h3>{{ $t('landing.step3Title') }}</h3>
          <p>{{ $t('landing.step3Desc') }}</p>
        </div>
      </div>
    </section>

    <!-- 活动目标模板 -->
    <section class="landing-section landing-section-alt">
      <h2 class="section-title">{{ $t('landing.templatesTitle') }}</h2>
      <p class="section-desc">{{ $t('landing.templatesDesc') }}</p>
      <div class="mode-grid">
        <div class="mode-card">
          <div class="mode-preview wheel-preview">
            <div class="wheel-mini"></div>
          </div>
          <div class="mode-info">
            <h3>{{ $t('landing.modeLotteryTitle') }}</h3>
            <span class="mode-tag">{{ $t('landing.modeLotteryTag') }}</span>
            <p>{{ $t('landing.modeLotteryDesc') }}</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview scratch-preview">
            <div class="scratch-mini"></div>
          </div>
          <div class="mode-info">
            <h3>{{ $t('landing.modeSignupTitle') }}</h3>
            <span class="mode-tag">{{ $t('landing.modeSignupTag') }}</span>
            <p>{{ $t('landing.modeSignupDesc') }}</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview slot-preview">
            <div class="slot-mini"></div>
          </div>
          <div class="mode-info">
            <h3>{{ $t('landing.modeSurveyTitle') }}</h3>
            <span class="mode-tag">{{ $t('landing.modeSurveyTag') }}</span>
            <p>{{ $t('landing.modeSurveyDesc') }}</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview card-preview">
            <div class="card-mini"></div>
          </div>
          <div class="mode-info">
            <h3>{{ $t('landing.modeReviewTitle') }}</h3>
            <span class="mode-tag">{{ $t('landing.modeReviewTag') }}</span>
            <p>{{ $t('landing.modeReviewDesc') }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 核心能力 -->
    <section class="landing-section">
      <h2 class="section-title">{{ $t('landing.capabilityTitle') }}</h2>
      <div class="capability-grid">
        <div class="capability-item">
          <div class="capability-icon">1</div>
          <h3>{{ $t('landing.capQuickTitle') }}</h3>
          <p>{{ $t('landing.capQuickDesc') }}</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">2</div>
          <h3>{{ $t('landing.capReliableTitle') }}</h3>
          <p>{{ $t('landing.capReliableDesc') }}</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">3</div>
          <h3>{{ $t('landing.capReviewTitle') }}</h3>
          <p>{{ $t('landing.capReviewDesc') }}</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">4</div>
          <h3>{{ $t('landing.capFollowTitle') }}</h3>
          <p>{{ $t('landing.capFollowDesc') }}</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">5</div>
          <h3>{{ $t('landing.capIntegrateTitle') }}</h3>
          <p>{{ $t('landing.capIntegrateDesc') }}</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">6</div>
          <h3>{{ $t('landing.capManagedTitle') }}</h3>
          <p>{{ $t('landing.capManagedDesc') }}</p>
        </div>
      </div>
    </section>

    <!-- 适合场景 -->
    <section class="landing-section landing-section-alt">
      <h2 class="section-title">{{ $t('landing.scenarioTitle') }}</h2>
      <div class="scenario-grid">
        <div class="scenario-card">
          <div class="scenario-icon">📱</div>
          <h3>{{ $t('landing.scenarioCommunityTitle') }}</h3>
          <p>{{ $t('landing.scenarioCommunityDesc') }}</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🏪</div>
          <h3>{{ $t('landing.scenarioStoreTitle') }}</h3>
          <p>{{ $t('landing.scenarioStoreDesc') }}</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🎉</div>
          <h3>{{ $t('landing.scenarioAnnualTitle') }}</h3>
          <p>{{ $t('landing.scenarioAnnualDesc') }}</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">📚</div>
          <h3>{{ $t('landing.scenarioCourseTitle') }}</h3>
          <p>{{ $t('landing.scenarioCourseDesc') }}</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">⭐</div>
          <h3>{{ $t('landing.scenarioFanTitle') }}</h3>
          <p>{{ $t('landing.scenarioFanDesc') }}</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🎪</div>
          <h3>{{ $t('landing.scenarioExpoTitle') }}</h3>
          <p>{{ $t('landing.scenarioExpoDesc') }}</p>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="landing-cta">
      <h2>{{ $t('landing.ctaTitle') }}</h2>
      <p>{{ $t('landing.ctaDesc') }}</p>
      <RouterLink to="/admin/register" class="btn btn-primary btn-lg">{{ $t('landing.ctaButton') }}</RouterLink>
    </section>

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
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.landing-page { max-width: 960px; margin: 0 auto; padding: 0 20px; }
.landing-nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 0; }
.nav-brand { font-size: 18px; font-weight: 700; }
.nav-link { font-size: 14px; color: var(--tg-hint); text-decoration: none; }
.nav-link:hover { color: var(--tg-text); }
.landing-hero { text-align: center; padding: 80px 0 60px; }
.hero-badge { display: inline-block; background: rgba(245,158,11,.15); color: #f59e0b; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
.hero-title { font-size: 40px; font-weight: 800; line-height: 1.3; margin-bottom: 16px; }
.hero-subtitle { font-size: 17px; color: var(--tg-hint); max-width: 500px; margin: 0 auto 28px; }
.hero-actions { display: flex; gap: 12px; justify-content: center; margin-bottom: 16px; }
.hero-note { font-size: 13px; color: var(--tg-hint); }
.btn-lg { padding: 14px 32px; font-size: 16px; font-weight: 600; border-radius: 10px; }
.landing-section { padding: 80px 0; }
.landing-section-alt { background: rgba(255,255,255,.02); border-radius: 24px; margin: 0 -20px; padding: 80px 20px; }
.section-title { text-align: center; font-size: 28px; font-weight: 700; margin-bottom: 12px; }
.section-desc { text-align: center; color: var(--tg-hint); margin-bottom: 40px; font-size: 15px; }

/* 三步流程 */
.steps-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 40px; }
.step-card { text-align: center; }
.step-number { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; margin: 0 auto 12px; }
.step-card h3 { font-size: 17px; margin-bottom: 8px; }
.step-card p { font-size: 14px; color: var(--tg-hint); line-height: 1.6; }

/* 游戏模式 */
.mode-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 40px; }
.mode-card { background: var(--tg-surface); border-radius: 16px; overflow: hidden; transition: transform .2s; }
.mode-card:hover { transform: translateY(-2px); }
.mode-preview { height: 100px; display: flex; align-items: center; justify-content: center; }
.wheel-preview { background: linear-gradient(135deg, #fef3c7, #fde68a); }
.scratch-preview { background: linear-gradient(135deg, #e0e7ff, #c7d2fe); }
.slot-preview { background: linear-gradient(135deg, #fce7f3, #fbcfe8); }
.card-preview { background: linear-gradient(135deg, #d1fae5, #a7f3d0); }
.wheel-mini { width: 60px; height: 60px; border-radius: 50%; border: 4px solid #f59e0b; background: conic-gradient(#f43f5e 0 25%, #f59e0b 25% 50%, #10b981 50% 75%, #3b82f6 75% 100%); }
.scratch-mini { width: 80px; height: 50px; background: #94a3b8; border-radius: 8px; position: relative; }
.scratch-mini::after { content: '🎁'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 24px; }
.slot-mini { display: flex; gap: 4px; }
.slot-mini > * { width: 20px; height: 40px; background: #f59e0b; border-radius: 4px; }
.slot-mini::before { content: '7'; display: flex; align-items: center; justify-content: center; width: 20px; height: 40px; background: #f43f5e; border-radius: 4px; color: #fff; font-weight: 700; }
.slot-mini::after { content: '7'; display: flex; align-items: center; justify-content: center; width: 20px; height: 40px; background: #10b981; border-radius: 4px; color: #fff; font-weight: 700; }
.card-mini { width: 50px; height: 70px; background: linear-gradient(135deg, #6366f1, #4f46e5); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 20px; font-weight: 700; }
.mode-info { padding: 14px; }
.mode-info h3 { font-size: 15px; margin-bottom: 4px; }
.mode-tag { display: inline-block; font-size: 11px; background: rgba(245,158,11,.15); color: #f59e0b; padding: 2px 8px; border-radius: 10px; margin-bottom: 6px; }
.mode-info p { font-size: 12px; color: var(--tg-hint); line-height: 1.5; }

/* 核心能力 */
.capability-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-top: 40px; }
.capability-item { display: flex; gap: 16px; align-items: flex-start; }
.capability-icon { font-size: 28px; flex-shrink: 0; width: 48px; height: 48px; background: var(--tg-surface); border-radius: 12px; display: flex; align-items: center; justify-content: center; }
.capability-item h3 { font-size: 16px; margin-bottom: 4px; }
.capability-item p { font-size: 14px; color: var(--tg-hint); line-height: 1.6; }

/* 场景 */
.scenario-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 40px; }
.scenario-card { text-align: center; padding: 20px; background: var(--tg-surface); border-radius: 12px; }
.scenario-icon { font-size: 32px; margin-bottom: 8px; }
.scenario-card h3 { font-size: 15px; margin-bottom: 4px; }
.scenario-card p { font-size: 13px; color: var(--tg-hint); }

/* CTA */
.landing-cta { text-align: center; padding: 80px 0; }
.landing-cta h2 { font-size: 28px; margin-bottom: 8px; }
.landing-cta p { color: var(--tg-hint); margin-bottom: 24px; }

/* Footer */
.landing-footer { text-align: center; padding: 40px 0; border-top: 1px solid var(--tg-border); }
.footer-main { font-size: 13px; color: var(--tg-hint); }
.footer-dot { margin: 0 8px; }
.footer-main a { color: var(--tg-link); }

@media (max-width: 768px) {
  .hero-title { font-size: 28px; }
  .mode-grid { grid-template-columns: repeat(2, 1fr); }
  .steps-grid { grid-template-columns: 1fr; }
  .capability-grid { grid-template-columns: 1fr; }
  .scenario-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
