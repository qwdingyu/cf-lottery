export type FlashSaleDirectChecklistKey = 'product' | 'price' | 'stock' | 'payment' | 'codePrize'

export interface FlashSaleDirectChecklistItem {
  key: FlashSaleDirectChecklistKey
  done: boolean
  labelKey: string
}

export interface FlashSaleDirectChecklistInput {
  enableFlashSale?: boolean
  flashSalePaymentRequired?: boolean
  flashSalePriceCents?: number | null
  flashSaleStockLimit?: number | null
  flashSaleTitle?: string | null
  maxParticipants?: number | null
  productLink?: { title?: string | null }
  tiers?: Array<{ prizeId?: string | null }>
  prizeOptions?: Array<{ id?: string | null; prizeType?: string | null; active?: number | null }>
}

function positiveInteger(value: unknown): boolean {
  const n = Number(value || 0)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0
}

export function buildFlashSaleDirectChecklist(input: FlashSaleDirectChecklistInput): FlashSaleDirectChecklistItem[] {
  const selectedPrizeIds = new Set((input.tiers || []).map((tier) => tier.prizeId).filter(Boolean))
  // 与后端 publish-check（validateFlashSalePayment）保持一致：
  // ① 仅直付模式（paymentRequired=true）要求恰好绑定 1 个 active 卡密奖品（发卡目标）；
  // ② 导流模式（不直付）不要求卡密奖品（后端不检查，用户无需绑定）。
  const selectedCodePrizeCount = (input.prizeOptions || []).filter((prize) =>
    selectedPrizeIds.has(prize.id)
    && String(prize.prizeType || '').trim() === 'code'
    && Number(prize.active) !== 0,
  ).length
  const needCodePrize = input.enableFlashSale === true && input.flashSalePaymentRequired === true

  return [
    {
      key: 'product',
      done: Boolean(String(input.productLink?.title || input.flashSaleTitle || '').trim()),
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
      done: input.enableFlashSale === true && input.flashSalePaymentRequired === true,
      labelKey: 'adminFlashSaleChecklistPayment',
    },
    {
      key: 'codePrize',
      // 直付模式才要求恰好 1 个卡密奖品；导流模式视为完成（与后端一致）
      done: !needCodePrize || selectedCodePrizeCount === 1,
      labelKey: 'adminFlashSaleChecklistCodePrize',
    },
  ]
}
