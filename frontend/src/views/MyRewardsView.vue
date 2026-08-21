<template>
  <div class="my-rewards-page">
    <!-- 页面头部：返回按钮 + 标题，让页面看起来像独立页面而非模态框 -->
    <header class="mr-page-header">
      <button type="button" class="mr-back-btn" @click="goBack" :aria-label="$t('myRewards.back')">
        <span class="mr-back-arrow">←</span>
        <span class="mr-back-text">{{ $t('myRewards.back') }}</span>
      </button>
    </header>

    <div class="my-rewards-card">
      <!-- 关闭按钮（卡片右上角，迎合"模态框"视觉习惯） -->
      <button type="button" class="mr-close-btn" @click="goBack" :aria-label="$t('myRewards.close')">
        ✕
      </button>

      <!-- 加载中 -->
      <div v-if="loading" class="mr-state">
        <div class="mr-spinner"></div>
        <p class="mr-state-text">{{ $t('myRewards.loading') }}</p>
      </div>

      <!-- 错误状态 -->
      <div v-else-if="error" class="mr-state">
        <div class="mr-error-icon">!</div>
        <p class="mr-state-text mr-error">{{ error }}</p>
        <!-- 登录提示改为可点击按钮，引导用户去参与活动 -->
        <button
          v-if="!token"
          type="button"
          class="btn btn-primary mr-login-btn"
          @click="goToLottery"
        >{{ $t('myRewards.goToLottery') }}</button>
      </div>

      <!-- 空状态 -->
      <div v-else-if="rewards.length === 0" class="mr-state">
        <p class="mr-state-text">{{ $t('myRewards.empty') }}</p>
        <button
          type="button"
          class="btn btn-primary mr-login-btn"
          @click="goToLottery"
        >{{ $t('myRewards.goToLottery') }}</button>
      </div>

      <!-- 奖励列表 -->
      <template v-else>
        <div class="mr-header">
          <h1 class="mr-title">{{ $t('myRewards.title') }}</h1>
          <p class="mr-total">{{ $t('myRewards.total', { count: rewards.length }) }}</p>
        </div>

        <div class="mr-list">
          <div v-for="(item, idx) in rewards" :key="idx" class="mr-item">
            <div class="mr-item-header">
              <span class="mr-item-title">{{ item.title }}</span>
              <a
                class="mr-item-link"
                :href="`/lottery/${item.slug}`"
              >{{ $t('myRewards.viewDraw') }}</a>
            </div>

            <!-- spins 奖励 -->
            <div v-if="item.spinsLeft > 0" class="mr-item-row">
              <span class="mr-item-label">{{ $t('myRewards.spins') }}</span>
              <span class="mr-item-value">{{ item.spinsLeft }}</span>
            </div>

            <!-- coupons 奖励 -->
            <div v-if="item.coupons.length > 0" class="mr-item-row">
              <span class="mr-item-label">{{ $t('myRewards.coupons') }}</span>
              <div class="mr-coupons">
                <div
                  v-for="(cp, ci) in item.coupons"
                  :key="ci"
                  class="mr-coupon"
                >
                  <code class="mr-coupon-code" @click="copyCoupon(cp, idx, ci)">{{ cp }}</code>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm mr-redeem-btn"
                    :disabled="redeemingKey === `${idx}-${ci}`"
                    @click="redeemCoupon(item, cp, idx, ci)"
                  >
                    {{ redeemingKey === `${idx}-${ci}` ? $t('myRewards.redeeming') : $t('myRewards.redeem') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 无奖励 -->
            <div v-if="item.spinsLeft <= 0 && item.coupons.length === 0" class="mr-item-row">
              <span class="mr-item-label mr-item-muted">{{ $t('myRewards.noReward') }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'

const { t } = useI18n()
const { showToast } = useToast()
const router = useRouter()

const API_BASE = '/api'
const LOTTERY_REGISTERED_TOKEN_KEY = 'lottery_registered_token'

const token = ref(sessionStorage.getItem(LOTTERY_REGISTERED_TOKEN_KEY) || '')
const loading = ref(true)
const error = ref('')
const rewards = ref<Array<{
  drawId: string
  tenantId: string
  slug: string
  title: string
  spinsLeft: number
  coupons: string[]
}>>([])
const redeemingKey = ref('')

interface MyRewardItem {
  drawId: string
  tenantId: string
  slug: string
  title: string
  spinsLeft: number
  coupons: string[]
}

/** 返回上一页；若无历史记录则回退到活动列表页 */
function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    void router.push('/lottery')
  }
}

/** 跳转到活动列表页，让用户参与活动后返回 */
function goToLottery() {
  void router.push('/lottery')
}

onMounted(async () => {
  if (!token.value) {
    loading.value = false
    error.value = t('myRewards.needLogin')
    return
  }

  try {
    const res = await fetch(`${API_BASE}/public/my-rewards`, {
      headers: { Authorization: `Bearer ${token.value}` },
    })
    const data = await res.json().catch(() => null)

    if (!res.ok || !data?.ok) {
      error.value = data?.message || t('myRewards.loadFailed')
      return
    }

    rewards.value = data.rewards || []
  } catch {
    error.value = t('myRewards.loadFailed')
  } finally {
    loading.value = false
  }
})

function copyCoupon(code: string, _idx: number, _ci: number): void {
  try {
    void navigator.clipboard.writeText(code)
    showToast(t('myRewards.copied'), 'success')
  } catch {
    showToast(t('myRewards.copyFailed'), 'error')
  }
}

async function redeemCoupon(_item: MyRewardItem, code: string, idx: number, ci: number): Promise<void> {
  const tk = sessionStorage.getItem(LOTTERY_REGISTERED_TOKEN_KEY) || ''
  if (!tk) {
    error.value = t('myRewards.needLogin')
    return
  }
  redeemingKey.value = `${idx}-${ci}`
  try {
    const res = await fetch(`${API_BASE}/public/coupons/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tk}`,
      },
      body: JSON.stringify({ code, email: '', otp: '' }),
    })
    const data = await res.json().catch(() => null)
    if (res.ok && data?.redeemed) {
      showToast(t('myRewards.redeemSuccess'), 'success')
      // 从列表移除已核销的券
      const target = rewards.value[idx]
      if (target) {
        target.coupons = target.coupons.filter((c) => c !== code)
      }
    } else {
      showToast(data?.message || t('myRewards.redeemFailed'), 'error')
    }
  } catch {
    showToast(t('myRewards.redeemFailed'), 'error')
  } finally {
    redeemingKey.value = ''
  }
}
</script>

<style scoped>
.my-rewards-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--tg-bg);
}

/* ── 页面头部 ── */
.mr-page-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--tg-bg);
  border-bottom: 1px solid var(--tg-border, #eee);
}

.mr-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--tg-text, #333);
  font-size: 14px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s, border-color 0.15s;
}

.mr-back-btn:hover {
  background: var(--tg-hover, rgba(0,0,0,0.05));
  border-color: var(--tg-border, #eee);
}

.mr-back-btn:active {
  background: var(--tg-hover, rgba(0,0,0,0.08));
}

.mr-back-arrow {
  font-size: 18px;
  line-height: 1;
}

.mr-back-text {
  font-size: 14px;
}

/* ── 卡片容器 ── */
.my-rewards-card {
  position: relative;
  max-width: 560px;
  width: 100%;
  margin: 24px auto;
  flex: 0 1 auto;  /* 不拉伸撑满，内容多高卡片多高 */
  background: var(--tg-section-bg);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

/* ── 关闭按钮（卡片右上角） ── */
.mr-close-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  display: flex;  /* 始终显示：卡片设计在任何屏幕上都像模态框 */
  align-items: center;
  justify-content: center;
  border: 1px solid var(--tg-border, #eee);
  background: var(--tg-section-bg);
  color: var(--tg-hint, #999);
  font-size: 14px;
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  opacity: 0.7;
}

.mr-close-btn:hover {
  background: var(--tg-danger, #e74c3c);
  color: white;
  border-color: var(--tg-danger, #e74c3c);
  opacity: 1;
}

.mr-close-btn:active {
  opacity: 0.8;
}

/* ── 状态区域 ── */
.mr-state {
  text-align: center;
  padding: 48px 16px;
}

.mr-state-text {
  font-size: 15px;
  color: var(--tg-text);
  margin: 16px 0 0;
  line-height: 1.6;
}

.mr-state-text.mr-error {
  color: var(--tg-danger, #e74c3c);
  font-weight: 500;
}

.mr-error-icon {
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

.mr-login-btn {
  margin-top: 16px;
}

.mr-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--tg-hint, #ccc);
  border-top-color: var(--tg-accent, #4a90d9);
  border-radius: 50%;
  margin: 0 auto;
  animation: mr-spin 0.8s linear infinite;
}

@keyframes mr-spin {
  to { transform: rotate(360deg); }
}

/* ── 奖励列表 ── */
.mr-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
}

.mr-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--tg-text);
  margin: 0;
}

.mr-total {
  font-size: 13px;
  color: var(--tg-hint, #999);
}

.mr-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mr-item {
  border: 1px solid var(--tg-border, #eee);
  border-radius: 8px;
  padding: 12px;
}

.mr-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mr-item-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--tg-text);
}

.mr-item-link {
  font-size: 13px;
  color: var(--tg-accent, #4a90d9);
  text-decoration: none;
}

.mr-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.mr-item-label {
  font-size: 13px;
  color: var(--tg-hint, #999);
  min-width: 60px;
}

.mr-item-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--tg-text);
}

.mr-item-muted {
  color: var(--tg-hint, #bbb);
}

.mr-coupons {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.mr-coupon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mr-coupon-code {
  font-size: 13px;
  background: var(--tg-section-bg, #f5f5f5);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  flex: 1;
  word-break: break-all;
  transition: background 0.15s, box-shadow 0.15s;
  user-select: all;  /* 点击即全选，方便复制 */
}

.mr-coupon-code:hover {
  background: var(--tg-hover, rgba(0,0,0,0.06));
  box-shadow: 0 0 0 1px var(--tg-accent, #4a90d9);
}

.mr-redeem-btn {
  flex: 0 0 auto;
}
</style>
