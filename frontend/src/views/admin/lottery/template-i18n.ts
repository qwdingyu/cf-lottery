/**
 * 模板卡片/创建表单的文案解析（docs/162 P1-D / P2-B）。
 *
 * 背景：
 * - /api/admin/templates 返回的 name/description/hints 是后端硬编码中文，
 *   英文界面下模板卡片全中文；
 * - applyTemplate 曾把该运营向描述直接预填为公开活动描述（C 端可见，线上已发生）。
 *
 * 策略：
 * - 前端按模板 id 从 i18n 解析 name/desc/hints；key 缺失时回退 API 字符串，
 *   后端新增模板无需等前端发版也可展示（中文兜底，不失效）；
 * - 全部为纯函数，t/te/tm 以结构子集注入，便于单测（与 vue-i18n 解耦）。
 */

/** 模板对象的最小结构（API 返回 any，本模块只读这几个字段） */
export interface TemplateLike {
  id?: string
  name?: string
  description?: string
  hints?: unknown
  defaults?: {
    activityKind?: string
    resultMode?: string
    flashSalePaymentRequired?: boolean
  } & Record<string, unknown>
}

/** vue-i18n useI18n() 返回值的结构子集：单测可注入 mock，无需挂载 i18n 实例 */
export interface TemplateI18nSource {
  t: (key: string) => string
  te: (key: string) => boolean
  tm: (key: string) => unknown
}

/** i18n key 约定：lottery.tpl.<模板id>.<name|desc|hints> */
function tplKey(id: string, field: string): string {
  return `lottery.tpl.${id}.${field}`
}

/** 模板显示名：优先 i18n，缺失回退 API 中文名 */
export function templateDisplayName(tpl: TemplateLike, i18n: TemplateI18nSource): string {
  const id = String(tpl.id || '').trim()
  if (id) {
    const key = tplKey(id, 'name')
    if (i18n.te(key)) return i18n.t(key)
  }
  return String(tpl.name || '')
}

/** 模板卡片描述：优先 i18n，缺失回退 API 中文描述 */
export function templateDisplayDesc(tpl: TemplateLike, i18n: TemplateI18nSource): string {
  const id = String(tpl.id || '').trim()
  if (id) {
    const key = tplKey(id, 'desc')
    if (i18n.te(key)) return i18n.t(key)
  }
  return String(tpl.description || '')
}

/**
 * 模板配置要点（hints）：套用模板后展示在创建表单顶部。
 * i18n 里是数组（tm 取原始值）；缺失时回退 API hints。
 */
export function templateDisplayHints(tpl: TemplateLike, i18n: TemplateI18nSource): string[] {
  const id = String(tpl.id || '').trim()
  if (id) {
    const key = tplKey(id, 'hints')
    if (i18n.te(key)) {
      const raw = i18n.tm(key)
      if (Array.isArray(raw)) {
        return raw.map((item) => String(item || '').trim()).filter(Boolean)
      }
    }
  }
  if (Array.isArray(tpl.hints)) {
    return tpl.hints.map((item) => String(item || '').trim()).filter(Boolean)
  }
  return []
}

/**
 * 结果模式 → chip i18n key：复用管理端已有的 adminResult* 文案，不新造词。
 * 未知/空结果模式不出 chip（宁缺勿假）。
 */
const RESULT_MODE_CHIP_KEYS: Record<string, string> = {
  manual: 'lottery.adminResultManual',
  scheduled: 'lottery.adminResultScheduled',
  instant: 'lottery.adminResultInstant',
  ordered_assignment: 'lottery.adminResultOrdered',
  capacity_assignment: 'lottery.adminResultCapacity',
  vote_tally: 'lottery.adminResultVoteTally',
  review_decision: 'lottery.adminResultReview',
  no_result: 'lottery.adminResultNoResult',
}

/**
 * 模板卡片参数 chips（docs/162 P2-B）：
 * 「何时出结果 / 是否需奖品 / 是否涉及收款」在选模板时即可见，
 * 不必读完长描述才发现要配奖品或支付。返回 i18n key 列表（最多 3 个）。
 */
export function templateChips(tpl: TemplateLike): string[] {
  const defaults = tpl.defaults || {}
  const chips: string[] = []
  const resultKey = RESULT_MODE_CHIP_KEYS[String(defaults.resultMode || '').trim()]
  if (resultKey) chips.push(resultKey)
  if (defaults.activityKind === 'lottery') chips.push('lottery.tplChipNeedsPrize')
  if (defaults.flashSalePaymentRequired === true) chips.push('lottery.tplChipPayment')
  return chips
}
