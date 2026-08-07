/**
 * 秒杀（Flash Sale）配置解析与运行时展示计算。
 *
 * 为什么单独成库文件：
 * - 秒杀在 lottery 侧是「限时限量参与 + 导流购买」，不是支付下单。
 * - 配置落在 promotion_config.flashSale，与 viral/experience 同层，避免新增表与迁移。
 * - 公开端、发布预检、前端壳共用同一套清洗规则，防止「后台能存、前台算炸」。
 *
 * 边界（docs/130）：
 * - stockLimit / maxParticipants 表示「活动名额」，不是 shop SKU 库存。
 * - 真实购买与库存锁在 cf-shop；此处只做进度展示与参与门禁的配置语义。
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
  /** 每用户限次提示（展示/运营约定；硬限购仍靠参与模式与业务规则） */
  maxPerUser: number;
  showCountdown: boolean;
  showProgress: boolean;
  showStock: boolean;
  /** 主按钮文案，默认「抢」 */
  ctaLabel: string;
  /** 秒杀价格（分，整数最小单位；docs/131 支付金额来源） */
  priceCents: number | null;
  /** 币种，默认 cny */
  currency: string;
  /** 秒杀商品标题（订单描述/展示） */
  title: string;
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

  // 秒杀价格（分）：整数校验，非法置 null（订单创建时校验）
  const priceRaw = node.priceCents ?? node.price_cents;
  let priceCents: number | null = null;
  if (priceRaw !== null && priceRaw !== undefined && priceRaw !== "") {
    const n = Math.floor(Number(priceRaw));
    if (Number.isFinite(n) && n >= 0 && n <= 100_000_000) {
      priceCents = n;
    } else {
      issues.push({ code: "flash_sale.price.invalid", message: "秒杀价格必须是 0～1000000 元内的整数（分）" });
    }
  }
  const currency = String(node.currency || "cny").toLowerCase().slice(0, 8);
  const title = String(node.title || "").trim().slice(0, 100);

  const config: FlashSaleConfig = {
    enabled: true,
    sessionLabel,
    stockLimit,
    maxPerUser: maxPerUser ?? 1,
    showCountdown,
    showProgress,
    showStock,
    ctaLabel,
    priceCents,
    currency,
    title,
  };

  return { config, issues };
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
