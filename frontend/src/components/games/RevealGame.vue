<template>
  <div class="reveal-game">
    <p class="reveal-hint">{{ $t('lottery.gameRevealHint') }}</p>
    <button type="button" class="btn btn-primary btn-lg reveal-btn" :disabled="disabled || loading" @click="emit('play')">
      {{ loading ? $t('lottery.gameSubmitSubmitting') : $t('lottery.gameSubmitJoin') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { GameProps, GameEmits } from './types'

defineProps<GameProps>()
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
}
</style>