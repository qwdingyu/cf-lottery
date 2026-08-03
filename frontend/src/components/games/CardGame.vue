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
    <button v-if="flippedCount >= 2 && !played" class="card-btn" @click="emit('play')">参与抽奖 🎯</button>
    <p v-else-if="flippedCount === 0" class="card-hint">翻开两张牌参与抽奖</p>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { PrizeItem } from './types'

defineProps<{ prizes: PrizeItem[]; disabled?: boolean; loading?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const COLORS = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#9B59B6','#FF8C42']
const flipped = reactive(Array(6).fill(false))
const flippedCount = ref(0)
const played = ref(false)

function flip(i: number) {
  if (flipped[i]) return
  flipped[i] = true
  flippedCount.value++
}
</script>

<style scoped>
.card-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 16px; }
.card-grid { display: grid; grid-template-columns: repeat(3, 100px); grid-template-rows: repeat(2, 140px); gap: 12px; }
.card-item { perspective: 800px; cursor: pointer; }
.card-inner { position: relative; width: 100%; height: 100%; transition: transform 0.6s; transform-style: preserve-3d; }
.card-item.flipped .card-inner { transform: rotateY(180deg); }
.card-front, .card-back { position: absolute; inset: 0; backface-visibility: hidden; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 36px; font-weight: 700; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.card-front { background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; }
.card-back { transform: rotateY(180deg); color: #fff; }
.card-btn { padding: 12px 36px; border-radius: 10px; background: linear-gradient(135deg, #f59e0b, #fbbf24); color: #1a1a2e; font-size: 15px; font-weight: 700; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(245,158,11,0.4); transition: all 0.3s; }
.card-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(245,158,11,0.6); }
.card-hint { font-size: 13px; color: rgba(255,255,255,0.4); }
</style>
