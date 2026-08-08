<template>
  <div class="lucky-wheel-container">
    <!-- 外圈装饰光点 -->
    <div class="wheel-lights">
      <span v-for="i in 12" :key="i" class="light-dot" :class="{ active: lightsActive }" :style="{ transform: `rotate(${i * 30}deg) translateY(-${canvasSize/2 + 8}px)` }" />
    </div>
    <!-- 转盘 -->
    <canvas ref="wheelCanvasRef" class="wheel-canvas" :width="canvasSize" :height="canvasSize" />
    <!-- 指针按钮：点击只发 play；旋转仅在 celebrateKey 递增后 -->
    <div
      class="wheel-pointer-wrap"
      role="button"
      :tabindex="disabled || spinning || loading ? -1 : 0"
      :aria-disabled="disabled || spinning || loading ? 'true' : 'false'"
      @click="handleSpin"
      @keydown.enter.prevent="handleSpin"
      @keydown.space.prevent="handleSpin"
    >
      <div class="wheel-pointer" :class="{ spinning: spinning || loading }">
        <span class="pointer-arrow">▼</span>
      </div>
      <div class="wheel-btn" :class="{ disabled: disabled || spinning || loading, loading }">
        <!--
          delayed：join 氛围；instant：spin 成功后对准 prizeIndex 停扇（docs/116）。
          空闲=立即参与/抽奖；loading=提交中；spinning=旋转中。
        -->
        <span v-if="loading" class="wheel-btn-label">{{ $t('lottery.gameWheelSubmitting') }}</span>
        <span v-else-if="spinning" class="wheel-btn-label">{{
          targetSectorIndex != null ? $t('lottery.gameWheelDrawing') : $t('lottery.gameWheelCelebrating')
        }}</span>
        <span v-else class="wheel-btn-label wheel-btn-label--join">{{ $t('lottery.gameWheelJoin') }}</span>
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
  targetSectorIndex: null,
})
const emit = defineEmits<GameEmits>()

const wheelCanvasRef = ref<HTMLCanvasElement>()
const spinning = ref(false)
const canvasSize = 320
/** 避免 celebrateKey 初始 0 触发一次空庆祝 */
let lastCelebrate = 0
/** loading 期间慢速 idle 旋转的 rAF id */
let idleRaf = 0

const sliceAngle = computed(() => (2 * Math.PI) / Math.max(props.prizes.length, 1))
/** 外圈灯：提交中或庆祝旋转都亮，给即时反馈 */
const lightsActive = computed(() => spinning.value || props.loading)

const COLORS = [
  ['#FF6B6B', '#FF8E8E'], ['#FFD93D', '#FFE570'], ['#6BCB77', '#8FD99A'],
  ['#4D96FF', '#7AB4FF'], ['#9B59B6', '#BB8FCE'], ['#FF8C42', '#FFAB70'],
  ['#00D2FF', '#5CE0FF'], ['#FF4DA6', '#FF80C0'],
]

function getColors(i: number) { return COLORS[i % COLORS.length]! }

function currentRot(): number {
  return parseFloat(wheelCanvasRef.value?.dataset?.rot || '0') || 0
}

function drawWheel(rotation: number) {
  const cvs = wheelCanvasRef.value; if (!cvs) return
  const ctx = cvs.getContext('2d'); if (!ctx) return
  const cx = cvs.width / 2, cy = cvs.height / 2, r = cx - 6
  ctx.clearRect(0, 0, cvs.width, cvs.height)

  const n = Math.max(props.prizes.length, 1)
  for (let i = 0; i < n; i++) {
    const sa = i * sliceAngle.value + rotation, ea = sa + sliceAngle.value
    const [c1, c2] = getColors(i)
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r)
    g.addColorStop(0, c1); g.addColorStop(1, c2)

    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, sa, ea); ctx.closePath()
    ctx.fillStyle = g; ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 2; ctx.stroke()

    const mid = sa + sliceAngle.value / 2
    const tx = cx + Math.cos(mid) * r * 0.62
    const ty = cy + Math.sin(mid) * r * 0.62
    ctx.save(); ctx.translate(tx, ty); ctx.rotate(mid + Math.PI / 2)
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px system-ui'
    ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 3
    // 空名用中性「·」，禁止硬编码「奖品」——delayed 仪式壳与 i18n 语言无关（docs/128）
    const name = String(props.prizes[i]?.name || '·').trim() || '·'
    // 四字短语完整显示；更长截断（中文扇面可读上限约 6）
    const label = name.length > 6 ? name.slice(0, 6) + '…' : name
    ctx.fillText(label, 0, 0)
    ctx.restore()
  }

  ctx.beginPath(); ctx.arc(cx, cy, 32, 0, 2 * Math.PI)
  const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32)
  g2.addColorStop(0, '#fff'); g2.addColorStop(1, '#e0e0e0')
  ctx.fillStyle = g2; ctx.fill()
  ctx.strokeStyle = '#ccc'; ctx.lineWidth = 2; ctx.stroke()
}

function stopIdleSpin() {
  if (idleRaf) {
    cancelAnimationFrame(idleRaf)
    idleRaf = 0
  }
}

/**
 * 提交中慢速 idle 旋转：用户点中心后立刻看到盘在动，
 * 而不是等 OTP/网络才 celebrate（docs/093 时机问题）。
 * 不表示开奖结果；成功后由 runCelebrateSpin 接棒加速减速。
 */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function startIdleSpin() {
  stopIdleSpin()
  // 无障碍：减少动态时仅靠按钮脉冲/文案，不持续转盘
  if (prefersReducedMotion()) return
  const tick = () => {
    if (!props.loading || spinning.value) {
      idleRaf = 0
      return
    }
    const rot = (currentRot() + 0.04) % (Math.PI * 2)
    drawWheel(rot)
    if (wheelCanvasRef.value) wheelCanvasRef.value.dataset.rot = String(rot)
    idleRaf = requestAnimationFrame(tick)
  }
  idleRaf = requestAnimationFrame(tick)
}

/** 点击：只表达参与/抽奖意图；不在此处开庆祝旋转（等 celebrateKey） */
function handleSpin() {
  if (spinning.value || props.disabled || props.loading) return
  emit('play')
}

/**
 * 计算停角：指针在顶部（-π/2）。
 * 扇区 i 中心相对 canvas 0° 为 i*slice + slice/2；
 * 最终旋转使该中心落在指针下。
 */
function rotationDeltaForSector(sectorIndex: number, startRot: number): number {
  const n = Math.max(props.prizes.length, 1)
  const idx = ((Math.floor(sectorIndex) % n) + n) % n
  const slice = (2 * Math.PI) / n
  // 扇区中心角（未旋转时，从正 x 轴）
  const centerAtZero = idx * slice + slice / 2
  // 指针在 -π/2（顶部）；需要 rotation 使 centerAtZero + rot ≡ -π/2 (mod 2π)
  const desired = -Math.PI / 2 - centerAtZero
  // 从 startRot 正向多转至少 5 圈再落到 desired
  const turns = 5 + Math.random() * 2
  let delta = desired - (startRot % (Math.PI * 2))
  while (delta < Math.PI * 2 * turns) delta += Math.PI * 2
  return delta
}

/**
 * 参与/spin 成功后的旋转。
 * - 有 targetSectorIndex：对准服务端 prizeIndex（instant）
 * - 无：随机停角（delayed 氛围，不代表中奖）
 */
async function runCelebrateSpin() {
  if (spinning.value) return
  stopIdleSpin()
  spinning.value = true
  const startRot = currentRot()
  const hasTarget =
    props.targetSectorIndex != null &&
    Number.isFinite(Number(props.targetSectorIndex)) &&
    props.prizes.length > 0
  const targetAngle = hasTarget
    ? rotationDeltaForSector(Number(props.targetSectorIndex), startRot)
    : Math.PI * 2 * (5 + Math.random())
  const duration = hasTarget ? 3200 : 2800
  const start = performance.now()

  if (prefersReducedMotion()) {
    // 无障碍：直接跳到终态，不播长动画
    const finalRot = (startRot + targetAngle) % (Math.PI * 2)
    drawWheel(finalRot)
    if (wheelCanvasRef.value) wheelCanvasRef.value.dataset.rot = String(finalRot)
    spinning.value = false
    return
  }

  await new Promise<void>(resolve => {
    const tick = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const rot = startRot + targetAngle * eased
      drawWheel(rot % (Math.PI * 2))
      if (wheelCanvasRef.value) wheelCanvasRef.value.dataset.rot = String(rot)
      if (progress < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
  spinning.value = false
}

watch(() => props.prizes, () => drawWheel(currentRot()), { immediate: true })

watch(() => props.loading, (loading) => {
  if (loading && !spinning.value) startIdleSpin()
  else if (!loading) stopIdleSpin()
})

watch(() => props.celebrateKey, (key) => {
  const n = Number(key) || 0
  if (n <= 0 || n === lastCelebrate) return
  lastCelebrate = n
  void runCelebrateSpin()
})

onUnmounted(() => {
  stopIdleSpin()
})
</script>

<style scoped>
.lucky-wheel-container {
  position: relative;
  width: min(360px, 92vw);
  height: min(360px, 92vw);
  margin: 0 auto;
  max-width: 100%;
}
.wheel-canvas {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(320px, 82vw);
  height: min(320px, 82vw);
  transform: translate(-50%, -50%);
  border-radius: 50%;
  filter: drop-shadow(0 0 20px rgba(245,158,11,0.3));
}
.wheel-lights { position: absolute; top: 50%; left: 50%; }
.light-dot { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: var(--brand-bright); box-shadow: 0 0 6px var(--brand-bright); }
.light-dot.active { animation: blink 0.5s infinite alternate; }
@keyframes blink { to { opacity: 0.3; transform: scale(0.7); } }
.wheel-pointer-wrap { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 10; cursor: pointer; }
.wheel-pointer { width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-top: 22px solid var(--brand); margin: 0 auto -2px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); }
.wheel-pointer.spinning { animation: bounce 0.1s infinite alternate; }
@keyframes bounce { to { transform: translateY(-2px); } }
.wheel-btn {
  width: 56px;
  height: 56px;
  min-width: 44px;
  min-height: 44px;
  border-radius: 50%;
  background: var(--brand-gradient);
  color: var(--brand-text);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.15;
  border: 3px solid #fff;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  transition: transform 0.2s;
}
.wheel-btn-label { white-space: pre-line; display: block; max-width: 44px; }
.wheel-btn-label--join { font-size: 11px; }
.wheel-btn:not(.disabled):hover { transform: scale(1.1); }
.wheel-btn:not(.disabled):active { transform: scale(0.95); }
.wheel-btn.disabled { opacity: 0.5; cursor: not-allowed; }
/* 提交中：按钮仍醒目，脉冲表示「在处理」而非死灰 */
.wheel-btn.loading {
  opacity: 1;
  cursor: wait;
  animation: wheelBtnPulse 1s ease-in-out infinite;
}
@keyframes wheelBtnPulse {
  0%, 100% { box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35); }
  50% { box-shadow: 0 4px 28px rgba(245, 158, 11, 0.65); }
}

@media (max-width: 640px) {
  .wheel-btn {
    width: 60px;
    height: 60px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wheel-btn.loading { animation: none; }
  .light-dot.active { animation: none; }
  .wheel-pointer.spinning { animation: none; }
  .wheel-btn:not(.disabled):hover { transform: none; }
}
</style>
