import { describe, expect, it } from 'vitest'
import { buildFlashSaleDirectChecklist, isSafeHttpUrl } from './flash-sale-readiness'

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
      // 3b 后 product 判定为「导流 URL 安全」：必须给合法落地链接，光填 title 不再算完成
      productLink: { url: 'https://shop.example.com/token-daily' },
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

  // ── docs/166 红线：lottery + 直付秒杀 发布必拒（对齐 promotion.lottery_payment.conflict） ──
  it('lottery + paymentRequired 时返回 error 级冲突条目（3a）', () => {
    const items = buildFlashSaleDirectChecklist({
      enableFlashSale: true,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
      activityKind: 'lottery',
      productLink: { url: 'https://shop.example.com/p/1' },
      tiers: [{ prizeId: 'active-code' }],
      prizeOptions: [{ id: 'active-code', prizeType: 'code', active: 1 }],
    })
    const conflict = items.find((item) => item.key === 'lotteryPaymentConflict')
    expect(conflict).toBeDefined()
    expect(conflict!.error).toBe(true)
    expect(conflict!.done).toBe(false)
    expect(conflict!.code).toBe('flash_sale.lottery_payment_conflict')
  })

  it('非 lottery（claim 直付）不产生冲突条目——与后端 claim 豁免一致（3a）', () => {
    const items = buildFlashSaleDirectChecklist({
      enableFlashSale: true,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
      activityKind: 'claim',
      productLink: { url: 'https://shop.example.com/p/1' },
      tiers: [{ prizeId: 'active-code' }],
      prizeOptions: [{ id: 'active-code', prizeType: 'code', active: 1 }],
    })
    expect(items.find((item) => item.key === 'lotteryPaymentConflict')).toBeUndefined()
  })

  it('lottery 未勾选直付时不产生冲突条目（3a）', () => {
    const items = buildFlashSaleDirectChecklist({
      enableFlashSale: true,
      flashSalePaymentRequired: false,
      activityKind: 'lottery',
    })
    expect(items.find((item) => item.key === 'lotteryPaymentConflict')).toBeUndefined()
  })

  // ── 导流 URL 安全判据（3b，对齐后端 isSafeHttpUrl / flash_sale.destination.missing） ──
  it('isSafeHttpUrl：合法 http/https 通过，非法协议/localhost/超长拒绝（3b）', () => {
    expect(isSafeHttpUrl('https://shop.example.com/p/1')).toBe(true)
    expect(isSafeHttpUrl('http://shop.example.com/p/1')).toBe(true)
    expect(isSafeHttpUrl(' https://shop.example.com/p/1 ')).toBe(true) // 首尾空白容忍
    expect(isSafeHttpUrl('ftp://shop.example.com/p/1')).toBe(false)
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('https://localhost/p/1')).toBe(false)
    expect(isSafeHttpUrl('https://127.0.0.1/p/1')).toBe(false)
    expect(isSafeHttpUrl('https://localhost:8443/p/1')).toBe(false)
    expect(isSafeHttpUrl('not-a-url')).toBe(false)
    expect(isSafeHttpUrl('')).toBe(false)
    expect(isSafeHttpUrl('   ')).toBe(false)
    expect(isSafeHttpUrl(null)).toBe(false)
    expect(isSafeHttpUrl(undefined)).toBe(false)
    expect(isSafeHttpUrl(42)).toBe(false)
    expect(isSafeHttpUrl(`https://shop.example.com/${'a'.repeat(2100)}`)).toBe(false) // 超长拒绝
  })

  it('product 检查要求安全导流 URL：productLink/destination/after_win 任一合法即通过（3b）', () => {
    const base = {
      enableFlashSale: true,
      flashSalePaymentRequired: false,
      flashSalePriceCents: 990,
      flashSaleStockLimit: 100,
    }
    // 商品链接合法 → 通过
    expect(doneMap({ ...base, productLink: { url: 'https://shop.example.com/p/1' } }).product).toBe(true)
    // destination 合法 → 通过（导流落地页路径）
    expect(doneMap({ ...base, destination: { url: 'https://land.example.com/join' } }).product).toBe(true)
    // after_win CTA 合法 → 通过
    expect(doneMap({ ...base, afterWin: { url: 'https://shop.example.com/buy/2' } }).product).toBe(true)
    // 只有 title 没有合法 URL → 不通过（后端 flash_sale.destination.missing 语义）
    expect(doneMap({ ...base, productLink: { url: '', title: 'AI 音箱' }, flashSaleTitle: '订单标题' }).product).toBe(false)
    // localhost 链接不算安全导流 → 不通过
    expect(doneMap({ ...base, productLink: { url: 'http://localhost:3000/p/1' } }).product).toBe(false)
    // 全缺 → 不通过
    expect(doneMap(base).product).toBe(false)
  })
})
