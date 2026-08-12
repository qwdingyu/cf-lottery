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

  it('导流模式（不直付）不要求卡密奖品——与后端 validateFlashSalePayment 一致（d1c301a）', () => {
    expect(doneMap({
      enableFlashSale: true,
      flashSalePaymentRequired: false,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
      flashSaleTitle: 'Token 日卡',
      // 未绑定任何奖品
      tiers: [],
      prizeOptions: [],
    }).codePrize).toBe(true)
  })

  it('非 active 卡密奖品不计入 codePrize 检查——与后端 publish-check 一致（b6bd932）', () => {
    // 绑定 1 个 inactive 卡密 + 1 个 active 非卡密：直付模式应视为未绑定可用卡密
    expect(doneMap({
      enableFlashSale: true,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
      flashSaleTitle: 'Token 日卡',
      tiers: [{ prizeId: 'inactive-code' }, { prizeId: 'active-gift' }],
      prizeOptions: [
        { id: 'inactive-code', prizeType: 'code', active: 0 },
        { id: 'active-gift', prizeType: 'gift', active: 1 },
      ],
    }).codePrize).toBe(false)
  })

  it('直付模式恰好 1 个 active 卡密奖品时通过', () => {
    expect(doneMap({
      enableFlashSale: true,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
      flashSaleTitle: 'Token 日卡',
      tiers: [{ prizeId: 'active-code' }],
      prizeOptions: [{ id: 'active-code', prizeType: 'code', active: 1 }],
    }).codePrize).toBe(true)
  })
})
