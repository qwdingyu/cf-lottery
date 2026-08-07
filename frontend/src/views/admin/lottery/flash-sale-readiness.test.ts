import { describe, expect, it } from 'vitest'
import { buildFlashSaleDirectChecklist } from './flash-sale-readiness'

function doneMap(input: Parameters<typeof buildFlashSaleDirectChecklist>[0]) {
  return Object.fromEntries(buildFlashSaleDirectChecklist(input).map((item) => [item.key, item.done]))
}

describe('flash-sale-readiness', () => {
  it('直付秒杀发布清单要求商品、价格、名额、直付开关和唯一卡密奖品', () => {
    expect(doneMap({
      enableFlashSale: true,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
      flashSaleTitle: 'Token 日卡',
      tiers: [{ prizeId: 'code-prize' }],
      prizeOptions: [{ id: 'code-prize', prizeType: 'code' }],
    })).toMatchObject({
      product: true,
      price: true,
      stock: true,
      payment: true,
      codePrize: true,
    })
  })

  it('卡密奖品必须恰好一个，避免支付后发卡目标不确定', () => {
    expect(doneMap({
      enableFlashSale: true,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      maxParticipants: 100,
      productLink: { title: 'Token 日卡' },
      tiers: [{ prizeId: 'a' }, { prizeId: 'b' }],
      prizeOptions: [{ id: 'a', prizeType: 'code' }, { id: 'b', prizeType: 'code' }],
    }).codePrize).toBe(false)
  })
})
