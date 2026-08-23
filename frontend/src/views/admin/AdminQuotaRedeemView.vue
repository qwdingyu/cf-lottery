<template>
  <div class="admin-page">
    <section class="section">
      <h3 class="section-title">{{ $t('adminQuota.title') }}</h3>
      <p class="muted-text">{{ $t('adminQuota.desc') }}</p>

      <form class="redeem-form" @submit.prevent="handleRedeem">
        <span class="redeem-input-label">{{ $t('adminQuota.codeLabel') }}</span>
        <div class="redeem-input-row">
          <input
            v-model="code"
            type="text"
            autocomplete="off"
            maxlength="64"
            placeholder="LUCKY-XXXX-XXXX-XXXX"
            required
          />
          <button class="btn btn-primary redeem-btn" type="submit" :disabled="submitting">
            <span v-if="!submitting">{{ $t('adminQuota.redeem') }}</span>
            <span v-else>{{ $t('adminQuota.redeeming') }}</span>
          </button>
        </div>
        <small class="field-hint">{{ $t('adminQuota.codeHint') }}</small>
      </form>
    </section>

    <section v-if="result" class="section">
      <h3 class="section-title">{{ $t('adminQuota.resultTitle') }}</h3>
      <div class="stats-row">
        <div class="stat-card">
          <span class="stat-value">{{ result.activityQuota }}</span>
          <span class="stat-label">{{ $t('adminQuota.newActivity') }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{{ result.participantQuota }}</span>
          <span class="stat-label">{{ $t('adminQuota.newParticipant') }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-value quota-expiry">{{ formatDateCST(result.expiresAt) }}</span>
          <span class="stat-label">{{ $t('adminQuota.expiresAt') }}</span>
        </div>
      </div>
      <div class="toolbar">
        <div class="filters">
          <button class="btn btn-ghost btn-sm" type="button" @click="router.push('/admin')">{{ $t('adminQuota.goDashboard') }}</button>
          <button class="btn btn-primary btn-sm" type="button" @click="router.push('/admin/draws')">{{ $t('adminQuota.createActivity') }}</button>
        </div>
      </div>
    </section>

    <section class="section">
      <h3 class="section-title">{{ $t('adminQuota.historyTitle') }}</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>{{ $t('adminQuota.colCode') }}</th>
              <th>{{ $t('adminQuota.colActivity') }}</th>
              <th>{{ $t('adminQuota.colParticipant') }}</th>
              <th>{{ $t('adminQuota.colExpires') }}</th>
              <th>{{ $t('adminQuota.colRedeemedAt') }}</th>
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
              <td>{{ formatDateCST(r.expiresAt) }}</td>
              <td>{{ formatDateCST(r.redeemedAt) }}</td>
            </tr>
            <tr v-if="records.length === 0">
              <td colspan="5" class="empty-text">{{ $t('adminQuota.empty') }}</td>
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
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { formatDateCST } from '@/composables/useFormat'
import { adminRequest } from '@/composables/useAdminRequest'

type RedeemResult = {
  redeemed: boolean
  activityQuota: number
  participantQuota: number
  expiresAt: string
}

const ADMIN_REDEMPTION_REDEEM_API = '/api/admin/redemption-codes/redeem'

const router = useRouter()
const { t } = useI18n()
const { showToast } = useToast()
const code = ref('')
const submitting = ref(false)
const result = ref<RedeemResult | null>(null)
const records = ref<any[]>([])
const recordsLoading = ref(false)

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
    showToast(t('adminQuota.codeRequired'), 'error')
    return
  }

  submitting.value = true
  try {
    result.value = await adminRequest<RedeemResult>(ADMIN_REDEMPTION_REDEEM_API, {
      method: 'POST',
      body: JSON.stringify({ code: normalizedCode }),
    })
    code.value = ''
    showToast(t('adminQuota.success'), 'success')
    await loadRecords()
  } catch (err: any) {
    showToast(err?.message || t('adminQuota.failed'), 'error')
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

/* 兑换表单：标签一行，输入框+按钮一行水平并排，提示在下方 */
.redeem-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.redeem-input-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--tg-text, #f0f2f5);
}
.redeem-input-row {
  display: flex;
  gap: 12px;
  align-items: center;
}
.redeem-input-row input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,0.15));
  background: var(--tg-bg, #1f2937);
  color: var(--tg-text, #f0f2f5);
  font-size: 14px;
  font-family: monospace;
  letter-spacing: 0.5px;
}
.redeem-btn {
  flex-shrink: 0;
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
