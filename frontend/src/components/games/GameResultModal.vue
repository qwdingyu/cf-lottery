<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="game-result-overlay"
      @click.self="emit('close')"
      @keydown.escape="emit('close')"
    >
      <div
        class="game-result-modal"
        ref="modalRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <button type="button" class="result-close" :aria-label="$t('lottery.gotIt')" @click="emit('close')">✕</button>

        <!--
          语义分支（docs/055a / 107）：本弹窗表示「参与已提交」，不是默认「已开奖中奖」。
          - instant + 有 outcome：展示结果标签
          - scheduled / manual / 其它 result_mode：参与成功 + 按 mode 诚实下一步
        -->
        <div class="result-icon" aria-hidden="true">{{ statusIcon }}</div>
        <h2 :id="titleId" class="result-title">{{ statusTitle }}</h2>
        <p class="result-hint">{{ statusHint }}</p>

        <!--
          裂变/邀请：仅活动未终态（docs/103）。
          加载中 / 成功 / 失败三态互斥，禁止失败后仍显示「加载分享链接…」（docs/105）。
        -->
        <template v-if="inviteShareAllowed">
          <div v-if="viralEnabled && shareLoaded" class="viral-card">
            <div class="viral-headline">{{ $t('lottery.viralHeadline') }}</div>
            <p class="viral-hint">{{ $t('lottery.viralInviteHint', { n: extraPerInvite }) }}</p>

            <div class="viral-stats">
              <div class="viral-stat">
                <span class="viral-stat-value">{{ shareData?.joinedCount ?? 0 }}</span>
                <span class="viral-stat-label">{{ $t('lottery.viralInvitedLabel') }}</span>
              </div>
              <div class="viral-stat">
                <span class="viral-stat-value">{{ extraEntriesEarned }}</span>
                <span class="viral-stat-label">{{ $t('lottery.viralExtraEarnedLabel') }}</span>
              </div>
              <div class="viral-stat">
                <span class="viral-stat-value">{{ maxExtraEntries }}</span>
                <span class="viral-stat-label">{{ $t('lottery.viralMaxLabel') }}</span>
              </div>
            </div>

            <div class="viral-progress">
              <div class="viral-progress-fill" :style="{ width: extraProgressPercent + '%' }" />
            </div>
            <p class="viral-progress-caption">{{ $t('lottery.viralExtraProgress', { earned: extraEntriesEarned, max: maxExtraEntries }) }}</p>

            <div class="viral-link-row">
              <code class="viral-link-text">{{ displayShareUrl }}</code>
              <button type="button" class="btn btn-sm btn-primary" @click="copyAttributedLink">
                {{ $t('lottery.copyShareLink') }}
              </button>
            </div>
          </div>

          <div v-else-if="shareLoaded" class="viral-link-row">
            <button type="button" class="btn btn-ghost" @click="copyAttributedLink">{{ $t('lottery.shareActivityBtn') }}</button>
          </div>

          <div v-else-if="shareError" class="viral-share-fail">
            <p class="result-error">{{ shareError }}</p>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="shareLoading" @click="loadShareLink">
              {{ shareLoading ? $t('lottery.loadingText') : $t('lottery.viralRetryShare') }}
            </button>
          </div>

          <div v-else-if="entryId && shareLoading" class="result-hint" style="margin-top:12px">
            {{ $t('lottery.viralLoadShareLink') }}
          </div>
        </template>

        <!--
          闭环 CTA（docs/096）：「知道了」只关弹窗不够；
          非即时或尚无 outcome 时提供「查我的结果」；分享仅未终态活动。
        -->
        <div class="result-actions">
          <button
            v-if="showQueryResultCta"
            type="button"
            class="btn btn-primary"
            @click="emit('query-result')"
          >{{ $t('lottery.queryResult') }}</button>
          <button
            v-if="inviteShareAllowed && shareLoaded && shareUrl"
            type="button"
            class="btn btn-ghost"
            @click="copyAttributedLink"
          >{{ $t('lottery.copyShareLink') }}</button>
          <button
            type="button"
            class="btn"
            :class="showQueryResultCta ? 'btn-ghost' : 'btn-primary'"
            @click="emit('close')"
          >{{ $t('lottery.gotIt') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, useId } from 'vue'
import { writeClipboardText } from '@/composables/useClipboard'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { shouldShowInviteShareCta } from '@/views/lottery/public-helpers'

const props = defineProps<{
  show: boolean
  drawSlug?: string
  entryId?: string
  /** 结果何时产生：instant | scheduled | manual 等；缺省按「已登记、待结果」 */
  resultMode?: string | null
  /** 即时结果标签（若有）；不表示转盘停扇结果 */
  outcomeLabel?: string | null
  /** 活动 status：drawn/cancelled 时不展示邀请分享（docs/103） */
  drawStatus?: string | null
  viralConfig?: { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | null
}>()

const emit = defineEmits<{ close: []; 'query-result': [] }>()

const { t } = useI18n()
const { showToast } = useToast()
const modalRef = ref<HTMLElement | null>(null)
const titleId = `game-result-title-${useId()}`

const shareData = ref<{
  shareCode: string
  shareUrl: string
  clickedCount?: number
  joinedCount?: number
  /** 与开奖公式一致的已赚额外次数（来自 my-viral-stats） */
  extraEntriesEarned?: number
} | null>(null)
const shareLoading = ref(false)
const shareError = ref('')

const isInstant = computed(() => (props.resultMode || '').toLowerCase() === 'instant')
const hasOutcome = computed(() => Boolean(props.outcomeLabel && String(props.outcomeLabel).trim()))

/**
 * 何时展示「查我的结果」：
 * - 已有即时 outcome → 弹窗本身已是结果，不必再查
 * - 否则（scheduled/manual/instant 尚无标签）→ 引导查卡密/状态，闭环不中断
 */
const showQueryResultCta = computed(() => !(isInstant.value && hasOutcome.value))

/** 标题：有即时 outcome 用带结果文案；否则统一「参与成功」 */
const statusTitle = computed(() => {
  if (hasOutcome.value) {
    return t('lottery.joinSuccessWithOutcome', { outcome: String(props.outcomeLabel).trim() })
  }
  return t('lottery.joinSuccess')
})

/**
 * 说明文案：按 result_mode 诚实表达下一步。
 * 不用 pageHint（那是页顶「如何参与」说明，放在成功弹窗会错位）。
 */
const statusHint = computed(() => {
  // 即时有 outcome：只说「结果已就绪」，不在 hint 里推邀请（邀请 CTA 另有门禁，docs/104）
  if (hasOutcome.value && isInstant.value) {
    return t('lottery.joinResultHintInstantDone')
  }
  if (isInstant.value) {
    return t('lottery.joinResultHintInstant')
  }
  const mode = (props.resultMode || '').toLowerCase()
  if (mode === 'scheduled') {
    return t('lottery.joinResultHintScheduled')
  }
  if (mode === 'manual') {
    return t('lottery.joinResultHintManual')
  }
  // 非抽奖：诚实语义，勿套「等开奖」（docs/097 / docs/105）
  if (mode === 'no_result') {
    return t('lottery.joinResultHintNoResult')
  }
  if (mode === 'vote_tally') {
    return t('lottery.joinResultHintVoteTally')
  }
  if (mode === 'ordered_assignment' || mode === 'capacity_assignment') {
    return t('lottery.joinResultHintOrdered')
  }
  if (mode === 'review_decision') {
    return t('lottery.joinResultHintReview')
  }
  // 未知或未传：保守「已登记，待结果」（joinResultHintPending 已中性化，docs/107）
  return t('lottery.joinResultHintPending')
})

const statusIcon = computed(() => {
  if (hasOutcome.value) return '🎉'
  if (isInstant.value) return '✨'
  return '✅'
})

/** 已开奖/取消：不拉分享、不展示邀请（docs/103） */
const inviteShareAllowed = computed(() => shouldShowInviteShareCta(props.drawStatus))
const viralEnabled = computed(
  () => inviteShareAllowed.value && props.viralConfig?.enabled === true && !!props.entryId,
)
const maxExtraEntries = computed(() => {
  const n = Number(props.viralConfig?.maxExtraEntries)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
})
/** 每邀额外次数：与后端 normalize 一致 */
const extraPerInvite = computed(() => {
  const n = Number(props.viralConfig?.extraEntriesPerInvite)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
})
/**
 * 弹窗侧估算已赚额外次数（刚生成分享时 joined 多为 0）。
 * 优先用 my-viral-stats 回填的 earned；否则 min(joined × per, max)。
 */
const extraEntriesEarned = computed(() => {
  if (shareData.value?.extraEntriesEarned != null) {
    return Math.max(0, Number(shareData.value.extraEntriesEarned) || 0)
  }
  const joined = shareData.value?.joinedCount ?? 0
  return Math.min(joined * extraPerInvite.value, maxExtraEntries.value)
})
const extraProgressPercent = computed(() => {
  const max = maxExtraEntries.value
  return max > 0 ? Math.min(100, Math.round((extraEntriesEarned.value / max) * 100)) : 0
})
const shareLoaded = computed(() => shareData.value !== null)
const shareUrl = computed(() => shareData.value?.shareUrl ?? '')
const displayShareUrl = computed(() => {
  const path = shareUrl.value
  if (!path) return ''
  if (path.startsWith('http')) return path
  return typeof window !== 'undefined' ? window.location.origin + path : path
})

async function loadShareLink() {
  if (!inviteShareAllowed.value) return
  if (!props.entryId || !props.drawSlug) return
  shareLoading.value = true
  shareError.value = ''
  try {
    const slug = encodeURIComponent(props.drawSlug)
    // 先拉已有统计（含正确 extra 公式）；无码再 POST /share
    const statsRes = await fetch(
      `/api/public/draws/${slug}/my-viral-stats?entryId=${encodeURIComponent(props.entryId)}`,
    )
    if (statsRes.ok) {
      const stats = await statsRes.json()
      if (stats.ok !== false && stats.shareUrl) {
        shareData.value = {
          shareCode: stats.shareCode,
          shareUrl: stats.shareUrl,
          clickedCount: stats.clickedCount,
          joinedCount: stats.invitedCount,
          extraEntriesEarned: stats.extraEntriesEarned,
        }
        return
      }
    }
    const res = await fetch(`/api/public/draws/${slug}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: props.entryId }),
    })
    const data = await res.json()
    if (data.ok) {
      shareData.value = {
        shareCode: data.shareCode,
        shareUrl: data.shareUrl,
        clickedCount: 0,
        joinedCount: 0,
        extraEntriesEarned: 0,
      }
    } else {
      shareError.value = data.message || t('lottery.shareLinkFailed')
    }
  } catch {
    shareError.value = t('lottery.networkError')
  } finally {
    shareLoading.value = false
  }
}

async function copyAttributedLink() {
  if (!inviteShareAllowed.value) return
  const url = shareData.value?.shareUrl
  if (!url) {
    await writeClipboardText(window.location.href)
  } else if (url.startsWith('http')) {
    await writeClipboardText(url)
  } else {
    await writeClipboardText(window.location.origin + url)
  }
  showToast(t('lottery.shareLinkCopied'))
}

watch(() => props.show, async (newVal) => {
  if (newVal && props.entryId) {
    shareData.value = null
    shareError.value = ''
    if (inviteShareAllowed.value) void loadShareLink()
    // 弹窗打开后聚焦到弹窗（焦点陷阱）
    await nextTick()
    modalRef.value?.focus()
  }
})
</script>

<style scoped>
.game-result-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.game-result-modal { background: var(--tg-bg); border-radius: 16px; padding: 32px 24px; max-width: 400px; width: 90%; text-align: center; position: relative; animation: modalIn .3s ease; }
.result-close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--tg-hint); }
.result-icon { font-size: 48px; margin-bottom: 12px; }
.result-title { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
.result-hint { font-size: 14px; color: var(--tg-hint); margin-bottom: 16px; }
.result-error { font-size: 13px; color: #ef4444; margin: 0 0 8px; }
.viral-share-fail {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.viral-hint {
  font-size: 12px;
  color: var(--tg-hint);
  margin: 0 0 10px;
}
.viral-progress-caption {
  font-size: 11px;
  color: var(--tg-hint);
  margin: 6px 0 10px;
}
.result-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 16px;
}
.result-actions .btn { min-height: 44px; }

/* 裂变引导卡片 */
.viral-card {
  margin: 16px 0 0;
  padding: 16px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.05));
  border-radius: 12px;
  text-align: left;
}
.viral-headline { font-size: 14px; font-weight: 600; margin-bottom: 12px; text-align: center; }
.viral-stats { display: flex; justify-content: center; gap: 24px; margin-bottom: 10px; }
.viral-stat { text-align: center; }
.viral-stat-value { font-size: 20px; font-weight: 700; }
.viral-stat-label { font-size: 11px; color: var(--tg-hint); display: block; }
.viral-progress {
  height: 6px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.1));
  border-radius: 3px;
  margin-bottom: 0;
  overflow: hidden;
}
.viral-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4ade80, #22c55e);
  border-radius: 3px;
  transition: width .4s ease;
}
.viral-link-row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  margin-top: 8px;
}
.viral-link-text {
  font-size: 11px;
  color: var(--tg-hint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.05));
  padding: 4px 8px;
  border-radius: 4px;
}

@keyframes modalIn { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: scale(1); } }
</style>
