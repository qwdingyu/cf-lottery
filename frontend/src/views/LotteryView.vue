<template>
  <div class="lottery-view">
    <header class="page-header">
      <div class="page-header-main">
        <h1>{{ $t('lottery.title') }}</h1>
        <p class="page-subtitle">{{ $t('lottery.pageHint') }}</p>
        <div v-if="isDeepLinked" class="deep-link-bar">
          <RouterLink class="btn btn-ghost btn-sm" to="/lottery">
            {{ $t('lottery.backToAllDraws') }}
          </RouterLink>
          <button
            v-if="draws[0]"
            type="button"
            class="btn btn-ghost btn-sm"
            @click="handleCopyPublicLink(draws[0].id)"
          >
            {{ $t('lottery.copyShareLink') }}
          </button>
        </div>
      </div>
      <div class="session-bar">
        <template v-if="sessionEmail">
          <span class="session-email" :title="sessionEmail">{{ sessionEmail }}</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="handleLogout">
            {{ $t('lottery.logout') }}
          </button>
        </template>
        <button
          v-else
          type="button"
          class="btn btn-primary btn-sm"
          @click="openLogin()"
        >
          {{ $t('lottery.loginFirst') }}
        </button>
      </div>
    </header>

    <!-- 我的记录：登录后汇总参与/中奖，不必逐卡展开 -->
    <section v-if="sessionEmail" class="my-records" aria-labelledby="lottery-my-records">
      <div class="section-head">
        <h2 id="lottery-my-records" class="section-title">{{ $t('lottery.myRecords') }}</h2>
      </div>

      <div v-if="recordsLoading && sortedMyEntries.length === 0" class="records-empty">
        {{ '加载中…' }}
      </div>
      <div v-else-if="sortedMyEntries.length === 0" class="records-empty">
        {{ $t('lottery.noMyRecords') }}
      </div>
      <ul v-else class="records-list">
        <li v-for="row in sortedMyEntries" :key="row.drawId" class="record-row">
          <div class="record-main">
            <span class="record-name">{{ row.drawName || row.drawId }}</span>
            <span class="chip" :class="'chip-' + (row.drawStatus || 'open')">
              {{ statusLabel(row.drawStatus || 'open') }}
            </span>
            <span
              v-if="myWonById[row.drawId]"
              class="chip chip-won"
            >{{ $t('lottery.won') }}</span>
            <span
              v-else-if="row.drawStatus === 'drawn'"
              class="chip chip-muted"
            >{{ $t('lottery.notWon') }}</span>
            <span
              v-else
              class="chip chip-muted"
            >{{ $t('lottery.joined') }}</span>
          </div>
          <div class="record-meta">
            <span v-if="row.joinedAt">{{ $t('lottery.joinedAt') }}: {{ formatTime(row.joinedAt) }}</span>
            <span v-if="row.drawTime">{{ $t('lottery.drawTime') }}: {{ formatTime(row.drawTime) }}</span>
            <RouterLink
              v-if="myWonById[row.drawId]?.orderToken"
              class="order-link"
              :to="{ path: '/order', query: { token: myWonById[row.drawId].orderToken } }"
              @click.stop
            >
              {{ $t('lottery.checkOrder') }}
            </RouterLink>
            <button
              v-else
              type="button"
              class="btn btn-ghost btn-xs"
              @click="focusDraw(row.drawId)"
            >
              {{ $t('lottery.viewDraw') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <div v-else class="login-banner">
      <p>{{ $t('lottery.loginBanner') }}</p>
      <button type="button" class="btn btn-primary btn-sm" @click="openLogin()">
        {{ $t('lottery.loginFirst') }}
      </button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading-state">{{ '加载中…' }}</div>

    <!-- 活动列表 -->
    <div v-else-if="draws.length === 0" class="empty-state">
      <p>{{ $t('lottery.noDraws') }}</p>
    </div>

    <div v-else class="draw-list">
      <div
        v-for="draw in draws"
        :key="draw.id"
        class="draw-card"
        :class="{ expanded: expandedId === draw.id }"
        :id="'draw-' + draw.id"
      >
        <div class="draw-card-header" @click="toggleExpand(draw.id)">
          <div class="draw-card-info">
            <h3 class="draw-name">{{ draw.name }}</h3>
            <span class="chip" :class="'chip-' + draw.status">
              {{ statusLabel(draw.status) }}
            </span>
            <span v-if="hasEnded(draw)" class="chip chip-muted">{{ $t('lottery.ended') }}</span>
            <!-- 已满员标记（参与人数达上限） -->
            <span v-else-if="draw.maxParticipants && (draw.entryCount ?? 0) >= draw.maxParticipants" class="chip chip-muted">{{ $t('lottery.full') }}</span>
            <!-- 折叠态也展示个人状态，减少二次点击 -->
            <span v-if="myWonById[draw.id]" class="chip chip-won">{{ $t('lottery.won') }}</span>
            <span v-else-if="myJoinedById[draw.id]" class="chip chip-joined">{{ $t('lottery.joined') }}</span>
          </div>
          <div class="draw-card-meta">
            <span
              v-if="draw.productTitle || draw.productId"
              class="draw-prize"
            >{{ $t('lottery.product') }}: {{ draw.productTitle || draw.productId }}</span>
            <span v-if="draw.showWinners" class="draw-count">{{ $t('lottery.drawCount', { count: draw.entryCount ?? 0 }) }}</span>
            <span class="draw-time">{{ $t('lottery.drawTime') }}: {{ formatTime(draw.drawTime || draw.drawAt || '') }}</span>
            <span
              v-if="countdownText(draw)"
              class="draw-countdown"
            >{{ $t('lottery.countdown') }}: {{ countdownText(draw) }}</span>
            <span
              v-if="draw.status === 'drawn' && draw.showWinners && draw.winnerCount !== undefined && draw.winnerCount > 0"
              class="draw-winners"
            >{{ $t('lottery.actualWinnerCount') }}: {{ draw.winnerCount }}</span>
          </div>
        </div>

        <!-- 折叠态快捷操作：不必展开即可参与/查单 -->
        <div class="draw-card-quick" @click.stop>
          <template v-if="draw.status === 'drawn'">
            <RouterLink
              v-if="myWonById[draw.id]?.orderToken"
              class="btn btn-primary btn-sm"
              :to="{ path: '/order', query: { token: myWonById[draw.id].orderToken } }"
            >
              {{ $t('lottery.checkOrder') }}
            </RouterLink>
            <span v-else-if="sessionEmail && myJoinedById[draw.id]" class="not-won">
              {{ $t('lottery.notWon') }}
            </span>
            <button
              v-else-if="!sessionEmail"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="openLogin()"
            >
              {{ $t('lottery.loginToCheck') }}
            </button>
          </template>
          <template v-else-if="draw.status === 'drawing'">
            <span class="drawing-state">{{ $t('lottery.statusDrawing') }}</span>
          </template>
          <template v-else-if="draw.status === 'open'">
            <span v-if="myJoinedById[draw.id]" class="joined-badge">{{ joinedStatusText(draw) }}</span>
            <button
              v-else-if="!sessionEmail"
              type="button"
              class="btn btn-primary btn-sm"
              @click="openLogin(draw.id)"
            >
              {{ $t('lottery.loginFirst') }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="joiningId === draw.id"
              @click="handleJoin(draw.id)"
            >
              {{ joiningId === draw.id ? '加载中…' : $t('lottery.join') }}
            </button>
          </template>
          <component
            :is="getGameComponent(draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'))"
            v-if="expandedId === draw.id && draw.status === 'open'"
            :prizes="(draw.prizes || []).map((p: any) => ({ name: p.name || p.tierName || '奖品', color: '' }))"
            :disabled="joiningId === draw.id"
            @play="handleJoin(draw.id)"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="toggleExpand(draw.id)"
          >
            {{ expandedId === draw.id ? $t('lottery.collapse') : $t('lottery.expand') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :title="$t('lottery.copyShareLink')"
            @click="handleCopyPublicLink(draw.id)"
          >
            {{ $t('lottery.copyShareLink') }}
          </button>
        </div>

        <!-- 展开详情 -->
        <div v-if="expandedId === draw.id" class="draw-card-body">
          <p v-if="draw.description" class="draw-desc">{{ draw.description }}</p>
          <div class="draw-detail-grid">
            <div v-if="draw.productTitle || draw.productId" class="detail-item">
              <span class="detail-label">{{ $t('lottery.product') }}</span>
              <span class="detail-value">{{ draw.productTitle || draw.productId }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{{ $t('lottery.joinTime') }}</span>
              <span class="detail-value">{{ formatTime(draw.startTime || draw.startAt || '') }} ~ {{ formatTime(draw.endTime || draw.endAt || '') }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{{ $t('lottery.drawTime') }}</span>
              <span class="detail-value">{{ formatTime(draw.drawTime || draw.drawAt || '') }}</span>
            </div>
            <div v-if="draw.showWinners" class="detail-item">
              <span class="detail-label">{{ $t('lottery.winnerCount') }}</span>
              <span class="detail-value">
                <template v-if="draw.status === 'drawn' && draw.showWinners && draw.winnerCount !== undefined">
                  {{ $t('lottery.actualWinnerCount') }}: {{ draw.winnerCount }}
                </template>
                <template v-else-if="draw.status !== 'drawn'">
                  {{ $t('lottery.maxWinnerCount') }}: {{ draw.maxWinners }}
                </template>
              </span>
            </div>
            <div v-if="draw.showWinners && draw.maxParticipants" class="detail-item">
              <span class="detail-label">{{ $t('lottery.maxParticipants') }}</span>
              <span class="detail-value">{{ draw.entryCount ?? 0 }} / {{ draw.maxParticipants }}</span>
            </div>
          </div>

          <div class="draw-actions">
            <div v-if="draw.status === 'drawn'" class="result-section">
              <span class="chip chip-drawn">{{ $t('lottery.drawResult') }}</span>
              <template v-if="sessionEmail">
                <div v-if="myWonById[draw.id]" class="won-badge">
                  {{ $t('lottery.won') }}
                  <RouterLink
                    v-if="myWonById[draw.id].orderToken"
                    class="order-link"
                    :to="{ path: '/order', query: { token: myWonById[draw.id].orderToken } }"
                  >
                    {{ $t('lottery.checkOrder') }}
                  </RouterLink>
                </div>
                <div v-else class="not-won">{{ $t('lottery.notWon') }}</div>
              </template>
              <div v-else class="login-prompt">
                <button type="button" class="btn btn-primary btn-sm" @click="openLogin()">
                  {{ $t('lottery.loginToCheck') }}
                </button>
              </div>
            </div>

            <div v-else-if="draw.status === 'drawing'" class="drawing-state">
              {{ $t('lottery.statusDrawing') }}
            </div>

            <div v-else-if="draw.status === 'open'" class="join-section">
              <div v-if="myJoinedById[draw.id]" class="joined-badge">
                {{ joinedStatusText(draw) }}
              </div>
              <!-- 导流：参与成功后展示商品卡片 -->
              <div v-if="myJoinedById[draw.id] && draw.productLink" class="product-card">
                <div class="product-card-inner">
                  <div v-if="draw.productLink.imageUrl" class="product-card-img">
                    <img :src="draw.productLink.imageUrl" :alt="draw.productLink.title" loading="lazy" />
                  </div>
                  <div class="product-card-body">
                    <h4 class="product-card-title">{{ draw.productLink.title }}</h4>
                    <p v-if="draw.productLink.price" class="product-card-price">{{ draw.productLink.price }}</p>
                    <a
                      :href="productUtmUrl(draw.productLink.url, draw.id, draw.publicSlug)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="btn btn-primary btn-sm"
                    >查看商品</a>
                  </div>
                </div>
              </div>
              <div v-else-if="!sessionEmail" class="login-prompt">
                <button type="button" class="btn btn-primary" @click="openLogin(draw.id)">
                  {{ $t('lottery.loginFirst') }}
                </button>
              </div>
              <div v-else>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="joiningId === draw.id"
                  @click="handleJoin(draw.id)"
                >
                  {{ joiningId === draw.id ? '加载中…' : $t('lottery.join') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 登录弹窗 -->
    <div v-if="showLoginModal" class="modal-overlay" @click.self="closeLogin">
      <div class="modal-content" role="dialog" aria-modal="true" :aria-label="$t('lottery.emailVerify')">
        <h3 class="modal-title">{{ $t('lottery.emailVerify') }}</h3>
        <p class="modal-hint">{{ $t('lottery.emailVerifyHint') }}</p>
        <div class="modal-form">
          <label>
            <span>{{ $t('lottery.emailPlaceholder') }}</span>
            <input
              v-model="loginEmail"
              type="email"
              autocomplete="email"
              inputmode="email"
              @keyup.enter="codeSent ? handleVerifyCode() : handleSendCode()"
            />
          </label>
          <div v-if="codeSent" class="verified-email-row">
            <span>已验证邮箱 {{ loginEmail }}</span>
            <button type="button" class="btn btn-primary btn-sm" :disabled="verifyingCode" @click="handleVerifyCode">
              一键继续
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="loginEmail=''; loginCode=''; codeSent=false">
              切换邮箱
            </button>
          </div>
          <div v-if="codeSent" class="code-row">
            <label class="code-label">
              <span>{{ $t('lottery.codePlaceholder') }}</span>
              <input
                v-model="loginCode"
                type="text"
                inputmode="numeric"
                maxlength="6"
                class="code-input"
                autocomplete="one-time-code"
                @keyup.enter="handleVerifyCode"
              />
            </label>
            <span class="code-timer">{{ codeCooldown > 0 ? codeCooldown + 's' : '' }}</span>
          </div>
          <div class="modal-actions">
            <button
              v-if="!codeSent"
              type="button"
              class="btn btn-primary"
              :disabled="sendingCode"
              @click="handleSendCode"
            >
              {{ sendingCode ? '加载中…' : $t('lottery.sendCode') }}
            </button>
            <template v-else>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="verifyingCode"
                @click="handleVerifyCode"
              >
                {{ verifyingCode ? '加载中…' : $t('lottery.verifyAndJoin') }}
              </button>
              <button
                type="button"
                class="btn btn-ghost"
                :disabled="sendingCode || codeCooldown > 0"
                @click="handleSendCode"
              >
                {{ codeCooldown > 0 ? $t('lottery.resendIn', { s: codeCooldown }) : $t('lottery.sendCode') }}
              </button>
            </template>
            <button type="button" class="btn btn-ghost" @click="closeLogin">
              {{ '取消' }}
            </button>
          </div>
          <p v-if="loginError" class="form-error">{{ loginError }}</p>
        </div>
      </div>
    </div>
  </div>

  <GameResultModal
    :show="showResult"
    @close="showResult = false"
  />
</template>

<script setup lang="ts">
/**
 * 用户端抽奖页。
 *
 * 体验要点：
 * - 顶栏会话 +「我的记录」汇总中奖/参与（/lottery/my）
 * - 卡片折叠态即可参与、查单，减少二次点击
 * - 登录后可选自动加入 pendingDrawId
 * - 订单链接使用 history 模式 /order?token=（禁止 hash 路由伪链接）
 * - 个人状态用普通对象（非 Map.set 原地修改）保证 Vue 响应式
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { writeClipboardText } from '@/composables/useClipboard'
import { getGameComponent } from '@/components/games/GameRegistry'
import GameResultModal from '@/components/games/GameResultModal.vue'

const { t, locale } = useI18n()
const { showToast } = useToast()

const props = defineProps<{ id?: string }>()
const router = useRouter()

/** 深链 /lottery/:id 时只展示单活动 */
const isDeepLinked = computed(() => Boolean(props.id && String(props.id).trim()))

const API_BASE = '/api'

type LotteryDraw = {
  id: string; publicSlug?: string; title: string; name?: string; description?: string; status: string;
  activityKind?: string; participationMode: string; experienceType?: string; resultMode?: string; allocationPolicy?: string;
  startAt: string; startTime?: string; endAt: string; endTime?: string; drawAt: string | null; drawTime?: string | null;
  winnerCount: number; maxParticipants?: number | null;
  showParticipantCount: number; showWinnerCount: number; showWinnerList: number;
  showWinners?: boolean; maxWinners?: number;
  participantCount?: number; entryCount?: number; winners?: Array<{ identity: string }>;
  prizes?: Array<{ name?: string; tierName?: string }>;
  productId?: string; productTitle?: string;
  productLink?: { url: string; title: string; imageUrl?: string; price?: string };
};

type ActivityOutcome = {
  id?: string;
  outcomeType?: string;
  status: string;
  sequenceNo?: number;
  assignmentNo?: number | null;
  resultLabel?: string;
  decidedAt?: string | null;
};

type MyEntry = {
  drawId: string; joinedAt?: string; drawName?: string; drawStatus?: string; drawTime?: string;
};

const loading = ref(true)
const recordsLoading = ref(false)
const draws = ref<LotteryDraw[]>([])
const expandedId = ref<string | null>(null)
const sessionEmail = ref('')
const myJoinedById = ref<Record<string, true>>({})
const myWonById = ref<Record<string, any>>({})
const myOutcomeById = ref<Record<string, ActivityOutcome>>({})
const myEntryList = ref<MyEntry[]>([])

/** 中奖优先，再按参与时间新→旧 */
const sortedMyEntries = computed(() => {
  const won = new Set(Object.keys(myWonById.value));
  return [...myEntryList.value].sort((a, b) => {
    const aWon = won.has(a.drawId) ? 1 : 0;
    const bWon = won.has(b.drawId) ? 1 : 0;
    if (aWon !== bWon) return bWon - aWon;
    return (b.joinedAt || '').localeCompare(a.joinedAt || '');
  });
});

const joiningId = ref('')
const showResult = ref(false)
const pendingJoinDrawId = ref<string | null>(null)
const nowMs = ref(Date.now())

const showLoginModal = ref(false)
const loginEmail = ref('')
const loginCode = ref('')
const codeSent = ref(false)
const sendingCode = ref(false)
const verifyingCode = ref(false)
const codeCooldown = ref(0)
const loginError = ref('')
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    open: 'statusOpen',
    drawn: 'statusDrawn',
    drawing: 'statusDrawing',
    paused: 'statusPaused',
  }
  return t('lottery.' + (map[status] || 'statusOpen'))
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === 'invite_code') return 'slot'
  if (participationMode === 'password') return 'scratch'
  if (participationMode === 'roster') return 'card'
  return 'wheel'
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return d.toLocaleString(locale.value || undefined)
  } catch {
    return d.toLocaleString()
  }
}

/** 距开奖/参与结束的可读倒计时；已过期返回空 */
function countdownText(draw: LotteryDraw): string {
  const targetIso = draw.status === 'open' ? draw.drawTime : ''
  if (!targetIso) return ''
  const target = new Date(targetIso).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - nowMs.value
  if (diff <= 0) return ''
  const totalSec = Math.floor(diff / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}${t('lottery.days')}`)
  parts.push(`${hours}${t('lottery.hours')}`)
  parts.push(`${minutes}${t('lottery.minutes')}`)
  if (days === 0) parts.push(`${seconds}${t('lottery.seconds')}`)
  return parts.join(' ')
}

/** 活动是否已结束（drawn/cancelled，或 open 态但 drawTime 已过） */
function hasEnded(draw: LotteryDraw): boolean {
  if (draw.status === 'drawn' || draw.status === 'cancelled') return true
  // open 态但 drawTime 已过 → 后端懒开奖还未触发，用户端标记已过期
  // 只对 open 态做时间判断：draft 未开始、paused 可能恢复，都不应标记结束
  if (draw.status === 'open' && draw.drawTime) {
    const t = new Date(draw.drawTime).getTime()
    if (Number.isFinite(t) && t < nowMs.value) return true
  }
  return false
}

function clearSession() {
  sessionEmail.value = ''
  myJoinedById.value = {}
  myWonById.value = {}
  myOutcomeById.value = {}
  myEntryList.value = []
}

function joinedStatusText(draw: LotteryDraw): string {
  const outcome = myOutcomeById.value[draw.id]
  if (draw.activityKind === 'signup_chain') {
    if (outcome?.status === 'waitlisted') return `已接龙 · ${outcome.resultLabel || '候补中'}`
    if (outcome?.status === 'assigned') return `已接龙 · ${outcome.resultLabel || '已占位'}`
    return '已接龙'
  }
  return `${t('lottery.joined')} · ${t('lottery.waitDraw')}`
}

/** 生成带 UTM 追踪参数的商品链接（使用公开 slug，不暴露内部 ID） */
function productUtmUrl(url: string, drawId: string, publicSlug?: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('utm_source', 'lottery')
    u.searchParams.set('utm_medium', 'draw')
    // 使用公开 slug 作为 campaign 标识，不暴露内部 ID
    u.searchParams.set('utm_campaign', publicSlug || drawId)
    return u.toString()
  } catch {
    return url
  }
}

function openLogin(drawId?: string) {
  pendingJoinDrawId.value = drawId || null
  loginError.value = ''
  showLoginModal.value = true
}

function closeLogin() {
  showLoginModal.value = false
  pendingJoinDrawId.value = null
  loginError.value = ''
}

function handleLogout() {
  clearSession()
  showToast('已退出')
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
  // 展开详情时调用 GET /lottery/draws/:id 触发懒开奖
  if (expandedId.value === id) {
    void fetchDrawDetail(id)
  }
}

function focusDraw(drawId: string) {
  // 列表页无该卡片时（例如仅深链其它活动），跳到该活动深链页
  if (!draws.value.some((d) => d.id === drawId)) {
    void router.push('/lottery/' + encodeURIComponent(drawId))
    return
  }
  expandedId.value = drawId
  void fetchDrawDetail(drawId)
  requestAnimationFrame(() => {
    document.getElementById('draw-' + drawId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

async function handleCopyPublicLink(drawId: string) {
  const draw = draws.value.find(d => d.id === drawId)
  const slug = draw?.publicSlug || drawId
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const url = `${origin}/lottery/${slug}`
  try {
    await writeClipboardText(url)
    showToast(t('lottery.shareLinkCopied'))
  } catch {
    showToast(t('lottery.shareLinkCopyFailed'))
  }
}

async function fetchDrawDetail(id: string) {
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(id))
    const data = await res.json() as any
    if (data.ok) {
      const idx = draws.value.findIndex((d) => d.id === id)
      if (idx !== -1) {
        draws.value[idx] = { ...draws.value[idx], ...data } as LotteryDraw
      }
    }
  } catch (e) {
    console.error('[lottery] fetch draw detail failed:', e)
  }
}

async function fetchDraws() {
  loading.value = true
  try {
    // 公开活动列表：通过 /api/public/draws/:slug 逐个查询
    // MVP 暂时只支持深链访问，不支持列表页
    if (props.id) {
      const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(props.id))
      const data = await res.json() as any
      if (data.ok) {
        draws.value = [{ ...data, id: props.id } as LotteryDraw]
        expandedId.value = props.id
        const title = String(data.title || '').trim()
        if (title) document.title = title + ' - 抽奖'
        void fetchDrawDetail(props.id)
      } else {
        draws.value = []
      }
    }
  } catch (e) {
    console.error('[lottery] fetch draws failed:', e)
    draws.value = []
  } finally {
    loading.value = false
  }
}

async function handleJoin(drawId: string) {
  // 打开登录弹窗，验证码验证后参与
  pendingJoinDrawId.value = drawId
  showLoginModal.value = true
}

function startCooldown(seconds: number) {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  codeCooldown.value = seconds
  cooldownTimer = setInterval(() => {
    codeCooldown.value -= 1
    if (codeCooldown.value <= 0 && cooldownTimer) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
      codeCooldown.value = 0
    }
  }, 1000)
}

async function handleSendCode() {
  if (!loginEmail.value.includes('@')) {
    loginError.value = '请输入有效的邮箱地址'
    return
  }
  if (!pendingJoinDrawId.value) return
  sendingCode.value = true
  loginError.value = ''
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail.value.trim() }),
    })
    const data = await res.json() as any
    if (data.ok && data.sent) {
      codeSent.value = true
      startCooldown(60)
    } else {
      loginError.value = data.message || '发送失败'
    }
  } catch {
    loginError.value = '网络错误'
  } finally {
    sendingCode.value = false
  }
}

async function handleVerifyCode() {
  if (!loginCode.value || loginCode.value.length !== 6) {
    loginError.value = '请输入 6 位验证码'
    return
  }
  if (!pendingJoinDrawId.value) return
  verifyingCode.value = true
  loginError.value = ''
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/verify-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
        code: loginCode.value.trim(),
      }),
    })
    const data = await res.json() as any
    if (data.ok && data.joined) {
      const joinedDrawId = pendingJoinDrawId.value
      sessionEmail.value = loginEmail.value
      myJoinedById.value = { ...myJoinedById.value, [joinedDrawId]: true }
      if (data.outcome) {
        myOutcomeById.value = { ...myOutcomeById.value, [joinedDrawId]: data.outcome }
      }
      showLoginModal.value = false
      pendingJoinDrawId.value = null
      loginEmail.value = ''
      loginCode.value = ''
      codeSent.value = false
      showToast(data.outcome?.resultLabel ? `参与成功：${data.outcome.resultLabel}` : '参与成功')
      showResult.value = true
    } else {
      loginError.value = data.message || '验证失败'
    }
  } catch {
    loginError.value = '网络错误'
  } finally {
    verifyingCode.value = false
  }
}

onMounted(async () => {
  countdownTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  await fetchDraws()
})

onUnmounted(() => {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
})
</script>

<style scoped>
/* 暗色主题：全部使用 base.css 的 CSS 变量，不写死颜色值 */

.lottery-view {
  max-width: 800px;
  margin: 0 auto;
  padding: 16px;
  color: var(--tg-text);
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 1.5rem;
  margin: 0;
  color: var(--tg-text);
}

.page-subtitle {
  margin: 4px 0 0;
  font-size: 0.85rem;
  color: var(--tg-hint);
}

.deep-link-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.session-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.session-email {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  color: var(--tg-hint);
}

.login-banner,
.my-records {
  background: var(--tg-secondary-bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 12px 14px;
  margin-bottom: 16px;
}

.login-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.login-banner p {
  margin: 0;
  color: var(--tg-hint);
  font-size: 0.9rem;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.records-empty {
  color: var(--tg-hint);
  font-size: 0.9rem;
  padding: 8px 0;
}

.records-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.record-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}

.record-row:first-child {
  border-top: none;
  padding-top: 0;
}

.record-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.record-name {
  font-weight: 500;
  color: var(--tg-text);
}

.record-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--tg-hint);
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--tg-hint);
}

/* ── 活动卡片 ── */
.draw-card {
  background: var(--tg-secondary-bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  margin-bottom: 12px;
  transition: border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
  overflow: hidden;
}
.draw-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.draw-card.expanded {
  border-color: var(--border-strong);
}

.draw-card-header {
  padding: 16px 16px 8px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}

.draw-card-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.draw-name {
  font-size: 1.1rem;
  margin: 0;
  color: var(--tg-text);
}

.chip {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--r-full);
  font-size: 0.75rem;
  line-height: 1.5;
  font-weight: 500;
}
.chip-open {
  background: var(--admin-info-soft);
  color: var(--admin-info);
  border: 1px solid var(--admin-info-border);
}
.chip-drawn {
  background: var(--admin-success-soft);
  color: var(--admin-success);
  border: 1px solid var(--admin-success-border);
}
.chip-drawing {
  background: var(--admin-warning-soft);
  color: var(--admin-warning);
  border: 1px solid var(--admin-warning-border);
}
.chip-paused {
  background: var(--surface);
  color: var(--tg-hint);
  border: 1px solid var(--border);
}
.chip-won {
  background: var(--admin-warning-soft);
  color: var(--admin-warning);
  border: 1px solid var(--admin-warning-border);
}
.chip-joined {
  background: var(--admin-success-soft);
  color: var(--admin-success);
  border: 1px solid var(--admin-success-border);
}
.chip-muted {
  background: var(--surface);
  color: var(--tg-hint);
  border: 1px solid var(--border);
}

.draw-card-meta {
  text-align: right;
  font-size: 0.85rem;
  color: var(--tg-hint);
  flex: 0 0 auto;
}
.draw-prize {
  color: var(--tg-hint);
  font-size: 0.85rem;
}

.draw-count,
.draw-time,
.draw-countdown {
  display: block;
}
.draw-time,
.draw-countdown {
  margin-top: 4px;
}
.draw-countdown {
  color: var(--admin-warning);
  font-variant-numeric: tabular-nums;
}

.draw-card-quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 16px 12px;
}

.draw-card-body {
  padding: 0 16px 16px;
  border-top: 1px solid var(--border);
}

.draw-desc {
  color: var(--tg-hint);
  margin: 12px 0;
}

.draw-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.detail-item .detail-label {
  display: block;
  font-size: 0.8rem;
  color: var(--tg-hint);
}
.detail-item .detail-value {
  font-size: 0.9rem;
  color: var(--tg-text);
}

.draw-actions {
  margin-top: 12px;
}

/* ── 按钮 ── */
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: var(--r-md);
  cursor: pointer;
  font-size: 0.9rem;
  transition: background var(--duration-fast) ease, opacity var(--duration-fast) ease;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.btn-sm {
  padding: 5px 12px;
  font-size: 0.8rem;
}
.btn-xs {
  padding: 3px 8px;
  font-size: 0.75rem;
}
.btn-primary {
  background: var(--tg-btn);
  color: var(--tg-btn-text);
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--tg-text);
}
.btn-ghost:hover {
  background: var(--surface-hover);
}
.btn-ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── 状态标识 ── */
.joined-badge {
  color: var(--admin-success);
  font-weight: 500;
  font-size: 0.9rem;
}
.won-badge {
  color: var(--admin-warning);
  font-weight: 500;
}
.not-won {
  color: var(--tg-hint);
  font-size: 0.9rem;
}
.drawing-state {
  color: var(--admin-warning);
  font-size: 0.9rem;
}
.order-link {
  color: var(--tg-link);
  text-decoration: none;
  font-weight: 500;
}
.order-link:hover {
  text-decoration: underline;
}

/* ── 模态框 ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}
.modal-content {
  background: var(--tg-secondary-bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  padding: 24px;
  width: 100%;
  max-width: 400px;
  box-shadow: var(--shadow-lg);
}
.modal-title {
  margin: 0 0 6px;
  font-size: 1.1rem;
  color: var(--tg-text);
}
.modal-hint {
  margin: 0 0 14px;
  font-size: 0.85rem;
  color: var(--tg-hint);
}

/* ── 表单 ── */
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--tg-text);
}
.modal-form label span {
  font-weight: 500;
  font-size: 12px;
  color: var(--tg-hint);
}
.modal-form input:not([type='checkbox']):not([type='radio']) {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background-color: var(--tg-secondary-bg);
  color: var(--tg-text);
  -webkit-text-fill-color: var(--tg-text);
  font-size: 13px;
  color-scheme: dark;
  line-height: 32px;
}

.code-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.code-label {
  flex: 1;
}
.code-input {
  letter-spacing: 2px;
  font-family: var(--font-mono);
}
.code-timer {
  min-width: 30px;
  color: var(--tg-hint);
  padding-bottom: 6px;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.form-error {
  color: var(--admin-danger);
  font-size: 0.85rem;
  margin: 0;
}

@media (max-width: 520px) {
  .draw-card-header {
    flex-direction: column;
  }
  .draw-card-meta {
    text-align: left;
  }
  .draw-detail-grid {
    grid-template-columns: 1fr;
  }
}

/* 导流商品卡片 */
.product-card {
  margin-top: 12px;
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-md, 8px);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  overflow: hidden;
}
.product-card-inner {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.product-card-img {
  width: 80px;
  height: 80px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--tg-bg, #0a0e17);
}
.product-card-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.product-card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.product-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--tg-text, #f0f2f5);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.product-card-price {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--admin-accent, #f59e0b);
}
</style>
