<template>
  <div class="reveal-game">
    <p class="reveal-hint">{{ $t('lottery.gameRevealHint') }}</p>
    <button
      type="button"
      class="btn btn-primary btn-lg reveal-btn"
      :class="{ loading, joined: disabled && !loading }"
      :disabled="disabled || loading"
      @click="emit('play')"
    >
      <span v-if="loading" class="reveal-spinner" aria-hidden="true" />
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
.reveal-game { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 20px 0; width: 100%; }
.reveal-hint { color: var(--tg-hint, #9aa4b2); font-size: 14px; text-align: center; padding: 0 12px; }
.reveal-btn {
  min-width: min(200px, 80vw);
  min-height: 48px;
  font-size: 16px;
  padding: 12px 32px;
  width: min(280px, 90vw);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.reveal-btn.loading {
  cursor: wait;
  opacity: 1;
  animation: revealPulse 1s ease-in-out infinite;
}
.reveal-btn.joined {
  opacity: 0.85;
  cursor: default;
}
.reveal-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(26, 26, 46, 0.25);
  border-top-color: #1a1a2e;
  border-radius: 50%;
  animation: revealSpin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes revealPulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35); }
  50% { box-shadow: 0 4px 28px rgba(245, 158, 11, 0.65); }
}
@keyframes revealSpin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .reveal-btn.loading { animation: none; }
  .reveal-spinner { animation: none; opacity: 0.7; }
}
</style>
