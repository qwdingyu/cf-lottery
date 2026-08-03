<template>
  <div class="card-game">
    <div class="card-grid">
      <div
        v-for="(_, i) in 6"
        :key="i"
        class="card-item"
        :class="{ flipped: flipped[i] }"
        role="button"
        :tabindex="disabled ? -1 : 0"
        :aria-label="flipped[i] ? '已翻开' : `翻牌 ${i + 1}`"
        @click="flip(i)"
        @keydown.enter="flip(i)"
      >
        <div class="card-inner">
          <div class="card-front">?</div>
          <div class="card-back" :style="{ background: COLORS[i] }">🎁</div>
        </div>
      </div>
    </div>
    <button
      v-if="flippedCount >= 2 && !played"
      type="button"
      class="card-btn"
      :disabled="disabled || loading"
      @click="onPlay"
    >
      {{ loading ? $t('lottery.gameWheelSubmitting') : $t('lottery.gameWheelJoin') }}
    </button>
    <p v-else-if="flippedCount === 0" class="card-hint">{{ $t('lottery.gameCardHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { PrizeItem } from './types'

const props = defineProps<{ prizes: PrizeItem[]; disabled?: boolean; loading?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const COLORS = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#9B59B6','#FF8C42']
const flipped = reactive(Array(6).fill(false))
const flippedCount = ref(0)
const played = ref(false)

function flip(i: number) {
  if (props.disabled || flipped[i]) return
  flipped[i] = true
  flippedCount.value++
}

function onPlay() {
  if (props.disabled || props.loading || played.value) return
  played.value = true
  emit('play')
}
</script>

<style scoped>
.card-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 16px; width: 100%; max-width: 100%; }
.card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 100px));
  grid-template-rows: repeat(2, minmax(100px, 140px));
  gap: 12px;
  width: min(336px, 94vw);
  justify-content: center;
}
.card-item { perspective: 800px; cursor: pointer; min-height: 100px; }
.card-inner { position: relative; width: 100%; height: 100%; min-height: 100px; transition: transform 0.6s; transform-style: preserve-3d; }
.card-item.flipped .card-inner { transform: rotateY(180deg); }
.card-front, .card-back { position: absolute; inset: 0; backface-visibility: hidden; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 36px; font-weight: 700; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.card-front { background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; }
.card-back { transform: rotateY(180deg); color: #fff; }
.card-btn {
  min-height: 48px;
  min-width: min(200px, 80vw);
  padding: 12px 28px;
  border-radius: 10px;
  background: linear-gradient(135deg, #f59e0b, #fbbf24);
  color: #1a1a2e;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.25;
  white-space: pre-line;
  border: none;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(245,158,11,0.4);
  transition: all 0.3s;
}
.card-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(245,158,11,0.6); }
.card-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.card-hint { font-size: 13px; color: rgba(255,255,255,0.4); text-align: center; padding: 0 12px; }
</style>
