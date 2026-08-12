/**
 * 模板差异字段可见性（docs/145 P2）。
 *
 * 为什么独立：
 * - 选模板后仍展示全量高级区，是新手「懵」的主因之一
 * - 白名单必须可单测，不能埋在 3600 行 SFC 里
 *
 * 策略（用户确认的最小范围）：
 * - 先只对「大转盘 / 即时大转盘 / 限时抢购」收口差异字段
 * - 其他模板与空白创建 / 编辑已有活动：全量可见（不藏能力）
 * - 不改提交 payload：隐藏只影响 UI 展示，开关关闭时保存仍写默认关
 *
 * 模板 id 与 src/lib/activity-templates.ts 对齐：
 * lottery-wheel | lottery-wheel-instant | flash-sale-rush
 */

/** 可按模板收口的编辑器区块 */
export type EditorFieldGroup =
  | 'prizeShell'
  | 'flashSale'
  | 'productLink'
  | 'viral'
  | 'cta'
  | 'loserReward'
  | 'experienceType'
  | 'tiers'
  | 'maxSpins'
  | 'instantWeight'

export type EditorFieldVisibility = Record<EditorFieldGroup, boolean>

/** 全量可见：空白创建、未知模板、编辑已有活动 */
export const FULL_EDITOR_FIELD_VISIBILITY: EditorFieldVisibility = {
  prizeShell: true,
  flashSale: true,
  productLink: true,
  viral: true,
  cta: true,
  loserReward: true,
  experienceType: true,
  tiers: true,
  maxSpins: true,
  instantWeight: true,
}

/**
 * 延迟大转盘：登记进池 + 主办方/定时开奖。
 * 不展示秒杀/直付；奖项与壳文案是主配置。
 */
const LOTTERY_WHEEL_VISIBILITY: EditorFieldVisibility = {
  prizeShell: true,
  flashSale: false,
  productLink: true,
  viral: true,
  cta: true,
  loserReward: true,
  experienceType: true,
  tiers: true,
  maxSpins: false,
  instantWeight: false,
}

/**
 * 即时大转盘：spin 出结果，需要 maxSpins + weight。
 * 仍不默认展示秒杀（与 flash-sale-rush 互斥语义）。
 */
const LOTTERY_WHEEL_INSTANT_VISIBILITY: EditorFieldVisibility = {
  prizeShell: true,
  flashSale: false,
  productLink: true,
  viral: true,
  cta: true,
  loserReward: true,
  experienceType: true,
  tiers: true,
  maxSpins: true,
  instantWeight: true,
}

/**
 * 限时抢购：秒杀壳 + 商品导流/直付是主路径。
 * 不展示抽奖奖项壳、安慰奖（claim 路径）。
 * 社交传播：开启后展示邀请排行榜，不影响购买优先级。
 * tiers: true —— 直付秒杀需通过奖档绑定唯一卡密奖品（发布清单 codePrize 检查项），
 * 隐藏奖档会导致用户无法选择卡密奖品而卡在发布门禁（docs/204 修复）。
 */
const FLASH_SALE_RUSH_VISIBILITY: EditorFieldVisibility = {
  prizeShell: false,
  flashSale: true,
  productLink: true,
  viral: true,
  cta: true,
  loserReward: false,
  experienceType: false,
  tiers: true,
  maxSpins: false,
  instantWeight: false,
}

/** 仅对高频模板定义差异；其余走 FULL */
const TEMPLATE_VISIBILITY: Record<string, EditorFieldVisibility> = {
  'lottery-wheel': LOTTERY_WHEEL_VISIBILITY,
  'lottery-wheel-instant': LOTTERY_WHEEL_INSTANT_VISIBILITY,
  'flash-sale-rush': FLASH_SALE_RUSH_VISIBILITY,
}

/**
 * 解析当前编辑器应展示哪些区块。
 *
 * @param templateId 创建时来自 applyTemplate 的 activeTemplateId；编辑/空白传空
 * @param opts.isEditing 编辑已有活动时强制全量，避免藏掉运营已开过的配置入口
 */
export function resolveEditorFieldVisibility(
  templateId: string | null | undefined,
  opts?: { isEditing?: boolean },
): EditorFieldVisibility {
  if (opts?.isEditing) return { ...FULL_EDITOR_FIELD_VISIBILITY }
  const id = String(templateId || '').trim()
  if (!id) return { ...FULL_EDITOR_FIELD_VISIBILITY }
  const profile = TEMPLATE_VISIBILITY[id]
  return profile ? { ...profile } : { ...FULL_EDITOR_FIELD_VISIBILITY }
}

/** 选中模板后是否建议自动展开高级区（秒杀等主路径在高级区里） */
export function shouldAutoExpandAdvancedForTemplate(templateId: string | null | undefined): boolean {
  const id = String(templateId || '').trim()
  return id === 'flash-sale-rush'
}

/** 是否已知的「差异字段」模板（便于 UI 提示「已按模板收敛」） */
export function isFieldScopedTemplate(templateId: string | null | undefined): boolean {
  const id = String(templateId || '').trim()
  return Object.prototype.hasOwnProperty.call(TEMPLATE_VISIBILITY, id)
}
