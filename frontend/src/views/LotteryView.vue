<template>
  <div class="lottery-view">
    <header class="lottery-header">
      <div class="lottery-header-left">
        <h1 class="lottery-title">{{ drawTitle }}</h1>
        <div v-if="isDeepLinked && draws[0]" class="lottery-link-bar">
          <button class="lottery-share-btn" @click="handleCopyPublicLink(draws[0].id)">📋 {{ $t('lottery.copyShareLink') }}</button>
          <RouterLink to="/lottery" class="lottery-share-btn">← {{ $t('lottery.backToAllDraws') }}</RouterLink>
        </div>
      </div>
      <div class="lottery-header-actions">
        <template v-if="sessionEmail || registeredUsername">
          <span class="lottery-user">{{ registeredUsername || sessionEmail }}</span>
          <button class="lottery-logout" @click="handleLogout">{{ $t('lottery.logout') }}</button>
        </template>
        <button v-else class="lottery-login-btn" @click="openLogin()">{{ $t('lottery.loginToViewRecords') }}</button>
      </div>
    </header>
<!-- 加载 / 空态 -->
    <div v-if="loading" class="lottery-skeleton">
      <div v-for="i in 3" :key="i" class="skeleton-card">
        <div class="skeleton-row skeleton-title" />
        <div class="skeleton-row skeleton-text" />
        <div class="skeleton-row skeleton-btn" />
      </div>
    </div>
    <div v-else-if="fetchError" class="lottery-center">
      <div class="empty-icon">⚠️</div>
      <p>{{ fetchError }}</p>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" @click="fetchDraws">{{ $t('adminPrizes.retry') }}</button>
    </div>
    <div v-else-if="draws.length === 0" class="lottery-center">
      <div class="empty-icon">🎪</div>
      <p>{{ $t('lottery.noActivity') }}</p>
    </div>

    <!-- 活动卡片 -->
    <div v-else class="lottery-main">
      <div
        v-for="draw in draws"
        :key="draw.id"
        class="lottery-card"
        :class="{ expanded: expandedId === draw.id }"
      >
        <div class="lottery-card-head" @click="toggleExpand(draw.id)">
          <div class="lottery-card-left">
            <h3 class="lottery-card-title">{{ draw.name }}</h3>
            <div class="lottery-card-tags">
              <span class="lottery-tag" :class="draw.status">{{ statusText(draw.status) }}</span>
              <span v-if="myWonById[draw.id]" class="lottery-tag won">🎉 {{ $t('lottery.wonTag') }}</span>
              <span v-else-if="myJoinedById[draw.id]" class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
              <span v-if="draw.entryCount != null" class="lottery-tag count">{{ $t('lottery.drawCount', { count: draw.entryCount }) }}</span>
            </div>
          </div>
          <button class="lottery-expand-btn">{{ expandedId === draw.id ? '▲ ' + $t('lottery.collapse') : '▼ ' + $t('lottery.expand') }}</button>
        </div>
        <!-- 折叠态快捷操作 -->
        <div v-if="expandedId !== draw.id && draw.status === 'drawn' && !sessionEmail" class="lottery-quick-bar">
          <button class="lottery-share-btn" @click="openLogin(draw.id)">{{ $t('lottery.loginToCheck') }}</button>
        </div>
        <div v-if="expandedId !== draw.id && draw.status === 'drawn' && sessionEmail" class="lottery-quick-bar">
          <button class="lottery-share-btn" @click="openMyResult(draw)">{{ $t('lottery.queryResult') }}</button>
        </div>

        <div v-if="expandedId === draw.id" class="lottery-card-body">
          <div class="lottery-game-area">
            <component
              :is="getGameComponent(draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'))"
              :key="draw.id"
              :prizes="(draw.prizes || []).map((p: any) => ({ name: p.name || p.tierName || $t('lottery.productPlaceholder'), color: '', imageUrl: p.imageUrl || '', valueText: p.valueText || '' }))"
              :disabled="joiningId === draw.id || !!myJoinedById[draw.id]"
              :loading="joiningId === draw.id"
              @play="handleJoin(draw.id)"
            />
          </div>
          <div class="lottery-join-bar">
            <template v-if="draw.status !== 'open'">
              <span class="lottery-join-hint">{{ statusText(draw.status) }}</span>
            </template>
            <template v-else-if="myJoinedById[draw.id]">
              <span class="lottery-join-hint">✅ {{ $t('lottery.joined') }} · {{ joinedTimeText(draw) }}</span>
              <button v-if="draw.showWinners" class="lottery-result-btn" @click="openMyResult(draw)">{{ $t('lottery.queryResult') }}</button>
            </template>
            <template v-else-if="!sessionEmail && !registeredUsername">
              <button class="lottery-join-btn" @click="openLogin(draw.id)">{{ $t('lottery.join') }}</button>
            </template>
            <template v-else>
              <button class="lottery-join-btn" :disabled="joiningId === draw.id" @click="handleJoin(draw.id)">
                {{ joiningId === draw.id ? $t('lottery.loadingText') : $t('lottery.join') }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 我的参与记录 -->
    <section v-if="(sessionEmail || registeredUsername) && sortedMyEntries.length > 0" class="lottery-records">
      <h2 class="lottery-section-title">{{ $t('lottery.myRecords') }}</h2>
      <div v-if="recordsLoading" class="lottery-center">{{ $t('lottery.loadingText') }}</div>
      <div v-else class="lottery-records-list">
        <div v-for="row in sortedMyEntries" :key="row.drawId" class="lottery-record">
          <span class="lottery-record-name">{{ row.drawName || row.drawId }}</span>
          <span v-if="myWonById[row.drawId]" class="lottery-tag won">🎉 {{ $t('lottery.wonTag') }}</span>
          <span v-else-if="row.drawStatus === 'drawn'" class="lottery-tag muted">{{ $t('lottery.notWonTag') }}</span>
          <span v-else class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
        </div>
      </div>
    </section>

    <div v-if="showLoginModal" class="modal-overlay" @click.self="closeLogin" @keydown.escape="closeLogin">
      <div class="modal-content" role="dialog" aria-modal="true" tabindex="-1" ref="loginModalRef" :aria-label="$t('lottery.emailVerify')">
        <h3 class="modal-title">{{ isRegisteredJoin ? $t('lottery.loginAndJoin') : $t('lottery.emailVerify') }}</h3>
        <p class="modal-hint">{{ isRegisteredJoin ? $t('lottery.registeredRequired') : isLoginOnly ? $t('lottery.loginToViewRecords') : $t('lottery.emailVerifyHint') }}</p>

        <!-- 仅登录（无具体活动）：跳转到完整登录页，确保邮箱验证码验证 -->
        <div v-if="isLoginOnly" class="modal-form">
          <p class="field-hint" style="text-align:center;margin-bottom:12px">{{ $t('lottery.loginToViewRecords') }}</p>
          <a href="/admin/login" class="btn btn-primary" style="width:100%;text-align:center;text-decoration:none">{{ $t('landing.login') }}</a>
          <button type="button" class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px" @click="closeLogin">{{ $t('confirm.cancel') }}</button>
        </div>

        <!-- registered 模式：用户名密码登录 -->
        <div v-else-if="isRegisteredJoin" class="modal-form">
          <label>
            <span>{{ $t('adminLogin.username') }}</span>
            <input v-model="regLoginUsername" type="text" autocomplete="username" @keyup.enter="handleRegisteredLogin" />
          </label>
          <label>
            <span>{{ $t('adminLogin.password') }}</span>
            <input v-model="regLoginPassword" type="password" autocomplete="current-password" @keyup.enter="handleRegisteredLogin" />
          </label>
          <p v-if="loginError" class="field-hint" style="color:var(--tg-danger)">{{ loginError }}</p>
          <button class="btn btn-primary" style="width:100%" :disabled="regLoginLoading" @click="handleRegisteredLogin">
            {{ regLoginLoading ? $t('adminLogin.loggingIn') : $t('lottery.loginAndJoin') }}
          </button>
          <p class="field-hint" style="text-align:center;margin-top:8px">
            {{ $t('adminLogin.noAccount') }}
            <a href="/admin/register" target="_blank" class="btn btn-ghost btn-xs">{{ $t('adminLogin.switchToRegister') }}</a>
          </p>
        </div>

        <!-- open 模式：邮箱验证码（保留原逻辑） -->
        <div v-else class="modal-form">
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
            <span>{{ $t('lottery.emailVerified', { email: loginEmail }) }}</span>
            <button type="button" class="btn btn-primary btn-sm" :disabled="verifyingCode" @click="handleVerifyCode">
              {{ $t('lottery.oneClickContinue') }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="loginEmail=''; loginCode=''; codeSent=false">
              {{ $t('lottery.switchEmail') }}
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
              {{ sendingCode ? $t('lottery.loadingText') : $t('lottery.sendCode') }}
            </button>
            <template v-else>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="verifyingCode"
                @click="handleVerifyCode"
              >
                {{ verifyingCode ? $t('lottery.loadingText') : $t('lottery.verifyAndJoin') }}
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
              {{ $t('confirm.cancel') }}
            </button>
          </div>
          <p v-if="loginError" class="form-error">{{ loginError }}</p>
        </div>
      </div>
    </div>
  </div>

  <GameResultModal
    :show="showResult"
    :draw-slug="lastJoinDrawSlug"
    :entry-id="lastJoinResult?.entryId"
    :viral-config="lastJoinViralConfig"
    @close="showResult = false"
  />

  <!-- 查询我的结果弹窗 -->
  <Teleport to="body">
    <div v-if="showMyResultModal" class="game-result-overlay" @click.self="showMyResultModal = false">
      <div class="game-result-modal">
        <button class="result-close" @click="showMyResultModal = false">✕</button>
        <div class="result-icon">🎫</div>
        <h2 class="result-title">{{ $t('lottery.myResultTitle') }}</h2>

        <!-- 查询表单 -->
        <div v-if="!myResultData" class="result-form">
          <!-- registered 模式：JWT 已证明身份，无需邮箱/验证码 -->
          <template v-if="isRegMyResult">
            <p class="result-hint">{{ $t('lottery.loggedInQueryHint', { name: registeredUsername }) }}</p>
            <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
            <button class="btn btn-primary" :disabled="myResultLoading" @click="queryMyResult">
              {{ myResultLoading ? $t('lottery.queryingText') : $t('lottery.queryText') }}
            </button>
          </template>
          <template v-else>
            <input
              v-model="myResultEmail"
              type="email"
              :placeholder="$t('lottery.resultEmailPlaceholder')"
              maxlength="120"
              :disabled="myResultLoading"
            />
            <input
              v-model="myResultCode"
              type="text"
              :placeholder="$t('lottery.resultCodePlaceholder')"
              maxlength="10"
              :disabled="myResultLoading"
            />
            <p class="result-hint">{{ $t('lottery.codeHint') }}</p>
            <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
            <button class="btn btn-primary" :disabled="myResultLoading" @click="queryMyResult">
              {{ myResultLoading ? $t('lottery.queryingText') : $t('lottery.queryText') }}
            </button>
          </template>
        </div>

        <!-- 查询结果 -->
        <div v-else class="result-detail">
          <template v-if="myResultData.won">
            <div class="result-line">🎉 <strong>{{ $t('lottery.won') }}</strong></div>
            <div v-if="myResultData.prizeCode" class="result-code-block">
              <span class="result-code-label">{{ $t('lottery.prizeCodeLabel') }}</span>
              <code class="result-code" @click="copyMyResult(myResultData.prizeCode)">{{ myResultData.prizeCode }}</code>
              <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
            </div>
            <div class="result-share-win">
              <p class="result-share-hint">🎁 {{ $t('lottery.shareYourLuck') }}</p>
              <button class="btn btn-primary btn-sm" @click="shareMyWin">📤 {{ $t('lottery.shareActivityBtn') }}</button>
            </div>
            <!-- 中奖后 CTA：运营者配置的导流卡片 -->
            <div v-if="getResultCta(myResultDraw, 'after_win')" class="result-cta-card">
              <a :href="getResultCta(myResultDraw, 'after_win')!.url" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
                {{ getResultCta(myResultDraw, 'after_win')!.title || $t('lottery.viewDetail') }}
              </a>
            </div>
          </template>
          <template v-else-if="myResultData.consolationCoupon">
            <div class="result-line">🎁 <strong>{{ $t('lottery.gotConsolation') }}</strong></div>
            <div class="result-code-block">
              <span class="result-code-label">{{ $t('lottery.couponLabel') }}</span>
              <code class="result-code" @click="copyMyResult(myResultData.consolationCoupon)">{{ myResultData.consolationCoupon }}</code>
              <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
            </div>
          </template>
          <template v-else>
            <div class="result-line">😊 {{ $t('lottery.thanksForParticipating') }}</div>
          </template>
          <!-- 未中奖 CTA：运营者配置的导流卡片（安慰奖和未中奖都展示） -->
          <div v-if="!myResultData.won && getResultCta(myResultDraw, 'after_loss')" class="result-cta-card">
            <a :href="getResultCta(myResultDraw, 'after_loss')!.url" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
              {{ getResultCta(myResultDraw, 'after_loss')!.title || $t('lottery.viewDetail') }}
            </a>
          </div>
          <button class="btn btn-ghost" @click="showMyResultModal = false">{{ $t('lottery.gotIt') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
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
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { writeClipboardText } from '@/composables/useClipboard'
import { getGameComponent } from '@/components/games/GameRegistry'
import GameResultModal from '@/components/games/GameResultModal.vue'

const { t, locale } = useI18n()
const { showToast } = useToast()

const props = defineProps<{ id?: string }>()
const router = useRouter()
const route = useRoute()

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
  prizes?: Array<{ name?: string; tierName?: string; description?: string; imageUrl?: string; valueText?: string; winnerCount?: number }>;
  productId?: string; productTitle?: string;
  productLink?: { url: string; title: string; imageUrl?: string; price?: string };
  activityConfig?: ActivityConfig;
};

type ActivityConfig =
  | {
      version: 1;
      kind: 'survey';
      fields: Array<{
        id: string;
        label: string;
        type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox';
        required: boolean;
        maxLength: number;
        options: Array<{ id: string; label: string }>;
      }>;
    }
  | {
      version: 1;
      kind: 'vote';
      selection: 'single';
      options: Array<{ id: string; label: string; description: string; imageUrl: string }>;
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

type ActivityEventType =
  | 'page_view'
  | 'participation_started'
  | 'participation_completed'
  | 'cta_click'

const loading = ref(true)
const fetchError = ref('')
const recordsLoading = ref(false)
const draws = ref<LotteryDraw[]>([])
const expandedId = ref<string | null>(null)
const sessionEmail = ref('')
/**
 * registered 模式：已登录用户的 JWT token。
 * 存 sessionStorage（会话级）：刷新页面不丢、关闭标签页自动清除；
 * 与后台 admin_token（localStorage）隔离，避免参与登录态污染管理后台入口。
 */
const registeredToken = ref(sessionStorage.getItem('lottery_registered_token') || '')
/** registered 模式：已登录用户名（展示用，随 token 一起会话级持久化） */
const registeredUsername = ref(sessionStorage.getItem('lottery_registered_username') || '')
/** registered 模式登录表单 */
const regLoginUsername = ref('')
const regLoginPassword = ref('')
const regLoginLoading = ref(false)
/** 当前登录弹窗对应的活动是否是 registered 模式 */
const isRegisteredJoin = computed(() => {
  if (!pendingJoinDrawId.value) return false
  const draw = draws.value.find(d => d.id === pendingJoinDrawId.value)
  return draw?.participationMode === 'registered'
})
/** 仅登录查看记录（无具体活动，不需要验证码） */
const isLoginOnly = computed(() => !pendingJoinDrawId.value)
/** 结果查询弹窗对应的活动是否是 registered 模式（决定是否用 JWT 查询） */
const isRegMyResult = computed(() => myResultDraw.value?.participationMode === 'registered')

/** 头部标题：单活动模式用活动名，多活动模式用默认标题 */
const drawTitle = computed(() => {
  const d = draws.value[0]
  return d && draws.value.length === 1 ? d.name : t('lottery.title')
})
/** 状态精简文案 */
const statusText = (s: string) =>
  ({ draft: t('lottery.adminDrawDraft'), open: t('lottery.statusOpen'), paused: t('lottery.statusPaused'), drawing: t('lottery.statusDrawing'), drawn: t('lottery.ended'), cancelled: t('lottery.adminDrawCancelled') } as Record<string,string>)[s] || s
/** 参与时间 */
const joinedTimeText = (draw: any): string => {
  const e = sortedMyEntries.value.find((r: any) => r.drawId === draw.id)
  return e?.joinedAt ? formatTime(e.joinedAt) : ''
}

const myJoinedById = ref<Record<string, true>>({})
const myWonById = ref<Record<string, any>>({})
const myOutcomeById = ref<Record<string, ActivityOutcome>>({})
const myEntryList = ref<MyEntry[]>([])
const submissionDrafts = ref<Record<string, { optionId: string; fields: Record<string, any> }>>({})

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
/** 参与成功后暂存 drawId + entryId，传递给 GameResultModal 生成归因分享链接 */
const lastJoinResult = ref<{ drawId: string; entryId: string } | null>(null)

// ── 查询我的结果（中奖卡密/安慰奖券） ──
const showMyResultModal = ref(false)
const myResultDraw = ref<LotteryDraw | null>(null)
const myResultEmail = ref('')
const myResultCode = ref('')
const myResultLoading = ref(false)
const myResultData = ref<{ joined: boolean; won: boolean; prizeCode: string | null; consolationCoupon: string | null } | null>(null)
const myResultError = ref('')

/** 从最近参与的活动数据中提取 publicSlug，供 GameResultModal 调用 /share API */
const lastJoinDrawSlug = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  return draw?.publicSlug
})

/** 从最近参与的活动数据中提取裂变配置 */
const lastJoinViralConfig = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  const pc = (draw as any)?.promotionConfig
  return pc?.viral ?? undefined
})

function openMyResult(draw: LotteryDraw) {
  myResultDraw.value = draw
  myResultEmail.value = sessionEmail.value || ''
  myResultCode.value = ''
  myResultData.value = null
  myResultError.value = ''
  showMyResultModal.value = true
}

async function queryMyResult() {
  if (!myResultDraw.value) return
  const isReg = myResultDraw.value.participationMode === 'registered'
  // registered 模式：已登录用户带 JWT 直接查询，无需邮箱/验证码；
  // 其他模式仍需邮箱+验证码防枚举
  if (!isReg && (!myResultEmail.value.trim() || !myResultCode.value.trim())) {
    myResultError.value = t('lottery.emailCodeRequired') || ''
    return
  }
  myResultLoading.value = true
  myResultError.value = ''
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // registered 模式：JWT 即身份证明（后端按 userId 匹配 entry，跳过验证码）
    if (isReg && registeredToken.value) headers['Authorization'] = 'Bearer ' + registeredToken.value
    const res = await fetch(`${API_BASE}/public/draws/${myResultDraw.value.publicSlug}/my-result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: isReg ? registeredUsername.value : myResultEmail.value.trim(),
        code: isReg ? '' : myResultCode.value.trim(),
      }),
    })
    const data = await res.json()
    if (data.ok) {
      myResultData.value = data
    } else {
      myResultError.value = data.message || t('lottery.queryFailed')
    }
  } catch {
    myResultError.value = t('lottery.networkError') || ''
  } finally {
    myResultLoading.value = false
  }
}

function copyMyResult(text: string) {
  if (!text) return
  writeClipboardText(text)
  showToast(t('lottery.copied'), 'success')
}

/** 中奖后分享活动链接（归因到当前用户的分享记录） */
async function shareMyWin() {
  const draw = myResultDraw.value
  if (!draw) return
  const slug = draw.publicSlug || draw.id
  const origin = window.location.origin
  if (lastJoinResult.value && lastJoinResult.value.drawId === draw.id) {
    try {
      const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId: lastJoinResult.value.entryId }),
      })
      const data = await res.json()
      if (data.ok && data.shareUrl) {
        await writeClipboardText(origin + data.shareUrl)
        showToast(t('lottery.shareLinkCopied'), 'success')
        return
      }
    } catch { /* 降级到基础链接 */ }
  }
  await writeClipboardText(`${origin}/lottery/${slug}`)
  showToast(t('lottery.shareLinkCopied'), 'success')
}

const pendingJoinDrawId = ref<string | null>(null)
const nowMs = ref(Date.now())

// Telegram Mini App BackButton 适配
const tg = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : undefined
function handleTelegramBackButton() {
  if (showResult.value) { showResult.value = false; return }
  if (isDeepLinked.value) { void router.push('/lottery'); return }
  if (expandedId.value) { expandedId.value = null }
}
if (tg?.BackButton) {
  tg.BackButton.onClick(handleTelegramBackButton)
  watch([isDeepLinked, expandedId, showResult], () => {
    if (isDeepLinked.value || expandedId.value || showResult.value) {
      tg.BackButton.show()
    } else {
      tg.BackButton.hide()
    }
  }, { immediate: true })
  onUnmounted(() => {
    tg.BackButton.offClick?.(handleTelegramBackButton)
    tg.BackButton.hide?.()
  })
}

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
let pollTimer: ReturnType<typeof setInterval> | null = null
const trackedPageViews = new Set<string>()

function ensureSubmissionDraft(draw: LotteryDraw) {
  if (!requiresActivitySubmission(draw) || submissionDrafts.value[draw.id]) return
  const fields: Record<string, any> = {}
  // 防御：activityConfig.fields 可能未配置（如投票活动没有字段），遍历前兜底为空数组
  if (draw.activityConfig?.kind === 'survey' && Array.isArray(draw.activityConfig.fields)) {
    for (const field of draw.activityConfig.fields) {
      fields[field.id] = field.type === 'checkbox' ? [] : ''
    }
  }
  submissionDrafts.value = {
    ...submissionDrafts.value,
    [draw.id]: { optionId: '', fields },
  }
}

function requiresActivitySubmission(draw: LotteryDraw) {
  return draw.activityConfig?.kind === 'survey' || draw.activityConfig?.kind === 'vote'
}

function buildSubmissionPayload(draw: LotteryDraw): Record<string, unknown> | undefined {
  if (!requiresActivitySubmission(draw)) return undefined
  ensureSubmissionDraft(draw)
  const draft = submissionDrafts.value[draw.id]
  if (draw.activityConfig?.kind === 'vote') return { optionId: draft.optionId }
  return { fields: draft.fields }
}

function validateSubmissionDraft(draw: LotteryDraw): string {
  if (!requiresActivitySubmission(draw)) return ''
  ensureSubmissionDraft(draw)
  const draft = submissionDrafts.value[draw.id]
  if (draw.activityConfig?.kind === 'vote') {
    return draft.optionId ? '' : t('lottery.voteRequired')
  }
  if (draw.activityConfig?.kind === 'survey') {
    // 防御：fields 未配置时跳过校验
    const fields = Array.isArray(draw.activityConfig.fields) ? draw.activityConfig.fields : []
    for (const field of fields) {
      const value = draft.fields[field.id]
      const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
      if (field.required && empty) return t('lottery.requiredField', { label: field.label })
    }
  }
  return ''
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

/**
 * 从活动 promotionConfig 中提取指定状态的 CTA 配置。
 *
 * 安全：只返回 http/https 协议的外部链接。
 * 纵深防御：后端发布校验（publish-check）已拦截危险协议，这里再兜底一次，
 * 防止历史数据或配置被绕过时 `<a href>` 渲染 javascript: 等危险协议。
 */
function getResultCta(draw: LotteryDraw | null, key: 'after_win' | 'after_loss'): { url: string; title: string } | null {
  if (!draw) return null
  const pc = (draw as any)?.promotionConfig
  const cta = pc?.ctas?.[key]
  if (!cta?.url) return null
  // 协议白名单：仅 http/https，防止 javascript:/data: 等危险协议
  try {
    const parsed = new URL(cta.url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch {
    return null // 非法 URL 不渲染，避免坏链接和注入
  }
  return { url: cta.url, title: cta.title || '' }
}


function clearSession() {
  myEntryList.value = []
}

function drawSlug(drawId: string): string {
  const draw = draws.value.find((d) => d.id === drawId)
  return draw?.publicSlug || drawId
}

function routeParam(name: string): string {
  const value = route.query[name]
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function activityEventContext() {
  return {
    source: routeParam('utm_source') || 'direct',
    medium: routeParam('utm_medium'),
    campaign: routeParam('utm_campaign'),
    refCode: routeParam('ref'),
  }
}

async function recordActivityEvent(drawId: string, eventType: ActivityEventType, metadata?: Record<string, unknown>) {
  const slug = drawSlug(drawId)
  if (!slug) return
  try {
    await fetch(API_BASE + '/public/draws/' + encodeURIComponent(slug) + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        ...activityEventContext(),
        metadata,
      }),
    })
  } catch (error) {
    console.debug('[lottery] activity event ignored:', eventType, error)
  }
}

function trackPageView(draw: LotteryDraw) {
  const key = draw.publicSlug || draw.id
  if (!key || trackedPageViews.has(key)) return
  trackedPageViews.add(key)
  void recordActivityEvent(draw.id, 'page_view', {
    activityKind: draw.activityKind || 'lottery',
    experienceType: draw.experienceType || '',
    status: draw.status,
  })
}

const loginModalRef = ref<HTMLElement | null>(null)

function openLogin(drawId?: string) {
  pendingJoinDrawId.value = drawId || null
  if (drawId) void recordActivityEvent(drawId, 'participation_started')
  loginError.value = ''
  showLoginModal.value = true
  nextTick(() => loginModalRef.value?.focus())
}

function closeLogin() {
  showLoginModal.value = false
  pendingJoinDrawId.value = null
  loginError.value = ''
}

/** 仅登录（无需验证码）：存入邮箱后关闭弹窗，加载参与记录 */
function handleLogout() {
  clearSession()
  showToast(t('lottery.loggedOut'))
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
  // 展开详情时调用 GET /lottery/draws/:id 触发懒开奖
  if (expandedId.value === id) {
    const draw = draws.value.find((item) => item.id === id)
    if (draw) ensureSubmissionDraft(draw)
    void fetchDrawDetail(id)
  }
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
        ensureSubmissionDraft(draws.value[idx]!)
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
        ensureSubmissionDraft(draws.value[0]!)
        expandedId.value = props.id
        trackPageView(draws.value[0]!)
        const title = String(data.title || '').trim()
        if (title) document.title = title + ' - ' + t('lottery.title')
        void fetchDrawDetail(props.id)
      } else {
        draws.value = []
      }
    }
  } catch (e) {
    console.error('[lottery] fetch draws failed:', e)
    fetchError.value = t('lottery.networkError')
    draws.value = []
  } finally {
    loading.value = false
  }
}

/** registered 模式：用户名密码登录后直接参与 */
async function handleRegisteredLogin() {
  if (!regLoginUsername.value || !regLoginPassword.value) {
    loginError.value = t('adminLogin.missingUsernamePassword')
    return
  }
  if (!pendingJoinDrawId.value) return

  regLoginLoading.value = true
  loginError.value = ''
  try {
    // 1. 登录获取 JWT（与后台同一认证体系，API_BASE 统一，支持子路径部署）
    const loginRes = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: regLoginUsername.value, password: regLoginPassword.value }),
    })
    const loginData = await loginRes.json()
    if (!loginData.ok) { loginError.value = loginData.message || t('adminLogin.loginFailed'); return }

    const token = loginData.token
    registeredToken.value = token
    registeredUsername.value = regLoginUsername.value
    sessionEmail.value = regLoginUsername.value
    // 会话级持久化：刷新页面免重复登录；关闭标签页自动清除，不残留敏感信息
    sessionStorage.setItem('lottery_registered_token', token)
    sessionStorage.setItem('lottery_registered_username', regLoginUsername.value)

    // 2. 带 JWT 调 access-code（registered 模式后端以 JWT 中的 userId 为身份，
    // 无需也不应传邮箱——身份由 JWT 决定，杜绝"用户名当邮箱"的兼容 hack）
    const draw = draws.value.find(d => d.id === pendingJoinDrawId.value)
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ submission: draw ? buildSubmissionPayload(draw) : undefined }),
    })
    const data = await res.json()
    if (data.ok && data.joined) {
      const joinedDrawId = pendingJoinDrawId.value
      myJoinedById.value = { ...myJoinedById.value, [joinedDrawId]: true }
      // 结果/outcome 处理与 verify-join 对齐：registered 参与后同样展示结果弹窗
      if (data.outcome) {
        myOutcomeById.value = { ...myOutcomeById.value, [joinedDrawId]: data.outcome }
      }
      void recordActivityEvent(joinedDrawId, 'participation_completed', {
        activityKind: data.activityKind || '',
        outcomeStatus: data.outcome?.status || '',
      })
      // 暂存参与结果，供 GameResultModal 生成归因分享链接
      if (data.entryId) {
        lastJoinResult.value = { drawId: joinedDrawId, entryId: data.entryId }
      }
      closeLogin()
      regLoginPassword.value = ''
      showToast(data.outcome?.resultLabel ? t('lottery.joinSuccessWithOutcome', { outcome: data.outcome.resultLabel }) : t('lottery.joinSuccess'))
      showResult.value = true
    } else {
      loginError.value = data.message || t('lottery.joinFailed')
    }
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    regLoginLoading.value = false
  }
}

async function handleJoin(drawId: string) {
  const draw = draws.value.find((item) => item.id === drawId)
  if (draw) {
    ensureSubmissionDraft(draw)
    const message = validateSubmissionDraft(draw)
    if (message) {
      showToast(message, 'error')
      expandedId.value = drawId
      return
    }
  }
  // 打开登录弹窗，验证码验证后参与
  pendingJoinDrawId.value = drawId
  void recordActivityEvent(drawId, 'participation_started')
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
    loginError.value = t('lottery.invalidEmail')
    return
  }
  if (!pendingJoinDrawId.value) {
    loginError.value = t('lottery.drawNotLoaded')
    return
  }
  const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
  if (draw) {
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      return
    }
  }
  sendingCode.value = true
  loginError.value = ''
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail.value.trim() }),
    })
    const data = await res.json() as any
    if (data.ok && data.joined) {
      // 邮箱验证码已关闭：直接参与成功
      myJoinedById.value = { ...myJoinedById.value, [pendingJoinDrawId.value!]: true }
      closeLogin()
      showToast('参与成功', 'success')
      loadMyRecords()
    } else if (data.ok && data.sent) {
      codeSent.value = true
      startCooldown(data.expiresInSeconds || 60)
    } else {
      loginError.value = data.message || t('lottery.sendFailed')
    }
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    sendingCode.value = false
  }
}

async function handleVerifyCode() {
  if (!loginCode.value || loginCode.value.length !== 6) {
    loginError.value = t('lottery.invalidCode')
    return
  }
  if (!pendingJoinDrawId.value) return
  const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
  if (draw) {
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      return
    }
  }
  verifyingCode.value = true
  loginError.value = ''
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/verify-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
        code: loginCode.value.trim(),
        refCode: routeParam('ref'),
        submission: draw ? buildSubmissionPayload(draw) : undefined,
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
      void recordActivityEvent(joinedDrawId, 'participation_completed', {
        activityKind: data.activityKind || '',
        outcomeStatus: data.outcome?.status || '',
      })
      showLoginModal.value = false
      pendingJoinDrawId.value = null
      loginEmail.value = ''
      loginCode.value = ''
      codeSent.value = false
      showToast(data.outcome?.resultLabel ? t('lottery.joinSuccessWithOutcome', { outcome: data.outcome.resultLabel }) : t('lottery.joinSuccess'))
      // 暂存参与结果，供 GameResultModal 生成归因分享链接
      if (data.entryId) {
        lastJoinResult.value = { drawId: joinedDrawId, entryId: data.entryId }
      }
      showResult.value = true
    } else {
      loginError.value = data.message || t('lottery.verifyFailed')
    }
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    verifyingCode.value = false
  }
}

onMounted(async () => {
  countdownTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  // 每 30 秒轮询活动状态，自动反映开奖/状态变更（P1-4）
  pollTimer = setInterval(() => {
    fetchDraws()
  }, 30000)
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
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<style scoped>
/* ── 头部 ── */
.lottery-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08);
}
.lottery-title { margin:0; font-size:20px; font-weight:700; }
.lottery-user { font-size:13px; color:rgba(255,255,255,0.6); margin-right:8px; }
.lottery-logout { font-size:12px; color:rgba(255,255,255,0.4); background:none; border:none; cursor:pointer; }
.lottery-login-btn { font-size:13px; background:none; border:1px solid rgba(255,255,255,0.2); color:#fff; padding:4px 12px; border-radius:6px; cursor:pointer; }
.lottery-header-left { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
.lottery-link-bar { display:flex; gap:8px; }
.lottery-share-btn { font-size:12px; background:none; border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.5); padding:3px 10px; border-radius:4px; cursor:pointer; text-decoration:none; }
.lottery-share-btn:hover { color:#fff; border-color:rgba(255,255,255,0.3); }

/* ── 中心容器 ── */
.lottery-center { text-align:center; padding:60px 20px; color:var(--tg-hint,#9aa4b2); }

/* ── 活动卡片 ── */
.lottery-main { max-width:720px; margin:0 auto; padding:20px; }
.lottery-card { background:#1a1a2e; border-radius:12px; margin-bottom:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.06); }
.lottery-card-head { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; cursor:pointer; }
.lottery-card-head:hover { background:rgba(255,255,255,0.03); }
.lottery-card-title { margin:0 0 4px; font-size:17px; font-weight:600; }
.lottery-card-tags { display:flex; gap:6px; flex-wrap:wrap; }
.lottery-tag { font-size:11px; padding:2px 8px; border-radius:4px; background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.5); }
.lottery-tag.open { background:rgba(245,158,11,0.15); color:#f59e0b; }
.lottery-tag.drawn, .lottery-tag.muted { background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.3); }
.lottery-tag.won { background:rgba(34,197,94,0.15); color:#22c55e; }
.lottery-tag.joined { background:rgba(59,130,246,0.15); color:#3b82f6; }
.lottery-tag.count { background:transparent; }
.lottery-expand-btn { font-size:12px; color:rgba(255,255,255,0.4); background:none; border:none; cursor:pointer; white-space:nowrap; }

/* ── 展开区 ── */
.lottery-card-body { border-top:1px solid rgba(255,255,255,0.06); max-height:0; overflow:hidden; transition:max-height 0.35s ease,opacity 0.35s ease; opacity:0; }
.lottery-game-area { padding:24px 20px; display:flex; justify-content:center; }
.lottery-join-bar { display:flex; align-items:center; justify-content:center; gap:12px; padding:16px 20px; border-top:1px solid rgba(255,255,255,0.06); }
.lottery-join-btn { font-size:15px; font-weight:600; padding:10px 32px; border-radius:8px; background:var(--admin-accent,#f59e0b); color:#000; border:none; cursor:pointer; }
.lottery-join-btn:disabled { opacity:0.5; cursor:not-allowed; }
.lottery-join-hint { font-size:13px; color:rgba(255,255,255,0.5); }
.lottery-result-btn { font-size:12px; background:none; border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.6); padding:4px 12px; border-radius:6px; cursor:pointer; }

/* ── 参与记录 ── */
.lottery-records { max-width:720px; margin:0 auto; padding:0 20px 40px; }
.lottery-section-title { font-size:15px; font-weight:600; margin:0 0 12px; }
.lottery-records-list { display:flex; flex-wrap:wrap; gap:6px; }
.lottery-record { display:flex; align-items:center; gap:8px; padding:6px 12px; background:#1a1a2e; border-radius:8px; font-size:13px; }
.lottery-record-name { color:rgba(255,255,255,0.7); }

/* ── 骨架屏（加载态） ── */
.lottery-skeleton { max-width:720px; margin:0 auto; padding:20px; }
.skeleton-card { background:#1a1a2e; border-radius:12px; padding:20px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.06); }
.skeleton-row { height:14px; border-radius:6px; background:linear-gradient(90deg,rgba(255,255,255,0.06) 25%,rgba(255,255,255,0.12) 50%,rgba(255,255,255,0.06) 75%); background-size:200% 100%; animation:skeleton-pulse 1.5s ease infinite; margin-bottom:10px; }
.skeleton-title { width:60%; height:18px; }
.skeleton-text { width:80%; }
.skeleton-btn { width:40%; height:36px; border-radius:8px; }
@keyframes skeleton-pulse { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

/* ── 展开态 ── */
.expanded .lottery-card-body { max-height:800px; opacity:1; }

/* ── 空状态 ── */
.empty-icon { font-size:48px; margin-bottom:12px; }

/* ── 弹窗淡入淡出 ── */
.modal-overlay { transition:opacity 0.2s ease; }

/* ── 移动端适配 ── */
@media (max-width: 640px) {
  .lottery-view { padding:8px; }
  .lottery-header { flex-direction:column; align-items:flex-start; gap:8px; }
  .lottery-header-left { flex-direction:column; align-items:flex-start; }
  .lottery-card-head { flex-direction:column; align-items:flex-start; gap:8px; }
  .lottery-join-btn { width:100%; }
  .lottery-main { padding:12px; }
  .lottery-game-area { padding:16px; }
  .lottery-join-bar { flex-direction:column; gap:8px; }
  .lottery-record { font-size:12px; }
  .lottery-skeleton { padding:12px; }
}

/* ── 保留旧样式（兼容） ── */
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

.prize-showcase {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.prize-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.prize-card-img {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--tg-secondary-bg, #151b28);
  flex: 0 0 auto;
}

.prize-card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.prize-value {
  color: var(--admin-warning);
  font-weight: 600;
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
.activity-submission {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  margin-bottom: 10px;
}
.vote-option,
.survey-field,
.checkbox-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.vote-option,
.survey-field {
  flex-direction: column;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--tg-secondary-bg);
}
.vote-option {
  flex-direction: row;
}
.vote-option small,
.survey-field em {
  display: block;
  color: var(--tg-hint);
  font-style: normal;
  font-size: 0.78rem;
}
.survey-field input,
.survey-field textarea,
.survey-field select {
  width: 100%;
}
.checkbox-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
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

/* 查询我的结果弹窗 */
.game-result-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.game-result-modal { background: var(--tg-bg, #1f2937); border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 90%; text-align: center; position: relative; animation: modalIn .3s ease; }
.result-close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--tg-hint, #9aa4b2); }
.result-icon { font-size: 48px; margin-bottom: 12px; }
.result-title { font-size: 22px; font-weight: 700; margin-bottom: 16px; }
.result-form { display: flex; flex-direction: column; gap: 10px; }
.result-form input { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border, rgba(255,255,255,.1)); background: var(--tg-secondary-bg, #151b28); color: var(--tg-text, #f0f2f5); font-size: 14px; }
.result-hint { font-size: 12px; color: var(--tg-hint, #9aa4b2); margin: 0; }
.result-error { font-size: 13px; color: #ef4444; margin: 0; }
.result-detail { display: flex; flex-direction: column; gap: 12px; align-items: center; }
.result-line { font-size: 16px; }
.result-cta-card { margin-top: 8px; }
.result-cta-card .btn { display: inline-block; }
.result-code-block { display: flex; flex-direction: column; gap: 4px; align-items: center; background: var(--tg-secondary-bg, #151b28); padding: 12px; border-radius: 8px; width: 100%; }
.result-code-label { font-size: 12px; color: var(--tg-hint, #9aa4b2); }
.result-code { font-size: 16px; font-weight: 700; color: var(--admin-accent, #f59e0b); cursor: pointer; word-break: break-all; }
.result-share-win { margin-top: 12px; text-align: center; }
.result-share-hint { font-size: 12px; color: var(--tg-hint); margin-bottom: 6px; }

/* ── 视觉增强（不改结构，仅美化） ── */
.lottery-view { max-width: 860px; margin: 0 auto; }
.lottery-header { background: linear-gradient(180deg, rgba(245,158,11,0.08) 0%, transparent 100%); padding: 20px 24px 16px; }
.lottery-title { background: linear-gradient(135deg, #f59e0b, #fbbf24); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.lottery-card { border: 1px solid rgba(245,158,11,0.1); transition: all 0.3s ease; }
.lottery-card:hover { border-color: rgba(245,158,11,0.3); transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
.lottery-card.open { border-color: rgba(34,197,94,0.15); }
.lottery-card.drawn { border-color: rgba(255,255,255,0.05); }
.lottery-game-area { background: radial-gradient(ellipse at center, rgba(245,158,11,0.06) 0%, transparent 70%); min-height: 320px; align-items: center; }
.lottery-join-btn.primary { background: linear-gradient(135deg, #f59e0b, #fbbf24); color: #000; font-weight: 700; padding: 14px 40px; font-size: 16px; border-radius: 12px; box-shadow: 0 4px 16px rgba(245,158,11,0.3); transition: all 0.3s ease; }
.lottery-join-btn.primary:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(245,158,11,0.5); }
.lottery-prize-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-top: 12px; }
.lottery-prize-card { background: rgba(255,255,255,0.03); border-radius: 12px; padding: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.06); }
.lottery-prize-img { width: 64px; height: 64px; margin: 0 auto 8px; border-radius: 12px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 32px; }
.lottery-prize-name { display: block; font-weight: 600; font-size: 14px; }
.lottery-prize-value { display: block; font-size: 12px; color: #f59e0b; margin-top: 4px; }
.lottery-prize-count { display: block; font-size: 11px; color: rgba(255,255,255,0.3); margin-top: 2px; }
.lottery-hero { text-align: center; padding: 40px 20px 24px; }
.lottery-hero-title { font-size: 28px; font-weight: 800; margin: 12px 0 4px; }
.lottery-hero-desc { color: rgba(255,255,255,0.5); font-size: 14px; max-width: 480px; margin: 0 auto; }
.lottery-hero-stats { display: flex; justify-content: center; gap: 32px; margin-top: 20px; }
.lottery-stat { text-align: center; }
.lottery-stat-num { display: block; font-size: 24px; font-weight: 700; }
.lottery-stat-label { display: block; font-size: 12px; color: rgba(255,255,255,0.4); }
.lottery-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.lottery-badge.open { background: rgba(34,197,94,0.15); color: #22c55e; }
.lottery-badge.drawn { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); }
</style>










