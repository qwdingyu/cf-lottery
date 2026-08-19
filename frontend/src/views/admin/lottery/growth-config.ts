/**
 * 管理端增长配置（裂变 / 商品导流 / 多状态 CTA）的解析与回填。
 *
 * 为何独立成纯模块（docs/114）：
 * - handleEdit 若不回填 enableViral，表单默认 false，再保存可能擦掉 promotionConfig
 * - 列表/详情里 promotionConfig、productLink 可能是 JSON 字符串或对象
 * - 单测必须能不挂载 AdminLotteryView 就锁住回填契约
 */

export type GrowthProductLink = {
  url: string
  title: string
  imageUrl: string
  price: string
}

export type FlashSalePricingTier = {
  minQuantity: number
  unitPriceCents: number
  label: string
}

export type FlashSaleSalesMode = 'redirect' | 'direct_single' | 'direct_bulk'

export function inferFlashSaleSalesMode(
  paymentRequired: boolean,
  maxPerUser: number,
  pricingTiers: FlashSalePricingTier[],
): FlashSaleSalesMode {
  if (!paymentRequired) return 'redirect'
  if (maxPerUser > 1 || pricingTiers.length > 1) return 'direct_bulk'
  return 'direct_single'
}

export type GrowthFieldsFromDraw = {
  enableProductLink: boolean
  productLink: GrowthProductLink
  enableViral: boolean
  viralExtraEntriesPerInvite: number
  viralMaxExtraEntries: number
  viralLeaderboardEnabled: boolean
  /** 保底机制（docs/218 模式一）：连空 threshold 次后下次必中（仅 instant） */
  enablePity: boolean
  pityThreshold: number
  /** 每日免费（docs/218 模式二）：每自然日首抽免费（仅 instant） */
  enableDailyFreeSpins: boolean
  dailyFreeSpinsCount: number
  /** 排行榜奖励明细（docs/218 模式三）：多行 "名次:spins次数"，如 "1:3\n2:1" */
  leaderboardRewardsText: string
  /** 推荐里程碑（docs/217）：多行 "邀请数:spins次数"，如 "1:2\n3:5"（仅 instant） */
  referralRewardsText: string
  enableAfterWinCta: boolean
  afterWinCtaUrl: string
  afterWinCtaTitle: string
  enableAfterLossCta: boolean
  afterLossCtaUrl: string
  afterLossCtaTitle: string
  /**
   * 游戏壳展示（docs/128）：写入 promotion.experience
   * prizePanelMode: auto | full_on_shell | shell_ritual_pool_full | …
   * ritualPhrasesText: 每行一条中性短语（delayed 扇面）
   */
  prizePanelMode: string
  ritualPhrasesText: string
  /**
   * 秒杀壳配置（docs/130/131）：写入 promotion.flashSale
   * paymentRequired=false 是展示/导流壳；true 时进入 cf-lottery 直付发卡门禁。
   */
  enableFlashSale: boolean
  flashSaleSessionLabel: string
  flashSaleSalesMode: FlashSaleSalesMode
  flashSaleStockLimit: number | null
  flashSaleMaxPerUser: number
  flashSaleCtaLabel: string
  flashSaleShowCountdown: boolean
  flashSaleShowProgress: boolean
  flashSaleShowStock: boolean
  flashSalePaymentRequired: boolean
  flashSalePriceCents: number | null
  flashSaleCurrency: string
  flashSaleTitle: string
  flashSaleImageUrl: string
  flashSalePricingTiers: FlashSalePricingTier[]
  /** 是否已有增长配置：编辑时应用来展开高级区 */
  hasGrowthConfig: boolean
}

/**
 * 与 src/lib/prize-shell-display.ts FORBIDDEN_RITUAL_SUBSTRINGS 同步的禁用词副本
 * （管理端提交前轻量清洗）。修改必须三处一起改防漂移。
 */
const RITUAL_FORBIDDEN = ['中奖', '一等奖', '二等奖', '三等奖', '特等奖', '大奖', '奖品是', '已中', '恭喜获得']

export function sanitizeRitualPhrasesForSave(raw: string | string[] | null | undefined): string[] {
  const lines = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(/[\n,，;；]/)
        .map((s) => s.trim())
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of lines) {
    if (out.length >= 16) break
    const s = String(item || '')
      .replace(/\s+/g, '')
      .trim()
      .slice(0, 8)
    if (!s || seen.has(s)) continue
    if (RITUAL_FORBIDDEN.some((b) => s.includes(b))) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

const PRIZE_PANEL_MODES = new Set([
  'auto',
  'full_on_shell',
  'shell_ritual_pool_full',
  'shell_ritual_pool_summary',
  'ritual_only',
])

export function normalizePrizePanelMode(raw: unknown): string {
  const m = String(raw || 'auto')
    .trim()
    .toLowerCase()
  return PRIZE_PANEL_MODES.has(m) ? m : 'auto'
}

/** 排行榜奖励项（与后端 LeaderboardRewardConfig 对齐） */
export type LeaderboardRewardEntry = {
  rank: number
  rewardType: 'bonus_spin'
  rewardValue: number
}

/**
 * 解析排行榜奖励明细文本（多行 "名次:spins次数"，如 "1:3\n2:1"）。
 * 非法行跳过；名次/次数必须为正整数，名次上限 100。
 * 空输入 → []。
 */
export function parseLeaderboardRewardsText(raw: string | null | undefined): LeaderboardRewardEntry[] {
  const out: LeaderboardRewardEntry[] = []
  const seen = new Set<number>()
  for (const line of String(raw || '').split(/[\n,;；]/)) {
    const s = line.trim()
    if (!s) continue
    const m = s.match(/^(\d+)\s*[:：]\s*(\d+)$/)
    if (!m) continue
    const rank = Number(m[1])
    const rewardValue = Number(m[2])
    if (rank < 1 || rank > 100 || rewardValue < 1 || rewardValue > 1000) continue
    if (seen.has(rank)) continue
    seen.add(rank)
    out.push({ rank, rewardType: 'bonus_spin', rewardValue })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

/** 排行榜奖励明细 → 多行文本（与 parseLeaderboardRewardsText 互逆） */
export function formatLeaderboardRewardsText(rewards: Array<{ rank: number; rewardValue: number }> | null | undefined): string {
  if (!Array.isArray(rewards) || rewards.length === 0) return ''
  return [...rewards]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => `${r.rank}:${r.rewardValue}`)
    .join('\n')
}

/** 推荐里程碑项（与后端 ReferralMilestoneReward 对齐） */
export type ReferralRewardEntry = {
  requireCount: number
  rewardType: 'bonus_spin'
  rewardValue: number
}

/**
 * 解析推荐里程碑文本（多行 "邀请数:spins次数"，如 "1:2\n3:5"）。
 * 非法行跳过；邀请数/次数必须为正整数，邀请数上限 100、次数上限 1000。
 * 空输入 → []。
 */
export function parseReferralRewardsText(raw: string | null | undefined): ReferralRewardEntry[] {
  const out: ReferralRewardEntry[] = []
  const seen = new Set<number>()
  for (const line of String(raw || '').split(/[\n,;；]/)) {
    const s = line.trim()
    if (!s) continue
    const m = s.match(/^(\d+)\s*[:：]\s*(\d+)$/)
    if (!m) continue
    const requireCount = Number(m[1])
    const rewardValue = Number(m[2])
    if (requireCount < 1 || requireCount > 100 || rewardValue < 1 || rewardValue > 1000) continue
    if (seen.has(requireCount)) continue
    seen.add(requireCount)
    out.push({ requireCount, rewardType: 'bonus_spin', rewardValue })
  }
  return out.sort((a, b) => a.requireCount - b.requireCount)
}

/** 推荐里程碑 → 多行文本（与 parseReferralRewardsText 互逆） */
export function formatReferralRewardsText(rewards: Array<{ requireCount: number; rewardValue: number }> | null | undefined): string {
  if (!Array.isArray(rewards) || rewards.length === 0) return ''
  return [...rewards]
    .sort((a, b) => a.requireCount - b.requireCount)
    .map((r) => `${r.requireCount}:${r.rewardValue}`)
    .join('\n')
}

/** 解析活动上的 JSON 对象字段（字符串或对象）；空 / "{}" / 非法 → null */
export function parseJsonObjectField(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === '' || raw === '{}') return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed as object).length > 0) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* 非法 JSON 当空 */
    }
  }
  return null
}

/**
 * 从 draw 行（详情或列表）提取裂变 / 导流 / CTA 表单字段。
 * leaderboardEnabled：仅显式 false 关闭，与公开 API / ViralLeaderboard 一致。
 */
export function growthFieldsFromDraw(source: Record<string, unknown>): GrowthFieldsFromDraw {
  const promotion = parseJsonObjectField(source.promotionConfig)
  const productFromCol = parseJsonObjectField(source.productLink)
  const destination =
    promotion?.destination && typeof promotion.destination === 'object' && !Array.isArray(promotion.destination)
      ? (promotion.destination as Record<string, unknown>)
      : null
  const productSrc = productFromCol && String(productFromCol.url || '').trim()
    ? productFromCol
    : destination
  const viral =
    promotion?.viral && typeof promotion.viral === 'object' && !Array.isArray(promotion.viral)
      ? (promotion.viral as Record<string, unknown>)
      : null
  // docs/218 模式一：保底（promotion.pity）
  const pity =
    promotion?.pity && typeof promotion.pity === 'object' && !Array.isArray(promotion.pity)
      ? (promotion.pity as Record<string, unknown>)
      : null
  // docs/218 模式二：每日免费（promotion.dailyFreeSpins）
  const dailyFree =
    promotion?.dailyFreeSpins && typeof promotion.dailyFreeSpins === 'object' && !Array.isArray(promotion.dailyFreeSpins)
      ? (promotion.dailyFreeSpins as Record<string, unknown>)
      : null
  const ctas =
    promotion?.ctas && typeof promotion.ctas === 'object' && !Array.isArray(promotion.ctas)
      ? (promotion.ctas as Record<string, unknown>)
      : null
  const afterWin =
    ctas?.after_win && typeof ctas.after_win === 'object' && !Array.isArray(ctas.after_win)
      ? (ctas.after_win as Record<string, unknown>)
      : null
  const afterLoss =
    ctas?.after_loss && typeof ctas.after_loss === 'object' && !Array.isArray(ctas.after_loss)
      ? (ctas.after_loss as Record<string, unknown>)
      : null

  const experience =
    promotion?.experience && typeof promotion.experience === 'object' && !Array.isArray(promotion.experience)
      ? (promotion.experience as Record<string, unknown>)
      : null
  const prizePanelMode = normalizePrizePanelMode(experience?.prizePanelMode ?? experience?.prize_panel_mode)
  const ritualPhrases = sanitizeRitualPhrasesForSave(
    (experience?.ritualPhrases ?? experience?.ritual_phrases) as string[] | undefined,
  )
  const ritualPhrasesText = ritualPhrases.join('\n')

  // docs/130：flashSale / flash_sale 兼容
  const flashRaw = promotion?.flashSale ?? promotion?.flash_sale
  const flashSale =
    flashRaw && typeof flashRaw === 'object' && !Array.isArray(flashRaw)
      ? (flashRaw as Record<string, unknown>)
      : null
  const enableFlashSale = flashSale?.enabled === true || flashSale?.enabled === 1 || flashSale?.enabled === 'true'
  const flashStockRaw = flashSale?.stockLimit ?? flashSale?.stock_limit
  let flashSaleStockLimit: number | null = null
  if (flashStockRaw !== null && flashStockRaw !== undefined && flashStockRaw !== '') {
    const n = Number(flashStockRaw)
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) flashSaleStockLimit = n
  }
  const flashMaxRaw = flashSale?.maxPerUser ?? flashSale?.max_per_user ?? 1
  const flashMaxN = Number(flashMaxRaw)
  const flashSaleMaxPerUser =
    Number.isFinite(flashMaxN) && Number.isInteger(flashMaxN) && flashMaxN >= 1 && flashMaxN <= 100
      ? flashMaxN
      : 1
  const flashSalePaymentRequired =
    flashSale?.paymentRequired === true ||
    flashSale?.payment_required === true ||
    flashSale?.paymentRequired === 1 ||
    flashSale?.payment_required === 1 ||
    flashSale?.paymentRequired === 'true' ||
    flashSale?.payment_required === 'true'
  const flashPriceRaw = flashSale?.priceCents ?? flashSale?.price_cents
  let flashSalePriceCents: number | null = null
  if (flashPriceRaw !== null && flashPriceRaw !== undefined && flashPriceRaw !== '') {
    const n = Number(flashPriceRaw)
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) flashSalePriceCents = n
  }
  const flashSaleCurrency = String(flashSale?.currency || 'cny').trim().toLowerCase().slice(0, 8) || 'cny'
  const flashSaleTitle = String(flashSale?.title || '').trim().slice(0, 100)
  const flashSaleImageUrl = String(flashSale?.imageUrl ?? flashSale?.image_url ?? '').trim().slice(0, 500)
  const rawPricingTiers = flashSale?.pricingTiers ?? flashSale?.pricing_tiers
  const flashSalePricingTiers: FlashSalePricingTier[] = Array.isArray(rawPricingTiers)
    ? rawPricingTiers.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const row = item as Record<string, unknown>
        const minQuantity = Number(row.minQuantity ?? row.min_quantity)
        const unitPriceCents = Number(row.unitPriceCents ?? row.unit_price_cents ?? row.priceCents ?? row.price_cents)
        if (!Number.isInteger(minQuantity) || minQuantity < 1 || minQuantity > 100) return []
        if (!Number.isInteger(unitPriceCents) || unitPriceCents < 1 || unitPriceCents > 100_000_000) return []
        return [{
          minQuantity,
          unitPriceCents,
          label: String(row.label || '').trim().slice(0, 32),
        }]
      })
    : []
  const flashSaleSalesMode = inferFlashSaleSalesMode(
    flashSalePaymentRequired,
    flashSaleMaxPerUser,
    flashSalePricingTiers,
  )

  const productUrl = String(productSrc?.url || '').trim()
  const enableProductLink = Boolean(productUrl)
  const enableViral = Boolean(viral?.enabled)
  const enableAfterWinCta = Boolean(String(afterWin?.url || '').trim())
  const enableAfterLossCta = Boolean(String(afterLoss?.url || '').trim())
  const hasExperience = prizePanelMode !== 'auto' || ritualPhrases.length > 0

  return {
    enableProductLink,
    productLink: {
      url: productUrl,
      title: String(productSrc?.title || ''),
      imageUrl: String(productSrc?.imageUrl || productSrc?.image_url || ''),
      price: String(productSrc?.price || productSrc?.priceText || ''),
    },
    enableViral,
    // instant 可能只存 extraSpins*：回填优先 entries，缺省用 spins（docs/122）
    viralExtraEntriesPerInvite: (() => {
      const entries = Number(viral?.extraEntriesPerInvite)
      const spins = Number(viral?.extraSpinsPerInvite)
      if (Number.isFinite(entries) && entries > 0) return Math.floor(entries)
      if (Number.isFinite(spins) && spins > 0) return Math.floor(spins)
      return 1
    })(),
    viralMaxExtraEntries: (() => {
      const entries = Number(viral?.maxExtraEntries)
      const spins = Number(viral?.maxExtraSpins)
      if (Number.isFinite(entries) && entries > 0) return Math.floor(entries)
      if (Number.isFinite(spins) && spins > 0) return Math.floor(spins)
      return 10
    })(),
    viralLeaderboardEnabled: viral?.leaderboardEnabled !== false,
    enablePity: pity?.enabled === true || pity?.enabled === 1 || pity?.enabled === 'true',
    pityThreshold: (() => {
      const n = Number(pity?.threshold)
      return Number.isFinite(n) && Number.isInteger(n) && n >= 2 && n <= 100 ? n : 3
    })(),
    enableDailyFreeSpins: dailyFree?.enabled === true || dailyFree?.enabled === 1 || dailyFree?.enabled === 'true',
    dailyFreeSpinsCount: (() => {
      const n = Number(dailyFree?.count)
      return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1
    })(),
    leaderboardRewardsText: formatLeaderboardRewardsText(
      Array.isArray(viral?.leaderboardRewards)
        ? (viral!.leaderboardRewards as Array<Record<string, unknown>>).flatMap((item) => {
            const rank = Number(item?.rank)
            const rewardValue = Number(item?.rewardValue)
            if (!Number.isInteger(rank) || rank < 1 || !Number.isInteger(rewardValue) || rewardValue < 1) return []
            return [{ rank, rewardValue }]
          })
        : null,
    ),
    // docs/217 推荐里程碑（promotion.referralRewards）：编辑回填防整包覆盖擦掉
    referralRewardsText: formatReferralRewardsText(
      Array.isArray(promotion?.referralRewards)
        ? (promotion!.referralRewards as Array<Record<string, unknown>>).flatMap((item) => {
            const requireCount = Number(item?.requireCount)
            const rewardValue = Number(item?.rewardValue)
            if (!Number.isInteger(requireCount) || requireCount < 1 || !Number.isInteger(rewardValue) || rewardValue < 1) return []
            return [{ requireCount, rewardValue }]
          })
        : null,
    ),
    enableAfterWinCta,
    afterWinCtaUrl: String(afterWin?.url || ''),
    afterWinCtaTitle: String(afterWin?.title || ''),
    enableAfterLossCta,
    afterLossCtaUrl: String(afterLoss?.url || ''),
    afterLossCtaTitle: String(afterLoss?.title || ''),
    prizePanelMode,
    ritualPhrasesText,
    enableFlashSale,
    flashSaleSessionLabel: String(flashSale?.sessionLabel ?? flashSale?.session_label ?? '').trim().slice(0, 32),
    flashSaleSalesMode,
    flashSaleStockLimit,
    flashSaleMaxPerUser,
    flashSaleCtaLabel: String(flashSale?.ctaLabel ?? flashSale?.cta_label ?? '').trim().slice(0, 12) || '抢',
    flashSaleShowCountdown: flashSale?.showCountdown !== false && flashSale?.show_countdown !== false,
    flashSaleShowProgress: flashSale?.showProgress !== false && flashSale?.show_progress !== false,
    flashSaleShowStock: flashSale?.showStock !== false && flashSale?.show_stock !== false,
    flashSalePaymentRequired,
    flashSalePriceCents,
    flashSaleCurrency,
    flashSaleTitle,
    flashSaleImageUrl,
    flashSalePricingTiers,
    hasGrowthConfig:
      enableProductLink ||
      enableViral ||
      enableAfterWinCta ||
      enableAfterLossCta ||
      hasExperience ||
      enableFlashSale ||
      pity?.enabled === true ||
      pity?.enabled === 1 ||
      pity?.enabled === 'true' ||
      dailyFree?.enabled === true ||
      dailyFree?.enabled === 1 ||
      dailyFree?.enabled === 'true' ||
      (Array.isArray(viral?.leaderboardRewards) && viral!.leaderboardRewards.length > 0) ||
      (Array.isArray(promotion?.referralRewards) && promotion!.referralRewards.length > 0),
  }
}

/**
 * 构造提交用的 promotionConfig（创建 / 编辑）。
 * - 创建且无增长：undefined（后端落 "{}"）
 * - 编辑且无增长：显式关闭包，避免 PATCH 不带字段导致旧裂变关不掉
 * - 有增长：整包覆盖（依赖编辑已回填，避免只开商品却抹掉 viral）
 */
export function buildPromotionConfigPayload(form: {
  enableProductLink?: boolean
  productLink?: { url?: string; title?: string; imageUrl?: string; price?: string }
  enableViral?: boolean
  viralExtraEntriesPerInvite?: number
  viralMaxExtraEntries?: number
  viralLeaderboardEnabled?: boolean
  enableAfterWinCta?: boolean
  afterWinCtaUrl?: string
  afterWinCtaTitle?: string
  enableAfterLossCta?: boolean
  afterLossCtaUrl?: string
  afterLossCtaTitle?: string
  /** docs/218 保底（仅 instant） */
  enablePity?: boolean
  pityThreshold?: number | null
  /** docs/218 每日免费（仅 instant） */
  enableDailyFreeSpins?: boolean
  dailyFreeSpinsCount?: number | null
  /** docs/218 排行榜奖励明细（多行 "名次:次数"） */
  leaderboardRewardsText?: string | null
  /** docs/217 推荐里程碑（多行 "邀请数:次数"，仅 instant） */
  referralRewardsText?: string | null
  /** instant 时双写 extraSpins*，与 runtime grant 对齐（docs/122） */
  resultMode?: string | null
  /** docs/128 游戏壳 */
  prizePanelMode?: string | null
  ritualPhrasesText?: string | null
  ritualPhrases?: string[] | null
  /** docs/130 秒杀壳 */
  enableFlashSale?: boolean
  flashSaleSessionLabel?: string | null
  flashSaleSalesMode?: FlashSaleSalesMode | null
  flashSaleStockLimit?: number | null
  flashSaleMaxPerUser?: number | null
  flashSaleCtaLabel?: string | null
  flashSaleShowCountdown?: boolean
  flashSaleShowProgress?: boolean
  flashSaleShowStock?: boolean
  flashSalePaymentRequired?: boolean
  flashSalePriceCents?: number | null
  flashSaleCurrency?: string | null
  flashSaleTitle?: string | null
  flashSaleImageUrl?: string | null
  flashSalePricingTiers?: FlashSalePricingTier[] | null
}, opts: { isEditing: boolean }): Record<string, unknown> | undefined {
  const hasProduct = Boolean(form.enableProductLink && form.productLink?.url)
  const hasViral = Boolean(form.enableViral)
  const hasWinCta = Boolean(form.enableAfterWinCta && form.afterWinCtaUrl)
  const hasLossCta = Boolean(form.enableAfterLossCta && form.afterLossCtaUrl)
  const hasFlashSale = Boolean(form.enableFlashSale)
  // docs/218 模式一/二/三开关：仅 instant 生效；编辑态缺省回填，避免整包覆盖时擦掉已有配置
  const isInstantMode = String(form.resultMode || '').trim() === 'instant'
  const hasPity = isInstantMode && form.enablePity === true
  const hasDailyFree = isInstantMode && form.enableDailyFreeSpins === true
  const leaderboardRewards = parseLeaderboardRewardsText(form.leaderboardRewardsText)
  const hasLeaderboardRewards = leaderboardRewards.length > 0
  // docs/217 推荐里程碑（仅 instant 生效；编辑回填缺省保留）
  const referralRewards = parseReferralRewardsText(form.referralRewardsText)
  const hasReferralRewards = isInstantMode && referralRewards.length > 0
  const hasGrowth =
    hasProduct || hasViral || hasWinCta || hasLossCta || hasFlashSale || hasPity || hasDailyFree || hasLeaderboardRewards || hasReferralRewards

  const prizePanelMode = normalizePrizePanelMode(form.prizePanelMode)
  const ritualPhrases = sanitizeRitualPhrasesForSave(
    form.ritualPhrases ?? form.ritualPhrasesText ?? '',
  )
  // 非默认壳配置，或编辑态始终带 experience，避免二次保存把仪式短语/面板模式静默擦掉（docs/128）
  const hasCustomExperience = prizePanelMode !== 'auto' || ritualPhrases.length > 0
  const experienceBlock =
    hasCustomExperience || opts.isEditing
      ? {
          experience: {
            prizePanelMode,
            ...(ritualPhrases.length > 0 ? { ritualPhrases } : {}),
          },
        }
      : {}

  // 秒杀块：仅 enabled 时写出；编辑关闭则不写 flashSale，旧配置会被整包覆盖掉
  let flashSaleBlock: Record<string, unknown> = {}
  if (hasFlashSale) {
    const stockRaw = form.flashSaleStockLimit
    let stockLimit: number | undefined
    if (stockRaw !== null && stockRaw !== undefined && stockRaw !== ('' as unknown)) {
      const n = Number(stockRaw)
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 1_000_000) {
        stockLimit = n
      }
    }
    const maxPer = Number(form.flashSaleMaxPerUser ?? 1)
    const maxPerUser =
      Number.isFinite(maxPer) && Number.isInteger(maxPer) && maxPer >= 1 && maxPer <= 100 ? maxPer : 1
    const cta = String(form.flashSaleCtaLabel || '').trim().slice(0, 12) || '抢'
    const inferredMode = inferFlashSaleSalesMode(
      form.flashSalePaymentRequired === true,
      Number(form.flashSaleMaxPerUser ?? 1),
      Array.isArray(form.flashSalePricingTiers) ? form.flashSalePricingTiers : [],
    )
    const salesMode = form.flashSaleSalesMode || inferredMode
    const paymentRequired = salesMode !== 'redirect'
    const effectiveMaxPerUser = salesMode === 'direct_single' ? 1 : maxPerUser
    const priceRaw = form.flashSalePriceCents
    let priceCents: number | null = null
    if (priceRaw !== null && priceRaw !== undefined && priceRaw !== ('' as unknown)) {
      const n = Number(priceRaw)
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 100_000_000) {
        priceCents = n
      }
    }
    const currency = String(form.flashSaleCurrency || 'cny').trim().toLowerCase().slice(0, 8) || 'cny'
    const title = String(form.flashSaleTitle || '').trim().slice(0, 100)
    const imageUrl = String(form.flashSaleImageUrl || '').trim().slice(0, 500)
    const pricingTiers = Array.isArray(form.flashSalePricingTiers)
      ? form.flashSalePricingTiers
          .slice(0, 8)
          .flatMap((tier) => {
            const minQuantity = Number(tier?.minQuantity)
            const unitPriceCents = Number(tier?.unitPriceCents)
            if (!Number.isInteger(minQuantity) || minQuantity < 1 || minQuantity > effectiveMaxPerUser) return []
            if (!Number.isInteger(unitPriceCents) || unitPriceCents < 1 || unitPriceCents > 100_000_000) return []
            return [{
              minQuantity,
              unitPriceCents,
              label: String(tier?.label || '').trim().slice(0, 32),
            }]
          })
          .sort((a, b) => a.minQuantity - b.minQuantity)
      : []
    flashSaleBlock = {
      flashSale: {
        enabled: true,
        sessionLabel: String(form.flashSaleSessionLabel || '').trim().slice(0, 32),
        ...(stockLimit != null ? { stockLimit } : {}),
        maxPerUser: effectiveMaxPerUser,
        ctaLabel: cta,
        showCountdown: form.flashSaleShowCountdown !== false,
        showProgress: form.flashSaleShowProgress !== false,
        showStock: form.flashSaleShowStock !== false,
        ...(paymentRequired
          ? {
              paymentRequired: true,
              ...(priceCents != null ? { priceCents } : {}),
              currency,
              ...(title ? { title } : {}),
              ...(imageUrl ? { imageUrl } : {}),
              ...(salesMode === 'direct_bulk' && pricingTiers.length > 0 ? { pricingTiers } : {}),
            }
          : {}),
      },
    }
  }

  if (!hasGrowth && !hasCustomExperience) {
    return opts.isEditing
      ? {
          version: 1,
          enabled: false,
          kind: 'destination',
          placement: 'after_join',
          // 编辑清空增长时仍写 auto，明确回到默认壳策略
          experience: { prizePanelMode: 'auto' },
        }
      : undefined
  }

  // 仅有体验壳配置、无导流裂变秒杀：仍落 promotion 包，避免 experience 无处可存
  if (!hasGrowth && hasCustomExperience) {
    return {
      version: 1,
      enabled: true,
      kind: 'destination',
      placement: 'after_join',
      ...experienceBlock,
    }
  }

  const perInvite = form.viralExtraEntriesPerInvite || 1
  const maxExtra = form.viralMaxExtraEntries || 10
  const isInstant = String(form.resultMode || '').trim() === 'instant'

  // docs/218 模式一/二：保底与每日免费仅 instant 生效
  let pityBlock: Record<string, unknown> = {}
  if (hasPity) {
    const threshold = Math.floor(Number(form.pityThreshold) || 3)
    pityBlock = {
      pity: {
        enabled: true,
        threshold: Math.min(Math.max(threshold, 2), 100),
      },
    }
  }
  let dailyFreeBlock: Record<string, unknown> = {}
  if (hasDailyFree) {
    const count = Math.floor(Number(form.dailyFreeSpinsCount) || 1)
    dailyFreeBlock = {
      dailyFreeSpins: {
        enabled: true,
        count: Math.min(Math.max(count, 1), 10),
      },
    }
  }
  // docs/217 推荐里程碑：promotion.referralRewards（仅 instant，运行时 normalize 过滤）
  let referralRewardsBlock: Record<string, unknown> = {}
  if (hasReferralRewards) {
    referralRewardsBlock = {
      referralRewards: referralRewards.map((r) => ({
        requireCount: r.requireCount,
        rewardType: 'bonus_spin',
        rewardValue: r.rewardValue,
      })),
    }
  }

  return {
    version: 1,
    enabled: true,
    kind: 'destination',
    placement: 'after_join',
    ...(hasProduct
      ? {
          destination: {
            url: form.productLink!.url,
            title: form.productLink!.title || '',
            imageUrl: form.productLink!.imageUrl || '',
            priceText: form.productLink!.price || '',
          },
          tracking: { enabled: true },
        }
      : {}),
    ...(hasViral
      ? {
          viral: {
            enabled: true,
            // 发布预检仍读 extraEntries*；instant runtime 优先 extraSpins*（缺省回退 entries）
            extraEntriesPerInvite: perInvite,
            maxExtraEntries: maxExtra,
            ...(isInstant
              ? {
                  extraSpinsPerInvite: perInvite,
                  maxExtraSpins: maxExtra,
                }
              : {}),
            leaderboardEnabled: form.viralLeaderboardEnabled ?? true,
            // docs/218 模式三：排行榜奖励明细（rank:spins 数组，运行时归一化过滤）
            ...(hasLeaderboardRewards
              ? {
                  leaderboardRewards: leaderboardRewards.map((r) => ({
                    rank: r.rank,
                    rewardType: 'bonus_spin',
                    rewardValue: r.rewardValue,
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...pityBlock,
    ...dailyFreeBlock,
    ...referralRewardsBlock,
    ctas: {
      ...(hasWinCta
        ? { after_win: { url: form.afterWinCtaUrl, title: form.afterWinCtaTitle || '' } }
        : {}),
      ...(hasLossCta
        ? { after_loss: { url: form.afterLossCtaUrl, title: form.afterLossCtaTitle || '' } }
        : {}),
    },
    ...experienceBlock,
    ...flashSaleBlock,
  }
}
