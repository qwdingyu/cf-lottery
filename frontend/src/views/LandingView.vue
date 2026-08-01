<template>
  <div class="landing-page">
    <!-- 顶部导航 -->
    <nav class="landing-nav">
      <span class="nav-brand">运营活动引擎</span>
      <RouterLink to="/admin/login" class="nav-link">登录</RouterLink>
    </nav>

    <!-- Hero -->
    <header class="landing-hero">
      <h1 class="hero-title">3 分钟搭建可复盘的活动<br>从参与到承接一步到位</h1>
      <p class="hero-subtitle">面向站长、社群运营和活动负责人，用模板、规则校验、二维码和数据复盘快速完成留资、发券、报名、抽奖和导流目标。</p>
      <div class="hero-actions">
        <RouterLink to="/admin/register" class="btn btn-primary btn-lg">免费注册，开始使用</RouterLink>
        <p class="hero-note">无需信用卡，先用免费套餐验证活动目标</p>
      </div>
    </header>

    <!-- 创建流程 -->
    <section class="landing-section">
      <h2 class="section-title">三步把活动跑起来</h2>
      <div class="steps-grid">
        <div class="step-card">
          <div class="step-number">1</div>
          <h3>选择活动目标</h3>
          <p>从福利抽奖、报名接龙、资料领取、问卷调研等模板开始，默认规则先帮你选好。</p>
        </div>
        <div class="step-card">
          <div class="step-number">2</div>
          <h3>确认规则并发布</h3>
          <p>校验资格、去重、容量、候补、码池和时间设置，减少活动开始后的人工补救。</p>
        </div>
        <div class="step-card">
          <div class="step-number">3</div>
          <h3>分享、复盘、承接</h3>
          <p>复制链接和二维码，跟踪浏览、参与、CTA、分享和外部转化，把结果继续导向下一步。</p>
        </div>
      </div>
    </section>

    <!-- 游戏模式 -->
    <section class="landing-section landing-section-alt">
      <h2 class="section-title">四种游戏模式，提升参与感</h2>
      <p class="section-desc">每种参与模式对应一种游戏交互，让等待不再枯燥</p>
      <div class="mode-grid">
        <div class="mode-card">
          <div class="mode-preview wheel-preview">
            <div class="wheel-mini"></div>
          </div>
          <div class="mode-info">
            <h3>🎰 大转盘</h3>
            <span class="mode-tag">公开抽奖</span>
            <p>旋转指针，悬念感十足。适合店铺促销、粉丝福利。</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview scratch-preview">
            <div class="scratch-mini"></div>
          </div>
          <div class="mode-info">
            <h3>🎫 刮刮卡</h3>
            <span class="mode-tag">密码进入</span>
            <p>刮开涂层，揭晓惊喜。适合社群活动、VIP 专属。</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview slot-preview">
            <div class="slot-mini"></div>
          </div>
          <div class="mode-info">
            <h3>🎲 老虎机</h3>
            <span class="mode-tag">邀请码</span>
            <p>三列滚动，逐列停止。适合招商引流、定向邀请。</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview card-preview">
            <div class="card-mini"></div>
          </div>
          <div class="mode-info">
            <h3>🃏 卡片翻转</h3>
            <span class="mode-tag">名单抽奖</span>
            <p>翻牌揭晓，正式感强。适合企业年会、班级抽奖。</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 核心能力 -->
    <section class="landing-section">
      <h2 class="section-title">不只抽奖，更是运营工具</h2>
      <div class="capability-grid">
        <div class="capability-item">
          <div class="capability-icon">📧</div>
          <h3>自动发码通知</h3>
          <p>中奖后自动从码池发放卡密，邮件通知中奖者，无需人工干预。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">🔐</div>
          <h3>公平可验证</h3>
          <p>开奖前记录随机种子 hash，开奖后可展示原始种子，参与者可自行验证。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">📊</div>
          <h3>数据导出</h3>
          <p>CSV 导出中奖名单和参与数据，支持运营复盘和效果分析。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">🏢</div>
          <h3>多租户隔离</h3>
          <p>每个客户独立管理自己的活动和数据，互不干扰，安全可靠。</p>
        </div>
      </div>
    </section>

    <!-- 适合场景 -->
    <section class="landing-section landing-section-alt">
      <h2 class="section-title">适合你的场景</h2>
      <div class="scenario-grid">
        <div class="scenario-card">
          <div class="scenario-icon">📱</div>
          <h3>社群运营</h3>
          <p>微信群抽奖，收集用户邮箱，自动发码</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🏪</div>
          <h3>门店促销</h3>
          <p>扫码参与抽奖，中奖核销，带动到店</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🎉</div>
          <h3>企业年会</h3>
          <p>名单抽奖，公平随机，大屏展示</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">📚</div>
          <h3>课程福利</h3>
          <p>学员福利抽奖，自动发放课程码</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">⭐</div>
          <h3>粉丝抽奖</h3>
          <p>博主粉丝福利，公平报告增强信任</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🎪</div>
          <h3>展会活动</h3>
          <p>现场扫码参与，大屏实时开奖</p>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="landing-cta">
      <h2>准备好了吗？</h2>
      <p>免费注册，3 分钟创建你的第一个抽奖活动</p>
      <RouterLink to="/admin/register" class="btn btn-primary btn-lg">免费注册</RouterLink>
    </section>

    <footer class="landing-footer">
      <div class="footer-main">
        <span>© 2026 Lucky Draw</span>
        <span class="footer-dot">·</span>
        <span>由 <a href="https://eforge.xyz">eforge.xyz</a> 提供</span>
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
