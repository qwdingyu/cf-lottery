<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">支付设置</h2>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || checking" @click="checkConfig">
          {{ checking ? '自检中…' : '配置自检' }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="loading" class="skeleton-list">
      <div class="skeleton-line w-60" />
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" @click="loadData">重试</button>
    </div>

    <div v-if="checkResult" class="check-panel">
      <div class="check-header">
        <h3>支付配置自检</h3>
        <span class="tag" :class="checkReady ? 'tag-success' : 'tag-danger'">
          {{ checkReady ? '可用于已覆盖币种' : '存在阻断项' }}
        </span>
      </div>
      <div class="check-grid">
        <div class="check-item">
          <div class="check-label">密钥加密环境</div>
          <div class="check-value">{{ checkResult.credentialsEncryptionKey.configured ? '已配置' : '未配置' }}</div>
        </div>
        <div v-for="currency in checkResult.currencySupport" :key="currency.currency" class="check-item">
          <div class="check-label">{{ currency.currency.toUpperCase() }}</div>
          <div class="check-value">{{ currency.available ? currency.providers.join(', ') : '无可用渠道' }}</div>
        </div>
      </div>
      <div class="provider-checks">
        <div v-for="provider in checkResult.providers" :key="provider.name" class="provider-check">
          <div class="provider-check-title">
            <span>{{ provider.displayName }}</span>
            <span class="tag" :class="provider.configured ? 'tag-success' : 'tag-muted'">
              {{ provider.configured ? '完整' : '未就绪' }}
            </span>
          </div>
          <ul v-if="provider.issues.length || provider.warnings.length" class="check-messages">
            <li v-for="issue in provider.issues" :key="'issue-' + issue" class="check-message check-message--error">{{ issue }}</li>
            <li v-for="warning in provider.warnings" :key="'warning-' + warning" class="check-message check-message--warning">{{ warning }}</li>
          </ul>
        </div>
      </div>
    </div>

    <div v-if="!loading && !loadError" class="provider-list">
      <div v-for="item in providers" :key="item.name" class="provider-card">
        <div class="provider-header">
          <div>
            <h3 class="provider-name">{{ item.displayName }}</h3>
            <p class="provider-desc">{{ item.description }}</p>
          </div>
          <span class="tag" :class="item.enabled ? 'tag-success' : 'tag-muted'">
            {{ item.enabled ? '已启用' : '未启用' }}
          </span>
        </div>

        <label class="toggle-row">
          <input type="checkbox" v-model="item.enabled" :disabled="saving" />
          <span>启用该收款方式</span>
        </label>

        <form class="provider-fields" @submit.prevent="saveProvider">
          <div v-for="field in item.fields" :key="field.key" class="form-field">
            <label class="form-label">{{ field.label }}<span v-if="field.required" class="req">*</span></label>
            <input
              :type="field.type === 'password' ? 'password' : 'text'"
              v-model="item.saved.fields[field.key]"
              class="form-input"
              :placeholder="field.placeholder || ''"
              :disabled="saving"
            />
            <small v-if="field.hint" class="field-hint">{{ field.hint }}</small>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="saving">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminRequest } from '@/composables/useAdminRequest'
import { useToast } from '@usethink/cf-admin-fe/composables'
import type { AdminPaymentConfigCheckResult } from '@/types/admin'

const { showToast } = useToast()

interface ProviderFieldMeta {
  key: string
  label: string
  type?: string
  required: boolean
  sensitive: boolean
  placeholder?: string
  hint?: string
}

interface ProviderConfig {
  name: string
  displayName: string
  description: string
  supportedCurrencies: string[]
  fields: ProviderFieldMeta[]
  enabled: boolean
  configured: boolean
  saved: { enabled: boolean; fields: Record<string, string> }
}

const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const checking = ref(false)
const providers = ref<ProviderConfig[]>([])
const checkResult = ref<AdminPaymentConfigCheckResult | null>(null)
const checkReady = ref(false)

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ providers: ProviderConfig[] }>('/api/admin/payment-config')
    providers.value = data.providers.map((p) => ({
      ...p,
      saved: p.saved || { enabled: !!p.enabled, fields: {} },
    }))
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function saveProvider() {
  if (saving.value) return
  saving.value = true
  try {
    await adminRequest('/api/admin/payment-config', {
      method: 'PUT',
      body: JSON.stringify({
        providers: providers.value.map((p) => ({
          name: p.name,
          enabled: p.enabled,
          fields: p.saved.fields,
        })),
      }),
    })
    showToast('支付配置已保存', 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

async function checkConfig() {
  if (checking.value) return
  checking.value = true
  try {
    const data = await adminRequest<AdminPaymentConfigCheckResult>('/api/admin/payment-config/check')
    checkResult.value = data
    checkReady.value = data.currencySupport.some((item) => item.available)
    showToast(checkReady.value ? '自检完成' : '自检发现阻断项', checkReady.value ? 'success' : 'error')
  } catch (err) {
    showToast(err instanceof Error ? err.message : '自检失败', 'error')
  } finally {
    checking.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.provider-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.provider-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.provider-name { margin: 0 0 4px; font-size: 16px; }
.provider-desc { margin: 0; color: var(--muted); font-size: 13px; }
.toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.provider-fields { display: grid; gap: 12px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-label { font-size: 13px; }
.req { color: var(--danger); }
.form-input { padding: 8px; border: 1px solid var(--border); border-radius: 4px; }
.field-hint { color: var(--muted); font-size: 12px; }
.form-actions { display: flex; justify-content: flex-end; }
.check-panel { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; background: var(--surface); }
.check-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.check-header h3 { margin: 0; font-size: 15px; }
.check-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 12px; }
.check-item { border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
.check-label { color: var(--muted); font-size: 12px; }
.check-value { margin-top: 4px; font-weight: 600; overflow-wrap: anywhere; }
.provider-checks { display: grid; gap: 8px; }
.provider-check { border-top: 1px solid var(--border); padding-top: 8px; }
.provider-check-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.check-messages { margin: 8px 0 0; padding-left: 18px; }
.check-message { font-size: 13px; }
.check-message--error { color: var(--danger); }
.check-message--warning { color: #ca8a04; }
.tag-danger { background: rgba(239, 68, 68, .16); color: #dc2626; }
</style>
