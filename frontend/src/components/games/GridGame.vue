<template>
  <div class="grid-game">
    <div class="grid-container">
      <button
        v-for="idx in 9"
        :key="idx"
        class="grid-cell"
        :class="{ center: idx === 5, flipped: flippedIdx === idx }"
        :style="{ '--idx': idx }"
        :disabled="disabled || flippedIdx > 0"
        @click="handleClick(idx)"
      >
        <span v-if="flippedIdx === idx" class="grid-cell-icon flipped-icon">🎉</span>
        <span v-else-if="idx === 5" class="grid-cell-icon">🎁</span>
        <span v-else class="grid-cell-icon">❓</span>
      </button>
    </div>
    <p class="grid-hint">{{ flippedIdx ? '开奖中...' : '选择一个格子抽奖' }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PrizeItem } from './types'

defineProps<{ prizes: PrizeItem[]; disabled?: boolean; loading?: boolean }>()
const emit = defineEmits<{ play: [] }>()
const flippedIdx = ref(0)

function handleClick(idx: number) {
  if (flippedIdx.value || idx === 5) return
  flippedIdx.value = idx
  setTimeout(() => emit('play'), 600)
}
</script>

<style scoped>
.grid-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 12px; }
.grid-container { display: grid; grid-template-columns: repeat(3, 90px); grid-template-rows: repeat(3, 90px); gap: 10px; }
.grid-cell {
  border-radius: 16px; border: 2px solid rgba(255,255,255,0.1); cursor: pointer;
  background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(251,191,36,0.08));
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; transition: all 0.3s ease;
}
.grid-cell:hover:not(:disabled):not(.center) {
  transform: scale(1.08); border-color: var(--admin-accent, #f59e0b); background: rgba(245,158,11,0.25);
}
.grid-cell.center { background: linear-gradient(135deg, rgba(245,158,11,0.3), rgba(251,191,36,0.15)); border-color: rgba(245,158,11,0.3); cursor: default; }
.grid-cell.center .grid-cell-icon { animation: pulse 1.5s infinite; }
.grid-cell.flipped { background: linear-gradient(135deg, #22c55e, #16a34a); border-color: #22c55e; }
.flipped-icon { animation: popIn 0.4s cubic-bezier(0.34,1.56,0.64,1); }
.grid-hint { font-size: 13px; color: rgba(255,255,255,0.4); }
.grid-cell-icon { font-size: 32px; }
@keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.15); } }
@keyframes popIn { 0% { transform: scale(0); } 100% { transform: scale(1); } }
</style>
