<template>
  <div class="landing-page">
    <header class="landing-hero">
      <h1 class="hero-title">🎯 Lucky Draw</h1>
      <p class="hero-subtitle">轻量抽奖 SaaS — 3 分钟创建活动，自动发奖，公平开奖</p>
      <div class="hero-actions">
        <RouterLink to="/admin/register" class="btn btn-primary btn-lg">免费注册</RouterLink>
        <RouterLink to="/admin/login" class="btn btn-ghost btn-lg">登录</RouterLink>
      </div>
    </header>

    <section class="landing-modes">
      <h2>四种游戏模式</h2>
      <div class="mode-grid">
        <div class="mode-card">
          <div class="mode-icon">🎰</div>
          <h3>大转盘</h3>
          <p>公开抽奖，旋转指针，悬念感十足</p>
        </div>
        <div class="mode-card">
          <div class="mode-icon">🎫</div>
          <h3>刮刮卡</h3>
          <p>密码进入，刮开涂层，揭晓惊喜</p>
        </div>
        <div class="mode-card">
          <div class="mode-icon">🎲</div>
          <h3>老虎机</h3>
          <p>邀请码参与，三列滚动，逐列停止</p>
        </div>
        <div class="mode-card">
          <div class="mode-icon">🃏</div>
          <h3>卡片翻转</h3>
          <p>名单抽奖，翻牌揭晓，正式感强</p>
        </div>
      </div>
    </section>

    <section class="landing-features">
      <h2>产品特性</h2>
      <div class="feature-list">
        <div class="feature-item">
          <span class="feature-check">✓</span>
          <span>自动发码 — 中奖后自动发放卡密，邮件通知</span>
        </div>
        <div class="feature-item">
          <span class="feature-check">✓</span>
          <span>公平可验证 — 随机种子 hash，事后可验证</span>
        </div>
        <div class="feature-item">
          <span class="feature-check">✓</span>
          <span>多租户隔离 — 每个客户独立管理，互不干扰</span>
        </div>
        <div class="feature-item">
          <span class="feature-check">✓</span>
          <span>数据导出 — CSV 导出中奖名单，运营复盘</span>
        </div>
      </div>
    </section>

    <section class="landing-scenarios">
      <h2>适合场景</h2>
      <div class="scenario-tags">
        <span class="scenario-tag">社群运营</span>
        <span class="scenario-tag">门店促销</span>
        <span class="scenario-tag">企业年会</span>
        <span class="scenario-tag">课程福利</span>
        <span class="scenario-tag">粉丝抽奖</span>
        <span class="scenario-tag">展会活动</span>
      </div>
    </section>

    <footer class="landing-footer">
      <p>由 <a href="https://lucky.eforge.xyz">Lucky Draw</a> 提供抽奖工具</p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.landing-page { max-width: 800px; margin: 0 auto; padding: 40px 20px; text-align: center; }
.landing-hero { padding: 60px 0 40px; }
.hero-title { font-size: 36px; font-weight: 800; margin-bottom: 12px; }
.hero-subtitle { font-size: 16px; color: var(--tg-hint); margin-bottom: 24px; }
.hero-actions { display: flex; gap: 12px; justify-content: center; }
.btn-lg { padding: 12px 28px; font-size: 16px; border-radius: 10px; }
.landing-modes, .landing-features, .landing-scenarios { padding: 40px 0; }
.landing-modes h2, .landing-features h2, .landing-scenarios h2 { font-size: 22px; margin-bottom: 20px; }
.mode-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.mode-card { background: var(--tg-surface); border-radius: 12px; padding: 20px 12px; }
.mode-icon { font-size: 36px; margin-bottom: 8px; }
.mode-card h3 { font-size: 15px; margin-bottom: 4px; }
.mode-card p { font-size: 12px; color: var(--tg-hint); }
.feature-list { text-align: left; max-width: 500px; margin: 0 auto; }
.feature-item { display: flex; gap: 8px; padding: 8px 0; font-size: 14px; }
.feature-check { color: #10b981; font-weight: 700; }
.scenario-tags { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.scenario-tag { background: var(--tg-surface); padding: 6px 14px; border-radius: 20px; font-size: 13px; }
.landing-footer { padding: 40px 0 20px; font-size: 12px; color: var(--tg-hint); }
.landing-footer a { color: var(--tg-link); }

@media (max-width: 600px) {
  .mode-grid { grid-template-columns: repeat(2, 1fr); }
  .hero-title { font-size: 28px; }
}
</style>