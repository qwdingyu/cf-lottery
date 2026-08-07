/**
 * 秒杀配置纯函数测试（docs/130）
 */
import { describe, expect, it } from "vitest";
import {
  buildFlashSaleRuntime,
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
      showCountdown: true,
      showProgress: true,
      showStock: true,
    });
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
