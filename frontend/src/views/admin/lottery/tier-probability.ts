export type TierWeightInput = {
  weight?: number | string | null
}

export type TierProbability = {
  weight: number
  percent: number
  label: string
}

/** 与服务端奖项保存接口一致，避免前端展示、浏览器校验与实际落库上限分叉。 */
export const MAX_TIER_WEIGHT = 100_000

/**
 * 计算即时抽奖各奖项档位的权重占比。
 *
 * 使用原始输入值（不 floor），让用户看到的百分比与输入值一致。
 * 后端保存时 floor 权重（与 floorNonNeg 一致），下次编辑回填时概率会重新计算。
 *
 * 为什么只看 weight：后端即时抽奖先按可用档位权重抽取，再受库存、档位名额、
 * 用户剩余次数、卡密可用量等约束影响；后台这里展示的是运营配置的"相对命中倾向"，
 * 不能包装成最终真实发放率，否则会误导运营承诺中奖概率。
 */
export function buildTierProbabilities(tiers: TierWeightInput[]): TierProbability[] {
  const weights = tiers.map((tier) => normalizeDisplayWeight(tier.weight))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map((weight) => {
    const percent = totalWeight > 0 ? (weight / totalWeight) * 100 : 0
    return {
      weight,
      percent,
      label: formatTierProbability(percent),
    }
  })
}

/**
 * 展示用权重归一化：保留原始值（不 floor），让用户看到的百分比与输入值一致。
 * 后端保存时使用 normalizeTierWeight（floor），编辑回填时概率重新计算。
 */
function normalizeDisplayWeight(value: number | string | null | undefined): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(MAX_TIER_WEIGHT, Math.max(0, numeric))
}

/**
 * 与保存逻辑保持一致：非整数向下取整，负数按 0 处理。
 * 空值在“展示”阶段按 0 处理，避免运营误以为未填时已有真实概率。
 */
export function normalizeTierWeight(value: number | string | null | undefined): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(MAX_TIER_WEIGHT, Math.max(0, Math.floor(numeric)))
}

function formatTierProbability(percent: number): string {
  if (percent <= 0) return '0%'
  if (percent < 0.01) return '<0.01%'
  if (percent >= 99.995 && percent < 100) return '>99.99%'
  return `${percent.toFixed(2).replace(/\.?0+$/, '')}%`
}

export type TierCountInput = {
  winnerCount?: number | string | null
}

/**
 * 奖项名额合计：各档位中奖份数之和（负数按 0 过滤，空值按 0）。
 * 与后端开奖逻辑一致：有奖项配置时总中奖人数 = 各档 winnerCount 合计
 * （draw-execution.ts:186-188），而非活动的 draw.winnerCount。
 */
export function sumTierWinnerCounts(tiers: TierCountInput[] | null | undefined): number {
  return (tiers || []).reduce((sum, tier) => {
    const n = Math.floor(Number(tier?.winnerCount) || 0)
    return sum + Math.max(0, n)
  }, 0)
}

export type TierWinnerCountSummary = {
  total: number
  /** lottery 时返回活动 draw.winnerCount；其他活动类型不参与对比（null） */
  drawWinnerCount: number | null
  /** true 表示一致/不适用；false 表示名额合计与活动设置不一致 */
  match: boolean
}

/**
 * 构建「奖项名额合计」汇总（期表单展示）。
 * - total === 0（尚未填写份数）→ null，不展示提示
 * - lottery：与 draw.winnerCount 对比，不一致时 match=false（与 publish-check
 *   prizes.winner_count.mismatch 同规则，表单即时可见而非等到发布检查）
 * - 其他活动类型（claim 直付秒杀等）：draw.winnerCount 无对比语义，match=true
 */
export function buildTierWinnerCountSummary(
  tiers: TierCountInput[] | null | undefined,
  drawWinnerCount: number | string | null | undefined,
  activityKind: string,
): TierWinnerCountSummary | null {
  const total = sumTierWinnerCounts(tiers)
  if (total === 0) return null
  if (activityKind === 'lottery') {
    const drawWC = Math.max(0, Math.floor(Number(drawWinnerCount) || 0))
    return { total, drawWinnerCount: drawWC, match: total === drawWC }
  }
  return { total, drawWinnerCount: null, match: true }
}
