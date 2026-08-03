/**
 * 问卷/投票/安慰奖 activity_config 的默认与归一化。
 *
 * 为什么独立：normalize 被创建、复制、模板应用多处调用；
 * t 以参数注入，避免本模块硬绑 i18n 实例，方便单测。
 */
import type { ActivityConfigForm, SurveyFieldForm, SurveyFieldType } from './types'

export type ActivityConfigTranslate = (key: string, params?: Record<string, unknown>) => string

export function makeStableId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

export function defaultActivityConfigForKind(
  kind: string,
  t: ActivityConfigTranslate,
): ActivityConfigForm {
  if (kind === 'survey') {
    return {
      version: 1,
      kind: 'survey',
      fields: [
        { id: 'contact_email', label: t('lottery.adminDefaultContactEmail'), type: 'email', required: true, maxLength: 120, options: [] },
        { id: 'feedback', label: t('lottery.adminDefaultFeedback'), type: 'textarea', required: true, maxLength: 1000, options: [] },
      ],
    }
  }
  if (kind === 'vote') {
    return {
      version: 1,
      kind: 'vote',
      selection: 'single',
      options: [
        { id: 'option_a', label: t('lottery.adminOptionNumber', { n: 'A' }), description: '', imageUrl: '' },
        { id: 'option_b', label: t('lottery.adminOptionNumber', { n: 'B' }), description: '', imageUrl: '' },
      ],
    }
  }
  // lottery 默认配置：未中奖自动发券默认关闭，需运营者显式启用
  return { version: 1, kind, loserReward: { enabled: false, couponLabel: '' } }
}

export function normalizeActivityConfig(
  kind: string,
  config: unknown,
  t: ActivityConfigTranslate,
): ActivityConfigForm {
  const raw = config as { kind?: string; fields?: unknown[]; options?: unknown[] } | null
  if (!raw || typeof raw !== 'object' || raw.kind !== kind) {
    return defaultActivityConfigForKind(kind, t)
  }
  if (kind === 'survey') {
    const fields =
      Array.isArray(raw.fields) && raw.fields.length > 0
        ? raw.fields.map((field: any) => ({
            id: String(field.id || makeStableId('field')),
            label: String(field.label || t('lottery.adminUnnamedField')),
            type: (['text', 'email', 'phone', 'textarea', 'select', 'radio', 'checkbox'].includes(field.type)
              ? field.type
              : 'text') as SurveyFieldType,
            required: Boolean(field.required),
            maxLength: Number(field.maxLength || 120),
            options: Array.isArray(field.options)
              ? field.options.map((option: any) => ({
                  id: String(option.id || makeStableId('opt')),
                  label: String(option.label || t('lottery.adminOption')),
                }))
              : [],
          }))
        : (defaultActivityConfigForKind('survey', t) as Extract<ActivityConfigForm, { kind: 'survey' }>).fields
    return { version: 1, kind: 'survey', fields }
  }
  if (kind === 'vote') {
    const options =
      Array.isArray(raw.options) && raw.options.length >= 2
        ? raw.options.map((option: any) => ({
            id: String(option.id || makeStableId('opt')),
            label: String(option.label || t('lottery.adminOption')),
            description: String(option.description || ''),
            imageUrl: String(option.imageUrl || ''),
          }))
        : (defaultActivityConfigForKind('vote', t) as Extract<ActivityConfigForm, { kind: 'vote' }>).options
    return { version: 1, kind: 'vote', selection: 'single', options }
  }
  return defaultActivityConfigForKind(kind, t)
}

export function isChoiceSurveyField(field: SurveyFieldForm): boolean {
  return ['select', 'radio', 'checkbox'].includes(field.type)
}

export function normalizeSurveyFieldOptions(field: SurveyFieldForm, t: ActivityConfigTranslate): void {
  if (isChoiceSurveyField(field) && field.options.length === 0) {
    field.options = [
      { id: makeStableId('opt'), label: t('lottery.adminOptionNumber', { n: 1 }) },
      { id: makeStableId('opt'), label: t('lottery.adminOptionNumber', { n: 2 }) },
    ]
  }
  if (!isChoiceSurveyField(field)) field.options = []
  field.maxLength =
    field.type === 'textarea'
      ? Math.max(Number(field.maxLength) || 1000, 200)
      : Math.min(Number(field.maxLength) || 120, 500)
}
