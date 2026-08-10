<template>
  <div class="acc-view">
    <div class="acc-card">
      <!-- 加载中 -->
      <div v-if="loading" class="acc-state">
        <div class="acc-spinner"></div>
        <p class="acc-state-text">{{ $t('accessCardCodes.loading') }}</p>
      </div>

      <!-- 错误状态 -->
      <div v-else-if="error" class="acc-state">
        <div class="acc-error-icon">!</div>
        <p class="acc-state-text acc-error">{{ error }}</p>
        <p class="acc-hint">{{ $t('accessCardCodes.securityHint') }}</p>
      </div>

      <!-- 空状态 -->
      <div v-else-if="cardCodes.length === 0" class="acc-state">
        <p class="acc-state-text">{{ $t('accessCardCodes.empty') }}</p>
      </div>

      <!-- 卡密列表 -->
      <template v-else>
        <div class="acc-header">
          <h1 class="acc-title">{{ $t('accessCardCodes.title') }}</h1>
          <p class="acc-total">{{ $t('accessCardCodes.total', { count: cardCodes.length }) }}</p>
        </div>

        <div class="acc-security-notice">
          ⚠️ {{ $t('accessCardCodes.securityHint') }}
          <br>
          📋 {{ $t('accessCardCodes.saveHint') }}
        </div>

        <div class="acc-list">
          <div v-for="(item, idx) in cardCodes" :key="idx" class="acc-item">
            <div class="acc-item-header">
              <span class="acc-item-prize">{{ item.prizeName }}</span>
              <span v-if="item.drawTitle" class="acc-item-draw">{{ item.drawTitle }}</span>
            </div>
            <div class="acc-item-code">
              <code class="acc-code-text">{{ item.cardCode }}</code>
              <button class="btn btn-ghost btn-sm acc-copy" @click="copyCode(item.cardCode, idx)">
                {{ copyLabels[idx] || $t('common.copy') }}
              </button>
            </div>
            <div v-if="item.drawnAt" class="acc-item-time">
              {{ $t('accessCardCodes.drawnAt') }}: {{ formatTime(item.drawnAt) }}
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const route = useRoute()

const API_BASE = '/api'
const loading = ref(true)
const error = ref('')
const cardCodes = ref<Array<{
  drawTitle: string
  prizeName: string
  cardCode: string | null
  drawnAt: string
}>>([])
const copyLabels = ref<Record<number, string>>({})

onMounted(async () => {
  const token = route.query.token as string
  if (!token) {
    loading.value = false
    error.value = t('accessCardCodes.invalidToken')
    return
  }

  try {
    const res = await fetch(`${API_BASE}/public/access/card-codes?token=${encodeURIComponent(token)}`)
    const data = await res.json().catch(() => null)

    if (!res.ok || !data?.ok) {
      error.value = data?.message || t('accessCardCodes.invalidToken')
      return
    }

    cardCodes.value = data.cardCodes || []
  } catch {
    error.value = t('accessCardCodes.invalidToken')
  } finally {
    loading.value = false
  }
})

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

function copyCode(code: string | null, idx: number): void {
  if (!code) return
  navigator.clipboard.writeText(code).then(() => {
    copyLabels.value[idx] = '✓'
    setTimeout(() => { delete copyLabels.value[idx] }, 2000)
  }).catch(() => {
    copyLabels.value[idx] = t('common.copyFailed')
  })
}
</script>

<style scoped>
.acc-view {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--tg-bg);
}

.acc-card {
  max-width: 520px;
  width: 100%;
  background: var(--tg-section-bg);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

.acc-state {
  text-align: center;
  padding: 48px 16px;
}

.acc-state-text {
  font-size: 15px;
  color: var(--tg-text);
  margin: 16px 0 0;
  line-height: 1.6;
}

.acc-state-text.acc-error {
  color: var(--tg-danger, #e74c3c);
  font-weight: 500;
}

.acc-error-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--tg-danger, #e74c3c);
  color: white;
  font-size: 24px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.acc-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--tg-border);
  border-top-color: var(--tg-accent);
  border-radius: 50%;
  animation: acc-spin 0.8s linear infinite;
  margin: 0 auto;
}

@keyframes acc-spin {
  to { transform: rotate(360deg); }
}

.acc-hint {
  font-size: 13px;
  color: var(--tg-hint);
  margin-top: 16px;
  line-height: 1.5;
}

.acc-header {
  margin-bottom: 16px;
}

.acc-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 4px;
  color: var(--tg-text);
}

.acc-total {
  font-size: 14px;
  color: var(--tg-hint);
  margin: 0;
}

.acc-security-notice {
  font-size: 13px;
  color: var(--tg-warning, #e67e22);
  background: var(--tg-warning-bg, #fef3e0);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 20px;
  line-height: 1.6;
}

.acc-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.acc-item {
  border: 1px solid var(--tg-border);
  border-radius: 8px;
  padding: 14px 16px;
}

.acc-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  gap: 8px;
}

.acc-item-prize {
  font-weight: 600;
  font-size: 15px;
  color: var(--tg-text);
}

.acc-item-draw {
  font-size: 12px;
  color: var(--tg-hint);
  flex-shrink: 0;
}

.acc-item-code {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--tg-bg);
  border-radius: 6px;
  padding: 8px 10px;
}

.acc-code-text {
  flex: 1;
  font-size: 14px;
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
  word-break: break-all;
  color: var(--tg-text);
  user-select: all;
}

.acc-copy {
  flex-shrink: 0;
  min-width: 48px;
  text-align: center;
}

.acc-item-time {
  font-size: 12px;
  color: var(--tg-hint);
  margin-top: 6px;
}
</style>