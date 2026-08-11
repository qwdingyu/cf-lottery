/**
 * 秒杀（Flash Sale）配置解析与运行时展示计算。
 *
 * 为什么单独成库文件：
 * - 秒杀在 lottery 侧有两种模式：docs/130 的展示/导流壳，以及 docs/131 的 `paymentRequired=true` 直付发卡。
 * - 配置落在 promotion_config.flashSale，与 viral/experience 同层，避免新增表与迁移。
 * - 公开端、发布预检、前端壳共用同一套清洗规则，防止「后台能存、前台算炸」。
 *
 * 边界（docs/130）：
 * - stockLimit / maxParticipants 表示「活动名额」，不是 shop SKU 库存。
 * - `paymentRequired=false` 时真实购买仍在外部承接；`paymentRequired=true` 时价格、收款渠道和卡密池必须由 cf-lottery 发布预检闭环。
 */

export type FlashSaleConfig = {
  /** 是否启用秒杀壳（未启用则公开端不附加 flashSale 运行时块） */
  enabled: boolean;
  /** 场次文案，如「12:00场」；纯展示 */
  sessionLabel: string;
  /**
   * 展示用名额上限。
   * null = 未在 flashSale 节点显式配置，运行时应回退 draw.maxParticipants。
   */
  stockLimit: number | null;
  /**
   * 每用户限购件数（单笔订单数量上限 + 累计购买上限双保险）。
   * 
   * 两级防护（见 docs/203 注释链）：
   *   ① 路由层 normalizeFlashSaleQuantity 把单笔 quantity 钳制到 ≤ maxPerUser，
   *      即用户一次最多购买 maxPerUser 件（如 maxPerUser=1 时 qty=5→1）。
   *   ② 订单层 validateOrderPreconditions 在事务内统计该 entry 已有 PAID/
   *      FULFILLMENT_FAILED 订单总件数，加上本次 quantity 不得超过 maxPerUser。
   *      防止用户反复下单（每次 qty=maxPerUser）累计突破限购。
   * 默认 1（单件限购）。运营配置时需注意：这是"每人总限购量"，不是"单次限购"。
   */
  maxPerUser: number;
  showCountdown: boolean;
  showProgress: boolean;
  showStock: boolean;
  /** 主按钮文案，默认「抢」 */
  ctaLabel: string;
  /** 是否启用 cf-lottery 内直付。false 时仍是 docs/130 的轻秒杀展示/导流壳。 */
  paymentRequired: boolean;
  /** 秒杀价格（分，整数最小单位；docs/131 支付金额来源） */
  priceCents: number | null;
  /** 币种，默认 cny */
  currency: string;
  /** 秒杀商品标题（订单描述/展示） */
  title: string;
  /**
   * 阶梯单价（分）。按 minQuantity 从小到大匹配，取不超过购买数量的最高阶梯。
   * 例：[{minQuantity: 1, unitPriceCents: 990}, {minQuantity: 10, unitPriceCents: 790}]
   */
  pricingTiers: Array<{ minQuantity: number; unitPriceCents: number; label: string }>;
};

export type FlashSaleRuntime = FlashSaleConfig & {
  /** 已参与人数（来自 entries 计数） */
  claimed: number;
  /** 剩余名额；无限额时为 null */
  remaining: number | null;
  /** 0–100；无限额时为 0（不展示假进度） */
  progressPercent: number;
  /** 生效的名额上限（flashSale.stockLimit 优先，否则 maxParticipants） */
  effectiveStockLimit: number | null;
};

export type FlashSaleParseResult = {
  /** 解析后的配置；未启用或非法时为 null */
  config: FlashSaleConfig | null;
  issues: Array<{ code: string; message: string }>;
};

const MAX_SESSION_LABEL = 32;
const MAX_CTA_LABEL = 12;
const MAX_STOCK = 1_000_000;
const MAX_PER_USER = 100;
const MAX_PRICE_CENTS = 100_000_000;
const MAX_TIERS = 8;

function textValue(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function parseRoot(promotionConfig: unknown): Record<string, unknown> | null {
  if (promotionConfig && typeof promotionConfig === "object" && !Array.isArray(promotionConfig)) {
    return promotionConfig as Record<string, unknown>;
  }
  if (typeof promotionConfig === "string") {
    const raw = promotionConfig.trim();
    if (!raw || raw === "{}") return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readFlashSaleNode(root: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!root) return null;
  // 兼容 camelCase / snake_case，避免运营手写 JSON 踩坑
  const node = root.flashSale ?? root.flash_sale;
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  return node as Record<string, unknown>;
}

function positiveInt(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

function parsePricingTiers(node: Record<string, unknown>, issues: FlashSaleParseResult["issues"]) {
  const raw = node.pricingTiers ?? node.pricing_tiers;
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_TIERS) {
    issues.push({
      code: "flash_sale.pricing_tier.too_many",
      message: `阶梯价最多只允许 ${MAX_TIERS} 档，超出部分必须删减后再发布`,
    });
  }
  const tiers: Array<{ minQuantity: number; unitPriceCents: number; label: string }> = [];
  for (const item of raw.slice(0, MAX_TIERS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const minQuantity = positiveInt(row.minQuantity ?? row.min_quantity, MAX_PER_USER);
    const unitRaw = row.unitPriceCents ?? row.unit_price_cents ?? row.priceCents ?? row.price_cents;
    const unitPriceCents = positiveInt(unitRaw, MAX_PRICE_CENTS);
    if (!minQuantity || !unitPriceCents) {
      issues.push({ code: "flash_sale.pricing_tier.invalid", message: "阶梯价必须包含 minQuantity 和 unitPriceCents 正整数" });
      continue;
    }
    tiers.push({
      minQuantity,
      unitPriceCents,
      label: textValue(row.label, 32),
    });
  }
  return tiers.sort((a, b) => a.minQuantity - b.minQuantity);
}

/**
 * 解析并清洗 promotion_config 中的 flashSale。
 * - enabled 不为 true 时返回 config=null（不报错，视为未开秒杀壳）。
 * - enabled=true 时做名额等校验，issues 非空表示发布应阻断或警告（由调用方决定）。
 */
export function parseFlashSaleConfig(promotionConfig: unknown): FlashSaleParseResult {
  const issues: FlashSaleParseResult["issues"] = [];
  const root = parseRoot(promotionConfig);
  const node = readFlashSaleNode(root);

  if (!node) {
    return { config: null, issues };
  }

  const enabled = node.enabled === true || node.enabled === 1 || node.enabled === "true";
  if (!enabled) {
    return { config: null, issues };
  }

  const stockRaw = node.stockLimit ?? node.stock_limit;
  let stockLimit: number | null = null;
  if (stockRaw !== null && stockRaw !== undefined && stockRaw !== "") {
    stockLimit = positiveInt(stockRaw, MAX_STOCK);
    if (stockLimit === null) {
      issues.push({
        code: "flash_sale.stock_limit.invalid",
        message: "秒杀名额上限必须是 1～1000000 的整数",
      });
    }
  }

  const maxPerUserRaw = node.maxPerUser ?? node.max_per_user ?? 1;
  let maxPerUser = positiveInt(maxPerUserRaw, MAX_PER_USER);
  if (maxPerUser === null) {
    issues.push({
      code: "flash_sale.max_per_user.invalid",
      message: "秒杀每人限次必须是 1～100 的整数",
    });
    maxPerUser = 1;
  }

  const sessionLabel = textValue(node.sessionLabel ?? node.session_label, MAX_SESSION_LABEL);
  const ctaLabel = textValue(node.ctaLabel ?? node.cta_label, MAX_CTA_LABEL) || "抢";

  const showCountdown = node.showCountdown !== false && node.show_countdown !== false;
  const showProgress = node.showProgress !== false && node.show_progress !== false;
  const showStock = node.showStock !== false && node.show_stock !== false;
  const paymentRequired =
    node.paymentRequired === true ||
    node.payment_required === true ||
    node.paymentRequired === 1 ||
    node.payment_required === 1 ||
    node.paymentRequired === "true" ||
    node.payment_required === "true";

  // 秒杀价格（分）：必须是整数最小货币单位。不能向下取整，否则手写 JSON
  // 中的 9900.9 会静默变成 9900，造成支付金额低于运营配置意图。
  const priceRaw = node.priceCents ?? node.price_cents;
  let priceCents: number | null = null;
  if (priceRaw !== null && priceRaw !== undefined && priceRaw !== "") {
    const n = Number(priceRaw);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= MAX_PRICE_CENTS) {
      priceCents = n;
    } else {
      issues.push({ code: "flash_sale.price.invalid", message: "秒杀价格必须是 0～100000000 分内的整数" });
    }
  }
  const currency = String(node.currency || "cny").toLowerCase().slice(0, 8);
  const title = String(node.title || "").trim().slice(0, 100);
  const pricingTiers = parsePricingTiers(node, issues);

  const config: FlashSaleConfig = {
    enabled: true,
    sessionLabel,
    stockLimit,
    maxPerUser: maxPerUser ?? 1,
    showCountdown,
    showProgress,
    showStock,
    ctaLabel,
    paymentRequired,
    priceCents,
    currency,
    title,
    pricingTiers,
  };

  return { config, issues };
}

/** 购买数量清洗：直付批量购买仍是一身份一订单，数量是订单内件数。 */
export function normalizeFlashSaleQuantity(raw: unknown, flashSale: FlashSaleConfig): number {
  const n = Number(raw);
  const requested = Number.isFinite(n) ? Math.floor(n) : 1;
  const min = 1;
  const max = Math.max(1, Math.min(MAX_PER_USER, Math.floor(Number(flashSale.maxPerUser || 1))));
  return Math.min(max, Math.max(min, requested));
}

/** 按阶梯价计算服务端权威金额；前端不得提交金额。 */
export function calculateFlashSalePrice(
  flashSale: FlashSaleConfig,
  quantityRaw: unknown,
): { quantity: number; unitPriceCents: number; amountCents: number; tierLabel: string } {
  const quantity = normalizeFlashSaleQuantity(quantityRaw, flashSale);
  const basePrice = Math.max(0, Math.floor(Number(flashSale.priceCents || 0)));
  let matched = {
    minQuantity: 1,
    unitPriceCents: basePrice,
    label: "",
  };
  for (const tier of flashSale.pricingTiers) {
    if (tier.minQuantity <= quantity) matched = tier;
  }
  const unitPriceCents = Math.max(0, Math.floor(Number(matched.unitPriceCents ?? basePrice)));
  return {
    quantity,
    unitPriceCents,
    amountCents: unitPriceCents * quantity,
    tierLabel: matched.label,
  };
}

/**
 * 生效名额：flashSale.stockLimit 优先；否则用活动 maxParticipants。
 */
export function resolveEffectiveStockLimit(
  flashSale: FlashSaleConfig | null,
  maxParticipants: number | null | undefined,
): number | null {
  if (flashSale?.stockLimit != null && flashSale.stockLimit > 0) return flashSale.stockLimit;
  if (maxParticipants != null && Number.isFinite(maxParticipants) && maxParticipants > 0) {
    return Math.floor(Number(maxParticipants));
  }
  return null;
}

/**
 * 根据已参与人数计算进度与剩余（展示用，不替代 DB 容量锁）。
 */
export function buildFlashSaleRuntime(
  flashSale: FlashSaleConfig,
  claimedRaw: number,
  maxParticipants?: number | null,
): FlashSaleRuntime {
  const claimed = Math.max(0, Math.floor(Number(claimedRaw) || 0));
  const effectiveStockLimit = resolveEffectiveStockLimit(flashSale, maxParticipants);

  let remaining: number | null = null;
  let progressPercent = 0;

  if (effectiveStockLimit != null && effectiveStockLimit > 0) {
    remaining = Math.max(0, effectiveStockLimit - claimed);
    progressPercent = Math.min(100, Math.floor((claimed / effectiveStockLimit) * 100));
  }

  return {
    ...flashSale,
    claimed,
    remaining,
    progressPercent,
    effectiveStockLimit,
  };
}

/**
 * 是否应在公开详情返回 flashSale 块。
 */
export function shouldExposeFlashSale(promotionConfig: unknown): boolean {
  return parseFlashSaleConfig(promotionConfig).config != null;
}
