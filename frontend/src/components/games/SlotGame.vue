<template>
  <div class="slot-game">
    <div class="slot-machine">
      <div class="slot-frame">
        <div class="slot-window">
          <div class="slot-reel-wrap" v-for="(reel, idx) in 3" :key="'r'+idx">
            <div class="slot-reel" :ref="el => { if (el) reelRefs[idx] = el as HTMLDivElement }">
              <div v-for="(p, i) in reelPrizes" :key="idx+'-'+i" class="slot-item" :style="{ background: getGradient(i) }">
                <span class="slot-emoji">{{ ['🎁','💎','🏆','🎯','🌟','💰','🎪','🎰'][i % 8] }}</span>
                <span class="slot-name">{{ p.name.slice(0, 6) }}</span>
              </div>
            </div>
            <div class="slot-overlay top" />
            <div class="slot-overlay bottom" />
          </div>
        </div>
      </div>
      <div class="slot-controls">
        <button class="slot-btn" :class="{ spinning }" :disabled="disabled || spinning" @click="handlePull">
          <span class="slot-btn-icon">🎰</span>
          <span v-if="spinning">转动中...</span>
          <span v-else>开始抽奖</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PrizeItem } from './types'

const props = defineProps<{ prizes: PrizeItem[]; disabled?: boolean; loading?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const reelRefs = ref<HTMLDivElement[]>([])
const spinning = ref(false)

const GRADS = ['#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF', '#9B59B6', '#FF8C42', '#00D2FF', '#FF4DA6']

const reelPrizes = computed(() => {
  const arr = [...props.prizes, ...props.prizes.slice(0, 4)]
  while (arr.length < 8) arr.push({ name: '?' } as any)
  return arr.slice(0, 8)
})

function getGradient(i: number) { return GRADS[i % GRADS.length]! }

async function spinReel(reel: HTMLDivElement, delay: number) {
  await new Promise(r => setTimeout(r, delay))
  const duration = 1500 + Math.random() * 500
  const target = (5 + Math.floor(Math.random() * 8)) * 80
  reel.style.transition = `transform ${duration}ms cubic-bezier(0.17, 0.67, 0.12, 0.99)`
  reel.style.transform = `translateY(-${target}px)`
  await new Promise(r => setTimeout(r, duration + 200))
  reel.style.transition = 'none'
  reel.style.transform = 'translateY(0)'
}

async function handlePull() {
  if (spinning.value || props.disabled) return
  spinning.value = true
  emit('play')
  const reels = reelRefs.value.filter(Boolean)
  if (reels.length !== 3) { spinning.value = false; return }
  await Promise.all([
    spinReel(reels[0]!, 0),
    spinReel(reels[1]!, 150),
    spinReel(reels[2]!, 300),
  ])
  spinning.value = false
}
</script>

<style scoped>
.slot-game { display: flex; justify-content: center; padding: 20px 0; }
.slot-machine { width: 320px; }
.slot-frame { background: linear-gradient(180deg, #1e1b4b, #312e81); border-radius: 20px; padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.4), inset 0 2px 0 rgba(255,255,255,0.1); }
.slot-window { display: flex; gap: 8px; background: #0f0d23; border-radius: 12px; padding: 12px; }
.slot-reel-wrap { flex: 1; height: 200px; overflow: hidden; position: relative; border-radius: 8px; }
.slot-reel { display: flex; flex-direction: column; }
.slot-item { height: 80px; display: flex; flex-direction: column; align-items: center; justify-content: center; border-bottom: 2px solid rgba(255,255,255,0.1); }
.slot-emoji { font-size: 24px; }
.slot-name { font-size: 11px; color: rgba(255,255,255,0.9); font-weight: 600; }
.slot-overlay { position: absolute; left: 0; right: 0; height: 32px; pointer-events: none; z-index: 1; }
.slot-overlay.top { top: 0; background: linear-gradient(180deg, #0f0d23, transparent); }
.slot-overlay.bottom { bottom: 0; background: linear-gradient(0deg, #0f0d23, transparent); }
.slot-controls { margin-top: 16px; text-align: center; }
.slot-btn { padding: 12px 40px; border-radius: 12px; background: linear-gradient(135deg, #f59e0b, #fbbf24); color: #1a1a2e; font-size: 15px; font-weight: 700; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(245,158,11,0.4); transition: all 0.3s; }
.slot-btn:hover:not(:disabled) { transform: translateY(-2px) scale(1.05); box-shadow: 0 6px 24px rgba(245,158,11,0.6); }
.slot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
