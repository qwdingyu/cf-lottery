<template>
  <div class="grid-game">
    <div class="grid-container">
      <button
        v-for="(prize, idx) in prizes.slice(0, 9)"
        :key="idx"
        class="grid-cell"
        :class="{ 'grid-cell--disabled': disabled || loading }"
        :style="{ backgroundColor: prize.color || 'var(--tg-secondary-bg, #151b28)' }"
        :disabled="disabled || loading"
        @click="handleClick(idx)"
      >
        <span class="grid-cell-icon">{{ idx === 4 ? '🎁' : '❓' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { GameProps, GameEmits } from './types'

defineProps<GameProps>()
const emit = defineEmits<GameEmits>()

function handleClick(idx: number) {
  // 九宫格中间是奖品，四周是格子，点击任意格子触发抽奖
  if (idx === 4) return // 中间是装饰
  emit('play')
}
</script>

<style scoped>
.grid-game { display: flex; justify-content: center; padding: 20px 0; }
.grid-container { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-width: 280px; }
.grid-cell {
  aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  border-radius: 12px; border: 2px solid var(--border, rgba(255,255,255,0.1));
  cursor: pointer; font-size: 24px; transition: all 0.2s;
}
.grid-cell:hover:not(:disabled) { transform: scale(1.05); border-color: var(--admin-accent, #f59e0b); }
.grid-cell--disabled { opacity: 0.5; cursor: not-allowed; }
.grid-cell-icon { font-size: 28px; }
</style>