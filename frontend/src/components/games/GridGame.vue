<template>
  <div class="grid-game">
    <div class="grid-container">
      <button
        v-for="idx in 9"
        :key="idx"
        type="button"
        class="grid-cell"
        :class="{
          center: idx === 5,
          flipped: flippedIdx === idx,
          loading: loading && pendingIdx === idx,
        }"
        :style="{ '--idx': idx }"
        :disabled="disabled || loading || (flippedIdx > 0 && flippedIdx !== idx)"
        @click="handleClick(idx)"
      >
        <span v-if="flippedIdx === idx" class="grid-cell-icon flipped-icon">✨</span>
        <span v-else-if="idx === 5" class="grid-cell-icon">🎁</span>
        <span v-else class="grid-cell-icon">❓</span>
      </button>
    </div>
    <!-- 诚实文案：选格=参与意图；翻转=成功后氛围，不是「开奖中」 -->
    <p class="grid-hint">
      <template v-if="loading">{{ $t('lottery.gameWheelSubmitting') }}</template>
      <template v-else-if="flippedIdx">{{ $t('lottery.gameGridJoinedHint') }}</template>
      <template v-else>{{ $t('lottery.gameGridPickHint') }}</template>
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GameProps, GameEmits } from './types'

const props = withDefaults(defineProps<GameProps>(), {
  disabled: false,
  loading: false,
  celebrateKey: 0,
})
const emit = defineEmits<GameEmits>()

const flippedIdx = ref(0)
/** 用户点选的格子；成功后再翻开（celebrateKey） */
const pendingIdx = ref(0)
let lastCelebrate = 0

function handleClick(idx: number) {
  if (props.disabled || props.loading || flippedIdx.value || idx === 5) return
  pendingIdx.value = idx
  emit('play')
}

watch(() => props.celebrateKey, (key) => {
  const n = Number(key) || 0
  if (n <= 0 || n === lastCelebrate) return
  lastCelebrate = n
  // 参与成功：翻开用户所选（或默认一格），不宣称中奖
  flippedIdx.value = pendingIdx.value || 1
})
</script>

<style scoped>
.grid-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 12px; width: 100%; }
.grid-container {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 90px));
  grid-template-rows: repeat(3, minmax(72px, 90px));
  gap: 10px;
  width: min(300px, 94vw);
  justify-content: center;
}
.grid-cell {
  border-radius: 16px; border: 2px solid rgba(255,255,255,0.1); cursor: pointer;
  background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(251,191,36,0.08));
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; transition: all 0.3s ease;
  min-height: 72px;
}
.grid-cell:hover:not(:disabled):not(.center) {
  transform: scale(1.08); border-color: var(--admin-accent, #f59e0b); background: rgba(245,158,11,0.25);
}
.grid-cell:focus-visible {
  outline: 2px solid var(--admin-accent, #f59e0b);
  outline-offset: 2px;
}
.grid-cell.center { background: linear-gradient(135deg, rgba(245,158,11,0.3), rgba(251,191,36,0.15)); border-color: rgba(245,158,11,0.3); cursor: default; }
.grid-cell.center .grid-cell-icon { animation: pulse 1.5s infinite; }
@media (prefers-reduced-motion: reduce) {
  .grid-cell { transition: none; }
  .grid-cell:hover:not(:disabled):not(.center) { transform: none; }
  .grid-cell.center .grid-cell-icon { animation: none; }
}
.grid-cell.flipped { background: linear-gradient(135deg, #6366f1, #4f46e5); border-color: #818cf8; }
/* 提交中：高亮用户刚点的格，避免「点了没反应」 */
.grid-cell.loading {
  border-color: var(--admin-accent, #f59e0b);
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.45);
  animation: gridCellPulse 1s ease-in-out infinite;
}
.flipped-icon { animation: popIn 0.4s cubic-bezier(0.34,1.56,0.64,1); }
.grid-hint { font-size: 13px; color: rgba(255,255,255,0.45); text-align: center; padding: 0 12px; }
.grid-cell-icon { font-size: 32px; }
@keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.15); } }
@keyframes popIn { 0% { transform: scale(0); } 100% { transform: scale(1); } }
@keyframes gridCellPulse {
  0%, 100% { background: linear-gradient(135deg, rgba(245,158,11,0.28), rgba(251,191,36,0.12)); }
  50% { background: linear-gradient(135deg, rgba(245,158,11,0.45), rgba(251,191,36,0.22)); }
}
@media (prefers-reduced-motion: reduce) {
  .grid-cell.loading { animation: none; }
}
</style>
