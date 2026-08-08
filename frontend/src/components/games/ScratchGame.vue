<template>
  <div class="scratch-game">
    <div class="scratch-card" :class="{ joined: joinedPulse }">
      <!--
        底层：中性提示，不是「已参与/中奖结果」。
        刮开后仍需点按钮 emit('play') 才真正提交（docs/055a）。
        参与成功后 celebrateKey 触发轻量反馈，仍不宣称具体奖品。
      -->
      <div class="scratch-prize">
        <span class="prize-icon">{{ joinedPulse ? '✨' : '🎁' }}</span>
        <span class="prize-text">{{ joinedPulse ? $t('lottery.gameScratchJoined') : $t('lottery.gameScratchReveal') }}</span>
      </div>
      <!-- 上层：涂层（Canvas 刮开） -->
      <canvas
        ref="canvasRef"
        class="scratch-canvas"
        :class="{ hidden: joinedPulse }"
        :width="300"
        :height="200"
        role="img"
        :aria-label="scratched ? $t('lottery.gameScratchReveal') : $t('lottery.gameScratchHint')"
        :tabindex="disabled ? -1 : 0"
        @mousedown="startScratch"
        @mousemove="scratch"
        @mouseup="endScratch"
        @mouseleave="endScratch"
        @touchstart.prevent="startTouchScratch"
        @touchmove.prevent="touchScratch"
        @touchend="endScratch"
        @keydown.enter="quickScratch"
        @keydown.space.prevent="quickScratch"
      />
    </div>
    <p v-if="!scratched && !joinedPulse" class="scratch-hint">{{ $t('lottery.gameScratchHint') }}</p>
    <p v-else-if="joinedPulse" class="scratch-hint joined-hint">{{ $t('lottery.gameScratchJoinedHint') }}</p>
    <button
      v-if="scratched && !joinedPulse"
      type="button"
      class="btn btn-primary btn-sm scratch-join-btn"
      :class="{ loading }"
      :disabled="disabled || loading"
      @click="emit('play')"
    >
      {{ loading ? $t('lottery.gameSubmitSubmitting') : $t('lottery.join') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GameProps, GameEmits } from './types'

const props = withDefaults(defineProps<GameProps>(), {
  disabled: false,
  loading: false,
  celebrateKey: 0,
})
const emit = defineEmits<GameEmits>()
const { t } = useI18n()

const canvasRef = ref<HTMLCanvasElement>()
const scratched = ref(false)
const isDrawing = ref(false)
/** 参与成功氛围：轻量脉冲，不展示假中奖 */
const joinedPulse = ref(false)
let lastCelebrate = 0

function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#94a3b8'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#64748b'
  ctx.font = 'bold 18px sans-serif'
  ctx.textAlign = 'center'
  // i18n：避免英文界面硬编码中文（055a P2）
  ctx.fillText(t('lottery.gameScratchCanvasTitle'), canvas.width / 2, canvas.height / 2 + 6)
  ctx.fillStyle = '#475569'
  ctx.font = '12px sans-serif'
  ctx.fillText(t('lottery.gameScratchCanvasHint'), canvas.width / 2, canvas.height / 2 + 30)
}

function scratchAt(x: number, y: number) {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(x, y, 24, 0, 2 * Math.PI)
  ctx.fill()
  checkScratched()
}

/**
 * 把指针/触点映射到 canvas 内部像素坐标。
 * 055a：CSS 缩放后 offsetX/client 与 bitmap 不一致会导致「刮不开」；统一用比例换算。
 */
function pointerToCanvas(clientX: number, clientY: number) {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  const rw = rect.width || 1
  const rh = rect.height || 1
  return {
    x: ((clientX - rect.left) / rw) * canvas.width,
    y: ((clientY - rect.top) / rh) * canvas.height,
  }
}

function startScratch(e: MouseEvent) {
  // 已参与 / 提交中禁止再刮（docs/097 P1-1）
  if (props.disabled || props.loading || joinedPulse.value) return
  isDrawing.value = true
  const p = pointerToCanvas(e.clientX, e.clientY)
  scratchAt(p.x, p.y)
}
function scratch(e: MouseEvent) {
  if (!isDrawing.value || props.disabled) return
  const p = pointerToCanvas(e.clientX, e.clientY)
  scratchAt(p.x, p.y)
}
function endScratch() { isDrawing.value = false; checkScratched() }
function startTouchScratch(e: TouchEvent) {
  if (props.disabled || props.loading || joinedPulse.value) return
  isDrawing.value = true
  const t = e.touches[0]
  if (!t) return
  const p = pointerToCanvas(t.clientX, t.clientY)
  scratchAt(p.x, p.y)
}
function touchScratch(e: TouchEvent) {
  if (!isDrawing.value || props.disabled) return
  const t = e.touches[0]
  if (!t) return
  const p = pointerToCanvas(t.clientX, t.clientY)
  scratchAt(p.x, p.y)
}
function quickScratch() {
  if (scratched.value || isDrawing.value || props.disabled) return
  // 键盘/无障碍快捷刮开
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  scratched.value = true
  // 不自动 emit('play')——用户需手动点击按钮确认参与，防误操作
}
function checkScratched() {
  if (scratched.value) return
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const imageData = ctx.getImageData(0, 0, w, h)
  let transparent = 0
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i]! < 128) transparent++
  }
  if (transparent / (w * h) > 0.5) {
    scratched.value = true
    // 不自动 emit('play')——用户需手动点击按钮确认参与，防误操作
  }
}

watch(() => props.celebrateKey, (key) => {
  const n = Number(key) || 0
  if (n <= 0 || n === lastCelebrate) return
  lastCelebrate = n
  joinedPulse.value = true
  scratched.value = true
})

onMounted(initCanvas)
</script>

<style scoped>
.scratch-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 12px; width: 100%; max-width: 100%; }
/* 055a：卡片随屏宽，canvas 用 CSS 铺满 + pointerToCanvas 对齐 bitmap */
.scratch-card {
  position: relative;
  width: min(300px, 92vw);
  height: min(200px, calc(92vw * 2 / 3));
  border-radius: 12px;
  overflow: hidden;
  touch-action: none;
  max-width: 100%;
  transition: box-shadow 0.35s ease, transform 0.35s ease;
}
.scratch-card.joined {
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.55), 0 8px 28px rgba(245, 158, 11, 0.25);
  transform: scale(1.02);
}
.scratch-prize { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: linear-gradient(135deg, #fef3c7, #fde68a); }
.prize-icon { font-size: 40px; }
.prize-text { font-size: 18px; font-weight: 700; color: #92400e; margin-top: 8px; text-align: center; padding: 0 8px; }
.scratch-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; touch-action: none; }
.scratch-canvas.hidden { opacity: 0; pointer-events: none; }
.scratch-hint { color: var(--tg-hint); font-size: 13px; text-align: center; padding: 0 12px; }
.scratch-hint.joined-hint { color: var(--brand-bright); font-weight: 600; }
.scratch-join-btn {
  margin-top: 4px;
  min-height: 44px;
  min-width: min(200px, 80vw);
  padding: 12px 24px;
  font-size: 15px;
  font-weight: 600;
}
.scratch-join-btn.loading {
  cursor: wait;
  animation: scratchBtnPulse 1s ease-in-out infinite;
}
@keyframes scratchBtnPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.35); }
  50% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.15); }
}
@media (prefers-reduced-motion: reduce) {
  .scratch-join-btn.loading { animation: none; }
}
</style>
