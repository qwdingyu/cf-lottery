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

    <!-- 活动目标模板 -->
    <section class="landing-section landing-section-alt">
      <h2 class="section-title">按活动目标选择模板</h2>
      <p class="section-desc">抽奖、接龙、问卷只是入口，真正交付的是创建速度、规则确定性和后续承接。</p>
      <div class="mode-grid">
        <div class="mode-card">
          <div class="mode-preview wheel-preview">
            <div class="wheel-mini"></div>
          </div>
          <div class="mode-info">
            <h3>福利抽奖</h3>
            <span class="mode-tag">拉新 / 促活</span>
            <p>适合粉丝福利、门店活动、展会抽奖，重点是公平开奖、码池发放和结果复盘。</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview scratch-preview">
            <div class="scratch-mini"></div>
          </div>
          <div class="mode-info">
            <h3>报名接龙</h3>
            <span class="mode-tag">容量 / 候补</span>
            <p>适合课程、线下活动、社群报名，重点是名额顺序、满额候补和导出名单。</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview slot-preview">
            <div class="slot-mini"></div>
          </div>
          <div class="mode-info">
            <h3>资料领取 / 问卷</h3>
            <span class="mode-tag">留资 / 调研</span>
            <p>适合白皮书、课程资料、用户调研，重点是低摩擦提交和后续 CTA 承接。</p>
          </div>
        </div>
        <div class="mode-card">
          <div class="mode-preview card-preview">
            <div class="card-mini"></div>
          </div>
          <div class="mode-info">
            <h3>预约 / 审核</h3>
            <span class="mode-tag">筛选 / 确认</span>
            <p>适合体验课、内测资格、咨询预约，重点是资格确认、审核结果和候补转化。</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 核心能力 -->
    <section class="landing-section">
      <h2 class="section-title">客户真正买的是运营确定性</h2>
      <div class="capability-grid">
        <div class="capability-item">
          <div class="capability-icon">1</div>
          <h3>快速创建</h3>
          <p>模板、复制、二维码和默认规则，减少每次活动从零开始配置的时间。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">2</div>
          <h3>少出错</h3>
          <p>资格校验、去重、容量、候补、码池和 CAS 发放，降低重复发放和超额参与风险。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">3</div>
          <h3>能复盘</h3>
          <p>浏览、开始、完成、CTA、分享和外部转化回传，活动结束后能说清楚效果。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">4</div>
          <h3>能承接</h3>
          <p>中奖、候补、未中奖、提交成功后都能配置 CTA、资料、优惠或下一活动。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">5</div>
          <h3>能接系统</h3>
          <p>Webhook、API Key、导出和外部转化回传，让活动结果进入已有业务系统。</p>
        </div>
        <div class="capability-item">
          <div class="capability-icon">6</div>
          <h3>能托管运营</h3>
          <p>平台方能查看租户、套餐、用量、失败任务和异常，不靠直接查数据库救火。</p>
        </div>
      </div>
    </section>

    <!-- 适合场景 -->
    <section class="landing-section landing-section-alt">
      <h2 class="section-title">适合这些活动负责人</h2>
      <div class="scenario-grid">
        <div class="scenario-card">
          <div class="scenario-icon">📱</div>
          <h3>社群运营</h3>
          <p>微信群报名、福利领取、活动复盘</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🏪</div>
          <h3>门店促销</h3>
          <p>扫码参与、领券核销、带动到店</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🎉</div>
          <h3>企业年会</h3>
          <p>名单抽奖、签到报名、结果导出</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">📚</div>
          <h3>课程福利</h3>
          <p>报名接龙、资料领取、训练营打卡</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">⭐</div>
          <h3>粉丝抽奖</h3>
          <p>粉丝福利、问卷调研、下一活动承接</p>
        </div>
        <div class="scenario-card">
          <div class="scenario-icon">🎪</div>
          <h3>展会活动</h3>
          <p>现场扫码、名额确认、会后转化回传</p>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="landing-cta">
      <h2>先创建一个能复盘的活动</h2>
      <p>从模板开始，先跑通参与、结果、承接和复盘闭环</p>
      <RouterLink to="/admin/register" class="btn btn-primary btn-lg">免费注册</RouterLink>
    </section>

    <footer class="landing-footer">
      <div class="footer-main">
        <span>© 2026 运营活动引擎</span>
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
