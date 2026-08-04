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
  /** 是否已有增长配置：编辑时应用来展开高级区 */
  hasGrowthConfig: boolean
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

  const productUrl = String(productSrc?.url || '').trim()
  const enableProductLink = Boolean(productUrl)
  const enableViral = Boolean(viral?.enabled)
  const enableAfterWinCta = Boolean(String(afterWin?.url || '').trim())
  const enableAfterLossCta = Boolean(String(afterLoss?.url || '').trim())

  return {
    enableProductLink,
    productLink: {
      url: productUrl,
      title: String(productSrc?.title || ''),
      imageUrl: String(productSrc?.imageUrl || productSrc?.image_url || ''),
      price: String(productSrc?.price || productSrc?.priceText || ''),
    },
    enableViral,
    viralExtraEntriesPerInvite: Number(viral?.extraEntriesPerInvite) > 0
      ? Math.floor(Number(viral!.extraEntriesPerInvite))
      : 1,
    viralMaxExtraEntries: Number(viral?.maxExtraEntries) > 0
      ? Math.floor(Number(viral!.maxExtraEntries))
      : 10,
    viralLeaderboardEnabled: viral?.leaderboardEnabled !== false,
    enableAfterWinCta,
    afterWinCtaUrl: String(afterWin?.url || ''),
    afterWinCtaTitle: String(afterWin?.title || ''),
    enableAfterLossCta,
    afterLossCtaUrl: String(afterLoss?.url || ''),
    afterLossCtaTitle: String(afterLoss?.title || ''),
    hasGrowthConfig: enableProductLink || enableViral || enableAfterWinCta || enableAfterLossCta,
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
}, opts: { isEditing: boolean }): Record<string, unknown> | undefined {
  const hasProduct = Boolean(form.enableProductLink && form.productLink?.url)
  const hasViral = Boolean(form.enableViral)
  const hasWinCta = Boolean(form.enableAfterWinCta && form.afterWinCtaUrl)
  const hasLossCta = Boolean(form.enableAfterLossCta && form.afterLossCtaUrl)
  const hasGrowth = hasProduct || hasViral || hasWinCta || hasLossCta

  if (!hasGrowth) {
    return opts.isEditing
      ? { version: 1, enabled: false, kind: 'destination', placement: 'after_join' }
      : undefined
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
            extraEntriesPerInvite: form.viralExtraEntriesPerInvite || 1,
            maxExtraEntries: form.viralMaxExtraEntries || 10,
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
  }
}
