<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">{{ $t('adminConfig.title') }}</h2>
      <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadData">{{ $t('adminConfig.refresh') }}</button>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">{{ $t('adminConfig.reload') }}</button>
    </div>

    <div
      v-if="!loading && !loadError"
      class="tabs config-section-tabs"
      role="tablist"
      :aria-label="$t('adminConfig.sectionTabsLabel')"
    >
      <button
        v-for="section in SYSTEM_CONFIG_SECTIONS"
        :key="section.id"
        type="button"
        class="tab"
        role="tab"
        :aria-selected="activeSection === section.id"
        :class="{ active: activeSection === section.id }"
        @click="selectSection(section.id)"
      >
        {{ $t('adminConfig.sectionLabels.' + section.id) }}
        <span class="config-tab-count">{{ sectionItemCounts[section.id] ?? 0 }}</span>
      </button>
    </div>

    <div class="config-scroll">
      <div
        v-if="!loading && !loadError && activeSection === 'security'"
        class="status-banner"
        :class="turnstileBannerClass"
      >
        {{ turnstileBannerText }}
      </div>

      <div v-if="loading" class="skeleton-list">
        <div v-for="i in 6" :key="i" class="skeleton-line w-80" />
      </div>

      <template v-else-if="!loadError">
        <section class="config-section" :aria-labelledby="`config-section-${activeSection}`">
          <div class="config-section-head">
            <div>
              <h3 :id="`config-section-${activeSection}`">{{ $t('adminConfig.sectionLabels.' + activeSection) }}</h3>
              <p>{{ $t('adminConfig.sectionDescriptions.' + activeSection) }}</p>
            </div>
            <span class="config-count">{{ $t('adminConfig.itemCount', { count: activeSectionItemCount }) }}</span>
          </div>

          <p v-if="activeSection === 'payment'" class="config-crosslink">
            {{ $t('adminConfig.paymentCrosslink') }}
            <RouterLink class="config-crosslink-a" to="/admin/payment">{{ $t('adminConfig.paymentPageLink') }}</RouterLink>
            {{ $t('adminConfig.paymentPageNote') }}
          </p>
          <p v-if="activeSection === 'referral'" class="config-crosslink">
            {{ $t('adminConfig.referralCrosslink1') }}
            <RouterLink class="config-crosslink-a" to="/admin/referral-codes">{{ $t('adminConfig.referralLink') }}</RouterLink>
            {{ $t('adminConfig.referralCrosslink2') }}
          </p>

          <div v-if="activeGroupedDefinitions.length === 0" class="empty-text config-empty">
            {{ $t('adminConfig.noData') }}
          </div>

          <div
            v-for="group in activeGroupedDefinitions"
            :key="group.name"
            class="config-group"
          >
            <div class="config-group-title">
              <span>{{ $t('adminConfig.groupNames.' + groupNameKey(group.name)) }}</span>
              <span>{{ $t('adminConfig.itemCount', { count: group.items.length }) }}</span>
            </div>
            <div class="config-grid">
              <ConfigField
                v-for="item in group.items"
                :key="item.key"
                :item="item"
                :value="config[item.key] || ''"
                :status="fieldStatus[item.key] || 'idle'"
                @change="update"
                @reset="reset"
              />
            </div>
            <div v-if="group.name === '邮件服务'" class="config-test-panel">
              <div class="config-test-main">
                <label>
                  <span>{{ $t('adminConfig.emailTest.toLabel') }}</span>
                  <input v-model="testEmailTo" type="email" :placeholder="t('checkout.emailPlaceholder')" />
                </label>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="emailTestDisabled"
                  @click="sendTestEmail"
                >
                  {{ sendingTestEmail ? t('adminConfig.emailTest.sending') : t('adminConfig.emailTest.sendTest') }}
                </button>
              </div>
              <p class="config-test-help">{{ emailTestHelp }}</p>
              <p
                v-if="testEmailStatus"
                class="config-test-status"
                :class="testEmailOk ? 'config-test-status--success' : 'config-test-status--error'"
              >
                {{ testEmailStatus }}
              </p>
            </div>
          </div>
        </section>

        <section
          v-if="activeSectionDef.includeDangerZone"
          class="config-section danger-section"
          aria-labelledby="data-maintenance-title"
        >
          <div class="config-section-head">
            <div>
              <h3 id="data-maintenance-title">{{ $t('adminConfig.dataMaintenance.title') }}</h3>
              <p>
                {{ $t('adminConfig.dataMaintenance.desc') }}
              </p>
            </div>
          </div>
          <div class="danger-profiles" role="radiogroup" :aria-label="$t('adminConfig.dataMaintenance.title')">
            <label
              v-for="item in clearProfiles"
              :key="item.id"
              class="danger-profile"
              :class="{ 'danger-profile--active': clearProfile === item.id }"
            >
              <input v-model="clearProfile" type="radio" name="clear-profile" :value="item.id" />
              <span class="danger-profile-body">
                <strong>{{ $t(`adminConfig.clearProfiles.${item.id}.title`) }}</strong>
                <span>{{ $t(`adminConfig.clearProfiles.${item.id}.summary`) }}</span>
              </span>
            </label>
          </div>
          <p class="danger-profile-detail">{{ $t(`adminConfig.clearProfiles.${clearProfile}.detail`) }}</p>
          <div class="danger-panel">
            <label>
              <span>{{ $t('adminConfig.dataMaintenance.confirmPhrase') }}</span>
              <input
                v-model="clearBusinessConfirmText"
                type="text"
                autocomplete="off"
                :placeholder="$t(`adminConfig.clearProfiles.${clearProfile}.confirmation`)"
              />
            </label>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="!canClearBusinessData"
              @click="clearBusinessData"
            >
              {{ clearingBusinessData ? $t('adminConfig.clearing') : $t(`adminConfig.clearProfiles.${clearProfile}.buttonLabel`) }}
            </button>
          </div>
          <p v-if="clearBusinessDataStatus" class="danger-status">{{ clearBusinessDataStatus }}</p>
        </section>
      </template>
    </div>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { clearAdminBusinessData, fetchAdminSystemConfig, testAdminEmail, updateAdminSystemConfig } from '@/api/admin'
import type { AdminClearBusinessDataProfile } from '@/api/admin'
import type { AdminSystemConfigResult, AdminSystemConfigDefinition } from '@/types/admin'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import i18n from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import ConfigField from '@/components/admin/ConfigField.vue'
import { useShopConfig } from '@/composables/useShopConfig'
import {
  SYSTEM_CONFIG_SECTIONS,
  getSystemConfigSection,
  resolveSystemConfigSectionId,
  type SystemConfigSectionId,
} from './system-config-sections'

/** 将后端配置分组名映射为 i18n 键名 */
function groupNameKey(name: string): string {
  const map: Record<string, string> = {
    '基础信息': 'basic',
    '支付配置': 'payment',
    '安全与验证': 'security_verification',
    '邮箱策略': 'email_policy',
    '订单与限流': 'order_rate_limit',
    '后台与安全': 'admin_security',
    '邮件服务': 'email_service',
    '库存预警': 'stock_alert',
    '分销与返佣': 'referral_commission',
    '数据保留与清理': 'data_retention',
    '其他': 'other',
  }
  return map[name] || 'other'
}

const { showToast } = useToast()
const { t } = useI18n()
const { token } = useAdminAuth()
const { loadShopConfig } = useShopConfig()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const loadError = ref('')
const config = reactive<Record<string, string>>({})
const fieldStatus = reactive<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})
const definitions = ref<AdminSystemConfigDefinition[]>([])
const turnstileStatus = ref<AdminSystemConfigResult['turnstileStatus']>()
const testEmailTo = ref('')
const sendingTestEmail = ref(false)
const testEmailStatus = ref('')
const testEmailOk = ref(false)
const activeSection = ref<SystemConfigSectionId>(
  resolveSystemConfigSectionId(route.query.tab),
)

const clearProfiles = [
  { id: 'runtime' as const },
  { id: 'keep_trade' as const },
  { id: 'keep_catalog' as const },
  { id: 'full' as const },
] as const

const clearProfile = ref<AdminClearBusinessDataProfile>('keep_trade')
const clearBusinessConfirmText = ref('')
const clearBusinessDataStatus = ref('')
const clearingBusinessData = ref(false)

// 切换档位时清空已输入短语，避免用上一档短语误触高危档位（服务端仍会校验，此处减少误操作）。
watch(clearProfile, () => {
  clearBusinessConfirmText.value = ''
  clearBusinessDataStatus.value = ''
})

watch(
  () => route.query.tab,
  (tab) => {
    activeSection.value = resolveSystemConfigSectionId(tab)
  },
)

const emailConfigKeys = ['resend_api_key', 'email_from']

const activeSectionDef = computed(() => getSystemConfigSection(activeSection.value))

const groupsByName = computed(() => {
  const map = new Map<string, AdminSystemConfigDefinition[]>()
  for (const item of definitions.value) {
    const name = item.group || i18n.global.t('adminConfig.groupNames.other')
    if (!map.has(name)) map.set(name, [])
    map.get(name)!.push(item)
  }
  for (const items of map.values()) {
    items.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
  }
  return map
})

const sectionItemCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const section of SYSTEM_CONFIG_SECTIONS) {
    let n = 0
    for (const group of section.groups) {
      n += groupsByName.value.get(group)?.length ?? 0
    }
    counts[section.id] = n
  }
  return counts
})

const activeGroupedDefinitions = computed(() => {
  const section = activeSectionDef.value
  return section.groups
    .map((name) => {
      const items = groupsByName.value.get(name) ?? []
      return { name, items }
    })
    .filter((group) => group.items.length > 0)
})

const activeSectionItemCount = computed(
  () => sectionItemCounts.value[activeSection.value] ?? 0,
)

const emailConfigSaving = computed(() =>
  emailConfigKeys.some((key) => fieldStatus[key] === 'saving'),
)
const emailTestDisabled = computed(() =>
  sendingTestEmail.value || emailConfigSaving.value || !testEmailTo.value.trim(),
)
const emailTestHelp = computed(() =>
  emailConfigSaving.value
    ? t('adminConfig.emailTest.savingHint')
    : t('adminConfig.emailTest.readyHint'),
)
const activeClearProfile = computed(() => {
  const matched = clearProfiles.find((item) => item.id === clearProfile.value)
  if (matched) return matched
  // 未知档位回退到默认 keep_trade（与 clearProfile 初始值一致），禁止静默落到高危档。
  return clearProfiles.find((item) => item.id === 'keep_trade') || clearProfiles[0]
})
const canClearBusinessData = computed(() =>
  !clearingBusinessData.value
    && clearBusinessConfirmText.value.trim() === t('adminConfig.clearProfiles.' + activeClearProfile.value.id + '.confirmation'),
)

const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()
let resetKey: string | null = null

function selectSection(id: SystemConfigSectionId) {
  if (activeSection.value === id && route.query.tab === id) return
  activeSection.value = id
  const nextQuery = { ...route.query, tab: id }
  void router.replace({ query: nextQuery })
}

async function refreshPublicConfig(scope?: AdminSystemConfigDefinition['scope']): Promise<boolean> {
  if (scope !== 'public') return true
  try {
    await loadShopConfig(true)
    return true
  } catch {
    return false
  }
}

function showSavedStatus(message: string, publicConfigSynced: boolean) {
  if (publicConfigSynced) {
    showToast(message, 'success')
    return
  }
  showToast(`${message}${t('adminConfig.notSynced')}`, 'info', 5000)
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const res: AdminSystemConfigResult = await fetchAdminSystemConfig(token.value)
    Object.assign(config, res.config)
    definitions.value = res.definitions
    turnstileStatus.value = res.turnstileStatus
    if (!testEmailTo.value.trim() && res.config.support_email) {
      testEmailTo.value = res.config.support_email
    }
  } catch (err: any) {
    definitions.value = []
    turnstileStatus.value = undefined
    for (const key of Object.keys(config)) delete config[key]
    loadError.value = err.message || t('adminConfig.loadFailed')
    showToast(err.message || t('adminConfig.loadFailed'), 'error')
  } finally {
    loading.value = false
  }
}

async function update(key: string, value: string) {
  fieldStatus[key] = 'saving'
  try {
    const res = await updateAdminSystemConfig(token.value, { key, value })
    config[key] = res.value
    const publicConfigSynced = await refreshPublicConfig(definitions.value.find((item) => item.key === key)?.scope)
    if (res.configured !== undefined) {
      const definition = definitions.value.find((item) => item.key === key)
      if (definition) definition.configured = res.configured
    }
    if (res.turnstileStatus) turnstileStatus.value = res.turnstileStatus
    fieldStatus[key] = 'saved'
    markEmailTestStale(key)
    showSavedStatus(t('adminConfig.saved'), publicConfigSynced)
  } catch (err: any) {
    fieldStatus[key] = 'error'
    showToast(err.message || t('adminConfig.saveFailed'), 'error')
  }
}

async function sendTestEmail() {
  if (sendingTestEmail.value) return
  if (emailConfigSaving.value) {
    testEmailOk.value = false
    testEmailStatus.value = t('adminConfig.emailTest.savingHint')
    return
  }
  const to = testEmailTo.value.trim()
  if (!to) return
  sendingTestEmail.value = true
  testEmailStatus.value = ''
  testEmailOk.value = false
  try {
    const res = await testAdminEmail(token.value, { to })
    testEmailOk.value = true
    testEmailStatus.value = res.resendId
      ? t('adminConfig.emailTest.sentWithId', { id: res.resendId })
      : (res.message || t('adminConfig.emailTest.sent'))
    showToast(t('adminConfig.emailTest.sent'), 'success')
  } catch (err: any) {
    testEmailOk.value = false
    testEmailStatus.value = err.message || t('adminConfig.emailTest.sendTest')
    showToast(testEmailStatus.value, 'error')
  } finally {
    sendingTestEmail.value = false
  }
}

async function clearBusinessData() {
  if (!canClearBusinessData.value) return
  const profile = activeClearProfile.value
  const confirmed = await askConfirm(
    `${t('adminConfig.clearData.confirmTitle', { title: t('adminConfig.clearProfiles.' + profile.id + '.title') })}\n\n${t('adminConfig.clearProfiles.' + profile.id + '.detail')}\n\n${t('adminConfig.clearData.confirmBody')}`,
  )
  if (!confirmed) return

  clearingBusinessData.value = true
  clearBusinessDataStatus.value = ''
  try {
    const confirmationText = t('adminConfig.clearProfiles.' + profile.id + '.confirmation')
    const result = await clearAdminBusinessData(token.value, confirmationText, profile.id)
    clearBusinessConfirmText.value = ''
    clearBusinessDataStatus.value = t('adminConfig.clearData.result', {
      profile: result.profile,
      deleted: result.deleted,
      auditId: result.retainedAuditId,
      strategy: result.cardStrategy,
    })
    showToast(t('adminConfig.clearData.completed'), 'success')
  } catch (err: any) {
    clearBusinessDataStatus.value = err.message || t('adminConfig.emailTest.sendTest')
    showToast(clearBusinessDataStatus.value, 'error')
  } finally {
    clearingBusinessData.value = false
  }
}

const turnstileBannerClass = computed(() => {
  if (!turnstileStatus.value?.enabled) return 'status-banner-info'
  return turnstileStatus.value.complete ? 'status-banner-success' : 'status-banner-error'
})

const turnstileBannerText = computed(() => {
  if (!turnstileStatus.value?.enabled) {
    return t('adminConfig.turnstileDisabled')
  }
  if (turnstileStatus.value.complete) {
    return t('adminConfig.turnstileEnabled')
  }
  return t('adminConfig.turnstileIncomplete')
})

async function reset(key: string) {
  const def = definitions.value.find((d) => d.key === key)
  if (!def) return
  resetKey = key
  if (!(await askConfirm(t('adminConfig.resetConfirm', { key })))) return
  fieldStatus[key] = 'saving'
  try {
    const res = await updateAdminSystemConfig(token.value, {
      key: resetKey,
      value: def.defaultValue || '',
    })
    config[resetKey] = res.value
    const publicConfigSynced = await refreshPublicConfig(def.scope)
    if (res.configured !== undefined) {
      const definition = definitions.value.find((item) => item.key === resetKey)
      if (definition) definition.configured = res.configured
    }
    if (res.turnstileStatus) turnstileStatus.value = res.turnstileStatus
    fieldStatus[key] = 'saved'
    markEmailTestStale(key)
    showSavedStatus(t('adminConfig.resetSuccess'), publicConfigSynced)
  } catch (err: any) {
    fieldStatus[key] = 'error'
    showToast(err.message || t('adminConfig.resetFailed'), 'error')
  } finally {
    resetKey = null
  }
}

function markEmailTestStale(key: string) {
  if (!emailConfigKeys.includes(key)) return
  testEmailOk.value = false
  testEmailStatus.value = t('adminConfig.emailTest.configUpdated')
}

onMounted(loadData)
</script>

<style>
@import '@/assets/admin.css';
</style>

<style scoped>
/*
 * page-title / skeleton-* / status-banner* / config-grid /
 * config-section* / config-count / tabs → admin.css
 */
.config-section-tabs {
  flex-shrink: 0;
  flex-wrap: nowrap;
  overflow-x: auto;
  padding-bottom: 2px;
  margin: 0 0 4px;
  -webkit-overflow-scrolling: touch;
}

.config-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25em;
  margin-left: 2px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--tg-hint, #9aa4b2);
  background: rgba(255, 255, 255, 0.06);
}

.tab.active .config-tab-count,
.tab[aria-selected='true'] .config-tab-count {
  color: #fff7ed;
  background: rgba(255, 255, 255, 0.12);
}

.config-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 24px;
  display: flex;
  flex-direction: column;
  gap: var(--admin-stack-gap, 8px);
}

.config-crosslink {
  margin: 0 0 var(--admin-stack-gap, 8px);
  font-size: 12px;
  line-height: 1.5;
  color: var(--tg-hint, #9aa4b2);
}

.config-crosslink-a {
  color: var(--admin-accent-text, #fbbf24);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.config-crosslink-a:hover {
  color: #fcd34d;
}

/* 系统配置字段卡：比通用 two-cols 更宽的自适应列 */
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--admin-card-gap, 10px);
}

.config-group {
  display: flex;
  flex-direction: column;
  gap: var(--admin-stack-gap, 8px);
}

.config-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
  font-weight: 600;
}

.config-group-title span:last-child {
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
  font-weight: 400;
}

.config-empty {
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-lg, 12px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
}

.config-test-panel {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-lg, 12px);
  padding: 10px;
  background: var(--surface-2, rgba(255, 255, 255, 0.07));
}

.config-test-main {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 10px;
  align-items: end;
}

.config-test-main label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.config-test-main input {
  min-width: 0;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  padding: 8px 10px;
  font-size: 13px;
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--tg-text, #f0f2f5);
}

.config-test-status {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}

.config-test-help {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.config-test-status--success {
  color: #6ee7b7;
}

.config-test-status--error {
  color: #fca5a5;
}

.danger-section {
  border-color: rgba(220, 38, 38, 0.28);
}

.danger-profiles {
  display: grid;
  gap: var(--admin-inline-gap, 8px);
  margin: 0 0 var(--admin-stack-gap, 8px);
}

.danger-profile {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border: 0.5px solid rgba(220, 38, 38, 0.22);
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, #151b28);
  cursor: pointer;
}

.danger-profile--active {
  border-color: rgba(220, 38, 38, 0.55);
  box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.12);
}

.danger-profile input {
  margin-top: 3px;
}

.danger-profile-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.danger-profile-body strong {
  font-size: 13px;
  color: var(--tg-text, #f0f2f5);
}

.danger-profile-detail {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #fdba74;
}

.danger-panel {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 10px;
  align-items: end;
}

.danger-panel label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.danger-panel input {
  min-width: 0;
  border: 0.5px solid rgba(220, 38, 38, 0.35);
  border-radius: var(--r-md, 8px);
  padding: 8px 10px;
  font-size: 13px;
  background: var(--tg-secondary-bg, #151b28);
  color: var(--tg-text, #f0f2f5);
}

.danger-status {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: #fca5a5;
  word-break: break-word;
}

@media (max-width: 560px) {
  .config-test-main {
    grid-template-columns: 1fr;
  }

  .danger-panel {
    grid-template-columns: 1fr;
  }
}
</style>
