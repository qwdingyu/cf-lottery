<template>
  <div class="form-game">
    <!--
      Form 体验：不另建一套姓名/邮箱（会与参与身份、activityConfig 脱节）。
      问卷字段在 LotteryView 的 activity-submission 区填写；此处只做诚实主 CTA。
    -->
    <p class="form-hint">{{ $t('lottery.gameFormHint') }}</p>
    <button
      type="button"
      class="btn btn-primary btn-lg form-btn"
      :class="{ loading, joined: disabled && !loading }"
      :disabled="disabled || loading"
      @click="emit('play')"
    >
      <span v-if="loading" class="form-spinner" aria-hidden="true" />
      {{
        loading
          ? $t('lottery.gameSubmitSubmitting')
          : disabled
            ? $t('lottery.gameSubmitJoined')
            : $t('lottery.gameSubmitJoin')
      }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { GameProps, GameEmits } from './types'

withDefaults(defineProps<GameProps>(), {
  disabled: false,
  loading: false,
  celebrateKey: 0,
})
const emit = defineEmits<GameEmits>()
</script>

<style scoped>
.form-game { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px 0; width: 100%; }
.form-hint { color: var(--tg-hint, #9aa4b2); font-size: 14px; text-align: center; padding: 0 12px; max-width: 28em; line-height: 1.45; }
.form-btn {
  min-width: min(200px, 80vw);
  min-height: 48px;
  margin-top: 4px;
  width: min(280px, 90vw);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.form-btn.loading {
  cursor: wait;
  opacity: 1;
  animation: formPulse 1s ease-in-out infinite;
}
.form-btn.joined {
  opacity: 0.85;
  cursor: default;
}
.form-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(26, 26, 46, 0.25);
  border-top-color: #1a1a2e;
  border-radius: 50%;
  animation: formSpin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes formPulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35); }
  50% { box-shadow: 0 4px 28px rgba(245, 158, 11, 0.65); }
}
@keyframes formSpin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .form-btn.loading { animation: none; }
  .form-spinner { animation: none; opacity: 0.7; }
}
</style>
