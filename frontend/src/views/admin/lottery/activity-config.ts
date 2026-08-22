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
  // lottery（及其余非 survey/vote 类型）分支：必须解析 raw 里的 loserReward / reward 并与默认合并，
  // 而不是直接返回默认。为什么：DB 里可能已启用「未中奖自动发券」（{enabled:true, couponLabel:'安慰奖'}），
  // 直接 return default 会把 enabled 重置为 false，导致「编辑任一字段保存后发券被静默关闭」（P0 回归）。
  // 合并语义 { ...default, ...stored }：stored 缺省（含非法值）时回落默认。
  const defaultLottery = defaultActivityConfigForKind(kind, t) as {
    version: 1
    kind: string
    loserReward: { enabled: boolean; couponLabel: string }
    reward?: {
      perInviteAmount: number
      currency: string
      quota?: {
        perUserPerDay?: number
        globalPerDay?: number
      }
    }
  }
  // 容错：loserReward 非对象（null / 字符串 / 数组 / 数字）一律视为缺省，避免脏数据炸表单
  const storedLoserReward = (raw as { loserReward?: unknown }).loserReward
  const parsedLoserReward =
    storedLoserReward && typeof storedLoserReward === 'object' && !Array.isArray(storedLoserReward)
      ? {
          enabled: Boolean((storedLoserReward as { enabled?: unknown }).enabled),
          couponLabel: String((storedLoserReward as { couponLabel?: unknown }).couponLabel || ''),
        }
      : undefined

  // P1-3：保留 reward 配置（perInviteAmount / currency / quota）
  const storedReward = (raw as { reward?: unknown }).reward
  const parsedReward =
    storedReward && typeof storedReward === 'object' && !Array.isArray(storedReward)
      ? {
          perInviteAmount: Number((storedReward as { perInviteAmount?: unknown }).perInviteAmount || 0),
          currency: String((storedReward as { currency?: unknown }).currency || 'USD'),
          quota: (storedReward as { quota?: unknown }).quota && typeof (storedReward as { quota?: unknown }).quota === 'object'
            ? {
                perUserPerDay: Number(((storedReward as { quota?: { perUserPerDay?: unknown } }).quota?.perUserPerDay) || 0) || undefined,
                globalPerDay: Number(((storedReward as { quota?: { globalPerDay?: unknown } }).quota?.globalPerDay) || 0) || undefined,
              }
            : undefined,
        }
      : undefined

  return {
    ...defaultLottery,
    ...(parsedLoserReward ? { loserReward: parsedLoserReward } : {}),
    ...(parsedReward ? { reward: parsedReward } : {}),
  }
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
