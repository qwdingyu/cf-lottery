export type FlashSaleDirectChecklistKey =
  | 'product'
  | 'price'
  | 'stock'
  | 'payment'
  | 'codePrize'
  | 'cta'
  | 'lotteryPaymentConflict'

export interface FlashSaleDirectChecklistItem {
  key: FlashSaleDirectChecklistKey
  done: boolean
  labelKey: string
  /**
   * error 级条目：配置与后端发布红线冲突，保存后发布预检必拒。
   * 与普通「未完成」区分：普通项提示补齐即可，error 项提示「此组合不可发布」。
   */
  error?: boolean
  /** 与后端 publish-check code 对齐的稳定标识（如 promotion.lottery_payment.conflict），便于测试与排障 */
  code?: string
}

export interface FlashSaleDirectChecklistInput {
  enableFlashSale?: boolean
  flashSaleSalesMode?: 'redirect' | 'direct_single' | 'direct_bulk' | null
  flashSalePaymentRequired?: boolean
  flashSalePriceCents?: number | null
  flashSaleStockLimit?: number | null
  flashSaleTitle?: string | null
  maxParticipants?: number | null
  /**
   * 活动类型：lottery + 直付秒杀 是发布红线
   * （对齐后端 publish-check 的 promotion.lottery_payment.conflict，docs/166）
   */
  activityKind?: string | null
  /** 表单商品链接字段（legacy productLink 列 / promotion.destination 同源） */
  productLink?: { url?: string | null; title?: string | null }
  /** promotionConfig.destination（导流落地页） */
  destination?: { url?: string | null }
  /** promotionConfig.ctas.after_win（中奖后导流 CTA） */
  afterWin?: { url?: string | null }
  tiers?: Array<{ prizeId?: string | null }>
  prizeOptions?: Array<{ id?: string | null; prizeType?: string | null; active?: number | null }>
}

function positiveInteger(value: unknown): boolean {
  const n = Number(value || 0)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0
}

/**
 * 导流 URL 安全性校验（纯函数，便于单测）。
 *
 * 为什么独立成函数：与后端 publish-check-service.ts 的 isSafeHttpUrl 判据对齐
 * （http/https 协议、排除 localhost / 127.0.0.1、超长 URL 拒绝），
 * 保证前端清单与后端发布预检「同一条红线」，避免前端提示可通过、后端却拒绝。
 */
export function isSafeHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return false
    // 与后端 isSafeHttpUrl 对齐：带凭据的链接容易在日志、分享消息或浏览器历史中泄露账号密码，
    // 不能作为活动导流地址。此前前端误判为可用，直到发布预检才会失败。
    if (url.username || url.password) return false
    if (url.href.length > 2000) return false
    return true
  } catch {
    return false
  }
}

export function buildFlashSaleDirectChecklist(input: FlashSaleDirectChecklistInput): FlashSaleDirectChecklistItem[] {
  const isDirect = input.flashSaleSalesMode
    ? input.flashSaleSalesMode !== 'redirect'
    : input.flashSalePaymentRequired === true
  const selectedPrizeIds = new Set((input.tiers || []).map((tier) => tier.prizeId).filter(Boolean))
  // 与后端 publish-check（validateFlashSalePayment）保持一致：
  // ① 仅直付模式（paymentRequired=true）要求恰好绑定 1 个 active 卡密奖品（发卡目标）；
  // ② 导流模式（不直付）不要求卡密奖品（后端不检查，用户无需绑定）。
  // 奖品选择器是服务端分页搜索，当前已选奖品可能不在初始第一页。
  // 调用方会合并初始列表和已选奖品缓存；这里仍按 id 去重，避免同一奖品在两处出现时被误判为“绑定多个卡密池”。
  const selectedCodePrizeIds = new Set(
    (input.prizeOptions || [])
      .filter((prize) =>
        selectedPrizeIds.has(prize.id)
        && String(prize.prizeType || '').trim() === 'code'
        && Number(prize.active) !== 0,
      )
      .map((prize) => String(prize.id)),
  )
  const selectedCodePrizeCount = selectedCodePrizeIds.size
  const needCodePrize = input.enableFlashSale === true && isDirect

  // 导流 URL 检查：productLink.url / destination.url / after_win.url 任一为安全 http(s) 即可。
  // 直付模式由站内支付承接，不要求外部商品链接；只有展示/导流模式才把链接作为发布必填。
  // 为什么不再看 title：后端 publish-check 只认「安全的导流/购买链接」，
  // 光填商品名没有落地页，用户抢到后无法下单（flash_sale.destination.missing）。
  const hasSafeShopLink =
    isSafeHttpUrl(input.productLink?.url) ||
    isSafeHttpUrl(input.destination?.url) ||
    isSafeHttpUrl(input.afterWin?.url)

  // 红线：lottery + 直付秒杀 → 后端 promotion.lottery_payment.conflict 必拒（docs/222）。
  // 历史开奖执行虽额外过滤未付款参与者，但抽奖开奖与付款即履约是两套结果和库存归属模型。
  const lotteryPaymentConflict =
    input.activityKind === 'lottery' && isDirect

  const items: FlashSaleDirectChecklistItem[] = []
  if (lotteryPaymentConflict) {
    // error 级条目放最前：运营一眼先看到「此组合不可发布」，再补其他项没有意义
    items.push({
      key: 'lotteryPaymentConflict',
      done: false,
      error: true,
      code: 'promotion.lottery_payment.conflict',
      labelKey: 'adminFlashSaleChecklistLotteryConflict',
    })
  }
  items.push(
    {
      key: 'product',
      done: isDirect || hasSafeShopLink,
      labelKey: 'adminFlashSaleChecklistProduct',
    },
    {
      key: 'price',
      done: positiveInteger(input.flashSalePriceCents),
      labelKey: 'adminFlashSaleChecklistPrice',
    },
    {
      key: 'stock',
      done: positiveInteger(input.flashSaleStockLimit) || positiveInteger(input.maxParticipants),
      labelKey: 'adminFlashSaleChecklistStock',
    },
    {
      key: 'payment',
      done: input.enableFlashSale === true && isDirect,
      labelKey: 'adminFlashSaleChecklistPayment',
    },
    {
      key: 'codePrize',
      // 直付模式才要求恰好 1 个卡密奖品；导流模式视为完成（与后端一致）
      done: !needCodePrize || selectedCodePrizeCount === 1,
      labelKey: 'adminFlashSaleChecklistCodePrize',
    },
    {
      key: 'cta',
      done: !isDirect || !String(input.afterWin?.url || '').trim(),
      error: isDirect && Boolean(String(input.afterWin?.url || '').trim()),
      code: isDirect && Boolean(String(input.afterWin?.url || '').trim())
        ? 'flash_sale.payment.cta_conflict'
        : undefined,
      labelKey: 'adminFlashSaleChecklistCtaConflict',
    },
  )
  return items
}
