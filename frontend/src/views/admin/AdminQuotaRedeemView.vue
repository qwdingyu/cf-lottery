<template>
  <div class="admin-page">
    <section class="section">
      <h3 class="section-title">兑换额度</h3>
      <p class="muted-text">输入平台发放的额度码，为当前租户增加活动次数或参与人数额度。</p>

      <form class="redeem-form" @submit.prevent="handleRedeem">
        <label class="redeem-input-wrap">
          <span class="redeem-input-label">额度码</span>
          <input
            v-model="code"
            type="text"
            autocomplete="off"
            maxlength="64"
            placeholder="LUCKY-XXXX-XXXX-XXXX"
            required
          />
          <small class="field-hint">兑换码只会作用于当前登录租户，不会展示平台码池。</small>
        </label>
        <button class="btn btn-primary redeem-btn" type="submit" :disabled="submitting">
          <span v-if="!submitting">🎟️ 兑换额度</span>
          <span v-else>兑换中…</span>
        </button>
      </form>
    </section>

    <section v-if="result" class="section">
      <h3 class="section-title">兑换结果</h3>
      <div class="stats-row">
        <div class="stat-card">
          <span class="stat-value">{{ result.activityQuota }}</span>
          <span class="stat-label">新增活动次数</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{{ result.participantQuota }}</span>
          <span class="stat-label">新增参与人数</span>
        </div>
        <div class="stat-card">
          <span class="stat-value quota-expiry">{{ formatDate(result.expiresAt) }}</span>
          <span class="stat-label">额度有效期</span>
        </div>
      </div>
      <div class="toolbar">
        <div class="filters">
          <button class="btn btn-ghost btn-sm" type="button" @click="router.push('/admin')">查看运营台</button>
          <button class="btn btn-primary btn-sm" type="button" @click="router.push('/admin/draws')">创建活动</button>
        </div>
      </div>
    </section>

    <section class="section">
      <h3 class="section-title">兑换历史</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>兑换码</th>
              <th>活动次数</th>
              <th>参与人数</th>
              <th>有效期</th>
              <th>兑换时间</th>
            </tr>
          </thead>
          <tbody v-if="recordsLoading">
            <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
              <td :colspan="5"><div class="skeleton-cell" /></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="r in records" :key="r.id">
              <td><code class="code-text">{{ r.code }}</code></td>
              <td>{{ r.activityQuotaGranted }}</td>
              <td>{{ r.participantQuotaGranted }}</td>
              <td>{{ formatDate(r.expiresAt) }}</td>
              <td>{{ formatDate(r.redeemedAt) }}</td>
            </tr>
            <tr v-if="records.length === 0">
              <td colspan="5" class="empty-text">暂无兑换记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/composables/useFormat'
import { adminRequest } from '@/composables/useAdminRequest'

type RedeemResult = {
  redeemed: boolean
  activityQuota: number
  participantQuota: number
  expiresAt: string
}

const ADMIN_REDEMPTION_REDEEM_API = '/api/admin/redemption-codes/redeem'

const router = useRouter()
const { showToast } = useToast()
const code = ref('')
const submitting = ref(false)
const result = ref<RedeemResult | null>(null)
// 兑换历史
const records = ref<any[]>([])
const recordsLoading = ref(false)

/** 加载兑换历史 */
async function loadRecords() {
  recordsLoading.value = true
  try {
    const data = await adminRequest<{ records: any[] }>('/api/admin/redemption-records')
    records.value = data.records || []
  } catch { records.value = [] }
  recordsLoading.value = false
}

onMounted(loadRecords)

async function handleRedeem() {
  const normalizedCode = code.value.trim().toUpperCase()
  if (!normalizedCode) {
    showToast('请输入额度码', 'error')
    return
  }

  submitting.value = true
  try {
    // 租户只能兑换额度；平台发码、查码池、统计都在 /api/platform/redemption-codes。
    result.value = await adminRequest<RedeemResult>(ADMIN_REDEMPTION_REDEEM_API, {
      method: 'POST',
      body: JSON.stringify({ code: normalizedCode }),
    })
    code.value = ''
    showToast('额度已兑换', 'success')
    // 兑换成功后刷新历史记录
    await loadRecords()
  } catch (err: any) {
    showToast(err?.message || '兑换失败', 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* 区块容器：卡片化视觉层次（此前 .section 未定义，页面扁平无层次） */
.section {
  background: var(--tg-secondary-bg, #151b28);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: var(--r-lg, 12px);
  padding: 20px;
  margin-bottom: 16px;
}
.section-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
}
.muted-text {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
}

/* 兑换表单：标签 + 输入框 + 按钮一行，水平对齐 */
.redeem-form {
  display: grid;
  grid-template-columns: minmax(220px, 420px) auto;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
}
.redeem-input-wrap {
  display: contents;
}
.redeem-input-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--tg-text, #f0f2f5);
  white-space: nowrap;
}
.redeem-form input {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,0.15));
  background: var(--tg-bg, #1f2937);
  color: var(--tg-text, #f0f2f5);
  font-size: 14px;
  font-family: monospace;
  letter-spacing: 0.5px;
  grid-column: 1;
  grid-row: 2;
}
.redeem-input-label {
  grid-column: 1;
  grid-row: 1;
}
.redeem-btn {
  grid-column: 2;
  grid-row: 1;
  min-width: 140px;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.redeem-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.quota-expiry {
  font-size: 15px;
}

@media (max-width: 720px) {
  .redeem-form {
    grid-template-columns: 1fr;
  }
  .redeem-btn {
    width: 100%;
  }
}
</style>
