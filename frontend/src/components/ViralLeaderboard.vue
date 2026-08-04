<template>
  <!--
    同场裂变面板（docs/041 / docs/108）：
    - 有 entryId：展示我的邀请 / 额外机会进度 / 分享链接
    - leaderboardEnabled：展示 Top 20 邀请排行
    - 仅排行榜关时仍可展示「我的邀请」（管理端开关独立）
  -->
  <div v-if="shouldMount" class="viral-section">
    <div v-if="entryId && myStats" class="my-viral-card">
      <div class="my-viral-head">
        <span class="my-viral-title">{{ $t('lottery.viralMyInvite') }}</span>
        <span class="my-viral-extra">{{ $t('lottery.viralInviteHint', { n: myStats.extraEntriesPerInvite }) }}</span>
      </div>
      <div class="my-viral-body">
        <div class="my-viral-stat-row">
          <div class="my-viral-stat">
            <span class="my-viral-num">{{ myStats.invitedCount }}</span>
            <span class="my-viral-label">{{ $t('lottery.viralInvitedLabel') }}</span>
          </div>
          <div class="my-viral-stat">
            <span class="my-viral-num my-viral-num--weight">{{ myStats.drawWeight ?? (1 + myStats.extraEntriesEarned) }}</span>
            <span class="my-viral-label">{{ $t('lottery.viralDrawWeightLabel') }}</span>
          </div>
        </div>
        <div class="my-viral-progress-wrap">
          <div class="my-viral-progress">
            <div
              class="my-viral-progress-fill"
              :style="{ width: myProgressPercent + '%' }"
            />
          </div>
          <span class="my-viral-progress-text">{{ $t('lottery.viralExtraProgress', { earned: myStats.extraEntriesEarned, max: myStats.maxExtraEntries }) }}</span>
        </div>
        <div class="my-viral-share">
          <code class="my-viral-link">{{ displayShareUrl || $t('lottery.viralGenerateHint') }}</code>
          <button type="button" class="btn btn-sm btn-primary" :disabled="shareBusy" @click="handleGenerateShareLink">
            {{ displayShareUrl ? $t('lottery.viralCopy') : $t('lottery.viralGenerateLink') }}
          </button>
        </div>
        <p v-if="shareError" class="my-viral-error">{{ shareError }}</p>
      </div>
    </div>

    <!-- 未参与但开启排行：仅榜单，激励先参与再邀请 -->
    <div v-if="showLeaderboard" class="leaderboard-card">
      <h4 class="leaderboard-title">{{ $t('lottery.viralLeaderboardTitle') }}</h4>
      <div v-if="loading && leaderboard.length === 0" class="leaderboard-empty">
        {{ $t('lottery.loadingText') }}
      </div>
      <div v-else-if="leaderboard.length === 0" class="leaderboard-empty">
        {{ $t('lottery.viralEmptyHint') }}
      </div>
      <ol v-else class="leaderboard-list">
        <li
          v-for="item in leaderboard"
          :key="item.rank"
          class="leaderboard-row"
          :class="{ 'is-me': entryId && myRank && item.rank === myRank.rank }"
        >
          <span class="leaderboard-rank">{{ item.rank <= 3 ? ['🥇','🥈','🥉'][item.rank - 1] : item.rank }}</span>
          <span class="leaderboard-name">{{ item.displayName }}</span>
          <span class="leaderboard-count">{{ $t('lottery.viralPeopleCount', { n: item.invitedCount }) }}</span>
        </li>
      </ol>
      <div v-if="myRank && myRank.rank > 20" class="leaderboard-my-rank">
        <span class="leaderboard-rank">{{ myRank.rank }}</span>
        <span class="leaderboard-name">{{ $t('lottery.viralMe') }}</span>
        <span class="leaderboard-count">{{ $t('lottery.viralPeopleCount', { n: myRank.invitedCount }) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { writeClipboardText } from '@/composables/useClipboard'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  /** 活动 publicSlug */
  drawSlug: string
  /** 当前参与者的 entryId（可选，用于查询「我的」数据与分享） */
  entryId?: string
  /** 裂变配置（来自 promotionConfig.viral） */
  viralConfig?: {
    enabled?: boolean
    extraEntriesPerInvite?: number
    maxExtraEntries?: number
    leaderboardEnabled?: boolean
  } | null
}>()

const { t } = useI18n()
const { showToast } = useToast()

interface LeaderboardEntry { rank: number; displayName: string; invitedCount: number }
interface MyViralStats {
  shareCode: string
  shareUrl: string
  clickedCount: number
  invitedCount: number
  extraEntriesEarned: number
  extraEntriesPerInvite: number
  maxExtraEntries: number
  /** 开奖袋票数 = 1 + extra；旧接口缺省时前端回退 */
  drawWeight?: number
}

const leaderboard = ref<LeaderboardEntry[]>([])
const myRank = ref<{ rank: number; invitedCount: number } | null>(null)
const myStats = ref<MyViralStats | null>(null)
const loading = ref(false)
const shareBusy = ref(false)
const shareError = ref('')

/** 裂变总开关 */
const viralOn = computed(() => props.viralConfig?.enabled === true)
/** 管理端「展示排行榜」 */
const showLeaderboard = computed(
  () => viralOn.value && props.viralConfig?.leaderboardEnabled !== false,
)
/**
 * 何时挂载整块：
 * - 裂变开启 + 有 slug
 * - 有 entryId（可拉我的数据）或开启排行榜（可只看榜）
 */
const shouldMount = computed(
  () => viralOn.value && !!props.drawSlug && (!!props.entryId || showLeaderboard.value),
)

/** 进度条按「已赚额外次数 / 上限」，与开奖公式一致，勿用邀请人数当分子 */
const myProgressPercent = computed(() => {
  if (!myStats.value) return 0
  const max = myStats.value.maxExtraEntries
  const earned = myStats.value.extraEntriesEarned
  return max > 0 ? Math.min(100, Math.round((earned / max) * 100)) : 0
})

const displayShareUrl = computed(() => {
  const path = myStats.value?.shareUrl || ''
  if (!path) return ''
  if (typeof window === 'undefined') return path
  return path.startsWith('http') ? path : window.location.origin + path
})

async function fetchData() {
  if (!shouldMount.value) return
  loading.value = true
  shareError.value = ''
  const slug = encodeURIComponent(props.drawSlug)
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

    if (lbRes && lbRes.ok) {
      const lb = await lbRes.json()
      // ok() 扁平展开：{ ok, entries, myRank }
      if (lb.ok !== false) {
        leaderboard.value = lb.entries || []
        myRank.value = lb.myRank || null
      }
    } else if (showLeaderboard.value) {
      leaderboard.value = []
      myRank.value = null
    }

    if (statsRes && statsRes.ok) {
      const stats = await statsRes.json()
      if (stats.ok !== false) {
        myStats.value = {
          shareCode: stats.shareCode || '',
          shareUrl: stats.shareUrl || '',
          clickedCount: stats.clickedCount ?? 0,
          invitedCount: stats.invitedCount ?? 0,
          extraEntriesEarned: stats.extraEntriesEarned ?? 0,
          extraEntriesPerInvite: stats.extraEntriesPerInvite ?? props.viralConfig?.extraEntriesPerInvite ?? 1,
          maxExtraEntries: stats.maxExtraEntries ?? props.viralConfig?.maxExtraEntries ?? 10,
          drawWeight: stats.drawWeight,
        }
      }
    }
  } catch {
    // 排行榜/统计失败不阻断主流程
  } finally {
    loading.value = false
  }
}

/** 生成或复制归因分享链接 */
async function handleGenerateShareLink() {
  if (!props.entryId || !props.drawSlug) return
  shareBusy.value = true
  shareError.value = ''
  try {
    if (myStats.value?.shareUrl) {
      const full = displayShareUrl.value
      await writeClipboardText(full)
      showToast(t('lottery.shareLinkCopied'))
      return
    }
    const slug = encodeURIComponent(props.drawSlug)
    const res = await fetch(`/api/public/draws/${slug}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: props.entryId }),
    })
    const data = await res.json()
    if (data.ok && data.shareUrl) {
      const full = data.shareUrl.startsWith('http')
        ? data.shareUrl
        : window.location.origin + data.shareUrl
      await writeClipboardText(full)
      showToast(t('lottery.shareLinkCopied'))
      await fetchData()
    } else {
      shareError.value = data.message || t('lottery.shareLinkFailed')
    }
  } catch {
    shareError.value = t('lottery.networkError')
  } finally {
    shareBusy.value = false
  }
}

onMounted(() => { void fetchData() })
watch(
  () => [props.entryId, props.drawSlug, props.viralConfig?.enabled, props.viralConfig?.leaderboardEnabled],
  () => { void fetchData() },
)
</script>

<style scoped>
.viral-section {
  margin: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.my-viral-card {
  background: linear-gradient(135deg, rgba(74,222,128,.08), rgba(34,197,94,.04));
  border: 1px solid rgba(74,222,128,.2);
  border-radius: 12px;
  padding: 14px;
}
.my-viral-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  gap: 8px;
  flex-wrap: wrap;
}
.my-viral-title { font-weight: 600; font-size: 14px; }
.my-viral-extra { font-size: 11px; color: var(--tg-hint); }
.my-viral-body { display: flex; flex-direction: column; gap: 10px; }
.my-viral-stat-row {
  display: flex;
  justify-content: center;
  gap: 28px;
}
.my-viral-stat { text-align: center; }
.my-viral-num { font-size: 28px; font-weight: 700; color: #4ade80; }
.my-viral-num--weight { color: #60a5fa; }
.my-viral-label { display: block; font-size: 11px; color: var(--tg-hint); }
.my-viral-progress-wrap { text-align: center; }
.my-viral-progress {
  height: 6px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.1));
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}
.my-viral-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4ade80, #22c55e);
  border-radius: 3px;
  transition: width .4s ease;
}
.my-viral-progress-text { font-size: 11px; color: var(--tg-hint); }
.my-viral-share {
  display: flex;
  gap: 8px;
  align-items: center;
}
.my-viral-link {
  flex: 1;
  font-size: 11px;
  color: var(--tg-hint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--tg-bg, rgba(0,0,0,.2));
  padding: 4px 8px;
  border-radius: 4px;
  text-align: left;
}
.my-viral-error {
  margin: 0;
  font-size: 12px;
  color: #ef4444;
  text-align: center;
}

.leaderboard-card {
  background: var(--tg-secondary-bg, rgba(255,255,255,.03));
  border-radius: 12px;
  padding: 14px;
}
.leaderboard-title { font-size: 14px; font-weight: 600; margin: 0 0 10px; }
.leaderboard-empty { font-size: 13px; color: var(--tg-hint); text-align: center; padding: 16px 0; }
.leaderboard-list { list-style: none; padding: 0; margin: 0; }
.leaderboard-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,.04);
}
.leaderboard-row:last-child { border-bottom: none; }
.leaderboard-row.is-me {
  background: rgba(74,222,128,.06);
  margin: 0 -14px;
  padding-left: 14px;
  padding-right: 14px;
  border-radius: 6px;
}
.leaderboard-rank { width: 28px; text-align: center; font-size: 16px; flex-shrink: 0; }
.leaderboard-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leaderboard-count { font-size: 12px; color: var(--tg-hint); flex-shrink: 0; }
.leaderboard-my-rank {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 0;
  margin-top: 8px;
  border-top: 1px dashed rgba(255,255,255,.08);
  opacity: .7;
}

.btn { cursor: pointer; border: none; border-radius: 6px; font-size: 13px; padding: 6px 14px; }
.btn-primary { background: var(--tg-button, #4f8ef7); color: #fff; }
.btn-sm { font-size: 12px; padding: 4px 10px; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
