<template>
  <div class="submit-game">
    <button
      type="button"
      class="btn btn-primary btn-lg submit-btn"
      :class="{ loading, joined: disabled && !loading }"
      :disabled="disabled || loading"
      @click="emit('play')"
    >
      <span v-if="loading" class="submit-spinner" aria-hidden="true" />
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
.submit-game { display: flex; justify-content: center; padding: 20px 0; width: 100%; }
.submit-btn {
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
.submit-btn.loading {
  cursor: wait;
  opacity: 1;
  animation: submitPulse 1s ease-in-out infinite;
}
.submit-btn.joined {
  opacity: 0.85;
  cursor: default;
}
.submit-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(26, 26, 46, 0.25);
  border-top-color: #1a1a2e;
  border-radius: 50%;
  animation: submitSpin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes submitPulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35); }
  50% { box-shadow: 0 4px 28px rgba(245, 158, 11, 0.65); }
}
@keyframes submitSpin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .submit-btn.loading { animation: none; }
  .submit-spinner { animation: none; border-top-color: #1a1a2e; opacity: 0.7; }
}
</style>
