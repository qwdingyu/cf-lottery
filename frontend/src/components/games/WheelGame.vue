<template>
  <div class="lucky-wheel-container">
    <div class="wheel-wrapper">
      <!-- 转盘 -->
      <canvas
        ref="wheelCanvasRef"
        class="wheel-canvas"
        :width="canvasSize"
        :height="canvasSize"
      />
      <!-- 指针 -->
      <div
        class="wheel-pointer"
        role="button"
        :tabindex="disabled ? -1 : 0"
        :aria-label="spinning ? '抽奖中' : '点击开始抽奖'"
        :aria-disabled="disabled || spinning"
        @click="handleSpin"
        @keydown.enter="handleSpin"
        @keydown.space.prevent="handleSpin"
      >
        <span class="pointer-text">{{ spinning ? '...' : '抽奖' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { PrizeItem } from './types'

const props = defineProps<{
  prizes: PrizeItem[]
  disabled?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{ play: [] }>()

const wheelCanvasRef = ref<HTMLCanvasElement>()
const spinning = ref(false)
const canvasSize = 300

/** 每份的角度 */
const sliceAngle = computed(() => (2 * Math.PI) / Math.max(props.prizes.length, 1))

/** 默认配色 */
const defaultColors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

/** 获取奖品颜色 */
function getColor(index: number): string {
  return props.prizes[index]?.color || defaultColors[index % defaultColors.length]!
}

/** 绘制转盘 */
function drawWheel(rotation: number = 0) {
  const canvas = wheelCanvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const radius = cx - 10

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // 绘制扇形
  for (let i = 0; i < props.prizes.length; i++) {
    const startAngle = i * sliceAngle.value + rotation
    const endAngle = startAngle + sliceAngle.value

    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, radius, startAngle, endAngle)
    ctx.closePath()
    ctx.fillStyle = getColor(i)
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.stroke()

    // 文字
    const textAngle = startAngle + sliceAngle.value / 2
    const textRadius = radius * 0.65
    const tx = cx + Math.cos(textAngle) * textRadius
    const ty = cy + Math.sin(textAngle) * textRadius

    ctx.save()
    ctx.translate(tx, ty)
    ctx.rotate(textAngle + Math.PI / 2)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'center'
    const name = props.prizes[i]?.name || '?'
    ctx.fillText(name.length > 6 ? name.slice(0, 5) + '…' : name, 0, 0)
    ctx.restore()
  }

  // 中心圆
  ctx.beginPath()
  ctx.arc(cx, cy, 30, 0, 2 * Math.PI)
  ctx.fillStyle = '#1e293b'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 3
  ctx.stroke()
}

/** 旋转动画 */
async function spinAnimation(targetIndex: number) {
  const totalRotation = 2 * Math.PI * 5 + (2 * Math.PI - targetIndex * sliceAngle.value)
  const duration = 4000
  const startTime = performance.now()

  return new Promise<void>((resolve) => {
    function animate(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3)
      const rotation = totalRotation * eased
      drawWheel(rotation)
      if (progress < 1) {
        requestAnimationFrame(animate)
      } else {
        resolve()
      }
    }
    requestAnimationFrame(animate)
  })
}

async function handleSpin() {
  if (spinning.value || props.disabled) return
  spinning.value = true
  emit('play')
  // 随机旋转目标（不关联奖品列表），避免用户误以为停下的位置代表中奖结果
  const randomTarget = Math.floor(Math.random() * 360 / sliceAngle.value)
  await spinAnimation(randomTarget)
  spinning.value = false
}

onMounted(() => {
  drawWheel()
})

watch(() => props.prizes, () => {
  drawWheel()
}, { deep: true })
</script>

<style scoped>
.lucky-wheel-container {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}

.wheel-wrapper {
  position: relative;
  width: v-bind(canvasSize + 'px');
  height: v-bind(canvasSize + 'px');
}

.wheel-canvas {
  display: block;
}

.wheel-pointer {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg, #f43f5e, #e11d48);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(244, 63, 94, 0.4);
  z-index: 2;
  transition: transform 0.2s;
  user-select: none;
}

.wheel-pointer:hover {
  transform: translate(-50%, -50%) scale(1.08);
}

.wheel-pointer:active {
  transform: translate(-50%, -50%) scale(0.95);
}
</style>