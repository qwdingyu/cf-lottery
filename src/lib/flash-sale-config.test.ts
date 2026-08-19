/**
 * 秒杀配置纯函数测试（docs/130）
 */
import { describe, expect, it } from "vitest";
import {
  buildFlashSaleRuntime,
  calculateFlashSalePrice,
  normalizeFlashSaleQuantity,
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

/**
 * normalizeFlashSaleQuantity：购买数量清洗函数。
 * 策略：无效输入 → 1；低于 1 → 1；高于 maxPerUser → 截断到 maxPerUser。
 */
describe("normalizeFlashSaleQuantity", () => {
  const makeCfg = (maxPerUser: number) =>
    parseFlashSaleConfig({
      flashSale: { enabled: true, maxPerUser, paymentRequired: true, priceCents: 9900, currency: "cny" },
    }).config!;

  it("无效输入（NaN / null / undefined / 对象）→ 默认 1", () => {
    const cfg = makeCfg(10);
    expect(normalizeFlashSaleQuantity(NaN, cfg)).toBe(1);
    expect(normalizeFlashSaleQuantity(null, cfg)).toBe(1);
    expect(normalizeFlashSaleQuantity(undefined, cfg)).toBe(1);
    expect(normalizeFlashSaleQuantity({}, cfg)).toBe(1);
  });

  it("数字字符串 → 解析为整数", () => {
    const cfg = makeCfg(10);
    expect(normalizeFlashSaleQuantity("5", cfg)).toBe(5);
    expect(normalizeFlashSaleQuantity("3.9", cfg)).toBe(3);
  });

  it("超过 maxPerUser → 截断到 maxPerUser", () => {
    const cfg = makeCfg(5);
    expect(normalizeFlashSaleQuantity(10, cfg)).toBe(5);
    expect(normalizeFlashSaleQuantity(6, cfg)).toBe(5);
  });

  it("低于 1 → 截断到 1", () => {
    const cfg = makeCfg(10);
    expect(normalizeFlashSaleQuantity(0, cfg)).toBe(1);
    expect(normalizeFlashSaleQuantity(-1, cfg)).toBe(1);
    expect(normalizeFlashSaleQuantity(-999, cfg)).toBe(1);
  });

  it("maxPerUser=0 时安全截断到 1（防御性兜底）", () => {
    const cfg = makeCfg(0);
    // maxPerUser=0 在 parse 阶段会被 positiveInt 拒绝并置为 1
    expect(cfg.maxPerUser).toBe(1);
    expect(normalizeFlashSaleQuantity(5, cfg)).toBe(1);
  });

  it("正常范围内保留原值", () => {
    const cfg = makeCfg(100);
    expect(normalizeFlashSaleQuantity(1, cfg)).toBe(1);
    expect(normalizeFlashSaleQuantity(50, cfg)).toBe(50);
    expect(normalizeFlashSaleQuantity(100, cfg)).toBe(100);
  });
});

/**
 * calculateFlashSalePrice：阶梯价格计算，覆盖无阶梯、零/负数量、截断、边界命中等场景。
 */
describe("calculateFlashSalePrice", () => {
  const makeCfg = (tiers: Array<{ minQuantity: number; unitPriceCents: number; label: string }>, maxPerUser = 20, priceCents = 9900) =>
    parseFlashSaleConfig({
      flashSale: {
        enabled: true, paymentRequired: true, priceCents, maxPerUser, currency: "cny",
        pricingTiers: tiers,
      },
    }).config!;

  it("无阶梯时使用 basePrice", () => {
    const cfg = makeCfg([], 20, 9900);
    const result = calculateFlashSalePrice(cfg, 5);
    expect(result).toMatchObject({ quantity: 5, unitPriceCents: 9900, amountCents: 49500, tierLabel: "" });
  });

  it("数量为 0 → 截断到 1，basePrice 计算", () => {
    const cfg = makeCfg([{ minQuantity: 3, unitPriceCents: 8000, label: "批发" }], 20, 9900);
    const result = calculateFlashSalePrice(cfg, 0);
    expect(result).toMatchObject({ quantity: 1, unitPriceCents: 9900, amountCents: 9900 });
  });

  it("负数数量 → 截断到 1", () => {
    const cfg = makeCfg([{ minQuantity: 3, unitPriceCents: 8000, label: "批发" }], 20, 9900);
    const result = calculateFlashSalePrice(cfg, -5);
    expect(result).toMatchObject({ quantity: 1, unitPriceCents: 9900, amountCents: 9900 });
  });

  it("数量超过所有阶梯 → 取最高阶梯单价", () => {
    const cfg = makeCfg([
      { minQuantity: 1, unitPriceCents: 9900, label: "原价" },
      { minQuantity: 10, unitPriceCents: 7900, label: "批发" },
    ], 50, 9900);
    const result = calculateFlashSalePrice(cfg, 50);
    expect(result).toMatchObject({ quantity: 50, unitPriceCents: 7900, amountCents: 395000, tierLabel: "批发" });
  });

  it("数量恰好等于阶梯边界 → 命中该阶梯", () => {
    const cfg = makeCfg([
      { minQuantity: 1, unitPriceCents: 9900, label: "原价" },
      { minQuantity: 5, unitPriceCents: 8900, label: "中批量" },
      { minQuantity: 10, unitPriceCents: 7900, label: "批发" },
    ], 50, 9900);
    expect(calculateFlashSalePrice(cfg, 5)).toMatchObject({ unitPriceCents: 8900, amountCents: 44500, tierLabel: "中批量" });
    expect(calculateFlashSalePrice(cfg, 10)).toMatchObject({ unitPriceCents: 7900, amountCents: 79000, tierLabel: "批发" });
  });

  it("数量在两个阶梯之间 → 取较低（满足条件）的阶梯", () => {
    const cfg = makeCfg([
      { minQuantity: 1, unitPriceCents: 9900, label: "原价" },
      { minQuantity: 5, unitPriceCents: 8900, label: "中批量" },
      { minQuantity: 10, unitPriceCents: 7900, label: "批发" },
    ], 50, 9900);
    // 数量 7 满足 minQuantity=5，不满足 minQuantity=10 → 应命中中批量
    expect(calculateFlashSalePrice(cfg, 7)).toMatchObject({ unitPriceCents: 8900, amountCents: 62300, tierLabel: "中批量" });
  });

  it("阶梯单价为 0 时（防御性）不静默回退 basePrice，应按 0 计算", () => {
    // 0 分阶梯在发布预检会被 `price_invalid` 阻断，但运行时不应因 `0 || base` 的 falsy
    // 陷阱把免费档错误回退成 basePrice。直接构造 config 隔离 test 运行时行为。
    const cfg = {
      enabled: true, sessionLabel: "", stockLimit: null, maxPerUser: 100,
      showCountdown: true, showProgress: true, showStock: true, ctaLabel: "抢",
      paymentRequired: true, priceCents: 9900, currency: "cny", title: "", imageUrl: "",
      pricingTiers: [
        { minQuantity: 1, unitPriceCents: 9900, label: "原价" },
        { minQuantity: 100, unitPriceCents: 0, label: "免费" },
      ],
    };
    const result = calculateFlashSalePrice(cfg, 100);
    expect(result).toMatchObject({ quantity: 100, unitPriceCents: 0, amountCents: 0, tierLabel: "免费" });
  });

  it("null/undefined 数量 → 默认 1", () => {
    const cfg = makeCfg([], 20, 9900);
    expect(calculateFlashSalePrice(cfg, null).quantity).toBe(1);
    expect(calculateFlashSalePrice(cfg, undefined).quantity).toBe(1);
  });

  it("maxPerUser 截断后按截断后数量匹配阶梯", () => {
    const cfg = makeCfg([
      { minQuantity: 1, unitPriceCents: 9900, label: "原价" },
      { minQuantity: 10, unitPriceCents: 5000, label: "批发" },
    ], 3, 9900); // maxPerUser=3，请求 10 会被截断到 3
    const result = calculateFlashSalePrice(cfg, 10);
    expect(result).toMatchObject({ quantity: 3, unitPriceCents: 9900, amountCents: 29700 });
    // 截断后 quantity=3，不满足 minQuantity=10，所以用 basePrice
  });

  it("超过 MAX_TIERS 会产生 issues，运行时仅保留前 8 档", () => {
    const tiers = Array.from({ length: 10 }, (_, i) => ({
      minQuantity: i + 1,
      unitPriceCents: 10000 - i * 500,
      label: `阶梯${i + 1}`,
    }));
    const { config, issues } = parseFlashSaleConfig({
      flashSale: {
        enabled: true, paymentRequired: true, priceCents: 9900, maxPerUser: 20, currency: "cny",
        pricingTiers: tiers,
      },
    });
    expect(config!.pricingTiers.length).toBeLessThanOrEqual(8);
    // 第 9 个及以后被忽略，但前 8 个仍正确排序
    expect(config!.pricingTiers[0].minQuantity).toBe(1);
    expect(config!.pricingTiers[7].minQuantity).toBe(8);
    expect(issues.some((i) => i.code === "flash_sale.pricing_tier.too_many")).toBe(true);
  });
});
