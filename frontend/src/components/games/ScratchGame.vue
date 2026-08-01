<template>
  <div class="scratch-game">
    <div class="scratch-card">
      <!-- 底层：奖品内容 -->
      <div class="scratch-prize">
        <span class="prize-icon">🎁</span>
        <span class="prize-text">已参与 ✓</span>
      </div>
      <!-- 上层：涂层（Canvas 刮开） -->
      <canvas
        ref="canvasRef"
        class="scratch-canvas"
        :width="300"
        :height="200"
        role="img"
        :aria-label="scratched ? '已刮开' : '刮开涂层参与抽奖'"
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
    <p v-if="!scratched" class="scratch-hint">刮开涂层参与抽奖</p>
    <button
      v-if="scratched"
      type="button"
      class="btn btn-primary btn-sm scratch-join-btn"
      :disabled="disabled"
      @click="emit('play')"
    >
      参与抽奖
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface PrizeItem { name: string; color?: string }

const props = defineProps<{ prizes: PrizeItem[]; disabled?: boolean }>()
const emit = defineEmits<{ play: [] }>()

const canvasRef = ref<HTMLCanvasElement>()
const scratched = ref(false)
const isDrawing = ref(false)

/** 展示参与状态（不展示随机奖品，避免误导用户以为已中奖） */
const prizeName = ref('')

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
  ctx.fillText('刮开此处', canvas.width / 2, canvas.height / 2 + 6)
  ctx.fillStyle = '#475569'
  ctx.font = '12px sans-serif'
  ctx.fillText('(用手指滑动)', canvas.width / 2, canvas.height / 2 + 30)
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

function checkScratched() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let transparent = 0
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] === 0) transparent++
  }
  if (transparent / (imageData.data.length / 4) > 0.4) {
    scratched.value = true
  }
}

function getPos(e: MouseEvent) { return { x: e.offsetX, y: e.offsetY } }
function getTouchPos(e: TouchEvent) {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: e.touches[0]!.clientX - rect.left, y: e.touches[0]!.clientY - rect.top }
}

function startScratch(e: MouseEvent) { isDrawing.value = true; scratchAt(e.offsetX, e.offsetY) }
function scratch(e: MouseEvent) { if (isDrawing.value) scratchAt(e.offsetX, e.offsetY) }
function endScratch() { isDrawing.value = false; checkScratched() }
function startTouchScratch(e: TouchEvent) { isDrawing.value = true; scratchAt(getTouchPos(e).x, getTouchPos(e).y) }
function touchScratch(e: TouchEvent) {
  if (isDrawing.value) { const p = getTouchPos(e); scratchAt(p.x, p.y) }
}
function quickScratch() {
  if (scratched.value || isDrawing.value) return
  // 键盘/无障碍快捷刮开
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, 300, 200)
  scratched.value = true
  emit('play')
}
function checkScratched() {
  if (scratched.value) return
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const imageData = ctx.getImageData(0, 0, 300, 200)
  let transparent = 0
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i]! < 128) transparent++
  }
  if (transparent / (300 * 200) > 0.5) {
    scratched.value = true
    emit('play')
  }
}

onMounted(initCanvas)
</script>

<style scoped>
.scratch-game { display: flex; flex-direction: column; align-items: center; padding: 20px 0; gap: 12px; }
.scratch-card { position: relative; width: 300px; height: 200px; border-radius: 12px; overflow: hidden; }
.scratch-prize { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: linear-gradient(135deg, #fef3c7, #fde68a); }
.prize-icon { font-size: 40px; }
.prize-text { font-size: 18px; font-weight: 700; color: #92400e; margin-top: 8px; }
.scratch-canvas { position: absolute; inset: 0; cursor: pointer; }
.scratch-hint { color: var(--tg-hint); font-size: 13px; }
.scratch-join-btn { margin-top: 4px; }
</style>