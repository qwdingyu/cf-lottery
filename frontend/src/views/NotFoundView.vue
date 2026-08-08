<template>
  <div class="nf-view">
    <div class="nf-card">
      <div class="nf-code">404</div>
      <p class="nf-title">{{ $t('lottery.noActivity') }}</p>
      <p class="nf-desc">{{ $t('lottery.needActivityLinkHint') }}</p>
      <div class="nf-actions">
        <RouterLink to="/" class="btn btn-primary nf-btn">{{ $t('landing.marketBrowseCta') }}</RouterLink>
        <RouterLink to="/admin/login" class="btn btn-ghost nf-btn">{{ $t('landing.login') }}</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// C 端 catch-all 兜底页：复用现有 i18n key，不新增翻译；不查后端，纯展示。
</script>

<style scoped>
.nf-view {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--tg-bg);
}
.nf-card {
  text-align: center;
  max-width: 420px;
  width: 100%;
}
.nf-code {
  font-size: 72px;
  font-weight: 800;
  line-height: 1;
  background: var(--brand-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 12px;
}
.nf-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--tg-text);
}
.nf-desc {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--tg-hint);
  line-height: 1.6;
}
.nf-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nf-btn {
  width: 100%;
  min-height: 48px;
  text-decoration: none;
}
</style>
