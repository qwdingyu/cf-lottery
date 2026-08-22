<template>
  <!--
    同场裂变面板（docs/041 / 108 / 109）— 自我裂变主入口，必须诚实、可操作、可感知。
    状态机：
    - viral 关 → 不渲染
    - 加载中 → 骨架（禁止空白误以为未开启）
    - 已参与 + entryId → 我的邀请（进度 / 权重 / 复制·系统分享）
    - 已参与无 entryId → 诚实提示「查结果后可生成专属链接」
    - 未参与 → 激励先参与（榜可看）
    - leaderboardEnabled → Top 榜；关则仅我的邀请
    - 终态（drawn/cancelled）→ 历史可看，弱化邀请主 CTA
  -->
  <section v-if="viralOn && drawSlug" class="viral-section" :aria-label="$t('lottery.viralSectionAria')">
    <!-- 加载骨架：避免首屏闪空 -->
    <div v-if="loading && !hasContent" class="viral-skeleton" aria-busy="true">
      <div class="viral-skeleton-bar" />
      <div class="viral-skeleton-bar viral-skeleton-bar--short" />
      <div class="viral-skeleton-bar" />
    </div>

    <template v-else>
      <!-- ── 我的邀请 ── -->
      <div v-if="showMyInviteBlock" class="my-viral-card" :class="{ 'my-viral-card--closed': !inviteOpen }">
        <div class="my-viral-head">
          <span class="my-viral-title">{{ $t('lottery.viralMyInvite') }}</span>
          <span v-if="inviteOpen && isLotteryKind" class="my-viral-extra">{{ $t('lottery.viralInviteHint', { n: displayPerInvite }) }}</span>
          <span v-else-if="inviteOpen && !isLotteryKind" class="my-viral-extra">{{ $t('lottery.viralSocialHint') }}</span>
          <span v-else class="my-viral-extra my-viral-extra--muted">{{ $t('lottery.viralInviteClosedHint') }}</span>
        </div>

        <!-- 有 entry 且已拉到 stats（或本地占位） -->
        <div v-if="entryId && effectiveStats" class="my-viral-body">
          <div class="my-viral-stat-row">
            <div class="my-viral-stat">
              <span class="my-viral-num">{{ effectiveStats.invitedCount }}</span>
              <span class="my-viral-label">{{ $t('lottery.viralInvitedLabel') }}</span>
            </div>
            <!-- 非 lottery 活动（秒杀/领券等）不展示额外票/权重（spins 专属语义，docs/246） -->
            <div v-if="isLotteryKind" class="my-viral-stat">
              <span class="my-viral-num my-viral-num--extra">{{ effectiveStats.extraEntriesEarned }}</span>
              <span class="my-viral-label">{{ $t('lottery.viralExtraEarnedLabel') }}</span>
            </div>
            <div v-if="isLotteryKind" class="my-viral-stat">
              <span class="my-viral-num my-viral-num--weight">{{ effectiveStats.drawWeight }}</span>
              <span class="my-viral-label">{{ $t('lottery.viralDrawWeightLabel') }}</span>
            </div>
          </div>

          <div v-if="isLotteryKind" class="my-viral-progress-wrap">
            <div
              class="my-viral-progress"
              role="progressbar"
              :aria-valuenow="effectiveStats.extraEntriesEarned"
              :aria-valuemin="0"
              :aria-valuemax="effectiveStats.maxExtraEntries"
            >
              <div
                class="my-viral-progress-fill"
                :style="{ width: myProgressPercent + '%' }"
              />
            </div>
            <span class="my-viral-progress-text">
              {{ $t('lottery.viralExtraProgress', {
                earned: effectiveStats.extraEntriesEarned,
                max: effectiveStats.maxExtraEntries,
              }) }}
            </span>
            <p class="my-viral-weight-hint">
              {{ $t('lottery.viralWeightExplain', { weight: effectiveStats.drawWeight }) }}
            </p>
          </div>

          <div v-if="inviteOpen" class="my-viral-share">
            <code class="my-viral-link" :title="displayShareUrl || undefined">
              {{ displayShareUrl || $t('lottery.viralGenerateHint') }}
            </code>
            <div class="my-viral-share-actions">
              <button
                type="button"
                class="btn btn-sm btn-primary"
                :disabled="shareBusy"
                @click="handlePrimaryShare"
              >
                {{ primaryShareLabel }}
              </button>
              <button
                v-if="canNativeShare && displayShareUrl"
                type="button"
                class="btn btn-sm btn-ghost"
                :disabled="shareBusy"
                @click="handleNativeShare"
              >
                {{ $t('lottery.viralNativeShare') }}
              </button>
            </div>
          </div>
          <p v-else-if="displayShareUrl" class="my-viral-closed-note">
            {{ $t('lottery.viralHistoryLinkNote') }}
          </p>
          <p v-if="shareError" class="my-viral-error" role="alert">{{ shareError }}</p>
          <p v-if="statsError && !effectiveStats.shareUrl" class="my-viral-error" role="alert">
            {{ statsError }}
            <button type="button" class="btn btn-ghost btn-xs" @click="fetchData">{{ $t('lottery.retry') }}</button>
          </p>
        </div>

        <!-- 已参与但本机无 entryId：禁止假生成链接 -->
        <div v-else-if="joinedWithoutEntry" class="my-viral-body my-viral-body--hint">
          <p class="my-viral-honest">{{ $t('lottery.viralNeedEntryHint') }}</p>
          <button
            v-if="canEmitQuery"
            type="button"
            class="btn btn-sm btn-primary"
            @click="emit('query-result')"
          >
            {{ $t('lottery.queryResult') }}
          </button>
        </div>

        <!-- 未参与：激励 -->
        <div v-else class="my-viral-body my-viral-body--hint">
          <p class="my-viral-honest">{{ $t('lottery.viralJoinFirstHint') }}</p>
        </div>
      </div>

      <!-- ── 排行榜（leaderboardEnabled 独立） ── -->
      <div v-if="showLeaderboard" class="leaderboard-card">
        <div class="leaderboard-head">
          <h4 class="leaderboard-title">{{ $t('lottery.viralLeaderboardTitle') }}</h4>
          <button
            type="button"
            class="btn btn-ghost btn-xs leaderboard-refresh"
            :disabled="loading"
            :aria-label="$t('lottery.retry')"
            @click="fetchData"
          >↻</button>
        </div>

        <div v-if="loading && leaderboard.length === 0" class="leaderboard-empty">
          {{ $t('lottery.loadingText') }}
        </div>
        <div v-else-if="lbError" class="leaderboard-empty leaderboard-empty--err">
          <p>{{ lbError }}</p>
          <button type="button" class="btn btn-ghost btn-sm" @click="fetchData">{{ $t('lottery.retry') }}</button>
        </div>
        <div v-else-if="leaderboard.length === 0" class="leaderboard-empty">
          {{ $t('lottery.viralEmptyHint') }}
        </div>
        <ol v-else class="leaderboard-list">
          <li
            v-for="item in leaderboard"
            :key="item.entryId || item.rank"
            class="leaderboard-row"
            :class="{ 'is-me': isMeOnRow(item) }"
          >
            <span class="leaderboard-rank">{{ rankBadge(item.rank) }}</span>
            <span class="leaderboard-name">
              {{ item.displayName }}
              <em v-if="isMeOnRow(item)" class="leaderboard-me-tag">{{ $t('lottery.viralMe') }}</em>
            </span>
            <span class="leaderboard-count">{{ $t('lottery.viralPeopleCount', { n: item.invitedCount }) }}</span>
          </li>
        </ol>

        <!-- 我的排名：真实名次；0 邀请诚实展示（模式由 viralMyRankFooterMode 决策） -->
        <div v-if="myRankFooterMode === 'zero'" class="leaderboard-my-rank leaderboard-my-rank--zero">
          <span class="leaderboard-rank">—</span>
          <span class="leaderboard-name">{{ $t('lottery.viralMe') }} · {{ $t('lottery.viralNotOnBoard') }}</span>
          <span class="leaderboard-count">{{ $t('lottery.viralPeopleCount', { n: 0 }) }}</span>
        </div>
        <div
          v-else-if="myRankFooterMode === 'footer' && myRank"
          class="leaderboard-my-rank"
        >
          <span class="leaderboard-rank">{{ myRank.rank }}</span>
          <span class="leaderboard-name">{{ $t('lottery.viralMe') }}</span>
          <span class="leaderboard-count">{{ $t('lottery.viralPeopleCount', { n: myRank.invitedCount }) }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * 公开活动卡裂变面板 — UX 铁律（docs/109）：
 * 1. 不假装有链接 / 有 entry
 * 2. 进度 = earned/max，与开奖公式一致
 * 3. 复制失败展示错误，不 toast 成功
 * 4. 终态弱化邀请，榜与历史统计仍可读
 */
import { ref, computed, watch, onMounted } from 'vue'
import { writeClipboardText } from '@usethink/cf-admin-fe/composables'
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { shouldShowInviteShareCta } from '@/views/lottery/public-helpers'
import {
  isMeVisibleInViralTop,
  isViralLeaderboardMeRow,
  parseViralLeaderboardResponse,
  shouldShowViralLeaderboard,
  viralMyRankFooterMode,
  viralRankBadge,
} from '@/views/lottery/viral-leaderboard-ui'

const props = defineProps<{
  drawSlug: string
  entryId?: string
  /** 是否已知本场已参与（无 entryId 时用于诚实提示） */
  isJoined?: boolean
  /** 活动 status：终态弱化邀请 CTA */
  drawStatus?: string | null
  activityKind?: string | null
  viralConfig?: {
    enabled?: boolean
    extraEntriesPerInvite?: number
    maxExtraEntries?: number
    leaderboardEnabled?: boolean
    referralRewardDefs?: unknown[]
  } | null
}>()

const emit = defineEmits<{ 'query-result': [] }>()

const { t } = useI18n()
const { showToast } = useToast()

interface LeaderboardEntry {
  rank: number
  displayName: string
  invitedCount: number
  entryId?: string
}
interface MyViralStats {
  shareCode: string
  shareUrl: string
  clickedCount: number
  invitedCount: number
  extraEntriesEarned: number
  extraEntriesPerInvite: number
  maxExtraEntries: number
  drawWeight: number
  inviteOpen?: boolean
  drawStatus?: string
}

const leaderboard = ref<LeaderboardEntry[]>([])
const myRank = ref<{ rank: number; invitedCount: number } | null>(null)
const myStats = ref<MyViralStats | null>(null)
const loading = ref(false)
const shareBusy = ref(false)
const shareError = ref('')
const statsError = ref('')
const lbError = ref('')

const viralOn = computed(() => {
  const cfg = props.viralConfig
  if (cfg?.enabled === true) return true
  // docs/259 D2：viral 关闭但配置了 referralRewardDefs 时，仍需展示里程碑进度面
  if (cfg?.referralRewardDefs && cfg.referralRewardDefs.length > 0) return true
  return false
})
const drawSlug = computed(() => String(props.drawSlug || '').trim())

/** 管理端「展示排行榜」：显式 false 才关；缺省 true（与 admin / API 一致） */
const showLeaderboard = computed(() => shouldShowViralLeaderboard(props.viralConfig))

/** 活动是否仍适合推邀请（与 docs/103 一致） */
const inviteOpenByStatus = computed(() => shouldShowInviteShareCta(props.drawStatus))
const inviteOpen = computed(() => {
  if (myStats.value?.inviteOpen === false) return false
  return inviteOpenByStatus.value
})

const isLotteryKind = computed(() => !props.activityKind || props.activityKind === 'lottery')

const displayPerInvite = computed(() => {
  const fromStats = myStats.value?.extraEntriesPerInvite
  if (fromStats != null && fromStats > 0) return fromStats
  const n = Number(props.viralConfig?.extraEntriesPerInvite)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
})

const displayMaxExtra = computed(() => {
  const fromStats = myStats.value?.maxExtraEntries
  if (fromStats != null && fromStats > 0) return fromStats
  const n = Number(props.viralConfig?.maxExtraEntries)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
})

/**
 * 有 entry 时展示「我的」卡；无 entry 时：已参与要诚实提示，未参与也要激励（裂变法宝）。
 * 仅排行榜关 + 完全路人且无 entry：仍展示激励条，避免整块消失。
 */
const showMyInviteBlock = computed(() => viralOn.value)

const joinedWithoutEntry = computed(
  () => props.isJoined === true && !props.entryId,
)

const canEmitQuery = computed(() => props.isJoined === true)

/** stats 未返回时的本地占位：进度 0，避免「有 entry 却空白」 */
const effectiveStats = computed((): MyViralStats | null => {
  if (!props.entryId) return null
  if (myStats.value) return myStats.value
  // 加载失败或尚未返回：仍给 0 进度占位 + 生成按钮
  if (loading.value && !statsError.value) return null
  return {
    shareCode: '',
    shareUrl: '',
    clickedCount: 0,
    invitedCount: 0,
    extraEntriesEarned: 0,
    extraEntriesPerInvite: displayPerInvite.value,
    maxExtraEntries: displayMaxExtra.value,
    drawWeight: 1,
    inviteOpen: inviteOpen.value,
  }
})

const hasContent = computed(
  () =>
    !!myStats.value ||
    leaderboard.value.length > 0 ||
    !!props.entryId ||
    props.isJoined === true ||
    showLeaderboard.value,
)

const myProgressPercent = computed(() => {
  const s = effectiveStats.value
  if (!s) return 0
  const max = s.maxExtraEntries
  return max > 0 ? Math.min(100, Math.round((s.extraEntriesEarned / max) * 100)) : 0
})

const displayShareUrl = computed(() => {
  const path = myStats.value?.shareUrl || ''
  if (!path) return ''
  if (path.startsWith('http')) return path
  if (typeof window === 'undefined') return path
  return window.location.origin + path
})

const canNativeShare = computed(() => {
  if (typeof navigator === 'undefined') return false
  return typeof navigator.share === 'function'
})

const primaryShareLabel = computed(() => {
  if (shareBusy.value) return t('lottery.loadingText')
  if (displayShareUrl.value) return t('lottery.viralCopy')
  return t('lottery.viralGenerateLink')
})

const meVisibleInTop = computed(() =>
  isMeVisibleInViralTop(leaderboard.value, {
    entryId: props.entryId,
    myRank: myRank.value,
  }),
)

/** 底栏：zero / footer / in_top / none — 与纯函数一致，避免模板条件漂移 */
const myRankFooterMode = computed(() =>
  viralMyRankFooterMode(myRank.value, { meVisibleInTop: meVisibleInTop.value }),
)

function isMeOnRow(item: LeaderboardEntry): boolean {
  return isViralLeaderboardMeRow(item, {
    entryId: props.entryId,
    myRank: myRank.value,
  })
}

function rankBadge(rank: number): string {
  return viralRankBadge(rank)
}

async function fetchData() {
  if (!viralOn.value || !drawSlug.value) return
  loading.value = true
  shareError.value = ''
  statsError.value = ''
  lbError.value = ''
  const slug = encodeURIComponent(drawSlug.value)
  try {
    const tasks: Promise<Response | null>[] = []
    if (showLeaderboard.value) {
      tasks.push(
        fetch(
          `/api/public/draws/${slug}/viral-leaderboard${
            props.entryId ? `?entryId=${encodeURIComponent(props.entryId)}` : ''
          }`,
        ),
      )
    } else {
      tasks.push(Promise.resolve(null))
    }
    if (props.entryId) {
      tasks.push(
        fetch(`/api/public/draws/${slug}/my-viral-stats?entryId=${encodeURIComponent(props.entryId)}`),
      )
    } else {
      tasks.push(Promise.resolve(null))
    }

    const [lbRes, statsRes] = await Promise.all(tasks)

    if (lbRes) {
      // 始终读 JSON：业务 message 优先（docs/114）；解析逻辑锁在 parseViralLeaderboardResponse
      let lbBody: unknown = {}
      try {
        lbBody = await lbRes.json()
      } catch {
        lbBody = {}
      }
      const parsed = parseViralLeaderboardResponse(lbRes.ok, lbBody, t('lottery.networkError'))
      if (parsed.ok) {
        leaderboard.value = parsed.entries
        myRank.value = parsed.myRank
        lbError.value = ''
      } else {
        lbError.value = parsed.error
        leaderboard.value = []
        myRank.value = null
      }
    }

    if (statsRes) {
      if (statsRes.ok) {
        const stats = await statsRes.json()
        if (stats.ok !== false) {
          const per = stats.extraEntriesPerInvite ?? displayPerInvite.value
          const max = stats.maxExtraEntries ?? displayMaxExtra.value
          const earned = stats.extraEntriesEarned ?? 0
          myStats.value = {
            shareCode: stats.shareCode || '',
            shareUrl: stats.shareUrl || '',
            clickedCount: stats.clickedCount ?? 0,
            invitedCount: stats.invitedCount ?? 0,
            extraEntriesEarned: earned,
            extraEntriesPerInvite: per,
            maxExtraEntries: max,
            drawWeight: stats.drawWeight ?? 1 + earned,
            inviteOpen: stats.inviteOpen,
            drawStatus: stats.drawStatus,
          }
          statsError.value = ''
        } else {
          statsError.value = stats.message || t('lottery.networkError')
        }
      } else {
        statsError.value = t('lottery.networkError')
      }
    }
  } catch {
    if (showLeaderboard.value) lbError.value = t('lottery.networkError')
    if (props.entryId) statsError.value = t('lottery.networkError')
  } finally {
    loading.value = false
  }
}

/** 确保有分享 URL：复用后端 POST /share（已复用码） */
async function ensureShareUrl(): Promise<string | null> {
  if (myStats.value?.shareUrl) {
    const path = myStats.value.shareUrl
    return path.startsWith('http') ? path : window.location.origin + path
  }
  if (!props.entryId || !drawSlug.value) return null
  const slug = encodeURIComponent(drawSlug.value)
  const res = await fetch(`/api/public/draws/${slug}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId: props.entryId }),
  })
  const data = await res.json()
  if (!data.ok || !data.shareUrl) {
    shareError.value = data.message || t('lottery.shareLinkFailed')
    return null
  }
  const full = data.shareUrl.startsWith('http')
    ? data.shareUrl
    : window.location.origin + data.shareUrl
  myStats.value = {
    shareCode: data.shareCode || '',
    shareUrl: data.shareUrl,
    clickedCount: myStats.value?.clickedCount ?? 0,
    invitedCount: myStats.value?.invitedCount ?? 0,
    extraEntriesEarned: myStats.value?.extraEntriesEarned ?? 0,
    extraEntriesPerInvite: myStats.value?.extraEntriesPerInvite ?? displayPerInvite.value,
    maxExtraEntries: myStats.value?.maxExtraEntries ?? displayMaxExtra.value,
    drawWeight: myStats.value?.drawWeight ?? 1,
    inviteOpen: myStats.value?.inviteOpen ?? inviteOpen.value,
  }
  return full
}

async function handlePrimaryShare() {
  if (!inviteOpen.value || !props.entryId) return
  shareBusy.value = true
  shareError.value = ''
  try {
    const full = await ensureShareUrl()
    if (!full) return
    await writeClipboardText(full)
    showToast(t('lottery.shareLinkCopied'))
  } catch {
    shareError.value = t('lottery.viralCopyFailed')
  } finally {
    shareBusy.value = false
  }
}

async function handleNativeShare() {
  if (!inviteOpen.value || !canNativeShare.value) return
  shareBusy.value = true
  shareError.value = ''
  try {
    const full = await ensureShareUrl()
    if (!full) return
    await navigator.share({
      title: t('lottery.viralShareTitle'),
      text: t('lottery.viralShareText'),
      url: full,
    })
  } catch (e: unknown) {
    // 用户取消不报错
    const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: string }).name) : ''
    if (name !== 'AbortError') {
      shareError.value = t('lottery.viralShareFailed')
    }
  } finally {
    shareBusy.value = false
  }
}

onMounted(() => { void fetchData() })
watch(
  () => [
    props.entryId,
    props.drawSlug,
    props.viralConfig?.enabled,
    props.viralConfig?.leaderboardEnabled,
    props.drawStatus,
    props.isJoined,
  ],
  () => { void fetchData() },
)
</script>

<style scoped>
.viral-section {
  margin: 16px 0 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.viral-skeleton {
  padding: 14px;
  border-radius: 12px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.04));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.viral-skeleton-bar {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(255,255,255,.06), rgba(255,255,255,.12), rgba(255,255,255,.06));
  background-size: 200% 100%;
  animation: viralShimmer 1.2s ease infinite;
}
.viral-skeleton-bar--short { width: 55%; }
@keyframes viralShimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

.my-viral-card {
  background: linear-gradient(135deg, rgba(74,222,128,.1), rgba(34,197,94,.04));
  border: 1px solid rgba(74,222,128,.22);
  border-radius: 14px;
  padding: 14px 14px 16px;
}
.my-viral-card--closed {
  background: var(--tg-secondary-bg, rgba(255,255,255,.03));
  border-color: rgba(255,255,255,.08);
  opacity: 0.92;
}
.my-viral-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 8px;
  flex-wrap: wrap;
}
.my-viral-title { font-weight: 700; font-size: 15px; letter-spacing: 0.01em; }
.my-viral-extra { font-size: 12px; color: var(--tg-hint); line-height: 1.3; }
.my-viral-extra--muted { opacity: 0.85; }
.my-viral-body { display: flex; flex-direction: column; gap: 12px; }
.my-viral-body--hint { text-align: center; padding: 4px 0 2px; gap: 10px; }
.my-viral-honest {
  margin: 0;
  font-size: 13px;
  color: var(--tg-hint);
  line-height: 1.45;
}
.my-viral-stat-row {
  display: flex;
  justify-content: space-around;
  gap: 8px;
}
.my-viral-stat { text-align: center; flex: 1; min-width: 0; }
.my-viral-num {
  font-size: 26px;
  font-weight: 800;
  color: #4ade80;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.my-viral-num--extra { color: var(--brand-bright); }
.my-viral-num--weight { color: #60a5fa; }
.my-viral-label {
  display: block;
  font-size: 11px;
  color: var(--tg-hint);
  margin-top: 2px;
}
.my-viral-progress-wrap { text-align: center; }
.my-viral-progress {
  height: 8px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.1));
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 6px;
}
.my-viral-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4ade80, #22c55e);
  border-radius: 4px;
  transition: width .45s ease;
  min-width: 0;
}
.my-viral-progress-text { font-size: 12px; color: var(--tg-hint); font-weight: 500; }
.my-viral-weight-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--tg-hint);
  line-height: 1.4;
  opacity: 0.9;
}
.my-viral-share {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.my-viral-link {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-size: 11px;
  color: var(--tg-hint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--tg-bg, rgba(0,0,0,.22));
  padding: 8px 10px;
  border-radius: 8px;
  text-align: left;
  border: 1px solid rgba(255,255,255,.06);
}
.my-viral-share-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: stretch;
}
.my-viral-share-actions .btn {
  flex: 1;
  min-height: 40px;
  min-width: 100px;
}
.my-viral-error {
  margin: 0;
  font-size: 12px;
  color: #ef4444;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.my-viral-closed-note {
  margin: 0;
  font-size: 12px;
  color: var(--tg-hint);
  text-align: center;
}

.leaderboard-card {
  background: var(--tg-secondary-bg, rgba(255,255,255,.03));
  border-radius: 14px;
  padding: 14px;
  border: 1px solid rgba(255,255,255,.05);
}
.leaderboard-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  gap: 8px;
}
.leaderboard-title { font-size: 14px; font-weight: 700; margin: 0; }
.leaderboard-refresh { min-width: 36px; min-height: 36px; font-size: 16px; }
.leaderboard-empty {
  font-size: 13px;
  color: var(--tg-hint);
  text-align: center;
  padding: 18px 8px;
  line-height: 1.45;
}
.leaderboard-empty--err {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.leaderboard-list { list-style: none; padding: 0; margin: 0; }
.leaderboard-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255,255,255,.04);
  min-height: 40px;
}
.leaderboard-row:last-child { border-bottom: none; }
.leaderboard-row.is-me {
  background: rgba(74,222,128,.1);
  margin: 0 -14px;
  padding-left: 14px;
  padding-right: 14px;
  border-radius: 8px;
  border-bottom-color: transparent;
}
.leaderboard-rank {
  width: 28px;
  text-align: center;
  font-size: 15px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.leaderboard-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.leaderboard-me-tag {
  font-style: normal;
  font-size: 11px;
  margin-left: 6px;
  color: #4ade80;
  font-weight: 600;
}
.leaderboard-count {
  font-size: 12px;
  color: var(--tg-hint);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.leaderboard-my-rank {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0 0;
  margin-top: 8px;
  border-top: 1px dashed rgba(255,255,255,.1);
  min-height: 40px;
}
.leaderboard-my-rank--zero { opacity: 0.75; }

.btn {
  cursor: pointer;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  padding: 8px 14px;
  font-weight: 600;
}
.btn-primary { background: var(--tg-button, #4f8ef7); color: #fff; }
.btn-ghost {
  background: transparent;
  color: var(--tg-text, inherit);
  border: 1px solid rgba(255,255,255,.12);
}
.btn-sm { font-size: 13px; padding: 8px 12px; }
.btn-xs { font-size: 12px; padding: 4px 10px; min-height: 32px; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
