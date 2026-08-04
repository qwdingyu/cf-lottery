<template>
  <div v-if="hasData" class="viral-section">
    <!-- 我的裂变数据（需要 entryId） -->
    <div v-if="entryId && myStats" class="my-viral-card">
      <div class="my-viral-head">
        <span class="my-viral-title">{{ $t('lottery.viralMyInvite') }}</span>
        <span class="my-viral-extra">{{ $t('lottery.viralInviteHint', { n: myStats.extraEntriesPerInvite }) }}</span>
      </div>
      <div class="my-viral-body">
        <div class="my-viral-stat">
          <span class="my-viral-num">{{ myStats.invitedCount }}</span>
          <span class="my-viral-label">{{ $t('lottery.viralInvitedLabel') }}</span>
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
          <code class="my-viral-link">{{ myStats.shareUrl || $t('lottery.viralGenerateHint') }}</code>
          <button class="btn btn-sm btn-primary" @click="handleGenerateShareLink">
            {{ myStats.shareUrl ? $t('lottery.viralCopy') : $t('lottery.viralGenerateLink') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 排行榜 -->
    <div class="leaderboard-card">
      <h4 class="leaderboard-title">{{ $t('lottery.viralLeaderboardTitle') }}</h4>
      <div v-if="leaderboard.length === 0" class="leaderboard-empty">
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
      <!-- 我的排名（不在 Top 20 时展示） -->
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

const props = defineProps<{
  /** 活动 publicSlug */
  drawSlug: string
  /** 当前参与者的 entryId（可选，用于查询"我的"数据） */
  entryId?: string
  /** 裂变配置 */
  viralConfig?: { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | null
}>()

interface LeaderboardEntry { rank: number; displayName: string; invitedCount: number }
interface MyViralStats {
  shareCode: string; shareUrl: string
  clickedCount: number; invitedCount: number
  extraEntriesEarned: number; extraEntriesPerInvite: number; maxExtraEntries: number
}

const leaderboard = ref<LeaderboardEntry[]>([])
const myRank = ref<{ rank: number; invitedCount: number } | null>(null)
const myStats = ref<MyViralStats | null>(null)
const loading = ref(false)

const hasData = computed(() => leaderboard.value.length > 0 || (myStats.value !== null))
const myProgressPercent = computed(() => {
  if (!myStats.value) return 0
  const max = myStats.value.maxExtraEntries
  return max > 0 ? Math.min(100, Math.round((myStats.value.invitedCount / max) * 100)) : 0
})

async function fetchData() {
  loading.value = true
  const slug = encodeURIComponent(props.drawSlug)
  try {
    // 并行请求排行榜和我的数据
    const [lbRes, statsRes] = await Promise.all([
      fetch(`/api/public/draws/${slug}/viral-leaderboard${props.entryId ? `?entryId=${encodeURIComponent(props.entryId)}` : ''}`),
      props.entryId
        ? fetch(`/api/public/draws/${slug}/my-viral-stats?entryId=${encodeURIComponent(props.entryId)}`)
        : Promise.resolve(null),
    ])

    if (lbRes.ok) {
      const lb = await lbRes.json()
      leaderboard.value = lb.entries || []
      myRank.value = lb.myRank || null
    }

    if (statsRes && statsRes.ok) {
      myStats.value = await statsRes.json()
    }
  } catch {
    // 排行榜加载失败不影响主流程
  } finally {
    loading.value = false
  }
}

/** 生成分享链接（复制到剪贴板） */
async function handleGenerateShareLink() {
  if (myStats.value?.shareUrl) {
    await writeClipboardText(window.location.origin + myStats.value.shareUrl)
  } else if (props.entryId) {
    // 调用 /share API 生成新链接
    try {
      const slug = encodeURIComponent(props.drawSlug)
      const res = await fetch(`/api/public/draws/${slug}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId: props.entryId }),
      })
      const data = await res.json()
      if (data.ok) {
        await writeClipboardText(window.location.origin + data.shareUrl)
        // 刷新数据
        await fetchData()
      }
    } catch { /* 忽略 */ }
  }
}

// 组件挂载时和 props 变化时刷新
onMounted(() => { void fetchData() })
watch(() => [props.entryId, props.drawSlug], () => { void fetchData() })
</script>

<style scoped>
.viral-section {
  margin: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 我的裂变卡片 */
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
}
.my-viral-title { font-weight: 600; font-size: 14px; }
.my-viral-extra { font-size: 11px; color: var(--tg-hint); }
.my-viral-body { display: flex; flex-direction: column; gap: 10px; }
.my-viral-stat { text-align: center; }
.my-viral-num { font-size: 28px; font-weight: 700; color: #4ade80; }
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
}

/* 排行榜 */
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
.leaderboard-row.is-me { background: rgba(74,222,128,.06); margin: 0 -14px; padding-left: 14px; padding-right: 14px; border-radius: 6px; }
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
</style>
