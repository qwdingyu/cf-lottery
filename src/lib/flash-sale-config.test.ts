/**
 * 秒杀配置纯函数测试（docs/130）
 */
import { describe, expect, it } from "vitest";
import {
  buildFlashSaleRuntime,
  calculateFlashSalePrice,
  parseFlashSaleConfig,
  resolveEffectiveStockLimit,
  shouldExposeFlashSale,
} from "./flash-sale-config";

describe("parseFlashSaleConfig", () => {
  it("未配置或未启用 → config null，无 issues", () => {
    expect(parseFlashSaleConfig("{}").config).toBeNull();
    expect(parseFlashSaleConfig({}).config).toBeNull();
    expect(parseFlashSaleConfig({ flashSale: { enabled: false } }).config).toBeNull();
    expect(parseFlashSaleConfig(null).config).toBeNull();
  });

  it("enabled=true 时清洗字段并给默认 cta", () => {
    const { config, issues } = parseFlashSaleConfig({
      flashSale: {
        enabled: true,
        sessionLabel: "  12:00场  ",
        stockLimit: 100,
        maxPerUser: 1,
        ctaLabel: "",
      },
    });
    expect(issues).toEqual([]);
    expect(config).toMatchObject({
      enabled: true,
      sessionLabel: "12:00场",
      stockLimit: 100,
      maxPerUser: 1,
      ctaLabel: "抢",
      paymentRequired: false,
      showCountdown: true,
      showProgress: true,
      showStock: true,
    });
  });

  it("解析 paymentRequired 与直付价格字段", () => {
    const { config, issues } = parseFlashSaleConfig({
      flashSale: {
        enabled: true,
        paymentRequired: true,
        priceCents: 9900,
        currency: "CNY",
        title: "秒杀卡密",
      },
    });
    expect(issues).toEqual([]);
    expect(config).toMatchObject({
      paymentRequired: true,
      priceCents: 9900,
      currency: "cny",
      title: "秒杀卡密",
    });
  });

  it("priceCents 必须是整数分，不能静默截断小数", () => {
    const { config, issues } = parseFlashSaleConfig({
      flashSale: {
        enabled: true,
        paymentRequired: true,
        priceCents: 9900.9,
      },
    });
    expect(config?.priceCents).toBeNull();
    expect(issues.some((i) => i.code === "flash_sale.price.invalid")).toBe(true);
  });

  it("兼容 flash_sale / snake_case", () => {
    const { config } = parseFlashSaleConfig(
      JSON.stringify({
        flash_sale: {
          enabled: true,
          session_label: "晚场",
          stock_limit: 50,
          max_per_user: 2,
          show_countdown: false,
          cta_label: "马上抢",
        },
      }),
    );
    expect(config).toMatchObject({
      enabled: true,
      sessionLabel: "晚场",
      stockLimit: 50,
      maxPerUser: 2,
      showCountdown: false,
      ctaLabel: "马上抢",
    });
  });

  it("非法 stockLimit / maxPerUser 产生 issues", () => {
    const badStock = parseFlashSaleConfig({ flashSale: { enabled: true, stockLimit: 0 } });
    expect(badStock.issues.some((i) => i.code === "flash_sale.stock_limit.invalid")).toBe(true);

    const badUser = parseFlashSaleConfig({ flashSale: { enabled: true, maxPerUser: 0 } });
    expect(badUser.issues.some((i) => i.code === "flash_sale.max_per_user.invalid")).toBe(true);
  });

  it("解析阶梯价并按 cliff 单价计算批量订单金额", () => {
    const { config, issues } = parseFlashSaleConfig({
      flashSale: {
        enabled: true,
        paymentRequired: true,
        priceCents: 9900,
        maxPerUser: 20,
        pricingTiers: [
          { minQuantity: 10, unitPriceCents: 7900, label: "批发价" },
          { minQuantity: 3, unitPriceCents: 8900, label: "小批量" },
        ],
      },
    });
    expect(issues).toEqual([]);
    expect(config?.pricingTiers).toEqual([
      { minQuantity: 3, unitPriceCents: 8900, label: "小批量" },
      { minQuantity: 10, unitPriceCents: 7900, label: "批发价" },
    ]);
    expect(calculateFlashSalePrice(config!, 2)).toMatchObject({ quantity: 2, unitPriceCents: 9900, amountCents: 19800 });
    expect(calculateFlashSalePrice(config!, 3)).toMatchObject({ quantity: 3, unitPriceCents: 8900, amountCents: 26700 });
    expect(calculateFlashSalePrice(config!, 12)).toMatchObject({ quantity: 12, unitPriceCents: 7900, amountCents: 94800 });
  });
});

describe("resolveEffectiveStockLimit / buildFlashSaleRuntime", () => {
  it("stockLimit 优先于 maxParticipants", () => {
    const cfg = parseFlashSaleConfig({
      flashSale: { enabled: true, stockLimit: 30 },
    }).config!;
    expect(resolveEffectiveStockLimit(cfg, 100)).toBe(30);
    expect(resolveEffectiveStockLimit(cfg, null)).toBe(30);
  });

  it("无 stockLimit 时回退 maxParticipants", () => {
    const cfg = parseFlashSaleConfig({ flashSale: { enabled: true } }).config!;
    expect(resolveEffectiveStockLimit(cfg, 80)).toBe(80);
    expect(resolveEffectiveStockLimit(cfg, null)).toBeNull();
  });

  it("进度与剩余按真实 claimed 计算，不造假", () => {
    const cfg = parseFlashSaleConfig({
      flashSale: { enabled: true, stockLimit: 100 },
    }).config!;
    const rt = buildFlashSaleRuntime(cfg, 48, null);
    expect(rt.claimed).toBe(48);
    expect(rt.remaining).toBe(52);
    expect(rt.progressPercent).toBe(48);
    expect(rt.effectiveStockLimit).toBe(100);
  });

  it("已抢超过上限时 remaining=0、progress=100", () => {
    const cfg = parseFlashSaleConfig({
      flashSale: { enabled: true, stockLimit: 10 },
    }).config!;
    const rt = buildFlashSaleRuntime(cfg, 15, null);
    expect(rt.remaining).toBe(0);
    expect(rt.progressPercent).toBe(100);
  });

  it("无限额时不展示假进度", () => {
    const cfg = parseFlashSaleConfig({ flashSale: { enabled: true } }).config!;
    const rt = buildFlashSaleRuntime(cfg, 9, null);
    expect(rt.remaining).toBeNull();
    expect(rt.progressPercent).toBe(0);
    expect(rt.claimed).toBe(9);
  });
});

describe("shouldExposeFlashSale", () => {
  it("仅 enabled 时为 true", () => {
    expect(shouldExposeFlashSale({ flashSale: { enabled: true } })).toBe(true);
    expect(shouldExposeFlashSale({ flashSale: { enabled: false } })).toBe(false);
    expect(shouldExposeFlashSale("{}")).toBe(false);
  });
});
