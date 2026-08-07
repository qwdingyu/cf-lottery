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
  prizeOptions?: Array<{ id?: string | null; prizeType?: string | null }>
}

function positiveInteger(value: unknown): boolean {
  const n = Number(value || 0)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0
}

export function buildFlashSaleDirectChecklist(input: FlashSaleDirectChecklistInput): FlashSaleDirectChecklistItem[] {
  const selectedPrizeIds = new Set((input.tiers || []).map((tier) => tier.prizeId).filter(Boolean))
  const selectedCodePrizeCount = (input.prizeOptions || []).filter((prize) =>
    selectedPrizeIds.has(prize.id) && String(prize.prizeType || '').trim() === 'code',
  ).length

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
      done: selectedCodePrizeCount === 1,
      labelKey: 'adminFlashSaleChecklistCodePrize',
    },
  ]
}
