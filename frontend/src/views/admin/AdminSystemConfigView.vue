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
            <div class="config-head-actions">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :title="showAdvanced ? $t('adminConfig.hideAdvanced') : $t('adminConfig.showAdvanced')"
                @click="showAdvanced = !showAdvanced"
              >
                {{ showAdvanced ? $t('adminConfig.collapseAdvanced') : $t('adminConfig.expandAdvanced', { n: advancedItemCount }) }}
              </button>
              <span class="config-count">{{ $t('adminConfig.itemCount', { count: activeSectionItemCount }) }}</span>
            </div>
          </div>

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
              <SystemConfigFieldWithHistory
                v-for="item in group.items"
                :key="item.key"
                :item="item"
                :value="config[item.key] || ''"
                :status="fieldStatus[item.key] || 'idle'"
                @change="update"
                @reset="reset"
                @history="openHistory"
              />
            </div>
            <div v-if="groupNameKey(group.name) === 'email_service'" class="config-test-panel">
              <div class="config-test-main">
                <label>
                  <span>{{ $t('adminConfig.emailTest.toLabel') }}</span>
                  <input v-model="testEmailTo" type="email" :placeholder="$t('adminConfig.emailTest.emailPlaceholder')" />
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

    <AdminModal v-model="historyVisible" :title="historyTitle" max-width="760px" hide-actions>
      <div class="config-history-modal">
        <div class="config-history-meta">
          <span>{{ historyCurrentLabel }}</span>
          <button
            v-if="canRollbackHistory"
            type="button"
            class="btn btn-danger btn-xs"
            :disabled="historyRollingBack"
            @click="rollbackHistory"
          >
            {{ historyRollingBack ? $t('adminConfig.history.rollbacking') : $t('adminConfig.history.rollback') }}
          </button>
        </div>

        <div v-if="historyLoading" class="empty-text">{{ $t('adminConfig.history.loading') }}</div>
        <div v-else-if="historyError" class="table-error" role="alert">
          <span>{{ historyError }}</span>
          <button class="btn btn-ghost btn-xs" :disabled="historyLoading" @click="reloadHistory">
            {{ $t('adminConfig.history.retry') }}
          </button>
        </div>
        <template v-else>
          <div v-if="historyRows.length === 0" class="empty-text">{{ $t('adminConfig.history.empty') }}</div>
          <div v-else class="config-history-list">
            <article v-for="row in historyRows" :key="row.revision" class="config-history-item">
              <div class="config-history-item-head">
                <strong>#{{ row.revision }}</strong>
                <span>{{ $t(`adminConfig.history.changeType.${row.changeType}`) }}</span>
                <span>{{ row.createdAt }}</span>
              </div>
              <div class="config-history-item-body">
                <div>
                  <span>{{ $t('adminConfig.history.before') }}</span>
                  <strong>{{ displayHistoryValue(row.beforeValue) }}</strong>
                </div>
                <div>
                  <span>{{ $t('adminConfig.history.after') }}</span>
                  <strong>{{ displayHistoryValue(row.afterValue) }}</strong>
                </div>
                <div class="config-history-item-foot">
                  <span>{{ row.actorRole || 'unknown' }}</span>
                  <span>{{ row.actorUserId }}</span>
                </div>
              </div>
            </article>
          </div>
        </template>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="onConfirm" />
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import i18n from '@/i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { useAdminAuth } from '@/composables/useAdminAuth'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import SystemConfigFieldWithHistory from '@/components/admin/SystemConfigFieldWithHistory.vue'
import {
  SYSTEM_CONFIG_SECTIONS,
  getSystemConfigSection,
  resolveSystemConfigSectionId,
  type SystemConfigSectionId,
} from './system-config-sections'
import type { AdminSystemConfigDefinition } from '@/types/admin'
import { adminRequest } from '@/composables/useAdminRequest'

type AdminClearBusinessDataProfile = 'runtime' | 'keep_trade' | 'keep_catalog' | 'full'
type AdminSystemConfigHistoryChangeType = 'update' | 'delete' | 'rollback'

type AdminSystemConfigHistoryRow = {
  revision: number
  key: string
  beforeValue: string
  afterValue: string
  changeType: AdminSystemConfigHistoryChangeType
  actorUserId: string
  actorRole: string
  createdAt: string
}


/** 将后端配置分组名映射为 i18n 键名 */
function groupNameKey(name: string): string {
  const map: Record<string, string> = {
    '基础信息': 'basic',
    '支付配置': 'payment',
    '安全与验证': 'security_verification',
    '安全设置': 'security_settings',
    '抽奖设置': 'lottery_settings',
    '秒杀/支付': 'flash_payment',
    '邮箱策略': 'email_policy',
    '邮件通知': 'email_notification',
    '订单与限流': 'order_rate_limit',
    '后台与安全': 'admin_security',
    '邮件服务': 'email_service',
    '库存预警': 'stock_alert',
    '营销邮件': 'marketing_email',
    '分销与返佣': 'referral_commission',
    '数据保留与清理': 'data_retention',
    '数据维护': 'data_maintenance',
    '套餐额度': 'plan_limits',
    '平台运营': 'platform_ops',
    '其他': 'other',
  }
  return map[name] || 'other'
}

const { showToast } = useToast()
const { t } = useI18n()
useAdminAuth()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const loadError = ref('')
const config = reactive<Record<string, string>>({})
const fieldStatus = reactive<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({})
const definitions = ref<AdminSystemConfigDefinition[]>([])
const testEmailTo = ref('')
const sendingTestEmail = ref(false)
const testEmailStatus = ref('')
const testEmailOk = ref(false)
const activeSection = ref<SystemConfigSectionId>(
  resolveSystemConfigSectionId(route.query.tab),
)
/** 是否显示高级参数（默认只显示基础参数，降低认知负担） */
const showAdvanced = ref(false)

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
const historyVisible = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const historyKey = ref('')
const historyCurrentValue = ref('')
const historySensitive = ref(false)
const historyRows = ref<AdminSystemConfigHistoryRow[]>([])
const historyRollingBack = ref(false)

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
      const items = (groupsByName.value.get(name) ?? [])
        // 基础模式：只显示 basic 参数；高级模式：显示全部
        .filter((item) => showAdvanced.value || item.difficulty !== "advanced")
      return { name, items }
    })
    .filter((group) => group.items.length > 0)
})

const activeSectionItemCount = computed(
  () => sectionItemCounts.value[activeSection.value] ?? 0,
)
/** 当前 Tab 中高级参数的数量（仅在基础模式下显示，用于按钮提示） */
const advancedItemCount = computed(() => {
  const section = activeSectionDef.value
  let count = 0
  for (const name of section.groups) {
    const items = groupsByName.value.get(name) ?? []
    count += items.filter((item) => item.difficulty === "advanced").length
  }
  return count
})

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
// 平台管理入口：只给 L3 平台 owner 读取完整定义、写入配置、删除非内置项。
const PLATFORM_SYSTEM_CONFIG_API = '/api/platform/system-config'
// 公开读取入口：无鉴权，只返回白名单配置。保存 public 配置后用它验证前台可见配置是否已同步。
const PUBLIC_SYSTEM_CONFIG_API = '/api/system-config/system-config'

function selectSection(id: SystemConfigSectionId) {
  if (activeSection.value === id && route.query.tab === id) return
  activeSection.value = id
  const nextQuery = { ...route.query, tab: id }
  void router.replace({ query: nextQuery })
}

async function refreshPublicConfig(scope?: string): Promise<boolean> {
  if (scope !== 'public') return true
  try {
    await adminRequest<any>(PUBLIC_SYSTEM_CONFIG_API)
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
  showToast(`${message}（公开配置未同步）`, 'info', 5000)
}

const historyTitle = computed(() => {
  if (!historyKey.value) return t('adminConfig.history.title')
  const item = definitions.value.find((def) => def.key === historyKey.value)
  return item ? t('adminConfig.history.titleWithKey', { key: item.label }) : t('adminConfig.history.title')
})

const historyCurrentLabel = computed(() => {
  if (!historyKey.value) return ''
  const item = definitions.value.find((def) => def.key === historyKey.value)
  const label = item ? item.label : historyKey.value
  return t('adminConfig.history.currentLabel', { key: label, value: displayHistoryValue(historyCurrentValue.value) })
})

const canRollbackHistory = computed(() => historyRows.value.length > 0 && !historyRollingBack.value && !historyLoading.value)

function displayHistoryValue(raw: string): string {
  if (historySensitive.value) {
    return raw.trim() ? t('adminConfig.history.configured') : t('adminConfig.history.notConfigured')
  }
  return raw.trim() ? raw : t('adminConfig.history.emptyValue')
}

async function loadHistory(key: string) {
  historyLoading.value = true
  historyError.value = ''
  historyRows.value = []
  try {
    const res = await adminRequest<{
      key: string
      currentValue: string
      history: AdminSystemConfigHistoryRow[]
    }>(`${PLATFORM_SYSTEM_CONFIG_API}/history/${key}`)
    historyKey.value = res.key
    historyCurrentValue.value = res.currentValue || ''
    historySensitive.value = definitions.value.find((item) => item.key === key)?.sensitive ?? false
    historyRows.value = res.history || []
  } catch (err: any) {
    historyError.value = err.message || t('adminConfig.history.loadFailed')
    historyRows.value = []
  } finally {
    historyLoading.value = false
  }
}

async function openHistory(key: string) {
  historyKey.value = key
  historySensitive.value = definitions.value.find((item) => item.key === key)?.sensitive ?? false
  historyVisible.value = true
  await loadHistory(key)
}

async function reloadHistory() {
  if (!historyKey.value) return
  await loadHistory(historyKey.value)
}

async function rollbackHistory() {
  if (!historyKey.value || !canRollbackHistory.value) return
  const item = definitions.value.find((def) => def.key === historyKey.value)
  const label = item ? item.label : historyKey.value
  if (!(await askConfirm(t('adminConfig.history.rollbackConfirm', { key: label })))) return
  historyRollingBack.value = true
  try {
    await adminRequest<{ key: string; rolledBackTo: string }>(`${PLATFORM_SYSTEM_CONFIG_API}/rollback/${historyKey.value}`, {
      method: 'POST',
    })
    showToast(t('adminConfig.history.rollbackSuccess'), 'success')
    await loadData()
    await loadHistory(historyKey.value)
  } catch (err: any) {
    showToast(err.message || t('adminConfig.history.rollbackFailed'), 'error')
  } finally {
    historyRollingBack.value = false
  }
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await adminRequest<any>(PLATFORM_SYSTEM_CONFIG_API)
    Object.assign(config, res.config)
    definitions.value = res.definitions
    if (!testEmailTo.value.trim() && res.config.support_email) {
      testEmailTo.value = res.config.support_email
    }
  } catch (err: any) {
    definitions.value = []
    for (const key of Object.keys(config)) delete config[key]
    loadError.value = err.message || '加载失败'
    showToast(err.message || '加载失败', 'error')
  } finally {
    loading.value = false
  }
}

async function update(key: string, value: string) {
  fieldStatus[key] = 'saving'
  try {
    const res = await adminRequest<any>(PLATFORM_SYSTEM_CONFIG_API, {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    })
    config[key] = res.value
    const definition = definitions.value.find((item) => item.key === key)
    if (res.configured !== undefined && definition) {
      definition.configured = res.configured
    }
    fieldStatus[key] = 'saved'
    showToast('已保存', 'success')
  } catch (err: any) {
    fieldStatus[key] = 'error'
    showToast(err.message || '保存失败', 'error')
  }
}

async function sendTestEmail() {
  const to = testEmailTo.value.trim()
  if (!to) {
    showToast(t('adminConfig.emailTest.emailPlaceholder'), 'error')
    return
  }
  sendingTestEmail.value = true
  testEmailStatus.value = ''
  try {
    const res = await adminRequest<{ sent: boolean; resendId?: string }>(`${PLATFORM_SYSTEM_CONFIG_API}/email-test`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    })
    testEmailOk.value = true
    testEmailStatus.value = res.resendId
      ? t('adminConfig.emailTest.sentWithId', { id: res.resendId })
      : t('adminConfig.emailTest.sent')
    showToast(testEmailStatus.value, 'success')
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
  clearingBusinessData.value = true
  clearBusinessDataStatus.value = ''
  try {
    // 根据清理档位映射到后端允许的白名单目标
    // 后端 /api/platform/data/cleanup 仅支持白名单内的表名
    // 各档位含义见 i18n 描述：runtime=仅运行态日志, keep_trade=保留交易,
    // keep_catalog=保留商品, full=全清（保留系统配置/支付/分类/API Key/迁移）
    const profileTargets: Record<string, string[]> = {
      runtime: ['email_access_codes', 'rate_limit_log', 'audit_logs', 'platform_audit_logs', 'activity_events'],
      keep_trade: ['email_access_codes', 'rate_limit_log', 'audit_logs', 'platform_audit_logs', 'activity_events', 'webhook_deliveries'],
      keep_catalog: ['email_access_codes', 'rate_limit_log', 'audit_logs', 'platform_audit_logs', 'activity_events', 'webhook_deliveries'],
      full: ['email_access_codes', 'rate_limit_log', 'audit_logs', 'platform_audit_logs', 'activity_events', 'webhook_deliveries'],
    }
    const targets = profileTargets[clearProfile.value] ?? profileTargets.runtime
    const data = await adminRequest<{ results: Record<string, number> }>('/api/platform/data/cleanup', {
      method: 'POST',
      body: JSON.stringify({ targets }),
    })
    const parts = Object.entries(data.results).map(([k, v]) => `${k}: ${v}`)
    clearBusinessDataStatus.value = t('adminConfig.clearData.result', {
      profile: t(`adminConfig.clearProfiles.${clearProfile.value}.title`),
      deleted: parts.join('，'),
      auditId: '',
      strategy: 'none',
    })
    showToast(t('adminConfig.clearData.completed'), 'success')
  } catch (err: any) {
    clearBusinessDataStatus.value = err?.message || ''
    showToast(clearBusinessDataStatus.value || t('adminConfig.clearData.completed'), 'error')
  } finally {
    clearingBusinessData.value = false
  }
}

async function reset(key: string) {
  const def = definitions.value.find((d) => d.key === key)
  if (!def) return
  resetKey = key
  if (!(await askConfirm(t('adminConfig.resetConfirm', { key })))) return
  fieldStatus[key] = 'saving'
  try {
    const res = await adminRequest<any>(PLATFORM_SYSTEM_CONFIG_API, {
      method: 'PUT',
      body: JSON.stringify({ key: resetKey, value: def.defaultValue || '' }),
    })
    config[resetKey] = res.value
    const publicConfigSynced = await refreshPublicConfig(def.scope)
    if (res.configured !== undefined) {
      const definition = definitions.value.find((item) => item.key === resetKey)
      if (definition) definition.configured = res.configured
    }
    fieldStatus[key] = 'saved'
    showSavedStatus('已重置', publicConfigSynced)
  } catch (err: any) {
    fieldStatus[key] = 'error'
    showToast(err.message || t('adminConfig.resetFailed'), 'error')
  } finally {
    resetKey = null
  }
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

.config-history-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.config-history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  color: var(--tg-hint, #9aa4b2);
}

.config-history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52vh;
  overflow: auto;
  padding-right: 2px;
}

.config-history-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
}

.config-history-item-head,
.config-history-item-foot,
.config-history-item-body > div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  line-height: 1.45;
}

.config-history-item-head span,
.config-history-item-foot span,
.config-history-item-body span {
  color: var(--tg-hint, #9aa4b2);
}

.config-history-item-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
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

.config-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
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
