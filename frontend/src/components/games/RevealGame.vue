<template>
  <div class="reveal-game">
    <p class="reveal-hint">{{ $t('lottery.gameRevealHint') }}</p>
    <button class="btn btn-primary btn-lg reveal-btn" :disabled="disabled || loading" @click="emit('play')">
      {{ loading ? $t('lottery.claiming') : $t('lottery.claim') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { GameProps, GameEmits } from './types'

defineProps<GameProps>()
const emit = defineEmits<GameEmits>()
</script>

<style scoped>
.reveal-game { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 20px 0; }
.reveal-hint { color: var(--tg-hint, #9aa4b2); font-size: 14px; }
.reveal-btn { min-width: 200px; font-size: 16px; padding: 12px 32px; }
</style>