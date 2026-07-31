<template>
  <div class="card-game">
    <div class="card-grid">
      <div
        v-for="(card, i) in cards"
        :key="i"
        class="card-item"
        :class="{ flipped: card.flipped }"
        @click="flipCard(i)"
      >
        <div class="card-inner">
          <div class="card-front">
            <span class="card-number">{{ i + 1 }}</span>
          </div>
          <div class="card-back" :style="{ background: getColor(i) }">
            <span class="card-prize-name">{{ card.prize?.name || '?' }}</span>
          </div>
        </div>
      </div>
    </div>
    <button
      v-if="flippedCount > 0"
      type="button"
      class="btn btn-primary btn-sm"
      :disabled="disabled"
      @click="emit('play')"
    >
      参与抽奖
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface PrizeItem { name: string; color?: string }

const props = defineProps<{ prizes: PrizeItem[]; disabled?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const defaultColors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

/** 生成卡片：每张随机分配一个奖品 */
const cards = ref(
  Array.from({ length: 6 }, () => ({
    prize: props.prizes[Math.floor(Math.random() * Math.max(props.prizes.length, 1))],
    flipped: false,
  }))
)

const flippedCount = ref(0)

function getColor(i: number) { return defaultColors[i % defaultColors.length]! }

function flipCard(i: number) {
  if (cards.value[i]!.flipped) return
  cards.value[i]!.flipped = true
  flippedCount.value++
}
</script>

<style scoped>
.card-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 16px; }
.card-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; max-width: 320px; }
.card-item { width: 90px; height: 120px; perspective: 600px; cursor: pointer; }
.card-inner { position: relative; width: 100%; height: 100%; transition: transform 0.5s; transform-style: preserve-3d; }
.card-item.flipped .card-inner { transform: rotateY(180deg); }
.card-front, .card-back { position: absolute; inset: 0; backface-visibility: hidden; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
.card-front { background: linear-gradient(135deg, #6366f1, #4f46e5); }
.card-number { font-size: 28px; font-weight: 700; color: #fff; }
.card-back { transform: rotateY(180deg); }
.card-prize-name { font-size: 13px; font-weight: 700; color: #fff; text-align: center; padding: 4px; }
</style>