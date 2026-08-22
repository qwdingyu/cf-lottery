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
            <!-- 分享引导标题按参与结果状态差异化（docs/107 话术）：
                 接龙占位 → 「已占位，邀好友一起加入」；抽奖待开奖 → 「邀好友一起赢」 -->
            <div class="viral-headline">{{ $t(`lottery.${viralHeadlineKey}`) }}</div>
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

            <!-- docs/259 D2：里程碑层进度（viral 关闭但配了 referralRewardDefs 时仍可见） -->
            <div v-if="hasMilestones" class="viral-milestones">
              <div class="viral-milestones-summary">
                <span class="viral-milestones-unlocked">
                  {{ $t('lottery.viralMilestonesUnlocked', { unlocked: shareData?.milestonesUnlocked, total: shareData?.milestones?.length || 0 }) }}
                </span>
                <span v-if="shareData?.nextMilestone" class="viral-milestones-next">
                  {{ $t('lottery.viralMilestonesNext', { n: shareData.nextMilestone.requireCount }) }}
                </span>
              </div>
              <div class="viral-milestones-list">
                <div
                  v-for="(ms, idx) in shareData?.milestones"
                  :key="idx"
                  class="viral-milestone-row"
                  :class="{ 'viral-milestone-row--granted': ms.granted }"
                >
                  <span class="viral-milestone-count">{{ ms.requireCount }}{{ $t('lottery.viralMilestonesPeople') }}</span>
                  <span class="viral-milestone-reward">
                    {{ ms.rewardValue }}
                    <span v-if="ms.rewardExit === 'bonus_spin'">{{ $t('lottery.viralMilestonesSpins') }}</span>
                    <span v-else>{{ $t('lottery.viralMilestonesCoupon') }}</span>
                  </span>
                  <span v-if="ms.granted" class="viral-milestone-badge">{{ $t('lottery.viralMilestonesGranted') }}</span>
                </div>
              </div>
            </div>

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
import { writeClipboardText } from '@usethink/cf-admin-fe/composables'
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { shouldShowInviteShareCta } from '@/views/lottery/public-helpers'
import {
  joinSuccessModalHintI18nKey,
  shouldShowJoinResultQueryCta,
  viralHeadlineI18nKey,
} from '@/views/lottery/joined-session'

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
  viralConfig?: { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean; referralRewardDefs?: unknown[] } | null
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
  // docs/259 D2：里程碑层进度（viral 关闭但配了 referralRewardDefs 时仍可见）
  milestones?: Array<{ requireCount: number; rewardExit: string; rewardValue: number; granted?: boolean }>
  nextMilestone?: { requireCount: number; rewardExit: string; rewardValue: number } | null
  milestonesUnlocked?: number
  milestonesGranted?: number
} | null>(null)
const shareLoading = ref(false)
const shareError = ref('')

const isInstant = computed(() => (props.resultMode || '').toLowerCase() === 'instant')
const hasOutcome = computed(() => Boolean(props.outcomeLabel && String(props.outcomeLabel).trim()))

/**
 * 「查我的结果」CTA：纯函数 shouldShowJoinResultQueryCta（docs/115），
 * 禁止在 SFC 内复制 instant+outcome 分支以免与横幅/单测漂移。
 */
const showQueryResultCta = computed(() =>
  shouldShowJoinResultQueryCta(props.resultMode, props.outcomeLabel),
)

/** 标题：有即时 outcome 用带结果文案；否则统一「参与成功」 */
const statusTitle = computed(() => {
  if (hasOutcome.value) {
    return t('lottery.joinSuccessWithOutcome', { outcome: String(props.outcomeLabel).trim() })
  }
  return t('lottery.joinSuccess')
})

/**
 * 说明文案：joinSuccessModalHintI18nKey 单一真相（与 joined-session 单测锁死）。
 * 不用 pageHint（页顶「如何参与」放在成功弹窗会错位）。
 */
const statusHint = computed(() =>
  t(`lottery.${joinSuccessModalHintI18nKey(props.resultMode, props.outcomeLabel)}`),
)

const statusIcon = computed(() => {
  if (hasOutcome.value) return '🎉'
  if (isInstant.value) return '✨'
  return '✅'
})

/** 裂变分享引导标题 key（按结果状态差异化，纯函数单测锁定） */
const viralHeadlineKey = computed(() =>
  viralHeadlineI18nKey(props.resultMode, props.outcomeLabel),
)

/** 已开奖/取消：不拉分享、不展示邀请（docs/103） */
const inviteShareAllowed = computed(() => shouldShowInviteShareCta(props.drawStatus))
const viralEnabled = computed(() => {
  if (!inviteShareAllowed.value || !props.entryId) return false
  const cfg = props.viralConfig
  if (cfg?.enabled === true) return true
  // docs/259 D2：viral 关闭但配置了 referralRewardDefs 时，仍允许展示里程碑进度
  if (cfg?.referralRewardDefs && cfg.referralRewardDefs.length > 0) return true
  return false
})
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
const hasMilestones = computed(() => {
  const ms = shareData.value?.milestones
  return Array.isArray(ms) && ms.length > 0
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
          // docs/259 D2：里程碑层进度（viral 关闭但配了 referralRewardDefs 时仍可见）
          milestones: stats.milestones || [],
          nextMilestone: stats.nextMilestone || null,
          milestonesUnlocked: stats.milestonesUnlocked ?? 0,
          milestonesGranted: stats.milestonesGranted ?? 0,
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
  // 无专属链时禁止静默复制当前页（可能带别人的 ?ref=，会污染归因，docs/110）
  if (!url) {
    shareError.value = t('lottery.shareLinkFailed')
    return
  }
  try {
    if (url.startsWith('http')) {
      await writeClipboardText(url)
    } else {
      await writeClipboardText(window.location.origin + url)
    }
    showToast(t('lottery.shareLinkCopied'))
  } catch {
    shareError.value = t('lottery.viralCopyFailed')
  }
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

/* docs/259 D2：里程碑层进度（viral 关闭但配了 referralRewardDefs 时仍可见） */
.viral-milestones {
  margin: 10px 0 0;
  padding: 12px;
  background: var(--tg-secondary-bg, rgba(255,255,255,.03));
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,.06);
}
.viral-milestones-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--tg-hint);
}
.viral-milestones-next {
  font-weight: 600;
  color: var(--tg-text);
}
.viral-milestones-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.viral-milestone-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,.02);
}
.viral-milestone-row--granted {
  background: rgba(74,222,128,.08);
}
.viral-milestone-count {
  font-weight: 700;
  min-width: 56px;
}
.viral-milestone-reward {
  flex: 1;
  color: var(--tg-hint);
}
.viral-milestone-badge {
  font-size: 11px;
  font-weight: 700;
  color: #4ade80;
}

@keyframes modalIn { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: scale(1); } }
</style>
