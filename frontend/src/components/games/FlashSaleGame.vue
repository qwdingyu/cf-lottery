<template>
  <div class="flash-sale-game" data-testid="flash-sale-game">
    <!-- 场次 + 倒计时：时间来自活动 startAt/endAt，不是伪造 -->
    <div v-if="sessionLabel || (showCountdown && countdownText)" class="flash-header">
      <span v-if="sessionLabel" class="flash-session">{{ sessionLabel }}</span>
      <span
        v-if="showCountdown && countdownText"
        class="flash-countdown"
        :class="{ ended: phase === 'ended', soon: phase === 'running' }"
      >
        {{ countdownText }}
      </span>
    </div>

    <div v-if="showProgress && effectiveStockLimit != null" class="flash-progress-wrap">
      <div class="flash-progress-track" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
        <div class="flash-progress-fill" :style="{ width: progressPercent + '%' }" />
      </div>
      <span class="flash-progress-label">{{ $t('lottery.flashClaimedPercent', { n: progressPercent }) }}</span>
    </div>

    <p v-if="showStock && remaining != null" class="flash-stock">
      {{ $t('lottery.flashRemaining', { n: remaining }) }}
    </p>

    <!-- 低库存紧迫提示（docs/240）：数据来自公开 API 剩余计数，不是本地造假；
         剩余 ≤10 提醒「抢完即止」，≤5 进入二级紧迫文案。
         仅 running 阶段显示：upcoming（未开始）时剩余=stockLimit-0 会误报低库存，
         ended/已参与（disabled）时紧迫文案无意义且会与按钮终态矛盾。 -->
    <p
      v-if="isLowStock && phase === 'running' && !disabled"
      class="flash-urgency"
      :class="{ critical: isCriticallyLow }"
      role="status"
    >
      {{ isCriticallyLow
        ? $t('lottery.flashUrgencyCritical', { n: remaining })
        : $t('lottery.flashUrgencyLowStock', { n: remaining }) }}
    </p>

    <!-- 主 CTA：直付活动在「已锁名额待支付/限购用尽」阶段由父组件置 hideCta，
         购买入口收敛到底部支付按钮，避免出现第二个看似可再抢一次的入口（docs/257） -->
    <button
      v-if="!hideCta"
      type="button"
      class="btn btn-primary btn-lg flash-btn"
      :class="{ loading, joined: disabled && !loading, soldout: isSoldOut, urgent: isCriticallyLow && phase === 'running' && !disabled }"
      :disabled="disabled || loading || isSoldOut || phase === 'ended' || phase === 'upcoming'"
      @click="emit('play')"
    >
      <span v-if="loading" class="flash-spinner" aria-hidden="true" />
      {{ buttonLabel }}
    </button>

    <!-- 售罄后引导（docs/240）：不提供「预约下一场」假按钮（后端无预约能力），
         仅如实提示本场结束，避免制造无法兑现的交互。 -->
    <p v-if="isSoldOut" class="flash-soldout-hint">
      {{ $t('lottery.flashSoldOutHintNext') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 秒杀体验壳（docs/130）
 *
 * - 只负责展示倒计时/进度/「抢」并 emit('play')
 * - 不调用支付、不扣 shop 库存；join 由 LotteryView 主路径完成
 * - progress / remaining 来自公开 API 的 flashSale 运行时块（entries 真实计数）
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GameProps, GameEmits, FlashSaleDisplay } from './types'

const props = withDefaults(
  defineProps<
    GameProps & {
      flashSale?: FlashSaleDisplay | null
      /** 活动开始 ISO；倒计时用 */
      startAt?: string | null
      endAt?: string | null
    }
  >(),
  {
    disabled: false,
    loading: false,
    celebrateKey: 0,
    flashSale: null,
    startAt: null,
    endAt: null,
  },
)
const emit = defineEmits<GameEmits>()
const { t } = useI18n()

const nowMs = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
})

watch(
  () => props.celebrateKey,
  () => {
    /* 参与成功氛围：秒杀壳保持简洁，不播长动画（诚实：抢的是名额不是中奖） */
  },
)

const sessionLabel = computed(() => String(props.flashSale?.sessionLabel || '').trim())
const showCountdown = computed(() => props.flashSale?.showCountdown !== false)
const showProgress = computed(() => props.flashSale?.showProgress !== false)
const showStock = computed(() => props.flashSale?.showStock !== false)
/** 父组件（LotteryView）按直付购买阶段决定是否收起「抢」按钮 */
const hideCta = computed(() => props.flashSale?.hideCta === true)
const progressPercent = computed(() => {
  const n = Number(props.flashSale?.progressPercent)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(100, Math.floor(n))
})
const remaining = computed(() => {
  const r = props.flashSale?.remaining
  if (r === null || r === undefined) return null
  const n = Number(r)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null
})
const effectiveStockLimit = computed(() => {
  const s = props.flashSale?.effectiveStockLimit ?? props.flashSale?.stockLimit
  if (s === null || s === undefined) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
})
const isSoldOut = computed(() => remaining.value === 0 && effectiveStockLimit.value != null)

// 低库存紧迫度（docs/240）：≤10 显示紧迫提示，≤5 进入二级高亮（按钮变红+脉动）
const isLowStock = computed(() => remaining.value != null && remaining.value > 0 && remaining.value <= 10)
const isCriticallyLow = computed(() => remaining.value != null && remaining.value > 0 && remaining.value <= 5)

const phase = computed<'upcoming' | 'running' | 'ended' | 'unknown'>(() => {
  const start = props.startAt ? Date.parse(props.startAt) : NaN
  const end = props.endAt ? Date.parse(props.endAt) : NaN
  const now = nowMs.value
  if (Number.isFinite(start) && now < start) return 'upcoming'
  if (Number.isFinite(end) && now > end) return 'ended'
  if (Number.isFinite(start) || Number.isFinite(end)) return 'running'
  return 'unknown'
})

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

const countdownText = computed(() => {
  if (!showCountdown.value) return ''
  const start = props.startAt ? Date.parse(props.startAt) : NaN
  const end = props.endAt ? Date.parse(props.endAt) : NaN
  const now = nowMs.value
  if (phase.value === 'upcoming' && Number.isFinite(start)) {
    return t('lottery.flashStartsIn', { time: formatDuration(start - now) })
  }
  if (phase.value === 'running' && Number.isFinite(end)) {
    return t('lottery.flashEndsIn', { time: formatDuration(end - now) })
  }
  if (phase.value === 'ended') {
    return t('lottery.flashEnded')
  }
  return ''
})

const buttonLabel = computed(() => {
  if (props.loading) return t('lottery.gameSubmitSubmitting')
  if (props.disabled) return t('lottery.gameSubmitJoined')
  if (isSoldOut.value) return t('lottery.flashSoldOut')
  if (phase.value === 'ended') return t('lottery.flashEnded')
  if (phase.value === 'upcoming') return t('lottery.flashNotStarted')
  const custom = String(props.flashSale?.ctaLabel || '').trim()
  // 低库存时按钮文案带剩余数（docs/240）：如「立即抢购（仅剩 3 份）」。
  // 仅 running 且未参与时生效——upcoming/ended/已参与走上方终态分支，不覆盖。
  if (isCriticallyLow.value && phase.value === 'running' && !props.disabled && remaining.value != null) {
    return t('lottery.flashGrabUrgent', { n: remaining.value })
  }
  return custom || t('lottery.flashGrab')
})
</script>

<style scoped>
.flash-sale-game {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  padding: 12px 0 8px;
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
}
.flash-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.flash-session {
  font-weight: 700;
  font-size: 15px;
  color: #e11d48;
  border: 1.5px solid #e11d48;
  border-radius: 8px;
  padding: 4px 10px;
}
.flash-countdown {
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  font-weight: 600;
  /* 暗色主题下的促销药丸：玫红字 + 同族半透明底，不再是全站唯一浅色块 */
  color: var(--shop-sale-text, #fecdd3);
  background: var(--shop-sale-soft, rgba(244, 63, 94, 0.16));
  border: 1px solid var(--shop-sale-border, rgba(244, 63, 94, 0.42));
  border-radius: 8px;
  padding: 4px 10px;
}
.flash-countdown.ended {
  color: var(--tg-hint, #9aa4b2);
  background: var(--surface-2, rgba(255, 255, 255, 0.07));
  border-color: var(--border, rgba(255, 255, 255, 0.10));
}
.flash-countdown.soon {
  color: #fff1f2;
  background: #be123c;
  border-color: #fb7185;
  font-weight: 800;
  box-shadow: 0 6px 18px rgba(225, 29, 72, 0.18);
}
.flash-progress-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.flash-progress-track {
  flex: 1;
  height: 10px;
  border-radius: 999px;
  /* 暗色轨道：玫红同族低透明底，保持填充前后的同色系对比 */
  background: var(--shop-sale-soft, rgba(244, 63, 94, 0.16));
  overflow: hidden;
}
.flash-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #fb7185, #e11d48);
  transition: width 0.35s ease;
}
.flash-progress-label {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  white-space: nowrap;
}
.flash-stock {
  margin: 0;
  font-size: 13px;
  color: var(--shop-sale, #fb7185);
  text-align: center;
}
/* 低库存紧迫提示（docs/240）：橙色提醒，≤5 转红色 + 脉动 */
.flash-urgency {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  color: #f59e0b;
}
.flash-urgency.critical {
  color: #f43f5e;
  animation: flashUrgencyPulse 1.2s ease-in-out infinite;
}
@keyframes flashUrgencyPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
/* 售罄引导（docs/240）：如实提示本场结束，不提供无法兑现的「预约」按钮 */
.flash-soldout-hint {
  margin: 0;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
  text-align: center;
}
.flash-btn.urgent {
  background: linear-gradient(90deg, #f43f5e, #be123c) !important;
  box-shadow: 0 0 0 2px rgba(244, 63, 94, 0.35);
  animation: flashUrgencyPulse 1.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .flash-urgency.critical,
  .flash-btn.urgent {
    animation: none;
  }
}
.flash-btn {
  min-height: 48px;
  font-size: 17px;
  font-weight: 700;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: linear-gradient(90deg, #f43f5e, #e11d48) !important;
  border: none !important;
  border-radius: 12px !important;
}
.flash-btn:active:not(:disabled) {
  transform: translateY(1px) scale(0.99);
}
.flash-btn.loading {
  cursor: wait;
  opacity: 1;
}
.flash-btn.joined,
.flash-btn.soldout {
  opacity: 0.55;
  cursor: default;
  /* 终态降级为暗色中性底，文字仍可读；不再用浅灰 #94a3b8 造成「浅色补丁」 */
  background: var(--surface-2, rgba(255, 255, 255, 0.07)) !important;
  color: var(--tg-hint, #9aa4b8);
}
.flash-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: flashSpin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes flashSpin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .flash-progress-fill {
    transition: none;
  }
  .flash-spinner {
    animation: none;
    opacity: 0.7;
  }
}
</style>
