<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <span class="toolbar-title">{{ $t('adminQqAssistant.title') }}</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="openCreateModal">
          {{ $t('adminQqAssistant.addBinding') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadTargets">{{ $t('adminQqAssistant.refresh') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadTargets">{{ $t('adminQqAssistant.retry') }}</button>
    </div>

    <div class="table-wrap" :aria-busy="loading">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ $t('adminQqAssistant.colGroup') }}</th>
            <th>{{ $t('adminQqAssistant.colGroupId') }}</th>
            <th>{{ $t('adminQqAssistant.colBotId') }}</th>
            <th>{{ $t('adminQqAssistant.colActivity') }}</th>
            <th>{{ $t('adminQqAssistant.colStatus') }}</th>
            <th class="col-actions">{{ $t('adminQqAssistant.colActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row"><td :colspan="6"><div class="skeleton-cell" /></td></tr>
        </tbody>
        <tbody v-else-if="targets.length === 0">
          <tr><td :colspan="6" class="empty-row">{{ $t('adminQqAssistant.empty') }}</td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="t in targets" :key="t.id" :class="{ 'is-selected': selectedId === t.id }">
            <td>{{ t.targetName || '-' }}</td>
            <td class="mono">{{ t.targetId }}</td>
            <td class="mono">{{ getBotId(t) }}</td>
            <td>
              <span v-if="t.activeDrawId" class="tag tag-info">{{ t.activeDrawId.slice(0, 8) }}…</span>
              <span v-else class="tag tag-muted">{{ $t('adminQqAssistant.notBound') }}</span>
            </td>
            <td>
              <span
                class="tag pointer"
                :class="t.assistantEnabled ? 'tag-success' : 'tag-muted'"
                :title="t.assistantEnabled ? $t('adminQqAssistant.enabled') : $t('adminQqAssistant.disabled')"
                @click="toggleEnabled(t)"
              >{{ t.assistantEnabled ? $t('adminQqAssistant.enabled') : $t('adminQqAssistant.disabled') }}</span>
            </td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" :title="$t('adminQqAssistant.edit')" @click="openEditModal(t)">{{ $t('adminQqAssistant.edit') }}</button>
              <button class="btn btn-ghost btn-xs" :title="$t('adminQqAssistant.testMessage')" @click="testMessage(t)" :disabled="testingId === t.id">{{ $t('adminQqAssistant.testMessage') }}</button>
              <button class="btn btn-ghost btn-xs" :title="$t('adminQqAssistant.resetSecret')" @click="resetSecret(t)" :disabled="resettingId === t.id">{{ $t('adminQqAssistant.resetSecret') }}</button>
              <button class="btn btn-danger btn-xs" :title="$t('adminQqAssistant.delete')" @click="deleteTarget(t)">{{ $t('adminQqAssistant.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
<!-- 创建 / 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-overlay" @click.self="closeModal">
        <div class="modal-content qq-assistant-modal">
          <div class="modal-header">
            <h3>{{ editingTarget ? $t('adminQqAssistant.editBinding') : $t('adminQqAssistant.addBinding') }}</h3>
            <button class="btn btn-ghost btn-sm" @click="closeModal" type="button" :aria-label="$t('adminQqAssistant.close')">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelGroupId') }} <span class="required">*</span></label>
              <input v-model="form.targetId" class="form-input" :placeholder="$t('adminQqAssistant.placeholderGroupId')" :disabled="!!editingTarget" />
            </div>
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelGroupName') }}</label>
              <input v-model="form.targetName" class="form-input" :placeholder="$t('adminQqAssistant.placeholderGroupName')" />
            </div>
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelActivity') }}</label>
              <select v-model="form.activeDrawId" class="form-select">
                <option value="">{{ $t('adminQqAssistant.noActivity') }}</option>
                <option v-for="d in draws" :key="d.id" :value="d.id">{{ d.title }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>
                {{ $t('adminQqAssistant.labelAdapterBaseUrl') }}
                <span v-if="editingTarget" class="form-hint">{{ $t('adminQqAssistant.hintAdapterBaseUrlEdit') }}</span>
              </label>
              <div v-if="!editingTarget" class="form-hint">{{ $t('adminQqAssistant.hintAdapterBaseUrl') }}</div>
              <input v-model="form.adapterBaseUrl" class="form-input" :placeholder="editingTarget ? $t('adminQqAssistant.placeholderAdapterBaseUrlEdit') : $t('adminQqAssistant.placeholderAdapterBaseUrl')" />
            </div>
            <div class="form-group">
              <label>{{ $t('adminQqAssistant.labelBotId') }}</label>
              <div class="form-hint">{{ $t('adminQqAssistant.hintBotId') }}</div>
              <input v-model="form.botId" class="form-input" :placeholder="$t('adminQqAssistant.placeholderBotId')" />
            </div>
            <div v-if="editingTarget" class="form-group">
              <label>{{ $t('adminQqAssistant.labelNewInboundSecret') }}</label>
              <div class="form-hint">{{ $t('adminQqAssistant.hintNewInboundSecret') }}</div>
              <input v-model="form.inboundSecret" class="form-input" autocomplete="new-password" :placeholder="$t('adminQqAssistant.placeholderNewInboundSecret')" />
            </div>
            <fieldset class="form-fieldset">
              <legend>{{ $t('adminQqAssistant.builtinCommands') }}</legend>
              <div class="checkbox-group">
                <label class="checkbox-label"><input type="checkbox" v-model="form.checkinEnabled" /> {{ $t('adminQqAssistant.cmdCheckin') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.spinEnabled" /> {{ $t('adminQqAssistant.cmdSpin') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.shareEnabled" /> {{ $t('adminQqAssistant.cmdShare') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.leaderboardEnabled" /> {{ $t('adminQqAssistant.cmdLeaderboard') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.myPrizeEnabled" /> {{ $t('adminQqAssistant.cmdMyPrize') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.myCardCodeEnabled" /> {{ $t('adminQqAssistant.cmdCardCode') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.helpEnabled" /> {{ $t('adminQqAssistant.cmdHelp') }}</label>
                <label class="checkbox-label"><input type="checkbox" v-model="form.flashEnabled" /> {{ $t('adminQqAssistant.cmdFlash') }}</label>
              </div>
              <!-- 每日签到奖励（docs/172）：仅在启用 /签到 时显示。
                   支持两种方式：简单固定值（grantSpinCount）或完整奖励模式（mode+baseRange） -->
              <div v-if="form.checkinEnabled" class="form-group">
                <label>{{ $t('adminQqAssistant.labelCheckinGrantSpin') }}</label>
                <div class="form-hint">{{ $t('adminQqAssistant.hintCheckinGrantSpin') }}</div>
                <input v-model.number="form.grantSpinCount" type="number" min="0" max="100" step="1" class="form-input" />
              </div>
              <div v-if="form.checkinEnabled" class="form-group">
                <label>{{ $t('adminQqAssistant.labelCheckinMode') }}</label>
                <div class="form-hint">{{ $t('adminQqAssistant.hintCheckinMode') }}</div>
                <select v-model="form.checkinMode" class="form-input">
                  <option value="">—</option>
                  <option value="daily">{{ $t('adminQqAssistant.optionModeDaily') }}</option>
                  <option value="linear">{{ $t('adminQqAssistant.optionModeLinear') }}</option>
                  <option value="step">{{ $t('adminQqAssistant.optionModeStep') }}</option>
                  <option value="cycle">{{ $t('adminQqAssistant.optionModeCycle') }}</option>
                </select>
              </div>
              <template v-if="form.checkinEnabled && form.checkinMode">
                <div class="form-row">
                  <div class="form-group">
                    <label>{{ $t('adminQqAssistant.labelBaseMin') }}</label>
                    <div class="form-hint">{{ $t('adminQqAssistant.hintBaseMin') }}</div>
                    <input v-model.number="form.baseMin" type="number" min="0" max="100" step="1" class="form-input" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('adminQqAssistant.labelBaseMax') }}</label>
                    <div class="form-hint">{{ $t('adminQqAssistant.hintBaseMax') }}</div>
                    <input v-model.number="form.baseMax" type="number" min="0" max="100" step="1" class="form-input" />
                  </div>
                </div>
                <div v-if="form.checkinMode === 'linear' || form.checkinMode === 'step'" class="form-row">
                  <div class="form-group">
                    <label>{{ $t('adminQqAssistant.labelIncrement') }}</label>
                    <div class="form-hint">{{ $t('adminQqAssistant.hintIncrement') }}</div>
                    <input v-model.number="form.increment" type="number" min="0" max="100" step="1" class="form-input" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('adminQqAssistant.labelCap') }}</label>
                    <div class="form-hint">{{ $t('adminQqAssistant.hintCap') }}</div>
                    <input v-model.number="form.cap" type="number" min="0" max="100" step="1" class="form-input" />
                  </div>
                </div>
                <div v-if="form.checkinMode === 'step'" class="form-group">
                  <label>{{ $t('adminQqAssistant.labelStepDays') }}</label>
                  <div class="form-hint">{{ $t('adminQqAssistant.hintStepDays') }}</div>
                  <input v-model.number="form.stepDays" type="number" min="1" max="365" step="1" class="form-input" />
                </div>
                <div v-if="form.checkinMode === 'cycle'" class="form-row">
                  <div class="form-group">
                    <label>{{ $t('adminQqAssistant.labelCycleDays') }}</label>
                    <div class="form-hint">{{ $t('adminQqAssistant.hintCycleDays') }}</div>
                    <input v-model.number="form.cycleDays" type="number" min="1" max="365" step="1" class="form-input" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('adminQqAssistant.labelCycleBonus') }}</label>
                    <div class="form-hint">{{ $t('adminQqAssistant.hintCycleBonus') }}</div>
                    <input v-model.number="form.cycleBonus" type="number" min="0" max="100" step="1" class="form-input" />
                  </div>
                </div>
              </template>
              <!-- P2 randomBonus 随机签到事件（docs/175 §2.4）：在基础奖励之上小概率额外增加 spins -->
              <div v-if="form.checkinEnabled" class="form-group">
                <label>{{ $t('adminQqAssistant.labelRandomBonus') }}</label>
                <div class="form-hint">{{ $t('adminQqAssistant.hintRandomBonus') }}</div>
                <label class="checkbox-label">
                  <input type="checkbox" v-model="form.randomBonusEnabled" /> {{ $t('adminQqAssistant.labelRandomBonusEnabled') }}
                </label>
              </div>
              <div v-if="form.checkinEnabled && form.randomBonusEnabled" class="form-row">
                <div class="form-group">
                  <label>{{ $t('adminQqAssistant.labelRandomBonusProbability') }}</label>
                  <div class="form-hint">{{ $t('adminQqAssistant.hintRandomBonusProbability') }}</div>
                  <input v-model.number="form.randomBonusProbability" type="number" min="0" max="1" step="0.05" class="form-input" />
                </div>
                <div class="form-group">
                  <label>{{ $t('adminQqAssistant.labelRandomBonusMin') }}</label>
                  <div class="form-hint">{{ $t('adminQqAssistant.hintRandomBonusMin') }}</div>
                  <input v-model.number="form.randomBonusMin" type="number" min="0" max="100" step="1" class="form-input" />
                </div>
                <div class="form-group">
                  <label>{{ $t('adminQqAssistant.labelRandomBonusMax') }}</label>
                  <div class="form-hint">{{ $t('adminQqAssistant.hintRandomBonusMax') }}</div>
                  <input v-model.number="form.randomBonusMax" type="number" min="0" max="100" step="1" class="form-input" />
                </div>
              </div>
              <!-- 购买引导（docs/171 §断层B）：配置 /秒杀 返回的购买链接；次数耗尽时也会自动附加引导 -->
              <div class="form-group">
                <label>{{ $t('adminQqAssistant.labelPurchaseUrl') }}</label>
                <div class="form-hint">{{ $t('adminQqAssistant.hintPurchaseUrl') }}</div>
                <input v-model="form.purchaseUrl" class="form-input" :placeholder="$t('adminQqAssistant.placeholderPurchaseUrl')" />
              </div>
              <div class="form-group">
                <label>{{ $t('adminQqAssistant.labelPurchaseLabel') }}</label>
                <div class="form-hint">{{ $t('adminQqAssistant.hintPurchaseLabel') }}</div>
                <input v-model="form.purchaseLabel" class="form-input" :placeholder="$t('adminQqAssistant.placeholderPurchaseLabel')" />
              </div>
            </fieldset>
          </div>
          <div v-if="inboundSecret" class="modal-body secret-box">
            <p class="secret-label">{{ $t('adminQqAssistant.inboundSecretLabel') }}</p>
            <div class="secret-value">{{ inboundSecret }}</div>
            <p class="secret-hint">{{ $t('adminQqAssistant.inboundSecretHint') }}</p>
            <pre class="config-value">{{ napcatInboundConfig }}</pre>
            <div class="secret-actions">
              <button class="btn btn-ghost btn-xs" type="button" @click="copyWebhookUrl">{{ $t('adminQqAssistant.copyWebhookUrl') }}</button>
              <button class="btn btn-ghost btn-xs" type="button" @click="copyInboundConfig">{{ $t('adminQqAssistant.copyConfig') }}</button>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="closeModal" type="button">{{ $t('adminQqAssistant.cancel') }}</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveTarget">{{ $t('adminQqAssistant.save') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const { showToast } = useToast()

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

const loading = ref(false)
const loadError = ref('')
const targets = ref<PlatformTarget[]>([])
const draws = ref<Draw[]>([])
const selectedId = ref('')
const resettingId = ref('')
const testingId = ref('')
const saving = ref(false)
const showModal = ref(false)
const editingTarget = ref<PlatformTarget | null>(null)
const inboundSecret = ref('')

const form = ref({
  targetId: '',
  targetName: '',
  activeDrawId: '',
  adapterBaseUrl: '',
  inboundSecret: '',
  /** 公证人 QQ 号（docs/177 批次2）：识别哪个机器人服务该群 */
  botId: '',
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

const napcatInboundConfig = computed(() => {
  const callbackUrl = `${window.location.origin}/api/platform/qq/message`
  return [
    `HTTP 上报地址: ${callbackUrl}`,
    `请求头 Authorization: Bearer ${inboundSecret.value}`,
    `请求头 X-CF-Lottery-Platform-Token: ${inboundSecret.value}`,
  ].join('\n')
})

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
    targetId: '', targetName: '', activeDrawId: '', adapterBaseUrl: '', inboundSecret: '',
    // 公证人 QQ 号（docs/177 批次2）：重置时默认空
    botId: '',
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
  // 公证人 QQ 号（docs/177 批次2）：从 adapterConfigJson 回填，供编辑时展示
  try {
    const cfg = JSON.parse(t.adapterConfigJson || '{}')
    form.value.botId = cfg.botId || ''
  } catch { form.value.botId = '' }
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
      /* 编辑时：baseUrl/botId 留空则不更新 adapterConfig，填写则覆盖 */
      const editPayload: Record<string, unknown> = {
        targetName: form.value.targetName,
        activeDrawId: form.value.activeDrawId,
        builtinCommands,
      }
      const editAdapterConfig: Record<string, string> = {}
      const baseUrl = form.value.adapterBaseUrl.trim()
      if (baseUrl) editAdapterConfig.baseUrl = baseUrl
      const botId = form.value.botId.trim()
      if (botId) editAdapterConfig.botId = botId
      if (Object.keys(editAdapterConfig).length > 0) editPayload.adapterConfig = editAdapterConfig
      const newInboundSecret = form.value.inboundSecret.trim()
      if (newInboundSecret) editPayload.inboundSecret = newInboundSecret
      await api(`/platform-targets/${editingTarget.value.id}`, {
        method: 'PUT',
        body: JSON.stringify(editPayload),
      })
      showToast(t('adminQqAssistant.toastUpdated'), 'success')
    } else {
      const adapterConfig: Record<string, string> = {}
      const baseUrl = form.value.adapterBaseUrl.trim()
      if (baseUrl) adapterConfig.baseUrl = baseUrl
      const botId = form.value.botId.trim()
      if (botId) adapterConfig.botId = botId
      const data = await api<{ inboundSecret?: string }>('/platform-targets', {
        method: 'POST',
        body: JSON.stringify({ targetId: form.value.targetId, targetName: form.value.targetName, activeDrawId: form.value.activeDrawId, adapterConfig, ...builtinCommands }),
      })
      inboundSecret.value = String(data.inboundSecret || '')
      showToast(t('adminQqAssistant.toastCreated'), 'success')
    }
    if (!inboundSecret.value) closeModal()
    await loadTargets()
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { saving.value = false }
}
async function deleteTarget(target: PlatformTarget) {
  if (!confirm(t('adminQqAssistant.confirmDelete', { name: target.targetName || target.targetId }))) return
  try {
    await api(`/platform-targets/${target.id}`, { method: 'DELETE' })
    showToast(t('adminQqAssistant.toastDeleted'), 'success')
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
    showToast(t('adminQqAssistant.toastToggled'), 'success')
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
    showToast(t('adminQqAssistant.toastTestSent'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  } finally { testingId.value = '' }
}

async function copyInboundConfig() {
  try {
    await navigator.clipboard.writeText(napcatInboundConfig.value)
    showToast(t('adminQqAssistant.toastCopied'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

/** 仅复制 webhook URL（docs/177 批次2），不包含密钥等敏感信息 */
async function copyWebhookUrl() {
  const callbackUrl = `${window.location.origin}/api/platform/qq/message`
  try {
    await navigator.clipboard.writeText(callbackUrl)
    showToast(t('adminQqAssistant.toastCopiedWebhook'), 'success')
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), 'error')
  }
}

/** 从目标的 adapterConfigJson 中提取公证人 QQ 号（docs/177 批次2） */
function getBotId(t: PlatformTarget): string {
  try {
    const cfg = JSON.parse(t.adapterConfigJson || '{}')
    return cfg.botId || '-'
  } catch { return '-' }
}

onMounted(() => { void loadTargets() })
</script>

<style scoped>
.mono { font-family: monospace; font-size: 13px; }
.empty-row { text-align: center; color: #666; padding: 32px 16px; }
.qq-assistant-modal { max-width: 520px; }
.pointer { cursor: pointer; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--text, #e0e0e0); }
.form-input, .form-select, .form-textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border, #333); border-radius: 6px; background: var(--bg-input, #1a1a2e); color: var(--text, #e0e0e0); font-size: 13px; }
.form-textarea { resize: vertical; min-height: 60px; }
.form-hint { font-size: 11px; color: #888; margin-bottom: 4px; }
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
