<template>
  <div class="lucky-wheel-container">
    <!-- 外圈装饰光点 -->
    <div class="wheel-lights">
      <span v-for="i in 12" :key="i" class="light-dot" :class="{ active: spinning }" :style="{ transform: `rotate(${i * 30}deg) translateY(-${canvasSize/2 + 8}px)` }" />
    </div>
    <!-- 转盘 -->
    <canvas ref="wheelCanvasRef" class="wheel-canvas" :width="canvasSize" :height="canvasSize" />
    <!-- 指针按钮 -->
    <div class="wheel-pointer-wrap" @click="handleSpin">
      <div class="wheel-pointer" :class="{ spinning }">
        <span class="pointer-arrow">▼</span>
      </div>
      <div class="wheel-btn" :class="{ disabled: disabled || spinning }">
        <span v-if="loading">加载中</span>
        <span v-else-if="spinning">抽奖中</span>
        <span v-else>开始<br>抽奖</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PrizeItem } from './types'

const props = defineProps<{ prizes: PrizeItem[]; disabled?: boolean; loading?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const wheelCanvasRef = ref<HTMLCanvasElement>()
const spinning = ref(false)
const canvasSize = 320

const sliceAngle = computed(() => (2 * Math.PI) / Math.max(props.prizes.length, 1))

const COLORS = [
  ['#FF6B6B', '#FF8E8E'], ['#FFD93D', '#FFE570'], ['#6BCB77', '#8FD99A'],
  ['#4D96FF', '#7AB4FF'], ['#9B59B6', '#BB8FCE'], ['#FF8C42', '#FFAB70'],
  ['#00D2FF', '#5CE0FF'], ['#FF4DA6', '#FF80C0'],
]

function getColors(i: number) { return COLORS[i % COLORS.length]! }

function drawWheel(rotation: number) {
  const cvs = wheelCanvasRef.value; if (!cvs) return
  const ctx = cvs.getContext('2d'); if (!ctx) return
  const cx = cvs.width / 2, cy = cvs.height / 2, r = cx - 6
  ctx.clearRect(0, 0, cvs.width, cvs.height)

  for (let i = 0; i < props.prizes.length; i++) {
    const sa = i * sliceAngle.value + rotation, ea = sa + sliceAngle.value
    const [c1, c2] = getColors(i)
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r)
    g.addColorStop(0, c1); g.addColorStop(1, c2)

    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, sa, ea); ctx.closePath()
    ctx.fillStyle = g; ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 2; ctx.stroke()

    // 奖品文字
    const mid = sa + sliceAngle.value / 2
    const tx = cx + Math.cos(mid) * r * 0.62
    const ty = cy + Math.sin(mid) * r * 0.62
    ctx.save(); ctx.translate(tx, ty); ctx.rotate(mid + Math.PI / 2)
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px system-ui'
    ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 3
    const name = props.prizes[i]?.name || '奖品'
    ctx.fillText(name.length > 6 ? name.slice(0, 6) + '…' : name, 0, 0)
    ctx.restore()
  }

  // 中心圆
  ctx.beginPath(); ctx.arc(cx, cy, 32, 0, 2 * Math.PI)
  const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32)
  g2.addColorStop(0, '#fff'); g2.addColorStop(1, '#e0e0e0')
  ctx.fillStyle = g2; ctx.fill()
  ctx.strokeStyle = '#ccc'; ctx.lineWidth = 2; ctx.stroke()
}

async function handleSpin() {
  if (spinning.value || props.disabled) return
  spinning.value = true
  emit('play')

  const targetAngle = Math.PI * 2 * (5 + Math.random())
  const startRot = parseFloat(wheelCanvasRef.value?.dataset?.rot || '0')
  const duration = 4000, start = performance.now()

  await new Promise<void>(resolve => {
    const tick = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const rot = startRot + targetAngle * eased
      drawWheel(rot % (Math.PI * 2))
      if (wheelCanvasRef.value) wheelCanvasRef.value.dataset.rot = String(rot)
      if (progress < 1) { requestAnimationFrame(tick) } else { resolve() }
    }
    requestAnimationFrame(tick)
  })
  spinning.value = false
}

watch(() => props.prizes, () => drawWheel(0), { immediate: true })
</script>

<style scoped>
.lucky-wheel-container { position: relative; width: 360px; height: 360px; margin: 0 auto; }
.wheel-canvas { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); border-radius: 50%; filter: drop-shadow(0 0 20px rgba(245,158,11,0.3)); }
.wheel-lights { position: absolute; top: 50%; left: 50%; }
.light-dot { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #fbbf24; box-shadow: 0 0 6px #fbbf24; }
.light-dot.active { animation: blink 0.5s infinite alternate; }
@keyframes blink { to { opacity: 0.3; transform: scale(0.7); } }
.wheel-pointer-wrap { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 10; }
.wheel-pointer { width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-top: 22px solid #f59e0b; margin: 0 auto -2px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); }
.wheel-pointer.spinning { animation: bounce 0.1s infinite alternate; }
@keyframes bounce { to { transform: translateY(-2px); } }
.wheel-btn { width: 54px; height: 54px; border-radius: 50%; background: linear-gradient(135deg, #f59e0b, #fbbf24); color: #1a1a2e; font-size: 13px; font-weight: 800; line-height: 1.2; border: 3px solid #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3); cursor: pointer; display: flex; align-items: center; justify-content: center; text-align: center; transition: transform 0.2s; }
.wheel-btn:not(.disabled):hover { transform: scale(1.1); }
.wheel-btn:not(.disabled):active { transform: scale(0.95); }
.wheel-btn.disabled { opacity: 0.5; cursor: not-allowed; }
</style>
