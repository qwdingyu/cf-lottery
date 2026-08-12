<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">{{ $t('adminPaymentConfig.title') }}</h2>
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || checking || Boolean(savingProvider)" @click="checkConfig">
          {{ checking ? $t('adminPaymentConfig.checking') : $t('adminPaymentConfig.checkConfig') }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="loading || Boolean(savingProvider)" @click="loadData">{{ $t('adminPaymentConfig.refresh') }}</button>
      </div>
    </div>

    <div v-if="checkResult" class="health-card" :class="healthClass">
      <strong>{{ healthTitle }}</strong>
      <p>{{ healthMessage }}</p>
    </div>

    <div v-if="loading" class="skeleton-list">
      <div class="skeleton-line w-60" />
      <div class="skeleton-line w-60" />
      <div class="skeleton-line w-60" />
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminPaymentConfig.retry') }}</button>
    </div>

    <div v-if="checkResult" class="payment-check-strip" role="status">
      <div class="payment-check-item">
        <span class="check-label">{{ $t('adminPaymentConfig.credentialEncryption') }}</span>
        <strong>{{ checkResult.credentialsEncryptionKey.configured ? $t('adminPaymentConfig.configured') : $t('adminPaymentConfig.notConfigured') }}</strong>
      </div>
      <div v-for="currency in checkResult.currencySupport" :key="currency.currency" class="payment-check-item">
        <span class="check-label">{{ currency.currency.toUpperCase() }}</span>
        <strong>{{ currency.available ? currency.providers.join(' / ') : $t('adminPaymentConfig.noAvailableProvider') }}</strong>
      </div>
    </div>

    <div
      v-if="!loading && !loadError"
      class="provider-list"
      role="region"
      :aria-label="$t('adminPaymentConfig.providersRegionAria')"
      tabindex="0"
    >
      <div v-for="item in providers" :key="item.name" class="provider-card">
        <div class="provider-header">
          <div class="provider-title-row">
            <div>
              <h3 class="provider-name">{{ item.displayName }}</h3>
              <p class="provider-desc">{{ item.description }}</p>
            </div>
          </div>
          <div class="provider-status">
            <span class="tag" :class="item.enabled ? 'tag-success' : 'tag-muted'">
              {{ item.enabled ? $t('adminPaymentConfig.enabled') : $t('adminPaymentConfig.disabled') }}
            </span>
            <span class="tag" :class="providerReady(item) ? 'tag-success' : 'tag-muted'">
              {{ providerReady(item) ? $t('adminPaymentConfig.ready') : $t('adminPaymentConfig.notReady') }}
            </span>
            <span v-if="providerIssues(item).length > 0" class="tag tag-danger">{{ $t('adminPaymentConfig.needsAttention') }}</span>
          </div>
        </div>

        <dl class="provider-facts">
          <div>
            <dt>{{ $t('adminPaymentConfig.supportedCurrencies') }}</dt>
            <dd>{{ item.supportedCurrencies.join(' / ') }}</dd>
          </div>
          <div>
            <dt>{{ $t('adminPaymentConfig.defaultPayType') }}</dt>
            <dd>{{ item.name === 'easypay' ? paymentTypeLabel(providerConfigValue(item, 'EASYPAY_PAY_TYPE')) : $t('adminPaymentConfig.perProvider') }}</dd>
          </div>
          <div>
            <dt>{{ $t('adminPaymentConfig.enabledPayTypes') }}</dt>
            <dd>{{ item.name === 'easypay' ? enabledPaymentTypesLabel(providerConfigValue(item, 'EASYPAY_ENABLED_PAY_TYPES'), providerConfigValue(item, 'EASYPAY_PAY_TYPE')) : $t('adminPaymentConfig.perProvider') }}</dd>
          </div>
          <div>
            <dt>{{ $t('adminPaymentConfig.gatewayUrl') }}</dt>
            <dd>{{ item.name === 'easypay' ? (providerConfigValue(item, 'EASYPAY_API_BASE') || $t('adminPaymentConfig.notConfigured')) : $t('adminPaymentConfig.perProvider') }}</dd>
          </div>
          <div>
            <dt>{{ $t('adminPaymentConfig.callback') }}</dt>
            <dd class="callback-value">
              <span>{{ callbackUrl(item) }}</span>
              <button class="btn btn-ghost btn-xs" type="button" @click="copyCallbackUrl(item)">{{ $t('adminPaymentConfig.copy') }}</button>
            </dd>
          </div>
          <div>
            <dt>{{ $t('adminPaymentConfig.selfCheckResult') }}</dt>
            <dd>
              <span v-if="providerIssues(item).length === 0 && providerWarnings(item).length === 0">{{ $t('adminPaymentConfig.noBlocking') }}</span>
              <span v-else>{{ providerIssues(item)[0] || providerWarnings(item)[0] }}</span>
            </dd>
          </div>
        </dl>

        <div v-if="providerIssues(item).length || providerWarnings(item).length" class="provider-alerts">
          <p v-for="issue in providerIssues(item)" :key="'issue-' + issue" class="provider-alert provider-alert--error">{{ issue }}</p>
          <p v-for="warning in providerWarnings(item)" :key="'warning-' + warning" class="provider-alert provider-alert--warning">{{ warning }}</p>
        </div>

        <div class="provider-actions">
          <button class="btn btn-primary btn-sm" :disabled="Boolean(savingProvider)" type="button" @click="openConfig(item)">
            {{ $t('adminPaymentConfig.configure') }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="Boolean(savingProvider)" type="button" @click="toggleProvider(item)">
            {{ savingProvider === item.name ? $t('adminPaymentConfig.saving') : (item.enabled ? $t('adminPaymentConfig.disable') : $t('adminPaymentConfig.enable')) }}
          </button>
        </div>
      </div>
    </div>

    <AdminModal v-model="configVisible" :title="editingProvider ? $t('adminPaymentConfig.configTitle', { name: editingProvider.displayName }) : $t('adminPaymentConfig.configTitleGeneric')" max-width="720px" hide-actions>
      <form class="modal-form" @submit.prevent="saveConfig">
        <template v-if="editingProvider">
          <div class="config-grid two-cols">
            <label>
              <span>{{ $t('adminPaymentConfig.payType') }}</span>
              <input :value="editingProvider.displayName" disabled />
            </label>
            <label>
              <span>{{ $t('adminPaymentConfig.supportedCurrencies') }}</span>
              <input :value="editingProvider.supportedCurrencies.join(' / ')" disabled />
            </label>
          </div>

          <template v-if="editingProvider.name === 'easypay'">
            <div class="quick-setting">
              <div class="quick-copy">
                <span class="quick-label">{{ $t('adminPaymentConfig.enabledPayTypes') }}</span>
                <small>{{ $t('adminPaymentConfig.easypayHint') }}</small>
              </div>
              <div class="segmented" role="group" :aria-label="$t('adminPaymentConfig.enabledPayTypes')">
                <button
                  v-for="option in paymentTypeOptions"
                  :key="option.value"
                  type="button"
                  class="segment-btn"
                  :class="{ active: enabledPayTypes.includes(option.value) }"
                  @click="togglePayType(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>

            <div class="quick-setting">
              <div class="quick-copy">
                <span class="quick-label">{{ $t('adminPaymentConfig.defaultPayType') }}</span>
                <small>{{ $t('adminPaymentConfig.defaultPayTypeHint') }}</small>
              </div>
              <div class="segmented" role="group" :aria-label="$t('adminPaymentConfig.defaultPayType')">
                <button
                  v-for="option in paymentTypeOptions"
                  :key="option.value"
                  type="button"
                  class="segment-btn"
                  :class="{ active: selectedPayType === option.value }"
                  @click="setPayType(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </template>

          <label class="toggle-row">
            <input type="checkbox" v-model="configEnabled" :disabled="Boolean(savingProvider)" />
            <span>{{ $t('adminPaymentConfig.enableThisPayType') }}</span>
          </label>

          <label v-for="field in editingProvider.fields" :key="field.key">
            <span>{{ field.label }}<em v-if="field.required">*</em></span>
            <input
              v-model="configForm[field.key]"
              :type="field.type === 'password' ? 'password' : 'text'"
              :placeholder="field.placeholder || ''"
              :autocomplete="field.sensitive ? 'new-password' : 'off'"
              :required="field.required && configEnabled"
            />
            <small v-if="field.hint" class="field-hint">{{ field.hint }}</small>
          </label>

          <div class="callback-box">
            <span>{{ $t('adminPaymentConfig.asyncCallbackUrl') }}</span>
            <code>{{ callbackUrl(editingProvider) }}</code>
            <button type="button" class="btn btn-ghost btn-xs" @click="copyCallbackUrl(editingProvider)">{{ $t('adminPaymentConfig.copy') }}</button>
          </div>
        </template>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="Boolean(savingProvider)" @click="configVisible = false">{{ $t('adminPaymentConfig.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="Boolean(savingProvider)">
            {{ savingProvider ? $t('adminPaymentConfig.saving') : $t('adminPaymentConfig.saveConfig') }}
          </button>
        </div>
      </form>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import { copyWithToast, useToast } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'
import type { AdminPaymentConfigCheckResult } from '@/types/admin'

const { t } = useI18n()
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
const checking = ref(false)
const providers = ref<ProviderConfig[]>([])
const checkResult = ref<AdminPaymentConfigCheckResult | null>(null)
const tenantId = ref('')
const configVisible = ref(false)
const editingProvider = ref<ProviderConfig | null>(null)
const configEnabled = ref(false)
const configForm = reactive<Record<string, string>>({})
const savingProvider = ref('')

const paymentTypeOptions = [
  { value: 'alipay' as const, label: t('adminPaymentConfig.payTypeAlipay') },
  { value: 'wxpay' as const, label: t('adminPaymentConfig.payTypeWxpay') },
  { value: 'qqpay' as const, label: t('adminPaymentConfig.payTypeQqpay') },
]

const selectedPayType = computed(() => normalizePayType(configForm.EASYPAY_PAY_TYPE))
const enabledPayTypes = computed(() => normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, selectedPayType.value))

const checkReady = computed(() => checkResult.value?.currencySupport.some((item) => item.available) === true)
const healthClass = computed(() => checkReady.value ? 'health-card-success' : 'health-card-error')
const healthTitle = computed(() => checkReady.value ? t('adminPaymentConfig.healthReady') : t('adminPaymentConfig.healthBlocking'))
const healthMessage = computed(() => {
  if (!checkResult.value?.credentialsEncryptionKey.configured) return t('adminPaymentConfig.healthKeyMissing')
  const available = checkResult.value.currencySupport.filter((item) => item.available).map((item) => item.currency.toUpperCase())
  return available.length > 0 ? `${t('adminPaymentConfig.healthCurrencies')}${available.join(' / ')}` : t('adminPaymentConfig.healthNoProvider')
})

function normalizeProvider(raw: ProviderConfig): ProviderConfig {
  return {
    ...raw,
    saved: raw.saved || { enabled: Boolean(raw.enabled), fields: {} },
    enabled: Boolean(raw.saved?.enabled ?? raw.enabled),
  }
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const [configData, checkData] = await Promise.all([
      adminRequest<{ tenantId?: string; providers: ProviderConfig[] }>('/api/admin/payment-config'),
      adminRequest<AdminPaymentConfigCheckResult>('/api/admin/payment-config/check'),
    ])
    tenantId.value = String(configData.tenantId || '').trim()
    providers.value = configData.providers.map(normalizeProvider)
    checkResult.value = checkData
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('adminPaymentConfig.loadFailed')
  } finally {
    loading.value = false
  }
}

async function checkConfig() {
  if (checking.value) return
  checking.value = true
  try {
    const data = await adminRequest<AdminPaymentConfigCheckResult>('/api/admin/payment-config/check')
    checkResult.value = data
    showToast(t('adminPaymentConfig.checkDone'), checkReady.value ? 'success' : 'error')
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('adminPaymentConfig.checkFailed'), 'error')
  } finally {
    checking.value = false
  }
}

function openConfig(provider: ProviderConfig) {
  editingProvider.value = provider
  configEnabled.value = Boolean(provider.enabled)
  Object.keys(configForm).forEach((key) => {
    delete configForm[key]
  })
  for (const field of provider.fields) {
    configForm[field.key] = provider.saved?.fields?.[field.key] || ''
  }
  if (provider.name === 'easypay') {
    configForm.EASYPAY_PAY_TYPE = normalizePayType(configForm.EASYPAY_PAY_TYPE)
    configForm.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, configForm.EASYPAY_PAY_TYPE).join(',')
  }
  configVisible.value = true
}

async function saveConfig() {
  if (!editingProvider.value || savingProvider.value) return
  if (editingProvider.value.name === 'easypay') {
    configForm.EASYPAY_PAY_TYPE = normalizePayType(configForm.EASYPAY_PAY_TYPE)
    configForm.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, configForm.EASYPAY_PAY_TYPE).join(',')
  }
  await saveProviders(editingProvider.value.name, configEnabled.value, { ...configForm })
  configVisible.value = false
}

async function toggleProvider(provider: ProviderConfig) {
  if (savingProvider.value) return
  await saveProviders(provider.name, !provider.enabled, provider.saved?.fields || {})
}

async function saveProviders(providerName: string, enabled: boolean, fields: Record<string, string>) {
  savingProvider.value = providerName
  try {
    await adminRequest('/api/admin/payment-config', {
      method: 'PUT',
      body: JSON.stringify({
        providers: providers.value.map((provider) => ({
          name: provider.name,
          enabled: provider.name === providerName ? enabled : provider.enabled,
          fields: provider.name === providerName ? fields : (provider.saved?.fields || {}),
        })),
      }),
    })
    showToast(t('adminPaymentConfig.saveSuccess'), 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('adminPaymentConfig.saveFailed'), 'error')
  } finally {
    savingProvider.value = ''
  }
}

function providerCheck(provider: ProviderConfig) {
  return checkResult.value?.providers.find((item) => item.name === provider.name)
}

function providerReady(provider: ProviderConfig) {
  return providerCheck(provider)?.configured === true
}

function providerIssues(provider: ProviderConfig) {
  return providerCheck(provider)?.issues || []
}

function providerWarnings(provider: ProviderConfig) {
  return providerCheck(provider)?.warnings || []
}

function providerConfigValue(provider: ProviderConfig, key: string) {
  return provider.saved?.fields?.[key] || ''
}

function normalizePayType(value: string | undefined) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['alipay', 'wxpay', 'qqpay'].includes(normalized) ? normalized : 'alipay'
}

function normalizeEnabledPayTypes(value: string | undefined, fallback: string) {
  const enabled: Array<typeof paymentTypeOptions[number]['value']> = []
  String(value || '')
    .split(',')
    .map((item) => normalizePayType(item))
    .forEach((item) => {
      if (!enabled.includes(item as typeof paymentTypeOptions[number]['value'])) {
        enabled.push(item as typeof paymentTypeOptions[number]['value'])
      }
    })
  const defaultType = normalizePayType(fallback) as typeof paymentTypeOptions[number]['value']
  if (enabled.length === 0) enabled.push(defaultType)
  if (!enabled.includes(defaultType)) enabled.unshift(defaultType)
  return enabled
}

function paymentTypeLabel(value: string | undefined) {
  const normalized = normalizePayType(value)
  return paymentTypeOptions.find((option) => option.value === normalized)?.label || t('adminPaymentConfig.payTypeAlipay')
}

function enabledPaymentTypesLabel(value: string | undefined, fallback: string | undefined) {
  return normalizeEnabledPayTypes(value, normalizePayType(fallback)).map(paymentTypeLabel).join('、')
}

function setPayType(value: string) {
  const next = normalizePayType(value)
  configForm.EASYPAY_PAY_TYPE = next
  configForm.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, next).join(',')
}

function togglePayType(value: string) {
  const next = normalizePayType(value) as typeof paymentTypeOptions[number]['value']
  const enabled = enabledPayTypes.value.filter((item) => item !== next)
  if (enabledPayTypes.value.includes(next)) {
    if (next === selectedPayType.value) {
      showToast(t('adminPaymentConfig.defaultMustEnabled'), 'error')
      return
    }
    if (enabled.length === 0) {
      showToast(t('adminPaymentConfig.atLeastOnePayType'), 'error')
      return
    }
    configForm.EASYPAY_ENABLED_PAY_TYPES = enabled.join(',')
    return
  }
  configForm.EASYPAY_ENABLED_PAY_TYPES = [...enabledPayTypes.value, next].join(',')
}

function callbackUrl(provider: ProviderConfig) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/api/payments/${encodeURIComponent(tenantId.value || '{tenantId}')}/${provider.name}/callback`
}

async function copyCallbackUrl(provider: ProviderConfig) {
  await copyWithToast(callbackUrl(provider), {
    successMessage: t('adminPaymentConfig.callbackCopied'),
    errorMessage: t('adminPaymentConfig.copyFailed'),
  })
}

onMounted(loadData)
</script>

<style scoped>
.provider-list {
  display: grid;
  gap: var(--admin-stack-gap);
}

.provider-card,
.health-card,
.payment-check-strip {
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--admin-card-pad);
}

.health-card strong {
  display: block;
  font-size: 15px;
  margin-bottom: 4px;
}

.health-card p {
  color: var(--tg-hint);
  font-size: 13px;
}

.health-card-success {
  border-color: rgba(34, 197, 94, .35);
  background: rgba(34, 197, 94, .08);
}

.health-card-error {
  border-color: rgba(239, 68, 68, .35);
  background: rgba(239, 68, 68, .08);
}

.payment-check-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.payment-check-item {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, .025);
}

.check-label {
  display: block;
  color: var(--tg-hint);
  font-size: 12px;
}

.payment-check-item strong {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.provider-title-row {
  min-width: 0;
}

.provider-name {
  margin: 0 0 4px;
  font-size: 17px;
  line-height: 1.35;
}

.provider-desc {
  margin: 0;
  color: var(--tg-hint);
  font-size: 13px;
}

.provider-status {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.provider-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.provider-facts div {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, .025);
}

.provider-facts dt {
  color: var(--tg-hint);
  font-size: 12px;
}

.provider-facts dd {
  margin-top: 3px;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.callback-value {
  display: flex;
  align-items: center;
  gap: 6px;
}

.callback-value span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-alerts {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.provider-alert {
  margin: 0;
  font-size: 13px;
}

.provider-alert--error {
  color: var(--danger);
}

.provider-alert--warning {
  color: #ca8a04;
}

.provider-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.tag-danger {
  background: rgba(239, 68, 68, .16);
  color: #f87171;
}

.modal-form {
  display: grid;
  gap: 14px;
}

.modal-form label {
  display: grid;
  gap: 6px;
}

.modal-form label span {
  color: var(--tg-hint);
  font-size: 13px;
  font-weight: 600;
}

.modal-form label em {
  margin-left: 2px;
  color: var(--danger);
  font-style: normal;
}

.modal-form input:not([type='checkbox']):not([type='radio']) {
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  color: var(--tg-text);
}

.config-grid {
  display: grid;
  gap: 12px;
}

.config-grid.two-cols {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.toggle-row {
  display: inline-flex;
  align-items: center;
  grid-template-columns: none;
  gap: 8px;
}

.quick-setting {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, .025);
}

.quick-copy {
  display: grid;
  gap: 2px;
}

.quick-label {
  font-size: 13px;
  font-weight: 700;
}

.quick-copy small,
.field-hint {
  color: var(--tg-hint);
  font-size: 12px;
}

.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

.segment-btn {
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--tg-hint);
  cursor: pointer;
}

.segment-btn.active {
  border-color: var(--tg-btn);
  background: rgba(56, 139, 253, .16);
  color: var(--tg-text);
}

.callback-box {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
}

.callback-box span {
  color: var(--tg-hint);
  font-size: 13px;
  font-weight: 600;
}

.callback-box code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tg-text);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

@media (max-width: 760px) {
  .provider-header,
  .quick-setting,
  .callback-box {
    grid-template-columns: 1fr;
  }

  .provider-header {
    flex-direction: column;
  }

  .provider-status,
  .provider-actions {
    justify-content: flex-start;
  }

  .provider-facts,
  .config-grid.two-cols {
    grid-template-columns: 1fr;
  }
}
</style>
