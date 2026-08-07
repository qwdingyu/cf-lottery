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

export type GrowthFieldsFromDraw = {
  enableProductLink: boolean
  productLink: GrowthProductLink
  enableViral: boolean
  viralExtraEntriesPerInvite: number
  viralMaxExtraEntries: number
  viralLeaderboardEnabled: boolean
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
   * 秒杀壳配置（docs/130）：写入 promotion.flashSale
   * 仅影响展示与发布预检；支付/发卡仍在 cf-shop
   */
  enableFlashSale: boolean
  flashSaleSessionLabel: string
  flashSaleStockLimit: number | null
  flashSaleMaxPerUser: number
  flashSaleCtaLabel: string
  flashSaleShowCountdown: boolean
  flashSaleShowProgress: boolean
  flashSaleShowStock: boolean
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
    flashSaleStockLimit,
    flashSaleMaxPerUser,
    flashSaleCtaLabel: String(flashSale?.ctaLabel ?? flashSale?.cta_label ?? '').trim().slice(0, 12) || '抢',
    flashSaleShowCountdown: flashSale?.showCountdown !== false && flashSale?.show_countdown !== false,
    flashSaleShowProgress: flashSale?.showProgress !== false && flashSale?.show_progress !== false,
    flashSaleShowStock: flashSale?.showStock !== false && flashSale?.show_stock !== false,
    hasGrowthConfig:
      enableProductLink ||
      enableViral ||
      enableAfterWinCta ||
      enableAfterLossCta ||
      hasExperience ||
      enableFlashSale,
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
  /** instant 时双写 extraSpins*，与 runtime grant 对齐（docs/122） */
  resultMode?: string | null
  /** docs/128 游戏壳 */
  prizePanelMode?: string | null
  ritualPhrasesText?: string | null
  ritualPhrases?: string[] | null
  /** docs/130 秒杀壳 */
  enableFlashSale?: boolean
  flashSaleSessionLabel?: string | null
  flashSaleStockLimit?: number | null
  flashSaleMaxPerUser?: number | null
  flashSaleCtaLabel?: string | null
  flashSaleShowCountdown?: boolean
  flashSaleShowProgress?: boolean
  flashSaleShowStock?: boolean
}, opts: { isEditing: boolean }): Record<string, unknown> | undefined {
  const hasProduct = Boolean(form.enableProductLink && form.productLink?.url)
  const hasViral = Boolean(form.enableViral)
  const hasWinCta = Boolean(form.enableAfterWinCta && form.afterWinCtaUrl)
  const hasLossCta = Boolean(form.enableAfterLossCta && form.afterLossCtaUrl)
  const hasFlashSale = Boolean(form.enableFlashSale)
  const hasGrowth = hasProduct || hasViral || hasWinCta || hasLossCta || hasFlashSale

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
    flashSaleBlock = {
      flashSale: {
        enabled: true,
        sessionLabel: String(form.flashSaleSessionLabel || '').trim().slice(0, 32),
        ...(stockLimit != null ? { stockLimit } : {}),
        maxPerUser,
        ctaLabel: cta,
        showCountdown: form.flashSaleShowCountdown !== false,
        showProgress: form.flashSaleShowProgress !== false,
        showStock: form.flashSaleShowStock !== false,
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
          },
        }
      : {}),
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
