<template>
  <div class="my-rewards-page">
    <!-- 页面头部：返回按钮 -->
    <header class="mr-page-header">
      <button type="button" class="mr-back-btn" @click="goBack" :aria-label="$t('myRewards.back')">
        <span class="mr-back-arrow">←</span>
        <span class="mr-back-text">{{ $t('myRewards.back') }}</span>
      </button>
    </header>

    <div class="my-rewards-card">
      <!-- 关闭按钮 -->
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

      <!-- 仪表盘内容 -->
      <template v-else>
        <!-- 标题 -->
        <h1 class="mr-title">{{ $t('myRewards.title') }}</h1>

        <!-- ═══ 总览大数字（仪表盘核心） ═══ -->
        <div class="mr-summary">
          <div class="mr-summary-item">
            <span class="mr-summary-value">{{ summary.totalSpins }}</span>
            <span class="mr-summary-label">{{ $t('myRewards.summarySpins') }}</span>
          </div>
          <div class="mr-summary-item">
            <span class="mr-summary-value">{{ summary.totalCoupons }}</span>
            <span class="mr-summary-label">{{ $t('myRewards.summaryCoupons') }}</span>
          </div>
          <div class="mr-summary-item">
            <span class="mr-summary-value">{{ summary.totalInvited }}</span>
            <span class="mr-summary-label">{{ $t('myRewards.summaryInvited') }}</span>
          </div>
          <div class="mr-summary-item">
            <span class="mr-summary-value">{{ summary.activityCount }}</span>
            <span class="mr-summary-label">{{ $t('myRewards.summaryActivities') }}</span>
          </div>
        </div>

        <!-- ═══ 按活动分组的奖励明细 ═══ -->
        <div class="mr-list">
          <div v-for="(item, idx) in rewards" :key="idx" class="mr-item">
            <!-- 活动标题行 -->
            <div class="mr-item-header">
              <span class="mr-item-title">{{ item.title }}</span>
              <a class="mr-item-link" :href="`/lottery/${item.slug}`">{{ $t('myRewards.viewDraw') }}</a>
            </div>

            <!-- 邀请贡献摘要 -->
            <div class="mr-invite-row">
              <span v-if="item.invitedCount > 0" class="mr-invite-count">
                {{ $t('myRewards.invited', { count: item.invitedCount }) }}
              </span>
              <span v-else class="mr-invite-empty">{{ $t('myRewards.noInvited') }}</span>
            </div>

            <!-- ═══ 里程碑进度（邀请奖励明细） ═══ -->
            <div v-if="item.milestones.length > 0" class="mr-milestones">
              <div class="mr-milestones-title">{{ $t('myRewards.milestoneProgress') }}</div>
              <div
                v-for="(ms, mi) in item.milestones"
                :key="mi"
                class="mr-milestone"
                :class="{ 'mr-milestone--reached': ms.reached }"
              >
                <span class="mr-milestone-icon">{{ ms.reached ? '✅' : '⏳' }}</span>
                <span class="mr-milestone-desc">
                  <template v-if="ms.requireCount != null">
                    {{ $t('myRewards.invited', { count: ms.requireCount }) }}
                  </template>
                  <template v-else>—</template>
                </span>
                <span class="mr-milestone-reward">
                  <template v-if="ms.rewardExit === 'bonus_spin'">
                    {{ $t('myRewards.spinsFromInvite', { count: ms.amount || '?' }) }}
                  </template>
                  <template v-else-if="ms.rewardExit === 'bonus_coupon'">
                    {{ $t('myRewards.couponsFromInvite', { count: ms.amount || '?' }) }}
                  </template>
                  <template v-else>{{ ms.rewardExit }}</template>
                </span>
                <span v-if="ms.reached" class="mr-milestone-badge">{{ $t('myRewards.milestoneReached') }}</span>
                <span v-else-if="ms.requireCount != null && item.invitedCount < ms.requireCount" class="mr-milestone-hint">
                  {{ $t('myRewards.milestonePending', { count: ms.requireCount - item.invitedCount }) }}
                </span>
              </div>
              <!-- 下一档提示 -->
              <div v-if="item.nextMilestone && item.nextMilestone.requireCount" class="mr-next-hint">
                {{ $t('myRewards.nextMilestoneHint', { count: item.nextMilestone.requireCount - item.invitedCount }) }}
              </div>
            </div>
            <div v-else-if="item.invitedCount > 0" class="mr-no-referral">
              {{ $t('myRewards.noReferralConfig') }}
            </div>

            <!-- G-4: 排行榜奖励发放状态 -->
            <div v-if="item.leaderboardRewardedCount > 0" class="mr-leaderboard-reward">
              <span class="mr-leaderboard-reward-icon">🏆</span>
              <span class="mr-leaderboard-reward-text">
                {{ $t('myRewards.leaderboardRewardGranted', { count: item.leaderboardRewardedCount }) }}
              </span>
              <span v-if="item.leaderboardRewardedAt" class="mr-leaderboard-reward-time">
                {{ formatDateCST(item.leaderboardRewardedAt) }}
              </span>
            </div>

            <!-- ═══ 实际奖励（spins + coupons） ═══ -->
            <div class="mr-rewards-section">
              <!-- spins 奖励 -->
              <div v-if="item.spinsLeft > 0" class="mr-reward-row">
                <span class="mr-reward-label">{{ $t('myRewards.spins') }}</span>
                <span class="mr-reward-value">{{ item.spinsLeft }}</span>
              </div>

              <!-- coupons 奖励 -->
              <div v-if="item.coupons.length > 0" class="mr-reward-row mr-reward-row--coupons">
                <span class="mr-reward-label">{{ $t('myRewards.coupons') }}</span>
                <div class="mr-coupons">
                  <div v-for="(cp, ci) in item.coupons" :key="ci" class="mr-coupon">
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
              <div v-if="item.spinsLeft <= 0 && item.coupons.length === 0" class="mr-reward-row">
                <span class="mr-reward-label mr-item-muted">{{ $t('myRewards.noReward') }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
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

/** 里程碑项（与后端 MilestoneProgressItem 对齐） */
interface MilestoneItem {
  rewardId: string
  requireCount: number | null
  rewardExit: string       // bonus_spin / bonus_coupon
  amount: number | null
  reached: boolean
  granted: boolean
  grantedCount: number
}

/** 奖励项（与后端 /my-rewards 返回结构对齐） */
interface RewardItem {
  drawId: string
  tenantId: string
  slug: string
  title: string
  spinsLeft: number
  coupons: string[]
  rewardStatus: 'available' | 'empty'
  invitedCount: number
  milestones: MilestoneItem[]
  nextMilestone: MilestoneItem | null
  unlockedMilestoneCount: number
  grantedMilestoneCount: number
}

/** 仪表盘汇总统计 */
interface Summary {
  totalSpins: number
  totalCoupons: number
  totalInvited: number
  activityCount: number
}

const rewards = ref<RewardItem[]>([])
const summary = reactive<Summary>({ totalSpins: 0, totalCoupons: 0, totalInvited: 0, activityCount: 0 })
const redeemingKey = ref('')

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    void router.push('/lottery')
  }
}

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
    // 合并汇总数据（后端已计算）
    if (data.summary) {
      summary.totalSpins = data.summary.totalSpins || 0
      summary.totalCoupons = data.summary.totalCoupons || 0
      summary.totalInvited = data.summary.totalInvited || 0
      summary.activityCount = data.summary.activityCount || 0
    }
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

async function redeemCoupon(_item: RewardItem, code: string, idx: number, ci: number): Promise<void> {
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
      const target = rewards.value[idx]
      if (target) {
        target.coupons = target.coupons.filter((c) => c !== code)
        // 更新汇总
        summary.totalCoupons = Math.max(0, summary.totalCoupons - 1)
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

.mr-back-btn:hover { background: var(--tg-hover, rgba(0,0,0,0.05)); border-color: var(--tg-border, #eee); }
.mr-back-btn:active { background: var(--tg-hover, rgba(0,0,0,0.08)); }
.mr-back-arrow { font-size: 18px; line-height: 1; }

/* ── 卡片容器 ── */
.my-rewards-card {
  position: relative;
  max-width: 560px;
  width: 100%;
  margin: 24px auto;
  flex: 0 1 auto;
  background: var(--tg-section-bg);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

/* ── 关闭按钮 ── */
.mr-close-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--tg-border, #eee);
  background: var(--tg-section-bg);
  color: var(--tg-hint, #999);
  font-size: 14px;
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  opacity: 0.7;
}
.mr-close-btn:hover { background: var(--tg-danger, #e74c3c); color: white; border-color: var(--tg-danger, #e74c3c); opacity: 1; }

/* ── 状态区域 ── */
.mr-state { text-align: center; padding: 48px 16px; }
.mr-state-text { font-size: 15px; color: var(--tg-text); margin: 16px 0 0; line-height: 1.6; }
.mr-state-text.mr-error { color: var(--tg-danger, #e74c3c); font-weight: 500; }
.mr-error-icon { width: 48px; height: 48px; border-radius: 50%; background: var(--tg-danger, #e74c3c); color: white; font-size: 24px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.mr-login-btn { margin-top: 16px; }
.mr-spinner { width: 28px; height: 28px; border: 3px solid var(--tg-hint, #ccc); border-top-color: var(--tg-accent, #4a90d9); border-radius: 50%; margin: 0 auto; animation: mr-spin 0.8s linear infinite; }
@keyframes mr-spin { to { transform: rotate(360deg); } }

/* ── 标题 ── */
.mr-title { font-size: 20px; font-weight: 700; color: var(--tg-text); margin: 0 0 16px; }

/* ═══ 总览大数字（仪表盘核心） ═══ */
.mr-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 20px;
  padding: 16px;
  background: var(--tg-section-bg, #f8f9fa);
  border-radius: 10px;
  border: 1px solid var(--tg-border, #eee);
}

.mr-summary-item {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mr-summary-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--tg-accent, #4a90d9);
  line-height: 1.2;
}

.mr-summary-label {
  font-size: 11px;
  color: var(--tg-hint, #999);
  white-space: nowrap;
}

/* ═══ 活动列表 ═══ */
.mr-list { display: flex; flex-direction: column; gap: 12px; }

.mr-item {
  border: 1px solid var(--tg-border, #eee);
  border-radius: 8px;
  padding: 14px;
}

.mr-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.mr-item-title { font-size: 15px; font-weight: 600; color: var(--tg-text); }
.mr-item-link { font-size: 13px; color: var(--tg-accent, #4a90d9); text-decoration: none; }

/* ── 邀请摘要行 ── */
.mr-invite-row { margin-bottom: 8px; }
.mr-invite-count { font-size: 13px; color: var(--tg-text); font-weight: 500; }
.mr-invite-empty { font-size: 13px; color: var(--tg-hint, #bbb); }

/* ═══ 里程碑进度 ═══ */
.mr-milestones {
  margin: 8px 0;
  padding: 10px;
  background: var(--tg-section-bg, #f8f9fa);
  border-radius: 6px;
  border: 1px solid var(--tg-border, #eee);
}

.mr-milestones-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--tg-hint, #999);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.mr-milestone {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--tg-text);
}

.mr-milestone--reached { color: var(--tg-success, #27ae60); }

.mr-milestone-icon { font-size: 14px; flex-shrink: 0; }

.mr-milestone-desc { flex: 1; }

.mr-milestone-reward {
  font-weight: 600;
  color: var(--tg-accent, #4a90d9);
  white-space: nowrap;
}

.mr-milestone-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--tg-success, #27ae60);
  color: white;
  white-space: nowrap;
}

.mr-milestone-hint {
  font-size: 11px;
  color: var(--tg-hint, #999);
  white-space: nowrap;
}

.mr-next-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--tg-accent, #4a90d9);
  font-style: italic;
}

.mr-no-referral {
  margin: 8px 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--tg-hint, #999);
  background: var(--tg-section-bg, #f8f9fa);
  border-radius: 6px;
  border: 1px dashed var(--tg-border, #ddd);
}

/* ═══ 实际奖励 ═══ */
.mr-rewards-section { margin-top: 8px; }

.mr-reward-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.mr-reward-label { font-size: 13px; color: var(--tg-hint, #999); min-width: 60px; }
.mr-reward-value { font-size: 15px; font-weight: 600; color: var(--tg-text); }
.mr-item-muted { color: var(--tg-hint, #bbb); }

.mr-coupons { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.mr-coupon { display: flex; align-items: center; gap: 8px; }

.mr-coupon-code {
  font-size: 13px;
  background: var(--tg-section-bg, #f5f5f5);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  flex: 1;
  word-break: break-all;
  transition: background 0.15s, box-shadow 0.15s;
  user-select: all;
}
.mr-coupon-code:hover { background: var(--tg-hover, rgba(0,0,0,0.06)); box-shadow: 0 0 0 1px var(--tg-accent, #4a90d9); }
.mr-redeem-btn { flex: 0 0 auto; }
</style>
