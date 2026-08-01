<template>
  <div class="config-card" :class="{ 'config-card-primary': primary }">
    <label class="config-label">
      <span>{{ localizedLabel }}</span>
      <input
        v-if="item.type === 'boolean'"
        type="checkbox"
        :checked="value === 'true'"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLInputElement).checked ? 'true' : 'false')"
      />
      <!-- 金额类 integer（unit=cents）：界面按「元」编辑，提交仍为分整数字符串 -->
      <input
        v-else-if="isCentsMoney"
        type="number"
        inputmode="decimal"
        step="0.01"
        min="0"
        :value="displayYuan"
        :disabled="status === 'saving'"
        @change="onYuanChange(($event.target as HTMLInputElement).value)"
      />
      <input
        v-else-if="item.type === 'integer'"
        type="number"
        step="1"
        :value="value"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLInputElement).value)"
      />
      <input
        v-else-if="item.sensitive"
        type="password"
        value=""
        :placeholder="item.configured ? $t('adminConfigField.override') : $t('adminConfigField.notConfigured')"
        autocomplete="new-password"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLInputElement).value)"
      />
      <textarea
        v-else
        :value="value"
        :disabled="status === 'saving'"
        @change="emitChange(($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <p v-if="localizedDescription" class="config-help">{{ localizedDescription }}</p>
    <p v-if="localizedEffect" class="config-effect">{{ localizedEffect }}</p>
    <p v-if="isCentsMoney" class="config-range">
      {{ $t('adminConfigField.range', { min: rangeYuanMin, max: rangeYuanMax }) }} {{ $t('adminConfigField.yuanUnit') }}
      <span class="config-range-hint">{{ $t('adminConfigField.hint') }}</span>
    </p>
    <p v-else-if="item.type === 'integer'" class="config-range">
      {{ $t('adminConfigField.range', { min: item.min ?? '不限', max: item.max ?? '不限' }) }}
    </p>
    <p v-if="localError" class="config-local-error" role="alert">{{ localError }}</p>
    <div class="config-actions">
      <span v-if="statusText" class="config-status" :class="`config-status-${status}`">{{ statusText }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="status === 'saving'" @click="$emit('reset', item.key)">{{ $t('adminConfigField.reset') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AdminSystemConfigDefinition } from '@/types/admin'
import { formatCents, parseYuanToCents } from '@/utils/currency'

type ConfigFieldStatus = 'idle' | 'saving' | 'saved' | 'error'

const props = defineProps<{
  item: AdminSystemConfigDefinition
  value: string
  primary?: boolean
  status?: ConfigFieldStatus
}>()

const emit = defineEmits<{
  change: [key: string, value: string]
  reset: [key: string]
}>()

const { t, te } = useI18n()

const localError = ref('')

/**
 * 系统配置定义来自后端，label/description/effect 可能包含邮箱、URL、Webhook 示例等普通文本。
 * 这些文本不能作为 vue-i18n default message 传入 t()，否则裸 @、花括号示例会被 message compiler
 * 当成 i18n 语法解析并在运行时抛 SyntaxError。这里先判断翻译 key 是否存在，不存在就直接展示后端原文。
 */
function translateConfigText(suffix: 'label' | 'description' | 'effect', fallback: string) {
  const key = `adminConfig.fields.${props.item.key}.${suffix}`
  return te(key) ? t(key) : fallback
}

const localizedLabel = computed(() => translateConfigText('label', props.item.label))
const localizedDescription = computed(() => translateConfigText('description', props.item.description || ''))
const localizedEffect = computed(() => translateConfigText('effect', props.item.effect || ''))

/** 库内分为整数、UI 按人民币元展示的配置项 */
const isCentsMoney = computed(() => props.item.type === 'integer' && props.item.unit === 'cents')

const displayYuan = computed(() => {
  if (!isCentsMoney.value) return props.value
  const cents = Number(props.value)
  if (!Number.isSafeInteger(cents)) return props.value
  return formatCents(cents)
})

const rangeYuanMin = computed(() => {
  if (props.item.min === undefined) return t('adminConfigField.unlimited')
  return formatCents(props.item.min)
})

const rangeYuanMax = computed(() => {
  if (props.item.max === undefined) return t('adminConfigField.unlimited')
  return formatCents(props.item.max)
})

function emitChange(value: string) {
  localError.value = ''
  emit('change', props.item.key, value)
}

/**
 * 用户按元输入 → 转为分整数再交给保存链路。
 * 非法金额不 emit，避免把「50」当成 50 分写进库。
 */
function onYuanChange(raw: string) {
  localError.value = ''
  const trimmed = raw.trim()
  if (!trimmed) {
    localError.value = t('adminConfigField.placeholder')
    return
  }
  const cents = parseYuanToCents(trimmed)
  if (cents === null || cents < 0) {
    localError.value = t('adminConfigField.placeholder')
    return
  }
  if (props.item.min !== undefined && cents < props.item.min) {
    localError.value = t('adminConfigField.minError', { min: formatCents(props.item.min) })
    return
  }
  if (props.item.max !== undefined && cents > props.item.max) {
    localError.value = t('adminConfigField.maxError', { max: formatCents(props.item.max) })
    return
  }
  emitChange(String(cents))
}

watch(
  () => props.value,
  () => {
    localError.value = ''
  },
)

const statusText = computed(() => {
  if (props.status === 'saving') return t('adminConfigField.saving')
  if (props.status === 'saved') return t('adminConfig.saved')
  if (props.status === 'error') return t('adminConfig.saveFailed')
  return ''
})
</script>

<style scoped>
.config-card {
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-lg, 12px);
  padding: 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.config-card-primary {
  border-color: var(--admin-accent-border, rgba(245, 158, 11, 0.38));
  background: linear-gradient(
    180deg,
    var(--admin-accent-soft, rgba(245, 158, 11, 0.14)),
    rgba(245, 158, 11, 0.04)
  );
}

.config-card:hover {
  border-color: rgba(245, 158, 11, 0.55);
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.3));
}

.config-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--tg-text, #f0f2f5);
}

.config-label span:first-child {
  font-weight: 500;
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
}

.config-help,
.config-effect,
.config-range {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--tg-hint, #9aa4b2);
}

.config-effect {
  color: var(--tg-text, #f0f2f5);
}

.config-range-hint {
  color: var(--admin-accent-text, #fbbf24);
}

.config-local-error {
  margin: 0;
  font-size: 12px;
  color: #fca5a5;
  line-height: 1.4;
}

.config-label input[type='number'],
.config-label input[type='password'],
.config-label textarea {
  padding: 8px 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
}

.config-label textarea {
  min-height: 72px;
  resize: vertical;
}

.config-label input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--admin-accent, #f59e0b);
  cursor: pointer;
}

.config-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
}

.config-status {
  font-size: 12px;
}

.config-status-saving {
  color: var(--tg-hint, #9aa4b2);
}

.config-status-saved {
  color: #6ee7b7;
}

.config-status-error {
  color: #fca5a5;
}
</style>
