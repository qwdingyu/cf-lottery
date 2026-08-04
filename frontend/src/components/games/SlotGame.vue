<template>
  <div class="slot-game">
    <div class="slot-machine">
      <div class="slot-frame">
        <div class="slot-window">
          <div class="slot-reel-wrap" v-for="idx in 3" :key="'r'+idx">
            <div class="slot-reel" :ref="el => { if (el) reelRefs[idx] = el as HTMLDivElement }">
              <div v-for="(p, i) in reelPrizes" :key="idx+'-'+i" class="slot-item" :style="{ background: getGradient(i) }">
                <span class="slot-emoji">{{ ['🎁','💎','🏆','🎯','🌟','💰','🎪','🎰'][i % 8] }}</span>
                <span class="slot-name">{{ (p.name || '?').slice(0, 6) }}</span>
              </div>
            </div>
            <div class="slot-overlay top" />
            <div class="slot-overlay bottom" />
          </div>
        </div>
      </div>
      <div class="slot-controls">
        <button
          type="button"
          class="slot-btn"
          :class="{ spinning, loading }"
          :disabled="disabled || spinning || loading"
          @click="handlePull"
        >
          <span class="slot-btn-icon">🎰</span>
          <!-- 点击只 emit play；loading=idle 晃动；celebrateKey 后完整滚动 -->
          <span v-if="loading">{{ $t('lottery.gameWheelSubmitting') }}</span>
          <span v-else-if="spinning">{{ $t('lottery.gameWheelCelebrating') }}</span>
          <span v-else>{{ $t('lottery.gameWheelJoin') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { GameProps, GameEmits } from './types'

const props = withDefaults(defineProps<GameProps>(), {
  disabled: false,
  loading: false,
  celebrateKey: 0,
})
const emit = defineEmits<GameEmits>()

const reelRefs = ref<HTMLDivElement[]>([])
const spinning = ref(false)
let lastCelebrate = 0
let idleRaf = 0
let idleStart = 0

const GRADS = ['#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF', '#9B59B6', '#FF8C42', '#00D2FF', '#FF4DA6']

const reelPrizes = computed(() => {
  const arr = [...props.prizes, ...props.prizes.slice(0, 4)]
  while (arr.length < 8) arr.push({ name: '?' } as any)
  return arr.slice(0, 8)
})

function getGradient(i: number) { return GRADS[i % GRADS.length]! }

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function stopIdleNudge() {
  if (idleRaf) {
    cancelAnimationFrame(idleRaf)
    idleRaf = 0
  }
  // 清掉 idle 位移，避免庆祝 spin 起点偏移
  for (const reel of reelRefs.value.filter(Boolean)) {
    if (!spinning.value) {
      reel.style.transition = 'none'
      reel.style.transform = 'translateY(0)'
    }
  }
}

/**
 * loading 期间轻量 reel 晃动：即时反馈「在提交」，不表示开奖结果。
 * 成功后由 runCelebrateSpin 接棒完整滚动。
 */
function startIdleNudge() {
  stopIdleNudge()
  if (prefersReducedMotion()) return
  idleStart = performance.now()
  const tick = (now: number) => {
    if (!props.loading || spinning.value) {
      idleRaf = 0
      return
    }
    const t = (now - idleStart) / 1000
    // 小幅正弦位移（px），三轴相位错开更像「在转」
    const reels = reelRefs.value.filter(Boolean)
    reels.forEach((reel, i) => {
      const phase = Math.sin(t * 6 + i * 0.9) * (5 + i * 2)
      reel.style.transition = 'none'
      reel.style.transform = `translateY(${phase}px)`
    })
    idleRaf = requestAnimationFrame(tick)
  }
  idleRaf = requestAnimationFrame(tick)
}

async function spinReel(reel: HTMLDivElement, delay: number) {
  await new Promise(r => setTimeout(r, delay))
  const duration = 1200 + Math.random() * 400
  const target = (5 + Math.floor(Math.random() * 8)) * 80
  reel.style.transition = `transform ${duration}ms cubic-bezier(0.17, 0.67, 0.12, 0.99)`
  reel.style.transform = `translateY(-${target}px)`
  await new Promise(r => setTimeout(r, duration + 200))
  reel.style.transition = 'none'
  reel.style.transform = 'translateY(0)'
}

function handlePull() {
  if (spinning.value || props.disabled || props.loading) return
  emit('play')
}

async function runCelebrateSpin() {
  if (spinning.value) return
  stopIdleNudge()
  spinning.value = true
  const reels = reelRefs.value.filter(Boolean)
  if (reels.length === 3) {
    await Promise.all([
      spinReel(reels[0]!, 0),
      spinReel(reels[1]!, 120),
      spinReel(reels[2]!, 240),
    ])
  }
  spinning.value = false
}

watch(() => props.loading, (loading) => {
  if (loading && !spinning.value) startIdleNudge()
  else if (!loading) stopIdleNudge()
})

watch(() => props.celebrateKey, (key) => {
  const n = Number(key) || 0
  if (n <= 0 || n === lastCelebrate) return
  lastCelebrate = n
  void runCelebrateSpin()
})

onUnmounted(() => {
  stopIdleNudge()
})
</script>

<style scoped>
.slot-game { display: flex; justify-content: center; padding: 20px 0; width: 100%; max-width: 100%; }
.slot-machine { width: min(320px, 94vw); max-width: 100%; }
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
.slot-btn {
  min-height: 48px;
  min-width: min(220px, 80vw);
  padding: 12px 28px;
  border-radius: 12px;
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
.slot-btn:hover:not(:disabled) { transform: translateY(-2px) scale(1.05); box-shadow: 0 6px 24px rgba(245,158,11,0.6); }
.slot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* 提交中：保持醒目脉冲，与转盘 loading 语义一致 */
.slot-btn.loading {
  opacity: 1;
  cursor: wait;
  animation: slotBtnPulse 1s ease-in-out infinite;
}
.slot-frame:has(+ .slot-controls .slot-btn.loading),
.slot-machine:has(.slot-btn.loading) .slot-frame {
  box-shadow: 0 8px 32px rgba(245, 158, 11, 0.35), inset 0 2px 0 rgba(255, 255, 255, 0.1);
}
@keyframes slotBtnPulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(245, 158, 11, 0.4); }
  50% { box-shadow: 0 4px 28px rgba(245, 158, 11, 0.7); }
}
@media (prefers-reduced-motion: reduce) {
  .slot-btn.loading { animation: none; }
  .slot-btn:hover:not(:disabled) { transform: none; }
}
</style>
