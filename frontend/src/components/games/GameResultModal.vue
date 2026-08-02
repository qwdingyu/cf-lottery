<template>
  <Teleport to="body">
    <div v-if="show" class="game-result-overlay" @click.self="emit('close')">
      <div class="game-result-modal">
        <button class="result-close" @click="emit('close')">✕</button>

        <div class="result-icon">✅</div>
        <h2 class="result-title">$t('lottery.joinSuccess')</h2>
        <p class="result-hint">$t('lottery.pageHint')</p>

        <!-- 裂变引导卡片：仅在 viralConfig.enabled 且已加载分享链接时展示 -->
        <div v-if="viralEnabled && shareLoaded" class="viral-card">
          <div class="viral-headline">🎁 邀请好友参与，额外获得抽奖机会！</div>

          <div class="viral-stats">
            <div class="viral-stat">
              <span class="viral-stat-value">{{ shareData?.joinedCount ?? 0 }}</span>
              <span class="viral-stat-label">$t('lottery.viralInvitedLabel')</span>
            </div>
            <div class="viral-stat">
              <span class="viral-stat-value">{{ maxExtraEntries }}</span>
              <span class="viral-stat-label">$t('lottery.viralMaxLabel')</span>
            </div>
          </div>

          <div class="viral-progress">
            <div
              class="viral-progress-fill"
              :style="{ width: extraProgressPercent + '%' }"
            />
          </div>

          <div class="viral-link-row">
            <code class="viral-link-text">{{ shareUrl }}</code>
            <button class="btn btn-sm btn-primary" @click="copyAttributedLink">
              📋 复制专属链接
            </button>
          </div>
        </div>

        <!-- 无裂变配置时：保持简洁，但使用归因链接 -->
        <div v-else-if="shareLoaded" class="viral-link-row">
          <button class="btn btn-ghost" @click="copyAttributedLink">📤 分享活动</button>
        </div>

        <!-- 分享链接加载中 -->
        <div v-else-if="entryId" class="result-hint" style="margin-top:12px">$t('lottery.viralLoadShareLink')</div>

        <div class="result-actions">
          <button class="btn btn-primary" @click="emit('close')">{{ $t('lottery.gotIt') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { writeClipboardText } from '@/composables/useClipboard'

const props = defineProps<{
  show: boolean
  /** 活动 publicSlug，用于调用 /share API 生成归因链接 */
  drawSlug?: string
  /** 参与记录 ID，用于调用 /share API */
  entryId?: string
  /** 裂变配置（promotion_config.viral），控制是否展示裂变引导 */
  viralConfig?: { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | null
}>()

const emit = defineEmits<{ close: [] }>()

const shareData = ref<{ shareCode: string; shareUrl: string; clickedCount?: number; joinedCount?: number } | null>(null)
const shareLoading = ref(false)
const shareError = ref('')

const viralEnabled = computed(() => props.viralConfig?.enabled === true && !!props.entryId)
const maxExtraEntries = computed(() => props.viralConfig?.maxExtraEntries ?? 10)
const extraProgressPercent = computed(() => {
  const joined = shareData.value?.joinedCount ?? 0
  const max = maxExtraEntries.value
  return max > 0 ? Math.min(100, Math.round((joined / max) * 100)) : 0
})
const shareLoaded = computed(() => shareData.value !== null)
const shareUrl = computed(() => shareData.value?.shareUrl ?? '')

/** 调用后端 /share API 生成带归因码的分享链接 */
async function loadShareLink() {
  if (!props.entryId || !props.drawSlug) return
  shareLoading.value = true
  shareError.value = ''
  try {
    const res = await fetch(`/api/public/draws/${encodeURIComponent(props.drawSlug)}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: props.entryId }),
    })
    const data = await res.json()
    if (data.ok) {
      shareData.value = data
    } else {
      shareError.value = data.message || '生成分享链接失败'
    }
  } catch {
    shareError.value = '网络错误'
  } finally {
    shareLoading.value = false
  }
}

/** 复制带归因码的分享链接 */
async function copyAttributedLink() {
  const url = shareData.value?.shareUrl
  if (!url) {
    // fallback：如果 API 还没返回，复制当前页面 URL
    await writeClipboardText(window.location.href)
  } else {
    // 构造完整 URL（shareUrl 是相对路径如 /slug?ref=abc123）
    const origin = window.location.origin
    await writeClipboardText(origin + url)
  }
}

// 弹窗打开时自动加载分享链接
watch(() => props.show, (newVal) => {
  if (newVal && props.entryId) {
    shareData.value = null
    shareError.value = ''
    void loadShareLink()
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
.result-actions { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }

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
  margin-bottom: 12px;
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
