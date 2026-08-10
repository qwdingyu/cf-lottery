export type TierWeightInput = {
  weight?: number | string | null
}

export type TierProbability = {
  weight: number
  percent: number
  label: string
}

/**
 * 计算即时抽奖各奖项档位的权重占比。
 *
 * 为什么只看 weight：后端即时抽奖先按可用档位权重抽取，再受库存、档位名额、
 * 用户剩余次数、卡密可用量等约束影响；后台这里展示的是运营配置的“相对命中倾向”，
 * 不能包装成最终真实发放率，否则会误导运营承诺中奖概率。
 */
export function buildTierProbabilities(tiers: TierWeightInput[]): TierProbability[] {
  const weights = tiers.map((tier) => normalizeTierWeight(tier.weight))
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
 * 与保存逻辑保持一致：非整数向下取整，负数按 0 处理。
 * 空值在“展示”阶段按 0 处理，避免运营误以为未填时已有真实概率。
 */
export function normalizeTierWeight(value: number | string | null | undefined): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.floor(numeric))
}

function formatTierProbability(percent: number): string {
  if (percent <= 0) return '0%'
  if (percent < 0.01) return '<0.01%'
  if (percent >= 99.995 && percent < 100) return '>99.99%'
  return `${percent.toFixed(2).replace(/\.?0+$/, '')}%`
}
