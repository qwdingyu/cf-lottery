<template>
  <div class="slot-game">
    <div class="slot-machine">
      <div class="slot-window">
        <div class="slot-reel" ref="reel1Ref">
          <div v-for="(p, i) in shuffledPrizes" :key="'r1-'+i" class="slot-item" :style="{ background: getColor(i) }">
            {{ p.name }}
          </div>
        </div>
        <div class="slot-reel" ref="reel2Ref">
          <div v-for="(p, i) in shuffledPrizes" :key="'r2-'+i" class="slot-item" :style="{ background: getColor(i) }">
            {{ p.name }}
          </div>
        </div>
        <div class="slot-reel" ref="reel3Ref">
          <div v-for="(p, i) in shuffledPrizes" :key="'r3-'+i" class="slot-item" :style="{ background: getColor(i) }">
            {{ p.name }}
          </div>
        </div>
      </div>
      <div
        class="slot-lever"
        role="button"
        :tabindex="disabled ? -1 : 0"
        :aria-label="spinning ? '抽奖中' : '拉动拉杆'"
        :aria-disabled="disabled || spinning"
        @click="handlePull"
        @keydown.enter="handlePull"
        @keydown.space.prevent="handlePull"
        :class="{ pulling: spinning }"
      >
        <span class="lever-text">{{ spinning ? '...' : '拉杆' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

interface PrizeItem { name: string; color?: string }

const props = defineProps<{ prizes: PrizeItem[]; disabled?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const reel1Ref = ref<HTMLDivElement>()
const reel2Ref = ref<HTMLDivElement>()
const reel3Ref = ref<HTMLDivElement>()
const spinning = ref(false)

const defaultColors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

/** 打乱奖品顺序用于展示 */
const shuffledPrizes = computed(() => {
  const arr = [...props.prizes, ...props.prizes, ...props.prizes]
  return arr.length > 0 ? arr : [{ name: '?' }]
})

function getColor(i: number) { return defaultColors[i % defaultColors.length]! }

async function spinReel(reel: HTMLDivElement, delay: number, duration: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      reel.style.transition = `transform ${duration}ms cubic-bezier(0.25, 0.1, 0.25, 1)`
      reel.style.transform = `translateY(-${(Math.floor(Math.random() * 3) + 2) * 60}px)`
      setTimeout(() => {
        reel.style.transition = 'none'
        reel.style.transform = 'translateY(0)'
        resolve()
      }, duration)
    }, delay)
  })
}

async function handlePull() {
  if (spinning.value || props.disabled) return
  spinning.value = true
  emit('play')
  await Promise.all([
    spinReel(reel1Ref.value!, 0, 1200),
    spinReel(reel2Ref.value!, 300, 1000),
    spinReel(reel3Ref.value!, 600, 800),
  ])
  spinning.value = false
}
</script>

<style scoped>
.slot-game { display: flex; justify-content: center; padding: 20px 0; }
.slot-machine { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.slot-window { display: flex; gap: 8px; background: #1e293b; padding: 12px; border-radius: 12px; }
.slot-reel { width: 80px; height: 180px; overflow: hidden; background: #0f172a; border-radius: 8px; }
.slot-item { height: 60px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 13px; }
.slot-lever { width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #f59e0b, #d97706); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.slot-lever:hover { transform: scale(1.08); }
.slot-lever:active { transform: scale(0.95); }
.lever-text { color: #fff; font-weight: 700; font-size: 13px; }
</style>