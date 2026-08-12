<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <span class="toolbar-title">{{ $t('adminPlatformTarget.title') }}</span>
        <select v-model="platformFilter" :aria-label="$t('adminPlatformTarget.filterAll')" @change="loadTargets">
          <option value="">{{ $t('adminPlatformTarget.filterAll') }}</option>
          <option v-for="p in SUPPORTED_PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="openCreateModal">
          {{ $t('adminPlatformTarget.addBinding') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadTargets">{{ $t('adminPlatformTarget.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadTargets">{{ $t('adminPlatformTarget.retry') }}</button>
    </div>

    <div class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminPlatformTarget.colName') }}</th>
            <th>{{ $t('adminPlatformTarget.colPlatform') }}</th>
            <th>{{ $t('adminPlatformTarget.colTargetId') }}</th>
            <th>{{ $t('adminPlatformTarget.colBotId') }}</th>
            <th>{{ $t('adminPlatformTarget.colActivity') }}</th>
            <th>{{ $t('adminPlatformTarget.colStatus') }}</th>
            <th class="col-actions">{{ $t('adminPlatformTarget.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="7"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else-if="filteredTargets.length === 0">
          <tr><td :colspan="7" class="empty-row">{{ $t('adminPlatformTarget.empty') }}</td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="t in filteredTargets" :key="t.id" :class="{ 'is-selected': selectedId === t.id }">
            <td>{{ t.targetName || '-' }}</td>
            <td><span class="tag tag-info">{{ t.platform }}</span></td>
            <td class="mono">{{ t.targetId }}</td>
            <td class="mono">{{ getBotId(t) }}</td>
            <td>
              <span v-if="t.activeDrawId" class="tag tag-info">{{ t.activeDrawId.slice(0, 8) }}…</span>
              <span v-else class="tag tag-muted">{{ $t('adminPlatformTarget.notBound') }}</span>
            </td>
            <td>
              <span
                class="tag pointer"
                :class="t.assistantEnabled ? 'tag-success' : 'tag-muted'"
                :title="t.assistantEnabled ? $t('adminPlatformTarget.enabled') : $t('adminPlatformTarget.disabled')"
                @click="toggleEnabled(t)"
              >{{ t.assistantEnabled ? $t('adminPlatformTarget.enabled') : $t('adminPlatformTarget.disabled') }}</span>
            </td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" :title="$t('adminPlatformTarget.edit')" @click="openEditModal(t)">{{ $t('adminPlatformTarget.edit') }}</button>
              <button class="btn btn-ghost btn-xs" :title="$t('adminPlatformTarget.testMessage')" @click="testMessage(t)" :disabled="testingId === t.id">{{ $t('adminPlatformTarget.testMessage') }}</button>
              <button v-if="t.platform === 'telegram'" class="btn btn-ghost btn-xs" :title="$t('adminPlatformTarget.registerWebhook')" @click="registerWebhook(t)" :disabled="registeringId === t.id">{{ $t('adminPlatformTarget.registerWebhook') }}</button>
              <button class="btn btn-ghost btn-xs" :title="$t('adminPlatformTarget.resetSecret')" @click="resetSecret(t)" :disabled="resettingId === t.id">{{ $t('adminPlatformTarget.resetSecret') }}</button>
              <button class="btn btn-danger btn-xs" :title="$t('adminPlatformTarget.delete')" @click="deleteTarget(t)">{{ $t('adminPlatformTarget.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
<!-- 创建 / 编辑弹窗：统一使用 cf-admin-fe 的 AdminModal 组件（不造轮子，样式与全后台一致） -->
    <AdminModal
      v-model="showModal"
      :title="editingTarget ? $t('adminPlatformTarget.editBinding') : $t('adminPlatformTarget.addBinding')"
      max-width="520px"
      hide-actions
    >
      <form @submit.prevent="saveTarget">
        <!-- 表单字段统一使用共享 admin-primitives 的 modal-form / label>span 结构（docs/199，不造轮子） -->
        <div class="modal-form">
        <label v-if="!editingTarget">
          <span>{{ $t('adminPlatformTarget.labelPlatform') }} <span class="required">*</span></span>
          <select v-model="form.platform">
            <option v-for="p in SUPPORTED_PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </label>
        <label>
          <span>{{ targetIdLabel }} <span class="required">*</span></span>
          <input v-model="form.targetId" :placeholder="targetIdPlaceholder" :disabled="!!editingTarget" />
        </label>
        <label>
          <span>{{ targetNameLabel }}</span>
          <input v-model="form.targetName" :placeholder="targetNamePlaceholder" />
        </label>
        <label>
          <span>{{ $t('adminPlatformTarget.labelActivity') }}</span>
          <select v-model="form.activeDrawId">
            <option value="">{{ $t('adminPlatformTarget.noActivity') }}</option>
            <option v-for="d in draws" :key="d.id" :value="d.id">{{ d.title }}</option>
          </select>
        </label>
            <!-- QQ 平台特定配置 -->
            <template v-if="form.platform === 'qq'">
            <label>
              <span>
                {{ $t('adminPlatformTarget.labelAdapterBaseUrl') }}
                <small v-if="editingTarget" class="field-hint">{{ $t('adminPlatformTarget.hintAdapterBaseUrlEdit') }}</small>
              </span>
              <small v-if="!editingTarget" class="field-hint">{{ $t('adminPlatformTarget.hintAdapterBaseUrl') }}</small>
              <input v-model="form.adapterBaseUrl" :placeholder="editingTarget ? $t('adminPlatformTarget.placeholderAdapterBaseUrlEdit') : $t('adminPlatformTarget.placeholderAdapterBaseUrl')" />
            </label>
            <label v-if="editingTarget">
              <span>{{ $t('adminPlatformTarget.labelNewInboundSecret') }}</span>
              <small class="field-hint">{{ $t('adminPlatformTarget.hintNewInboundSecret') }}</small>
              <input v-model="form.inboundSecret" autocomplete="new-password" :placeholder="$t('adminPlatformTarget.placeholderNewInboundSecret')" />
            </label>
            </template>
            <!-- Telegram 平台特定配置 -->
            <template v-if="form.platform === 'telegram'">
            <label>
              <span>{{ $t('adminPlatformTarget.labelBotToken') }} <span class="required">*</span></span>
              <small class="field-hint">{{ $t('adminPlatformTarget.hintBotToken') }}</small>
              <input v-model="form.botToken" :placeholder="$t('adminPlatformTarget.placeholderBotToken')" />
              <small v-if="editingTarget && !form.botToken" class="field-hint" style="color: #888; margin-top: 4px;">{{ $t('adminPlatformTarget.hintBotTokenKeep') }}</small>
            </label>
            </template>
            <fieldset class="form-fieldset">
              <legend>{{ $t('adminPlatformTarget.builtinCommands') }}</legend>
              <div class="checkbox-group">
                <label class="checkbox-label"><input type="checkbox" v-model="form.checkinEnabled" /> {{ $t('adminPlatformTarget.cmdCheckin') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.spinEnabled" /> {{ $t('adminPlatformTarget.cmdSpin') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.shareEnabled" /> {{ $t('adminPlatformTarget.cmdShare') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.leaderboardEnabled" /> {{ $t('adminPlatformTarget.cmdLeaderboard') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.myPrizeEnabled" /> {{ $t('adminPlatformTarget.cmdMyPrize') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.myCardCodeEnabled" /> {{ $t('adminPlatformTarget.cmdCardCode') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.helpEnabled" /> {{ $t('adminPlatformTarget.cmdHelp') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.flashEnabled" /> {{ $t('adminPlatformTarget.cmdFlash') }}</label>
              </div>
              <!-- 每日签到奖励（docs/172）：仅在启用 /签到 时显示。
                   支持两种方式：简单固定值（grantSpinCount）或完整奖励模式（mode+baseRange） -->
              <div v-if="form.checkinEnabled" class="form-group">
                <label>{{ $t('adminPlatformTarget.labelCheckinGrantSpin') }}</label>
                <small class="field-hint">{{ $t('adminPlatformTarget.hintCheckinGrantSpin') }}</small>
                <input v-model.number="form.grantSpinCount" type="number" min="0" max="100" step="1" />
              </div>
              <div v-if="form.checkinEnabled" class="form-group">
                <label>{{ $t('adminPlatformTarget.labelCheckinMode') }}</label>
                <small class="field-hint">{{ $t('adminPlatformTarget.hintCheckinMode') }}</small>
                <select v-model="form.checkinMode">
                  <option value="">—</option>
                  <option value="daily">{{ $t('adminPlatformTarget.optionModeDaily') }}</option>
                  <option value="linear">{{ $t('adminPlatformTarget.optionModeLinear') }}</option>
                  <option value="step">{{ $t('adminPlatformTarget.optionModeStep') }}</option>
                  <option value="cycle">{{ $t('adminPlatformTarget.optionModeCycle') }}</option>
                </select>
              </div>
              <template v-if="form.checkinEnabled && form.checkinMode">
                <div class="form-row">
                  <div class="form-group">
                    <label>{{ $t('adminPlatformTarget.labelBaseMin') }}</label>
                    <small class="field-hint">{{ $t('adminPlatformTarget.hintBaseMin') }}</small>
                    <input v-model.number="form.baseMin" type="number" min="0" max="100" step="1" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('adminPlatformTarget.labelBaseMax') }}</label>
                    <small class="field-hint">{{ $t('adminPlatformTarget.hintBaseMax') }}</small>
                    <input v-model.number="form.baseMax" type="number" min="0" max="100" step="1" />
                  </div>
                </div>
                <div v-if="form.checkinMode === 'linear' || form.checkinMode === 'step'" class="form-row">
                  <div class="form-group">
                    <label>{{ $t('adminPlatformTarget.labelIncrement') }}</label>
                    <small class="field-hint">{{ $t('adminPlatformTarget.hintIncrement') }}</small>
                    <input v-model.number="form.increment" type="number" min="0" max="100" step="1" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('adminPlatformTarget.labelCap') }}</label>
                    <small class="field-hint">{{ $t('adminPlatformTarget.hintCap') }}</small>
                    <input v-model.number="form.cap" type="number" min="0" max="100" step="1" />
                  </div>
                </div>
                <div v-if="form.checkinMode === 'step'" class="form-group">
                  <label>{{ $t('adminPlatformTarget.labelStepDays') }}</label>
                  <small class="field-hint">{{ $t('adminPlatformTarget.hintStepDays') }}</small>
                  <input v-model.number="form.stepDays" type="number" min="1" max="365" step="1" />
                </div>
                <div v-if="form.checkinMode === 'cycle'" class="form-row">
                  <div class="form-group">
                    <label>{{ $t('adminPlatformTarget.labelCycleDays') }}</label>
                    <small class="field-hint">{{ $t('adminPlatformTarget.hintCycleDays') }}</small>
                    <input v-model.number="form.cycleDays" type="number" min="1" max="365" step="1" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('adminPlatformTarget.labelCycleBonus') }}</label>
                    <small class="field-hint">{{ $t('adminPlatformTarget.hintCycleBonus') }}</small>
                    <input v-model.number="form.cycleBonus" type="number" min="0" max="100" step="1" />
                  </div>
                </div>
              </template>
              <!-- P2 randomBonus 随机签到事件（docs/175 §2.4）：在基础奖励之上小概率额外增加 spins -->
              <div v-if="form.checkinEnabled" class="form-group">
                <label>{{ $t('adminPlatformTarget.labelRandomBonus') }}</label>
                <small class="field-hint">{{ $t('adminPlatformTarget.hintRandomBonus') }}</small>
                <label class="checkbox-label">
                  <input type="checkbox" v-model="form.randomBonusEnabled" /> {{ $t('adminPlatformTarget.labelRandomBonusEnabled') }}
                </label>
              </div>
              <div v-if="form.checkinEnabled && form.randomBonusEnabled" class="form-row">
                <div class="form-group">
                  <label>{{ $t('adminPlatformTarget.labelRandomBonusProbability') }}</label>
                  <small class="field-hint">{{ $t('adminPlatformTarget.hintRandomBonusProbability') }}</small>
                  <input v-model.number="form.randomBonusProbability" type="number" min="0" max="1" step="0.05" />
                </div>
                <div class="form-group">
                  <label>{{ $t('adminPlatformTarget.labelRandomBonusMin') }}</label>
                  <small class="field-hint">{{ $t('adminPlatformTarget.hintRandomBonusMin') }}</small>
                  <input v-model.number="form.randomBonusMin" type="number" min="0" max="100" step="1" />
                </div>
                <div class="form-group">
                  <label>{{ $t('adminPlatformTarget.labelRandomBonusMax') }}</label>
                  <small class="field-hint">{{ $t('adminPlatformTarget.hintRandomBonusMax') }}</small>
                  <input v-model.number="form.randomBonusMax" type="number" min="0" max="100" step="1" />
                </div>
              </div>
              <!-- 购买引导（docs/171 §断层B）：配置 /秒杀 返回的购买链接；次数耗尽时也会自动附加引导 -->
              <div class="form-group">
                <label>{{ $t('adminPlatformTarget.labelPurchaseUrl') }}</label>
                <small class="field-hint">{{ $t('adminPlatformTarget.hintPurchaseUrl') }}</small>
                <input v-model="form.purchaseUrl" :placeholder="$t('adminPlatformTarget.placeholderPurchaseUrl')" />
              </div>
              <div class="form-group">
                <label>{{ $t('adminPlatformTarget.labelPurchaseLabel') }}</label>
                <small class="field-hint">{{ $t('adminPlatformTarget.hintPurchaseLabel') }}</small>
                <input v-model="form.purchaseLabel" :placeholder="$t('adminPlatformTarget.placeholderPurchaseLabel')" />
              </div>
            </fieldset>
      </div></form>
      <div v-if="inboundSecret" class="secret-box">
        <p class="secret-label">{{ $t('adminPlatformTarget.inboundSecretLabel') }}</p>
        <div class="secret-value">{{ inboundSecret }}</div>
        <p class="secret-hint">{{ $t('adminPlatformTarget.inboundSecretHint') }}</p>
        <pre class="config-value">{{ platformInboundConfig }}</pre>
        <div class="secret-actions">
          <button class="btn btn-ghost btn-xs" type="button" @click="copyWebhookUrl">{{ $t('adminPlatformTarget.copyWebhookUrl') }}</button>
          <button class="btn btn-ghost btn-xs" type="button" @click="copyInboundConfig">{{ $t('adminPlatformTarget.copyConfig') }}</button>
        </div>
      </div>
      <template #actions>
        <button class="btn btn-ghost" @click="closeModal" type="button">{{ $t('adminPlatformTarget.cancel') }}</button>
        <button class="btn btn-primary" :disabled="saving" @click="saveTarget">{{ $t('adminPlatformTarget.save') }}</button>
      </template>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" danger @confirm="handleConfirmDialogConfirm" />
  </div>
</template>
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { useToast, useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

function handleConfirmDialogConfirm() {
  onConfirm()
}

interface PlatformTarget {
  id: string
  tenantId: string
  platform: string
  targetId: string
  targetName: string
  activeDrawId: string
  assistantEnabled: number
  builtinCommandsJson: string
  /** 适配器配置（如 NapCat baseUrl、公证人 botId），docs/177 批次2 */
  adapterConfigJson: string
}

interface Draw {
  id: string
  title: string
  status: string
}

const SUPPORTED_PLATFORMS = [
  { value: 'qq', label: 'QQ' },
  { value: 'telegram', label: 'Telegram' },
] as const

const loading = ref(false)
const loadError = ref('')
const targets = ref<PlatformTarget[]>([])
const platformFilter = ref('')
/** 根据当前选择的平台返回目标 ID 的标签（QQ 群号 / Telegram 群组 ID） */
const targetIdLabel = computed(() => {
  if (form.value.platform === 'telegram') return t('adminPlatformTarget.labelTelegramTargetId')
  return t('adminPlatformTarget.labelGroupId')
})
/** 根据当前选择的平台返回目标 ID 的占位符 */
const targetIdPlaceholder = computed(() => {
  if (form.value.platform === 'telegram') return t('adminPlatformTarget.placeholderTelegramTargetId')
  return t('adminPlatformTarget.placeholderGroupId')
})
/** 根据当前选择的平台返回目标名称的标签 */
const targetNameLabel = computed(() => {
  if (form.value.platform === 'telegram') return t('adminPlatformTarget.labelTelegramTargetName')
  return t('adminPlatformTarget.labelGroupName')
})
/** 根据当前选择的平台返回目标名称的占位符 */
const targetNamePlaceholder = computed(() => {
  if (form.value.platform === 'telegram') return t('adminPlatformTarget.placeholderTelegramTargetName')
  return t('adminPlatformTarget.placeholderGroupName')
})

const filteredTargets = computed(() => {
  if (!platformFilter.value) return targets.value
  return targets.value.filter(t => t.platform === platformFilter.value)
})
const draws = ref<Draw[]>([])
const selectedId = ref('')
const resettingId = ref('')
const testingId = ref('')
const registeringId = ref('')
const saving = ref(false)
const showModal = ref(false)
const editingTarget = ref<PlatformTarget | null>(null)
const inboundSecret = ref('')

const form = ref({
  platform: 'qq',
  targetId: '',
  targetName: '',
  activeDrawId: '',
  adapterBaseUrl: '',
  inboundSecret: '',
  botToken: '',
  checkinEnabled: true,
  spinEnabled: true,
  shareEnabled: true,
  leaderboardEnabled: true,
  myPrizeEnabled: true,
  myCardCodeEnabled: true,
  helpEnabled: true,
  /** 每日签到奖励抽奖次数（docs/171）：0 表示不奖励，整数 1+ 则在 /签到 时增加 spinsLeft */
  grantSpinCount: 0,
  /** 签到奖励模式（docs/172）：''=不启用（仅 grantSpinCount），daily/linear/step/cycle */
  checkinMode: '',
  /** 基础奖励区间（所有模式通用） */
  baseMin: 1,
  baseMax: 1,
  /** 每日递增量（linear/step 模式） */
  increment: 1,
  /** 封顶值（递增模式） */
  cap: 10,
  /** 阶梯天数（step 模式） */
  stepDays: 7,
  /** 周期天数（cycle 模式） */
  cycleDays: 7,
  /** 周期额外奖励（cycle 模式） */
  cycleBonus: 5,
  /** P2 randomBonus 随机签到事件（docs/175 §2.4）：在基础奖励之上小概率额外增加 spins */
  randomBonusEnabled: false,
  randomBonusProbability: 0.2,
  randomBonusMin: 1,
  randomBonusMax: 3,
  /** /秒杀 命令开关（docs/171 §断层B）：群内用户可调用 /秒杀 获取购买链接 */
  flashEnabled: true,
  /** 购买链接 URL（公开活动页 URL），为空则 /秒杀 提示未配置 */
  purchaseUrl: '',
  /** 购买链接展示文案，为空时后端默认使用「立即购买」 */
  purchaseLabel: '',
})

const platformInboundConfig = computed(() => {
  const platform = form.value.platform
  const callbackUrl = getCallbackUrl(platform)
  if (platform === 'qq') {
    return [
      `HTTP 上报地址: ${callbackUrl}`,
      `请求头 Authorization: Bearer ${inboundSecret.value}`,
      `请求头 X-CF-Lottery-Platform-Token: ${inboundSecret.value}`,
    ].join('\n')
  }
  if (platform === 'telegram') {
    return [
      `Webhook URL: ${callbackUrl}`,
      `Bot Token 已加密存储，无需额外配置。`,
    ].join('\n')
  }
  return callbackUrl
})

function getCallbackUrl(platform: string): string {
  const origin = window.location.origin
  const paths: Record<string, string> = {
    qq: `${origin}/api/platform/qq/message`,
    telegram: `${origin}/api/platform/telegram/message`,
  }
  return paths[platform] || `${origin}/api/platform/${platform}/message`
}

async function api<T = Record<string, unknown>>(path: string, options?: RequestInit) {
  return adminRequest<T>(`/api/admin${path}`, options)
}

async function loadTargets() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await api<{ items: PlatformTarget[] }>('/platform-targets')
    targets.value = (data.items as PlatformTarget[]) || []
  } catch (err) {
    loadError.value = String(err instanceof Error ? err.message : err)
  } finally {
    loading.value = false
  }
}

async function loadDraws() {
  try {
    const data = await api<{ draws: Draw[] }>('/draws?limit=200')
    draws.value = data.draws || []
  } catch { /* 活动列表加载失败不影响主功能 */ }
}

function resetForm() {
  form.value = {
    platform: 'qq',
    targetId: '', targetName: '', activeDrawId: '', adapterBaseUrl: '', inboundSecret: '', botToken: '',
    checkinEnabled: true, spinEnabled: true, shareEnabled: true,
    leaderboardEnabled: true, myPrizeEnabled: true, myCardCodeEnabled: true, helpEnabled: true,
    // 签到奖励抽奖次数（docs/171）：重置时默认 0（不奖励），与 form 初始值保持一致
    grantSpinCount: 0,
    // 签到奖励模式（docs/172）：重置时默认不启用，保留旧字段 grantSpinCount
    checkinMode: '',
    baseMin: 1, baseMax: 1,
    increment: 1, cap: 10,
    stepDays: 7, cycleDays: 7, cycleBonus: 5,
    // P2 randomBonus 随机签到事件（docs/175 §2.4）：重置时默认不启用
    randomBonusEnabled: false,
    randomBonusProbability: 0.2,
    randomBonusMin: 1,
    randomBonusMax: 3,
    // /秒杀 命令开关 + 购买链接（docs/171 §断层B）：重置时默认开启但无链接
    flashEnabled: true,
    purchaseUrl: '',
    purchaseLabel: '',
  }
  inboundSecret.value = ''
  editingTarget.value = null
}

function fillFormFromTarget(t: PlatformTarget) {
  editingTarget.value = t
  form.value.targetId = t.targetId
  form.value.targetName = t.targetName
  form.value.activeDrawId = t.activeDrawId
  form.value.inboundSecret = ''
  // 编辑时不能修改平台类型
  form.value.platform = t.platform
  try {
    const cmds = JSON.parse(t.builtinCommandsJson || '{}')
    form.value.checkinEnabled = cmds.checkinEnabled !== false
    form.value.spinEnabled = cmds.spinEnabled !== false
    form.value.shareEnabled = cmds.shareEnabled !== false
    form.value.leaderboardEnabled = cmds.leaderboardEnabled !== false
    form.value.myPrizeEnabled = cmds.myPrizeEnabled !== false
    form.value.myCardCodeEnabled = cmds.myCardCodeEnabled !== false
    form.value.helpEnabled = cmds.helpEnabled !== false
    // 签到奖励（docs/172）：解析 rewardConfig 和 grantSpinCount
    form.value.grantSpinCount = cmds.dailyCheckinPolicy?.grantSpinCount || 0
    const rc = cmds.dailyCheckinPolicy?.rewardConfig
    if (rc && rc.mode) {
      form.value.checkinMode = rc.mode
      form.value.baseMin = rc.baseRange?.min ?? 1
      form.value.baseMax = rc.baseRange?.max ?? 1
      form.value.increment = rc.increment ?? 1
      form.value.cap = rc.cap ?? 10
      form.value.stepDays = rc.stepDays ?? 7
      form.value.cycleDays = rc.cycleDays ?? 7
      form.value.cycleBonus = rc.cycleBonus ?? 5
    } else {
      form.value.checkinMode = ''
      form.value.baseMin = 1; form.value.baseMax = 1
      form.value.increment = 1; form.value.cap = 10
      form.value.stepDays = 7; form.value.cycleDays = 7; form.value.cycleBonus = 5
    }
    // P2 randomBonus 随机签到事件（docs/175 §2.4）：回填随机奖励配置
    form.value.randomBonusEnabled = cmds.dailyCheckinPolicy?.randomBonus?.enabled ?? false
    form.value.randomBonusProbability = cmds.dailyCheckinPolicy?.randomBonus?.probability ?? 0.2
    form.value.randomBonusMin = cmds.dailyCheckinPolicy?.randomBonus?.bonusRange?.min ?? 1
    form.value.randomBonusMax = cmds.dailyCheckinPolicy?.randomBonus?.bonusRange?.max ?? 3
    // 购买引导（docs/171 §断层B）：回填 /秒杀 开关 + 购买链接
    form.value.flashEnabled = cmds.flashEnabled !== false
    form.value.purchaseUrl = cmds.purchaseConfig?.url || ''
    form.value.purchaseLabel = cmds.purchaseConfig?.label || ''
  } catch { /* 使用默认值 */ }
}

function openCreateModal() {
  resetForm()
  showModal.value = true
  void loadDraws()
}

function openEditModal(t: PlatformTarget) {
  resetForm()
  fillFormFromTarget(t)
  showModal.value = true
  void loadDraws()
}

function closeModal() { showModal.value = false }

async function saveTarget() {
  saving.value = true
  try {
    const purchaseUrl = form.value.purchaseUrl.trim()
    // 构建 dailyCheckinPolicy（docs/172）：两种模式
    // 1. 有 checkinMode: 构建完整 rewardConfig
    // 2. 无 checkinMode: 使用旧字段 grantSpinCount
    const dailyCheckinPolicy: Record<string, unknown> = {}
    if (form.value.checkinMode) {
      dailyCheckinPolicy.rewardConfig = {
        mode: form.value.checkinMode,
        baseRange: { min: form.value.baseMin, max: form.value.baseMax },
      }
      if (form.value.checkinMode === 'linear' || form.value.checkinMode === 'step') {
        if (form.value.increment > 0) (dailyCheckinPolicy.rewardConfig as Record<string, unknown>).increment = form.value.increment
        if (form.value.cap > 0) (dailyCheckinPolicy.rewardConfig as Record<string, unknown>).cap = form.value.cap
      }
      if (form.value.checkinMode === 'step' && form.value.stepDays > 0) {
        (dailyCheckinPolicy.rewardConfig as Record<string, unknown>).stepDays = form.value.stepDays
      }
      if (form.value.checkinMode === 'cycle') {
        if (form.value.cycleDays > 0) (dailyCheckinPolicy.rewardConfig as Record<string, unknown>).cycleDays = form.value.cycleDays
        if (form.value.cycleBonus > 0) (dailyCheckinPolicy.rewardConfig as Record<string, unknown>).cycleBonus = form.value.cycleBonus
      }
    } else if (form.value.grantSpinCount > 0) {
      dailyCheckinPolicy.grantSpinCount = form.value.grantSpinCount
    }
    // P2 randomBonus 随机签到事件（docs/175 §2.4）：与 rewardConfig/grantSpinCount 独立叠加
    if (form.value.randomBonusEnabled) {
      dailyCheckinPolicy.randomBonus = {
        enabled: true,
        probability: form.value.randomBonusProbability,
        bonusRange: { min: form.value.randomBonusMin, max: form.value.randomBonusMax },
      }
    }
    const builtinCommands = {
      checkinEnabled: form.value.checkinEnabled,
      spinEnabled: form.value.spinEnabled,
      shareEnabled: form.value.shareEnabled,
      leaderboardEnabled: form.value.leaderboardEnabled,
      myPrizeEnabled: form.value.myPrizeEnabled,
      myCardCodeEnabled: form.value.myCardCodeEnabled,
      helpEnabled: form.value.helpEnabled,
      /** 秒杀/购买命令开关（docs/171 §断层B）：后端默认 true */
      flashEnabled: form.value.flashEnabled,
      /** 签到奖励配置（docs/172）：有 rewardConfig 或 grantSpinCount 时发送 */
      ...(Object.keys(dailyCheckinPolicy).length > 0 ? { dailyCheckinPolicy } : {}),
      /** 购买链接配置（docs/171 §断层B）：有 url 时发送，后端省略空值 */
      ...(purchaseUrl
        ? { purchaseConfig: { url: purchaseUrl, label: form.value.purchaseLabel.trim() || '' } }
        : {}),
    }
    if (editingTarget.value) {
      /* 编辑时：baseUrl 留空则不更新 adapterConfig，填写则覆盖（botId 为入站自动写入的只读字段，不可编辑） */
      const editPayload: Record<string, unknown> = {
        targetName: form.value.targetName,
        activeDrawId: form.value.activeDrawId,
        builtinCommands,
      }
      const editAdapterConfig: Record<string, string> = {}
      const baseUrl = form.value.adapterBaseUrl.trim()
      if (baseUrl) editAdapterConfig.baseUrl = baseUrl
      // Telegram 平台：编辑时允许更新 botToken
      if (form.value.platform === 'telegram') {
        const token = form.value.botToken.trim()
        if (token) editAdapterConfig.botToken = token
      }
      if (Object.keys(editAdapterConfig).length > 0) editPayload.adapterConfig = editAdapterConfig
      const newInboundSecret = form.value.inboundSecret.trim()
      if (newInboundSecret) editPayload.inboundSecret = newInboundSecret
      await api(`/platform-targets/${editingTarget.value.id}`, {
        method: 'PUT',
        body: JSON.stringify(editPayload),
      })
      showToast(t('adminPlatformTarget.toastUpdated'), 'success')
    } else {
      const adapterConfig: Record<string, string> = {}
      const baseUrl = form.value.adapterBaseUrl.trim()
      if (baseUrl) adapterConfig.baseUrl = baseUrl
      // Telegram 平台：传递 botToken
      if (form.value.platform === 'telegram') {
        const token = form.value.botToken.trim()
        if (token) adapterConfig.botToken = token
      }
      const data = await api<{ inboundSecret?: string }>('/platform-targets', {
        method: 'POST',
        body: JSON.stringify({
          platform: form.value.platform,
          targetId: form.value.targetId,
          targetName: form.value.targetName,
          activeDrawId: form.value.activeDrawId,
          adapterConfig, ...builtinCommands,
        }),
      })
      inboundSecret.value = String(data.inboundSecret || '')
      showToast(t('adminPlatformTarget.toastCreated'), 'success')
    }
    if (!inboundSecret.value) closeModal()
    await loadTargets()
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { saving.value = false }
}
async function deleteTarget(target: PlatformTarget) {
  // 统一使用 ConfirmDialog 组件（与全后台一致），替代原生 confirm()
  if (!(await askConfirm(t('adminPlatformTarget.confirmDelete', { name: target.targetName || target.targetId })))) return
  try {
    await api(`/platform-targets/${target.id}`, { method: 'DELETE' })
    showToast(t('adminPlatformTarget.toastDeleted'), 'success')
    await loadTargets()
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

async function toggleEnabled(target: PlatformTarget) {
  try {
    await api(`/platform-targets/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify({ assistantEnabled: !target.assistantEnabled }),
    })
    target.assistantEnabled = target.assistantEnabled ? 0 : 1
    showToast(t('adminPlatformTarget.toastToggled'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

async function resetSecret(target: PlatformTarget) {
  resettingId.value = target.id
  try {
    const data = await api<{ inboundSecret?: string }>(`/platform-targets/${target.id}/reset-secret`, { method: 'POST' })
    inboundSecret.value = String(data.inboundSecret || '')
    fillFormFromTarget(target)
    showModal.value = true
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { resettingId.value = '' }
}

async function testMessage(target: PlatformTarget) {
  testingId.value = target.id
  try {
    await api(`/platform-targets/${target.id}/test-message`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    showToast(t('adminPlatformTarget.toastTestSent'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { testingId.value = '' }
}

async function registerWebhook(target: PlatformTarget) {
  registeringId.value = target.id
  try {
    await api(`/platform-targets/${target.id}/register-telegram-webhook`, {
      method: 'POST',
      body: JSON.stringify({ webhookOrigin: window.location.origin }),
    })
    showToast(t('adminPlatformTarget.toastWebhookRegistered'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { registeringId.value = '' }
}

async function copyInboundConfig() {
  try {
    await navigator.clipboard.writeText(platformInboundConfig.value)
    showToast(t('adminPlatformTarget.toastCopied'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

/** 仅复制 webhook URL（docs/177 批次2），不包含密钥等敏感信息 */
async function copyWebhookUrl() {
  const callbackUrl = `${window.location.origin}/api/platform/qq/message`
  try {
    await navigator.clipboard.writeText(callbackUrl)
    showToast(t('adminPlatformTarget.toastCopiedWebhook'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

/** 从目标的 adapterConfigJson 中提取平台特有标识（QQ 公证人号 / Telegram 等信息） */
function getBotId(t: PlatformTarget): string {
  try {
    const cfg = JSON.parse(t.adapterConfigJson || '{}')
    if (t.platform === 'qq') return cfg.botId || '-'
    if (t.platform === 'telegram') return cfg.botName || '—'
    return '-'
  } catch { return '-' }
}

onMounted(() => { void loadTargets() })
</script>

<style scoped>
.mono { font-family: monospace; font-size: 13px; }
.empty-row { text-align: center; color: #666; padding: 32px 16px; }
.pointer { cursor: pointer; }
/* 表单字段间距（本页 fieldset 内部的多字段布局需要，非重复造轮子的控件样式） */
.form-group { margin-bottom: 12px; }
.form-fieldset { border: 1px solid var(--border, #333); border-radius: 6px; padding: 8px 12px; margin-top: 8px; }
.form-fieldset legend { font-size: 12px; font-weight: 600; padding: 0 4px; color: #999; }
.checkbox-group { display: flex; flex-wrap: wrap; gap: 8px; }
.checkbox-label { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
.secret-box { background: #1a2a1a; border: 1px solid #2a4a2a; border-radius: 6px; padding: 12px; margin: 8px 0; }
.secret-label { font-size: 12px; color: #4caf50; font-weight: 600; margin-bottom: 4px; }
.secret-value { font-family: monospace; font-size: 14px; padding: 8px; background: #0a1a0a; border-radius: 4px; word-break: break-all; user-select: all; }
.secret-hint { font-size: 11px; color: #888; margin-top: 4px; }
.required { color: #e53935; }
	</style>
