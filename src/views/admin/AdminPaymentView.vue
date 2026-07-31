<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">{{ $t('adminPayment.title') }}</h2>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || isOperating" @click="loadData">{{ $t('adminPayment.refresh') }}</button>
      </div>
    </div>

    <div v-if="paymentHealth" class="health-card" :class="paymentHealthClass">
      <strong>{{ paymentHealthTitle }}</strong>
      <p>{{ paymentHealthMessage }}</p>
    </div>

    <div v-if="balancePaymentLoaded" class="balance-card" :class="balancePaymentEnabled ? 'balance-card-success' : 'balance-card-muted'">
      <div class="balance-card-head">
        <div>
          <strong>{{ $t('adminPayment.balancePay') }}</strong>
          <p>{{ $t('adminPayment.balancePayDesc') }}</p>
        </div>
        <span class="tag" :class="balancePaymentEnabled ? 'tag-success' : 'tag-muted'">
          {{ $t(balancePaymentEnabled ? 'adminPayment.statusEnabled' : 'adminPayment.statusDisabled') }}
        </span>
      </div>
      <div class="balance-card-actions">
        <button
          class="btn btn-primary btn-sm"
          :disabled="loading || isOperating || balanceSaving"
          type="button"
          @click="toggleBalancePayment"
        >
          {{ balanceSaving ? $t('adminPayment.statusProcessing') : $t(balancePaymentEnabled ? 'adminPayment.disableBalancePay' : 'adminPayment.enableBalancePay') }}
        </button>
        <span class="balance-card-hint">{{ $t('adminPayment.balancePayHint') }}</span>
      </div>
    </div>

    <div v-if="balancePaymentLoaded" class="balance-card" :class="balanceRechargeEnabled ? 'balance-card-success' : 'balance-card-muted'">
      <div class="balance-card-head">
        <div>
          <strong>{{ $t('adminPayment.rechargeTitle') }}</strong>
          <p>{{ $t('adminPayment.rechargeDesc') }}</p>
        </div>
        <span class="tag" :class="balanceRechargeEnabled ? 'tag-success' : 'tag-muted'">{{ $t(balanceRechargeEnabled ? 'adminPayment.statusEnabled' : 'adminPayment.statusDisabled') }}</span>
      </div>
      <div class="balance-card-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading || isOperating || rechargeSaving" type="button" @click="toggleBalanceRecharge">
          {{ rechargeSaving ? $t('adminPayment.statusProcessing') : $t(balanceRechargeEnabled ? 'adminPayment.disableRecharge' : 'adminPayment.enableRecharge') }}
        </button>
        <span class="balance-card-hint">{{ $t('adminPayment.rechargeHint') }}</span>
      </div>
    </div>

    <div v-if="loading" class="skeleton-list">
      <div v-for="i in 4" :key="i" class="skeleton-line w-60" />
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading || isOperating" @click="loadData">{{ $t('adminPayment.actionReload') }}</button>
    </div>

    <div
      v-if="!loading && !loadError"
      class="provider-list"
      role="region"
      :aria-label="$t('adminPayment.title')"
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
              {{ $t(item.enabled ? 'adminPayment.statusEnabled' : 'adminPayment.statusNotEnabled') }}
            </span>
            <span class="tag" :class="item.configured ? 'tag-success' : 'tag-muted'">
              {{ $t(item.configured ? 'adminPayment.statusConfigured' : 'adminPayment.statusNotConfigured') }}
            </span>
            <!-- 已启用但凭据为空：CREDENTIALS_ENCRYPTION_KEY 变更后旧配置丢失，需重新保存 -->
            <span v-if="item.enabled && item.configured && !item.hasValidCredentials" class="tag tag-danger">
              {{ $t('adminPayment.credentialMissing') }}
            </span>
          </div>
          <dl class="provider-facts">
            <div>
              <dt>{{ $t('adminPayment.colCurrency') }}</dt>
              <dd>{{ item.supportedCurrencies.join(' / ') }}</dd>
            </div>
            <div>
              <dt>{{ $t('adminPayment.colDefaultPayType') }}</dt>
              <dd>{{ paymentTypeLabel(providerConfigValue(item, 'EASYPAY_PAY_TYPE')) }}</dd>
            </div>
            <div>
              <dt>{{ $t('adminPayment.colEnableMethod') }}</dt>
              <dd>{{ enabledPaymentTypesLabel(providerConfigValue(item, 'EASYPAY_ENABLED_PAY_TYPES'), providerConfigValue(item, 'EASYPAY_PAY_TYPE')) }}</dd>
            </div>
            <div>
              <dt>{{ $t('adminPayment.colGateway') }}</dt>
              <dd>{{ providerConfigValue(item, 'EASYPAY_API_BASE') || $t('adminPayment.statusNotConfigured') }}</dd>
            </div>
            <div>
              <dt>{{ $t('adminPayment.colCallback') }}</dt>
              <dd class="callback-value"><span>{{ callbackUrl(item) }}</span><button class="btn btn-ghost btn-xs" @click="copyCallbackUrl(item)">{{ $t('adminPayment.actionCopy') }}</button></dd>
            </div>
            <div>
              <dt>{{ $t('adminPayment.colRechargeCallback') }}</dt>
              <dd class="callback-value"><span>{{ rechargeCallbackUrl(item) }}</span><button class="btn btn-ghost btn-xs" @click="copyRechargeCallbackUrl(item)">{{ $t('adminPayment.actionCopy') }}</button></dd>
            </div>
          </dl>
        </div>
        <div class="provider-actions">
          <button class="btn btn-primary btn-sm" :disabled="isOperating || deletingProvider === item.name" @click="openConfig(item)">{{ $t('adminPayment.actionConfigure') }}</button>
          <button class="btn btn-ghost btn-sm" :disabled="isOperating || !item.configured || deletingProvider === item.name" @click="toggleEnabled(item)">
            {{ togglingProvider === item.name ? $t('adminPayment.statusProcessing') : $t(item.enabled ? 'adminPayment.actionDisable' : 'adminPayment.actionEnable') }}
          </button>
          <button class="btn btn-danger btn-sm" :disabled="isOperating" @click="removeConfig(item)">
            {{ deletingProvider === item.name ? $t('adminPayment.statusDeleting') : $t('adminPayment.actionDelete') }}
          </button>
        </div>
      </div>
    </div>

    <AdminModal v-model="configVisible" :title="editingProvider ? $t('adminPayment.modalEditProvider') : $t('adminPayment.modalPaymentConfig')" max-width="720px" hide-actions>
      <form class="modal-form" @submit.prevent="saveConfig">
        <template v-if="editingProvider?.name === 'easypay'">
          <div class="config-grid two-cols">
            <label>
              <span>{{ $t('adminPayment.providerName') }}</span>
              <input :value="editingProvider.displayName" disabled />
            </label>
            <label>
              <span>{{ $t('adminPayment.providerType') }}</span>
              <input :value="$t('adminPayment.providerEasypay')" disabled />
            </label>
          </div>

          <div class="quick-setting">
            <div class="quick-copy">
              <span class="quick-label">{{ $t('adminPayment.enablePayMethods') }}</span>
              <small>{{ $t('adminPayment.enablePayMethodsHint') }}</small>
            </div>
            <div class="segmented" role="group" :aria-label="$t('adminPayment.enablePayMethods')">
              <button
                v-for="option in paymentTypeOptions"
                :key="option.value"
                type="button"
                class="segment-btn"
                :class="{ active: enabledPayTypes.includes(option.value) }"
                @click="togglePayType(option.value)"
              >
                {{ $t(option.labelKey) }}
              </button>
            </div>
          </div>

          <div class="quick-setting">
            <div class="quick-copy">
              <span class="quick-label">{{ $t('adminPayment.defaultPayMethod') }}</span>
              <small>{{ $t('adminPayment.defaultPayMethodHint') }}</small>
            </div>
            <div class="segmented" role="group" :aria-label="$t('adminPayment.defaultPayMethod')">
              <button
                v-for="option in paymentTypeOptions"
                :key="option.value"
                type="button"
                class="segment-btn"
                :class="{ active: selectedPayType === option.value }"
                @click="setPayType(option.value)"
              >
                {{ $t(option.labelKey) }}
              </button>
            </div>
          </div>

          <label>
            <span>{{ $t('adminPayment.merchantPID') }}</span>
            <input v-model="configForm.EASYPAY_PID" placeholder="2026062310564339" autocomplete="off" required />
          </label>
          <label>
            <span>{{ $t('adminPayment.merchantKey') }}</span>
            <input v-model="configForm.EASYPAY_KEY" type="password" :placeholder="$t('adminPayment.merchantKeyPlaceholder')" autocomplete="new-password" required />
            <small class="field-hint">{{ $t('adminPayment.merchantKeyHint') }}</small>
          </label>
          <label>
            <span>{{ $t('adminPayment.apiBaseUrl') }}</span>
            <input v-model="configForm.EASYPAY_API_BASE" :placeholder="$t('adminPayment.apiBasePlaceholder')" required />
            <small class="field-hint">{{ $t('adminPayment.apiBaseHint') }}</small>
          </label>
          <label>
            <span>{{ $t('adminPayment.returnUrl') }}</span>
            <input v-model="configForm.EASYPAY_RETURN_URL" :placeholder="$t('adminPayment.returnUrlPlaceholder')" />
          </label>
          <div class="callback-box">
            <span>{{ $t('adminPayment.asyncCallbackUrl') }}</span>
            <code>{{ editingProvider ? callbackUrl(editingProvider) : '' }}</code>
            <button v-if="editingProvider" type="button" class="btn btn-ghost btn-xs" @click="copyCallbackUrl(editingProvider)">{{ $t('adminPayment.actionCopy') }}</button>
          </div>
        </template>
        <template v-else>
          <label v-for="field in editingProvider?.fields" :key="field.key">
            <span>{{ field.label }}</span>
            <input v-model="configForm[field.key]" :type="field.type === 'password' ? 'password' : 'text'" :placeholder="field.placeholder || ''" />
            <small v-if="field.hint" class="field-hint">{{ field.hint }}</small>
          </label>
        </template>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" :disabled="Boolean(savingProvider)" @click="configVisible = false">{{ $t('adminPayment.actionCancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="Boolean(savingProvider)">
            {{ savingProvider ? $t('adminPayment.statusSaving') : $t('adminPayment.actionSave') }}
          </button>
        </div>
      </form>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchAdminPaymentProviders, fetchAdminPaymentConfigs, fetchAdminPaymentHealth, fetchAdminSystemConfig, updateAdminPaymentConfig, updateAdminSystemConfig, setAdminPaymentProviderEnabled, deleteAdminPaymentConfig } from '@/api/admin'
import type { AdminPaymentProvider, AdminPaymentConfigItem, AdminPaymentHealthResult, AdminSystemConfigResult } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { writeClipboardText } from '@/composables/useClipboard'
import { useShopConfig } from '@/composables/useShopConfig'

const { showToast } = useToast()
const { token } = useAdminAuth()
const { t } = useI18n()
const { loadShopConfig } = useShopConfig()

async function refreshPublicShopConfig(): Promise<boolean> {
  try {
    await loadShopConfig(true)
    return true
  } catch {
    return false
  }
}

function showConfigMutationResult(message: string, publicConfigSynced: boolean) {
  showToast(
    publicConfigSynced ? message : `${message}${t('adminPayment.publicConfigSyncFailed')}`,
    publicConfigSynced ? 'success' : 'info',
    publicConfigSynced ? 3000 : 5000,
  )
}

async function copyCallbackUrl(provider: AdminPaymentProvider) {
  try {
    await writeClipboardText(callbackUrl(provider))
    showToast(t('adminPayment.copyCallbackSuccess'), 'success')
  } catch {
    showToast(t('adminPayment.copyFailed'), 'error')
  }
}

const loading = ref(false)
const loadError = ref('')
const providers = ref<AdminPaymentProvider[]>([])
const configs = ref<AdminPaymentConfigItem[]>([])
const paymentHealth = ref<AdminPaymentHealthResult | null>(null)
const balancePaymentEnabled = ref(false)
const balancePaymentLoaded = ref(false)
const balanceSaving = ref(false)
const balanceRechargeEnabled = ref(false)
const rechargeSaving = ref(false)

const configVisible = ref(false)
const editingProvider = ref<AdminPaymentProvider | null>(null)
const configForm = reactive<Record<string, string>>({})
const savingProvider = ref('')
const togglingProvider = ref('')
const deletingProvider = ref('')
const isOperating = computed(() => Boolean(savingProvider.value || togglingProvider.value || deletingProvider.value))
const paymentTypeOptions = [
  { value: 'alipay' as const, labelKey: 'adminPayment.providerAlipay' },
  { value: 'wxpay' as const, labelKey: 'adminPayment.providerWechat' },
  { value: 'qqpay' as const, labelKey: 'adminPayment.providerQQ' },
]
const selectedPayType = computed(() => normalizePayType(configForm.EASYPAY_PAY_TYPE))
const enabledPayTypes = computed(() => normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, selectedPayType.value))

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let loadSequence = 0

const paymentHealthClass = computed(() => {
  const key = paymentHealth.value?.credentialsEncryptionKey
  return key?.configured && key.valid ? 'health-card-success' : 'health-card-error'
})

const paymentHealthTitle = computed(() => {
  const key = paymentHealth.value?.credentialsEncryptionKey
  if (!key?.configured) return t('adminPayment.healthKeyNotConfigured')
  return key.valid ? t('adminPayment.healthKeyValid') : t('adminPayment.healthKeyInvalid')
})

const paymentHealthMessage = computed(() => {
  const key = paymentHealth.value?.credentialsEncryptionKey
  if (!key?.configured) return t('adminPayment.healthMsgNotConfigured')
  if (!key.valid) return t('adminPayment.healthMsgInvalid')
  return t('adminPayment.healthMsgValid')
})

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const [providersRes, configsRes, healthRes] = await Promise.all([
      fetchAdminPaymentProviders(token.value),
      fetchAdminPaymentConfigs(token.value),
      fetchAdminPaymentHealth(token.value),
    ])
    if (sequence !== loadSequence) return
    providers.value = providersRes.providers
    configs.value = configsRes.configs
    paymentHealth.value = healthRes
    const systemRes: AdminSystemConfigResult = await fetchAdminSystemConfig(token.value)
    if (sequence !== loadSequence) return
    balancePaymentEnabled.value = systemRes.config.balance_payment_enabled === 'true'
    balanceRechargeEnabled.value = systemRes.config.balance_recharge_enabled === 'true'
    balancePaymentLoaded.value = true
  } catch (err: any) {
    if (sequence !== loadSequence) return
    providers.value = []
    configs.value = []
    balancePaymentLoaded.value = false
    loadError.value = err.message || t('adminPayment.loadFailed')
    showToast(err.message || t('adminPayment.loadFailed'), 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function toggleBalanceRecharge() {
  if (loading.value || isOperating.value || rechargeSaving.value) return
  const next = !balanceRechargeEnabled.value
  const confirmed = await askConfirm(next
    ? t('adminPayment.confirmEnableRecharge')
    : t('adminPayment.confirmDisableRecharge'))
  if (!confirmed) return
  rechargeSaving.value = true
  try {
    const res = await updateAdminSystemConfig(token.value, { key: 'balance_recharge_enabled', value: next ? 'true' : 'false' })
    balanceRechargeEnabled.value = res.value === 'true'
    const publicConfigSynced = await refreshPublicShopConfig()
    showConfigMutationResult(balanceRechargeEnabled.value ? t('adminPayment.rechargeEnabled') : t('adminPayment.rechargeDisabled'), publicConfigSynced)
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminPayment.saveFailed'), 'error')
  } finally {
    rechargeSaving.value = false
  }
}

async function toggleBalancePayment() {
  if (loading.value || isOperating.value || balanceSaving.value) return
  const next = !balancePaymentEnabled.value
  const confirmed = await askConfirm(
    next
      ? t('adminPayment.confirmEnableBalance')
      : t('adminPayment.confirmDisableBalance'),
  )
  if (!confirmed) return

  balanceSaving.value = true
  try {
    const res = await updateAdminSystemConfig(token.value, {
      key: 'balance_payment_enabled',
      value: next ? 'true' : 'false',
    })
    balancePaymentEnabled.value = res.value === 'true'
    const publicConfigSynced = await refreshPublicShopConfig()
    showConfigMutationResult(balancePaymentEnabled.value ? t('adminPayment.balanceEnabled') : t('adminPayment.balanceDisabled'), publicConfigSynced)
    await loadData()
  } catch (err: any) {
    showToast(err.message || t('adminPayment.saveFailed'), 'error')
  } finally {
    balanceSaving.value = false
  }
}

function openConfig(provider: AdminPaymentProvider) {
  editingProvider.value = provider
  const existing = configs.value.find((c) => c.name === provider.name)
  const form: Record<string, string> = {}
  Object.keys(configForm).forEach((key) => {
    delete configForm[key]
  })
  provider.fields.forEach((field) => {
    form[field.key] = existing?.configured
      ? (field.sensitive ? '••••••••' : existing.values?.[field.key] || '')
      : ''
  })
  if (provider.name === 'easypay') {
    form.EASYPAY_PAY_TYPE = normalizePayType(form.EASYPAY_PAY_TYPE)
    form.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(form.EASYPAY_ENABLED_PAY_TYPES, form.EASYPAY_PAY_TYPE).join(',')
  }
  Object.assign(configForm, form)
  configVisible.value = true
}

async function saveConfig() {
  if (!editingProvider.value) return
  if (savingProvider.value) return
  try {
    if (editingProvider.value.name === 'easypay') {
      configForm.EASYPAY_PAY_TYPE = normalizePayType(configForm.EASYPAY_PAY_TYPE)
      configForm.EASYPAY_ENABLED_PAY_TYPES = normalizeEnabledPayTypes(configForm.EASYPAY_ENABLED_PAY_TYPES, configForm.EASYPAY_PAY_TYPE).join(',')
    }
    savingProvider.value = editingProvider.value.name
    const result = await updateAdminPaymentConfig(token.value, editingProvider.value.name, configForm)
    showToast(result.message, 'success')
    configVisible.value = false
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminPayment.saveFailed'), 'error')
  } finally {
    savingProvider.value = ''
  }
}

async function toggleEnabled(provider: AdminPaymentProvider) {
  if (isOperating.value) return
  if (!provider.configured) {
    showToast(t('adminPayment.notConfiguredError'), 'error')
    return
  }
  const next = !provider.enabled
  if (next && !(await askConfirm(t('adminPayment.confirmEnableProvider', { name: provider.displayName })))) return
  if (togglingProvider.value) return
  togglingProvider.value = provider.name
  try {
    await setAdminPaymentProviderEnabled(token.value, provider.name, next)
    showToast(next ? t('adminPayment.providerEnabled') : t('adminPayment.providerDisabled'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminPayment.operationFailed'), 'error')
  } finally {
    togglingProvider.value = ''
  }
}

async function removeConfig(provider: AdminPaymentProvider) {
  if (isOperating.value) return
  if (!(await askConfirm(t('adminPayment.confirmDeleteProvider', { name: provider.displayName })))) return
  deletingProvider.value = provider.name
  try {
    await deleteAdminPaymentConfig(token.value, provider.name)
    showToast(t('adminPayment.providerDeleted'), 'success')
    loadData()
  } catch (err: any) {
    showToast(err.message || t('adminPayment.deleteFailed'), 'error')
  } finally {
    deletingProvider.value = ''
  }
}

function providerConfigValue(provider: AdminPaymentProvider, key: string) {
  const existing = configs.value.find((item) => item.name === provider.name)
  return existing?.values?.[key] || ''
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
  const option = paymentTypeOptions.find((option) => option.value === normalized)
  return option ? t(option.labelKey) : t('adminPayment.providerAlipay')
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
      showToast(t('adminPayment.defaultPayTypeMustBeEnabled'), 'error')
      return
    }
    if (enabled.length === 0) {
      showToast(t('adminPayment.atLeastOnePayType'), 'error')
      return
    }
    configForm.EASYPAY_ENABLED_PAY_TYPES = enabled.join(',')
    return
  }
  configForm.EASYPAY_ENABLED_PAY_TYPES = [...enabledPayTypes.value, next].join(',')
}

function callbackUrl(provider: AdminPaymentProvider) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/api/pay/callback/${provider.name}`
}

function rechargeCallbackUrl(provider: AdminPaymentProvider) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}/api/recharge/callback/${provider.name}`
}

async function copyRechargeCallbackUrl(provider: AdminPaymentProvider) {
  try {
    await writeClipboardText(rechargeCallbackUrl(provider))
    showToast(t('adminPayment.copyRechargeCallbackSuccess'), 'success')
  } catch {
    showToast(t('adminPayment.copyFailed'), 'error')
  }
}

onMounted(loadData)
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
/*
 * page-title / health-card* / balance-card* / provider-* /
 * segment-btn / quick-setting / callback-box / field-hint / modal-actions → admin.css
 * 仅保留支付页三列事实网格覆盖。
 */
.provider-facts {
  grid-template-columns: repeat(3, minmax(140px, 1fr));
}

@media (max-width: 640px) {
  .provider-facts {
    grid-template-columns: 1fr;
  }
}
</style>
