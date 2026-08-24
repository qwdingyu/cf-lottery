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
  // lottery（及其余非 survey/vote 类型）分支：必须解析 raw 里的 loserReward / reward / quota 并与默认合并，
  // 而不是直接返回默认。为什么：DB 里可能已启用「未中奖自动发券」（{enabled:true, couponLabel:'安慰奖'}），
  // 直接 return default 会把 enabled 重置为 false，导致「编辑任一字段保存后发券被静默关闭」（P0 回归）。
  // 合并语义 { ...default, ...stored }：stored 缺省（含非法值）时回落默认。
  //
  // ⚠️ 数据结构约定（对齐后端 triggerRewardEarned 读取路径）：
  // - activityConfig.reward：perInviteAmount / currency（reward.ts:73）
  // - activityConfig.quota：perUserPerDay / globalPerDay（reward.ts:84-85）
  // quota 必须在 activityConfig 顶层，而非 reward.quota 嵌套。
  const defaultLottery = defaultActivityConfigForKind(kind, t) as {
    version: 1
    kind: string
    loserReward: { enabled: boolean; couponLabel: string }
    reward?: {
      mode?: 'fixed' | 'percent'
      perInviteAmount?: number
      perInvitePercent?: number
      currency: string
    }
    quota?: {
      perUserPerDay?: number
      globalPerDay?: number
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

  // P1-3：保留 reward 配置（mode / perInviteAmount / perInvitePercent / currency），并对非法值做容错
  // ⚠️ reward 对象只包含 per-invite 维度配置，quota 从顶层读取（见下方 parsedQuota）
  // 旧数据兼容：无 mode 字段默认视为 fixed，优先读 perInviteAmount
  const storedReward = (raw as { reward?: unknown }).reward
  const parsedReward =
    storedReward && typeof storedReward === 'object' && !Array.isArray(storedReward)
      ? {
          // mode: 只接受 'fixed' 或 'percent'，否则回退 fixed
          mode: (() => {
            const v = (storedReward as { mode?: unknown }).mode
            return v === 'percent' ? 'percent' as const : 'fixed' as const
          })(),
          // perInviteAmount 必须是有限非负整数，否则回退 0（避免 NaN 进入后端）
          perInviteAmount: (() => {
            const v = Number((storedReward as { perInviteAmount?: unknown }).perInviteAmount)
            return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
          })(),
          // perInvitePercent: 百分比模式下的比例值（0-100），有限非负数，否则回退 0
          perInvitePercent: (() => {
            const v = Number((storedReward as { perInvitePercent?: unknown }).perInvitePercent)
            return Number.isFinite(v) ? Math.max(0, v) : 0
          })(),
          // currency 从 reward 配置读取，未配置时不写入（由后端从 flashSale.currency 或默认 cny 获取）
          ...((() => {
            const v = (storedReward as { currency?: unknown }).currency
            return typeof v === 'string' && v.trim().length > 0 ? { currency: v.trim() } : {}
          })()),
        }
      : undefined

  // P1-3：配额配置从 activityConfig 顶层读取（对齐后端 triggerRewardEarned: config?.quota?.perUserPerDay）
  const storedQuota = (raw as { quota?: unknown }).quota
  const parsedQuota =
    storedQuota && typeof storedQuota === 'object' && !Array.isArray(storedQuota)
      ? {
          // 配额必须是有限正整数，否则忽略该字段（不写入 payload）
          perUserPerDay: (() => {
            const v = Number((storedQuota as { perUserPerDay?: unknown }).perUserPerDay)
            return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
          })(),
          globalPerDay: (() => {
            const v = Number((storedQuota as { globalPerDay?: unknown }).globalPerDay)
            return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
          })(),
        }
      : undefined

  return {
    ...defaultLottery,
    ...(parsedLoserReward ? { loserReward: parsedLoserReward } : {}),
    ...(parsedReward ? { reward: parsedReward } : {}),
    // quota 在顶层，与后端 triggerRewardEarned 的 config?.quota 读取路径对齐
    ...(parsedQuota && (parsedQuota.perUserPerDay != null || parsedQuota.globalPerDay != null)
      ? { quota: parsedQuota }
      : {}),
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
