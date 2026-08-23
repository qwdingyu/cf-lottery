<template>
  <div class="checkin-calendar">
    <!-- 签到统计区 -->
    <div class="checkin-stats">
      <div class="stat-item">
        <span class="stat-value">{{ currentStreak }}</span>
        <span class="stat-label">{{ $t('lottery.checkinCurrentStreak') }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ monthlyCount }}</span>
        <span class="stat-label">{{ $t('lottery.checkinMonthlyCount') }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ maxStreak }}</span>
        <span class="stat-label">{{ $t('lottery.checkinMaxStreak') }}</span>
      </div>
    </div>

    <!-- 月份导航 -->
    <div class="calendar-nav">
      <button type="button" class="nav-btn" @click="prevMonth" :disabled="isPrevDisabled">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M10.354 3.354a.5.5 0 00-.708-.708l-5 5a.5.5 0 000 .708l5 5a.5.5 0 00.708-.708L5.707 8l4.647-4.646z"/>
        </svg>
      </button>
      <span class="month-label">{{ monthLabel }}</span>
      <button type="button" class="nav-btn" @click="nextMonth" :disabled="isNextDisabled">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5.646 3.354a.5.5 0 01.708-.708l5 5a.5.5 0 010 .708l-5 5a.5.5 0 01-.708-.708L10.293 8 5.646 3.354z"/>
        </svg>
      </button>
    </div>

    <!-- 星期标题 -->
    <div class="calendar-weekdays">
      <span v-for="day in weekDays" :key="day" class="weekday">{{ day }}</span>
    </div>

    <!-- 日期网格 -->
    <div class="calendar-grid">
      <div
        v-for="(day, idx) in calendarDays"
        :key="idx"
        class="calendar-day"
        :class="{
          'is-empty': !day.date,
          'is-today': day.isToday,
          'is-signed': day.isSigned,
          'is-future': day.isFuture,
          'is-prev-month': day.isPrevMonth,
        }"
      >
        <span v-if="day.date" class="day-number">{{ day.day }}</span>
        <span v-if="day.isSigned" class="day-check" aria-hidden="true">✓</span>
      </div>
    </div>

    <!-- 今日签到状态 -->
    <div class="checkin-today" :class="{ signed: signedToday }">
      <span v-if="signedToday" class="today-status">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/>
        </svg>
        {{ $t('lottery.checkinSignedToday') }}
      </span>
      <span v-else class="today-status pending">
        {{ $t('lottery.checkinNotSignedToday') }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t: $t } = useI18n()

/** 签到状态 API 响应 */
export interface CheckinStatusData {
  signedDates: string[]      // 本月已签到日期列表（YYYY-MM-DD）
  currentStreak: number      // 当前连续签到天数
  maxStreak: number          // 历史最长连续签到天数
  monthlyCount: number       // 本月签到天数
  signedToday: boolean       // 今日是否已签到
  month: string              // 当前查询月份（YYYY-MM）
}

interface CalendarDay {
  date: string | null        // YYYY-MM-DD 或 null（空位）
  day: number
  isToday: boolean
  isSigned: boolean
  isFuture: boolean
  isPrevMonth: boolean
}

const props = defineProps<{
  /** 活动 slug */
  slug: string
  /** 当前用户邮箱（用于 API 查询） */
  email?: string
}>()

const emit = defineEmits<{
  /** 签到状态刷新后触发（父组件可据此更新参与状态） */
  'status-refresh': [data: CheckinStatusData]
}>()

// ── 状态 ──
const currentMonth = ref<string>(getInitialMonth())
const signedDates = ref<Set<string>>(new Set())
const currentStreak = ref(0)
const maxStreak = ref(0)
const monthlyCount = ref(0)
const signedToday = ref(false)
const loading = ref(false)

// ── 常量 ──
const weekDays = computed(() => [
  $t('lottery.calWeekSun'),
  $t('lottery.calWeekMon'),
  $t('lottery.calWeekTue'),
  $t('lottery.calWeekWed'),
  $t('lottery.calWeekThu'),
  $t('lottery.calWeekFri'),
  $t('lottery.calWeekSat'),
])

const monthLabel = computed(() => {
  const [y, m] = currentMonth.value.split('-')
  return `${y}年${parseInt(m, 10)}月`
})

const isPrevDisabled = computed(() => {
  const [y, m] = currentMonth.value.split('-').map(Number)
  const now = new Date()
  return y === now.getFullYear() && m === now.getMonth() + 1
})

const isNextDisabled = computed(() => {
  const [y, m] = currentMonth.value.split('-').map(Number)
  const now = new Date()
  return y === now.getFullYear() && m === now.getMonth() + 1
})

// ── 日历网格计算 ──
const calendarDays = computed<CalendarDay[]>(() => {
  const [year, month] = currentMonth.value.split('-').map(Number)
  const firstDay = new Date(year, month - 1, 1)
  const lastDay = new Date(year, month, 0)
  const startWeekday = firstDay.getDay() // 0=周日
  const totalDays = lastDay.getDate()

  const days: CalendarDay[] = []

  // 上月补位
  const prevMonthLastDay = new Date(year, month - 1, 0).getDate()
  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = prevMonthLastDay - i
    const dateStr = formatDate(year, month - 1, d)
    days.push({
      date: dateStr,
      day: d,
      isToday: false,
      isSigned: signedDates.value.has(dateStr),
      isFuture: false,
      isPrevMonth: true,
    })
  }

  // 本月日期
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = formatDate(year, month, d)
    const dateObj = new Date(year, month - 1, d)
    const todayObj = new Date()
    const isToday = dateObj.getFullYear() === todayObj.getFullYear()
      && dateObj.getMonth() === todayObj.getMonth()
      && dateObj.getDate() === todayObj.getDate()
    const isFuture = dateObj > todayObj

    days.push({
      date: dateStr,
      day: d,
      isToday,
      isSigned: signedDates.value.has(dateStr),
      isFuture,
      isPrevMonth: false,
    })
  }

  // 下月补位（凑满 6 行 = 42 格）
  const remaining = 42 - days.length
  for (let d = 1; d <= remaining; d++) {
    const dateStr = formatDate(year, month + 1, d)
    days.push({
      date: dateStr,
      day: d,
      isToday: false,
      isSigned: signedDates.value.has(dateStr),
      isFuture: true,
      isPrevMonth: false,
    })
  }

  return days
})

// ── 工具函数 ──
function getInitialMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatDate(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── API 调用 ──
async function fetchCheckinStatus(): Promise<void> {
  if (!props.slug) return
  loading.value = true
  try {
    const params = new URLSearchParams({ month: currentMonth.value })
    if (props.email) params.set('email', props.email)
    const resp = await fetch(`/api/public/lottery/${props.slug}/checkin-status?${params}`)
    if (!resp.ok) return
    const result = await resp.json()
    if (!result?.success || !result?.data) return

    const data = result.data as CheckinStatusData
    signedDates.value = new Set(data.signedDates || [])
    currentStreak.value = data.currentStreak || 0
    maxStreak.value = data.maxStreak || 0
    monthlyCount.value = data.monthlyCount || 0
    signedToday.value = data.signedToday || false

    emit('status-refresh', data)
  } catch {
    /* 网络错误静默处理，不阻断主流程 */
  } finally {
    loading.value = false
  }
}

// ── 月份切换 ──
function prevMonth(): void {
  const [y, m] = currentMonth.value.split('-').map(Number)
  if (m === 1) {
    currentMonth.value = `${y - 1}-12`
  } else {
    currentMonth.value = `${y}-${String(m - 1).padStart(2, '0')}`
  }
}

function nextMonth(): void {
  const [y, m] = currentMonth.value.split('-').map(Number)
  if (m === 12) {
    currentMonth.value = `${y + 1}-01`
  } else {
    currentMonth.value = `${y}-${String(m + 1).padStart(2, '0')}`
  }
}

// ── 监听月份变化 ──
watch(currentMonth, () => fetchCheckinStatus())

// ── 挂载时加载 ──
onMounted(() => fetchCheckinStatus())

// ── 暴露刷新方法供父组件调用（签到成功后刷新日历） ──
defineExpose({ refresh: fetchCheckinStatus })
</script>

<style scoped>
.checkin-calendar {
  width: 100%;
  max-width: 360px;
  margin: 0 auto;
  padding: 16px;
  background: var(--bg-card, #fff);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

/* ── 统计区 ── */
.checkin-stats {
  display: flex;
  justify-content: space-around;
  margin-bottom: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color, #eee);
}
.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--primary-color, #f59e0b);
  line-height: 1;
}
.stat-label {
  font-size: 12px;
  color: var(--text-secondary, #888);
}

/* ── 月份导航 ── */
.calendar-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.nav-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-primary, #333);
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}
.nav-btn:hover:not(:disabled) {
  background: var(--bg-hover, #f5f5f5);
}
.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.month-label {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #333);
}

/* ── 星期标题 ── */
.calendar-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}
.weekday {
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary, #888);
  padding: 4px 0;
}

/* ── 日期网格 ── */
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.calendar-day {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 14px;
  color: var(--text-primary, #333);
  transition: all 0.15s;
}
.calendar-day.is-empty {
  visibility: hidden;
}
.calendar-day.is-prev-month,
.calendar-day.is-future {
  color: var(--text-disabled, #ccc);
}
.calendar-day.is-today {
  background: var(--primary-light, #fef3c7);
  font-weight: 700;
}
.calendar-day.is-signed {
  background: var(--primary-color, #f59e0b);
  color: #fff;
  font-weight: 600;
}
.calendar-day.is-signed.is-today {
  background: var(--primary-dark, #d97706);
}
.day-check {
  position: absolute;
  bottom: 2px;
  right: 2px;
  font-size: 8px;
  line-height: 1;
}

/* ── 今日签到状态 ── */
.checkin-today {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  text-align: center;
  font-size: 13px;
  background: var(--bg-secondary, #f9fafb);
}
.checkin-today.signed {
  background: var(--success-light, #d1fae5);
  color: var(--success-color, #059669);
}
.today-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.today-status.pending {
  color: var(--text-secondary, #888);
}
</style>
