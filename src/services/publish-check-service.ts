/**
 * 发布前预检服务。
 *
 * 设计边界：
 * - 这里是“能否正式发布”的统一门禁，路由和底层发布服务都复用它。
 * - 只检查当前活动必要的少量关联数据，避免在 Cloudflare Workers Free + Turso Free 上做全局扫描。
 * - 预检返回结构化 code/section，前端可以直接展示成运营清单，后续补问卷/投票配置时也只扩展本文件。
 */
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { isInstantResultMode, isFlashSaleExperience } from "../lib/activity-utils";
import type { DbType } from "../db/client";
import {
  lotteryDraws,
  lotteryInviteCodes,
  lotteryPrizeTiers,
  lotteryRosterMembers,
  prizeCodes,
  prizes,
  tenantConfigs,
  systemConfig,
  webhookConfigs,
} from "../db/schema";
import { validateActivityConfigForPublish } from "../lib/activity-config";
import { parseFlashSaleConfig, resolveEffectiveStockLimit } from "../lib/flash-sale-config";
import { PAYMENT_PROVIDER_CATALOG, type PaymentProviderCatalogItem } from "./payment/catalog";
import { decryptPaymentConfigValueResult, isEncryptedPaymentConfigValue } from "./payment/secret-config";
import { DRAW_STATUS } from "./lottery/types";

export type PublishCheckSection =
  | "basic"
  | "participation"
  | "prizes"
  | "promotion"
  | "payment"
  | "webhook"
  | "activity_config";

export type PublishCheckItem = {
  code: string;
  message: string;
  section: PublishCheckSection;
};

export type PublishCheckResult = {
  canPublish: boolean;
  errors: PublishCheckItem[];
  warnings: PublishCheckItem[];
  infos: PublishCheckItem[];
};

type LotteryDraw = typeof lotteryDraws.$inferSelect;

export type PublishCheckOptions = {
  credentialsEncryptionKey?: string;
};

function add(target: PublishCheckItem[], section: PublishCheckSection, code: string, message: string) {
  target.push({ section, code, message });
}

function parseIsoTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  const raw = String(value || "").trim();
  if (!raw || raw === "{}") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isSafeHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return false;
    if (url.href.length > 2000) return false;
    return true;
  } catch {
    return false;
  }
}

function providerConfigValue(config: Record<string, unknown>, key: string): string {
  return String(config[key.toLowerCase()] ?? config[key] ?? "").trim();
}

function providerSupportsCurrency(meta: PaymentProviderCatalogItem, currency: string): boolean {
  const normalized = currency.trim().toLowerCase();
  return meta.supportedCurrencies.some((value) => value.toLowerCase() === normalized);
}

function providerSupportsDirectFulfillmentCurrency(meta: PaymentProviderCatalogItem, currency: string): boolean {
  return meta.supportsDirectFulfillment && providerSupportsCurrency(meta, currency);
}

async function validateFlashSalePayment(
  db: DbType,
  tenantId: string,
  draw: LotteryDraw,
  flashSale: NonNullable<ReturnType<typeof parseFlashSaleConfig>["config"]>,
  effectiveStockLimit: number | null,
  result: PublishCheckResult,
  options: PublishCheckOptions,
) {
  if (!flashSale.paymentRequired) return;

  if (!flashSale.priceCents || flashSale.priceCents <= 0) {
    add(result.errors, "payment", "flash_sale.payment.price.required", "直付秒杀必须配置大于 0 的 priceCents");
  }

  // 价格上限：从 systemConfig 读取，未配则以 parseFlashSaleConfig 的默认上限为准
  const maxPriceCents = await readSystemConfigInteger(db, "flash_sale_max_price_cents", 1000000);
  if (flashSale.priceCents && flashSale.priceCents > maxPriceCents) {
    add(
      result.errors,
      "payment",
      "flash_sale.payment.price.too_high",
      `秒杀价格不能超过 ${formatPrice(maxPriceCents)} 元；当前配置为 ${formatPrice(flashSale.priceCents)} 元`,
    );
  }

  if (draw.participationMode === "registered") {
    add(
      result.errors,
      "payment",
      "payment.identity.email_required",
      "直付秒杀当前只支持 email 身份参与；registered 模式会导致已参与但无法下单",
    );
  }

  if (!Number.isInteger(flashSale.maxPerUser) || flashSale.maxPerUser < 1 || flashSale.maxPerUser > 100) {
    add(
      result.errors,
      "payment",
      "flash_sale.payment.max_per_user.invalid",
      "直付秒杀单笔购买上限必须是 1～100 的整数",
    );
  }

  const seenTierMin = new Set<number>();
  for (const tier of flashSale.pricingTiers) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 1) {
      add(result.errors, "payment", "flash_sale.payment.pricing_tier.min_invalid", "阶梯价起购数量必须是正整数");
    }
    if (tier.minQuantity > flashSale.maxPerUser) {
      add(
        result.errors,
        "payment",
        "flash_sale.payment.pricing_tier.exceeds_max",
        `阶梯价「${tier.label || tier.minQuantity}」起购数量不能超过单笔上限 ${flashSale.maxPerUser}`,
      );
    }
    if (seenTierMin.has(tier.minQuantity)) {
      add(result.errors, "payment", "flash_sale.payment.pricing_tier.duplicate", `阶梯价起购数量 ${tier.minQuantity} 重复`);
    }
    seenTierMin.add(tier.minQuantity);
    if (!Number.isInteger(tier.unitPriceCents) || tier.unitPriceCents <= 0) {
      add(result.errors, "payment", "flash_sale.payment.pricing_tier.price_invalid", "阶梯价单价必须是大于 0 的整数分");
    } else if (tier.unitPriceCents > maxPriceCents) {
      add(
        result.errors,
        "payment",
        "flash_sale.payment.pricing_tier.price_too_high",
        `阶梯价单价不能超过 ${formatPrice(maxPriceCents)} 元；当前配置为 ${formatPrice(tier.unitPriceCents)} 元`,
      );
    }
  }
  // 首档阶梯起购数量必须为 1，否则用户购买件数低于第一档时会按 basePrice 计价
  // （非预期价格）。例：[{minQuantity:5, unitPriceCents:500}] → 买 3 件按 basePrice。
  if (flashSale.pricingTiers.length > 0 && flashSale.pricingTiers[0].minQuantity !== 1) {
    add(
      result.errors,
      "payment",
      "flash_sale.payment.pricing_tier.first_min_quantity_not_one",
      "阶梯价首档起购数量必须为 1（覆盖所有购买件数），否则用户买不到首档价格",
    );
  }

  const currency = String(flashSale.currency || "cny").trim().toLowerCase();
  const catalogCurrencyProviders = PAYMENT_PROVIDER_CATALOG.filter((meta) => providerSupportsCurrency(meta, currency));
  const currencyProviders = PAYMENT_PROVIDER_CATALOG.filter((meta) => providerSupportsDirectFulfillmentCurrency(meta, currency));
  if (catalogCurrencyProviders.length > 0 && currencyProviders.length === 0) {
    add(
      result.errors,
      "payment",
      "payment.provider.direct_fulfillment_unsupported",
      `当前 ${currency.toUpperCase()} Provider 尚未支持直付自动发卡，不能发布直付秒杀`,
    );
  }
  if (catalogCurrencyProviders.length === 0) {
    add(result.errors, "payment", "payment.currency.unsupported", `当前支付目录没有支持 ${currency.toUpperCase()} 的 Provider`);
  }

  const [row] = await db
    .select({ enabled: tenantConfigs.enabled, providers: tenantConfigs.providers })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId))
    .limit(1);

  if (!row || !row.enabled) {
    add(result.errors, "payment", "payment.config.required", "直付秒杀必须先在租户支付设置中启用收款方式");
  } else {
    let providers: Record<string, Record<string, unknown>> = {};
    try {
      providers = JSON.parse(row.providers || "{}") as Record<string, Record<string, unknown>>;
    } catch {
      add(result.errors, "payment", "payment.config.invalid", "租户支付配置不是合法 JSON，无法发布直付秒杀");
    }

    const enabledSupported = currencyProviders
      .map((meta) => ({ meta, config: providers[meta.name] }))
      .filter((item) => item.config?.enabled === true);
    if (currencyProviders.length > 0 && enabledSupported.length === 0) {
      add(result.errors, "payment", "payment.provider.currency.required", `直付秒杀币种 ${currency.toUpperCase()} 没有已启用的可用收款方式`);
    } else if (enabledSupported.length > 0) {
      let usableProvider = false;
      for (const item of enabledSupported) {
        const env = await buildPublishProviderEnv(item.meta, item.config, result, options);
        if (!env) continue;
        if (item.meta.factory.isAvailable(env)) {
          usableProvider = true;
          continue;
        }
        add(
          result.errors,
          "payment",
          `payment.provider.${item.meta.name}.unavailable`,
          `${item.meta.displayName} 凭据不完整或接口地址不安全，无法创建支付 Provider`,
        );
      }
      if (!usableProvider) {
        add(result.errors, "payment", "payment.provider.incomplete", `支持 ${currency.toUpperCase()} 的已启用收款方式缺少可用凭据`);
      }
    }
  }

  const codePrizeRows = await db
    .select({
      prizeId: lotteryPrizeTiers.prizeId,
      prizeName: prizes.name,
    })
    .from(lotteryPrizeTiers)
    .innerJoin(prizes, and(
      eq(prizes.id, lotteryPrizeTiers.prizeId),
      eq(prizes.tenantId, tenantId),
      eq(prizes.prizeType, "code"),
      eq(prizes.active, 1),
    ))
    .where(and(eq(lotteryPrizeTiers.tenantId, tenantId), eq(lotteryPrizeTiers.drawId, draw.id)));

  if (codePrizeRows.length === 0) {
    add(result.errors, "payment", "payment.fulfillment.code_prize.required", "直付秒杀必须绑定且只绑定一个可用卡密奖品");
    return;
  }
  if (codePrizeRows.length > 1) {
    add(result.errors, "payment", "payment.fulfillment.code_prize.ambiguous", "直付秒杀只能绑定一个卡密奖品，避免支付成功后发卡目标不确定");
    return;
  }

  // prize_codes 没有活动级分配额度。若多个进行中活动共享同一奖品池，
  // 各自预检都可能通过，最终在支付/开奖热路径竞争同一批卡密，造成已付款但发卡失败。
  // 当前阶段采用 fail-closed：每个进行中活动必须使用独立卡密奖品池。
  const sharedPrizeDraws = await db
    .select({
      drawId: lotteryDraws.id,
      status: lotteryDraws.status,
    })
    .from(lotteryPrizeTiers)
    .innerJoin(lotteryDraws, and(
      eq(lotteryDraws.id, lotteryPrizeTiers.drawId),
      eq(lotteryDraws.tenantId, tenantId),
    ))
    .where(and(
      eq(lotteryPrizeTiers.tenantId, tenantId),
      eq(lotteryPrizeTiers.prizeId, codePrizeRows[0].prizeId),
      ne(lotteryDraws.id, draw.id),
      inArray(lotteryDraws.status, [DRAW_STATUS.OPEN, DRAW_STATUS.PAUSED, DRAW_STATUS.DRAWING]),
    ));
  if (sharedPrizeDraws.length > 0) {
    add(
      result.errors,
      "payment",
      "payment.fulfillment.code_prize.shared",
      "该卡密奖品池已绑定其他进行中的活动，不能共享；请为本场活动建立独立卡密奖品池",
    );
    return;
  }

  if (effectiveStockLimit != null && effectiveStockLimit > 0) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(prizeCodes)
      .where(and(
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.prizeId, codePrizeRows[0].prizeId),
        eq(prizeCodes.status, "available"),
      ));
    const available = Number(total || 0);
    if (available < effectiveStockLimit) {
      add(result.errors, "payment", "payment.fulfillment.codes.insufficient", `直付秒杀可用卡密 ${available} 个，少于名额上限 ${effectiveStockLimit} 个`);
    }
    // P2 低库存预警(不阻断发布,仅 warning)
    const threshold = await readSystemConfigNumber(db, "prize_code_low_stock_threshold", 0.3);
    if (available > 0 && effectiveStockLimit > 0 && available / effectiveStockLimit < threshold) {
      add(
        result.warnings,
        "payment",
        "payment.fulfillment.codes.low_stock",
        `直付秒杀可用卡密 ${available}/${effectiveStockLimit},低于阈值 ${Math.round(threshold * 100)}%,建议补充卡密`,
      );
    }
  }

  // P2 互斥:直付秒杀不应同时配置 after_win CTA(支付弹窗与外部导流冲突,docs/140)
  const promotionConfig = parseJsonObject(draw.promotionConfig);
  if (promotionConfig) {
    const ctas = promotionConfig["ctas"] as Record<string, unknown> | undefined;
    const afterWin = ctas?.["after_win"] as Record<string, unknown> | undefined;
    if (afterWin && typeof afterWin.url === "string" && afterWin.url.trim()) {
      add(
        result.errors,
        "payment",
        "flash_sale.payment.cta_conflict",
        "直付秒杀不能同时配置中奖后导流链接(after_win CTA)；直付时支付弹窗已承接转化。如需导流请关闭 paymentRequired 或清空 afterWinCtaUrl",
      );
    }
  }
}

async function buildPublishProviderEnv(
  meta: PaymentProviderCatalogItem,
  config: Record<string, unknown> | undefined,
  result: PublishCheckResult,
  options: PublishCheckOptions,
): Promise<Record<string, string> | null> {
  if (!config) return null;

  const env: Record<string, string> = {};
  let complete = true;
  for (const field of meta.fields) {
    const raw = providerConfigValue(config, field.key);
    if (!raw) {
      if (field.required) {
        complete = false;
        add(result.errors, "payment", `payment.provider.${meta.name}.${field.key.toLowerCase()}.required`, `${meta.displayName}: ${field.label} 未配置`);
      }
      continue;
    }

    if (field.sensitive && isEncryptedPaymentConfigValue(raw)) {
      const decrypted = await decryptPaymentConfigValueResult(raw, options.credentialsEncryptionKey);
      if (!decrypted.ok) {
        complete = false;
        add(
          result.errors,
          "payment",
          `payment.provider.${meta.name}.${field.key.toLowerCase()}.decrypt_failed`,
          `${meta.displayName}: ${field.label} 解密失败（${decrypted.reason}）`,
        );
        continue;
      }
      env[field.key] = decrypted.value;
      continue;
    }

    if (field.sensitive) {
      complete = false;
      add(
        result.errors,
        "payment",
        `payment.provider.${meta.name}.${field.key.toLowerCase()}.encrypted_required`,
        `${meta.displayName}: ${field.label} 必须使用 cf-core v2 密文保存，请重新保存支付配置`,
      );
      continue;
    }
    env[field.key] = raw;
  }

  return complete ? env : null;
}

function validateBasic(draw: LotteryDraw, result: PublishCheckResult) {
  const start = parseIsoTime(draw.startAt);
  const end = parseIsoTime(draw.endAt);
  const drawAt = parseIsoTime(draw.drawAt);

  if (!String(draw.title || "").trim()) add(result.errors, "basic", "basic.title.required", "活动标题不能为空");
  if (!draw.publicSlug) add(result.errors, "basic", "basic.public_slug.required", "公开链接标识缺失，无法生成参与链接");

  if (!draw.startAt || !draw.endAt) {
    add(result.errors, "basic", "basic.time.required", "请设置活动开始和结束时间");
  } else if (!start || !end) {
    add(result.errors, "basic", "basic.time.invalid", "活动时间格式无效");
  } else {
    if (start >= end) add(result.errors, "basic", "basic.time.order", "参与开始时间必须早于结束时间");
    if (end <= new Date()) add(result.errors, "basic", "basic.time.ended", "活动结束时间已过，不能发布");
  }

  if (draw.drawTrigger === "scheduled") {
    if (!draw.drawAt) {
      add(result.errors, "basic", "basic.draw_at.required", "定时开奖必须设置开奖时间");
    } else if (!drawAt) {
      add(result.errors, "basic", "basic.draw_at.invalid", "开奖时间格式无效");
    } else if (end && end >= drawAt) {
      add(result.errors, "basic", "basic.draw_at.order", "开奖时间必须晚于参与结束时间");
    }
  }

  // docs/115：有 drawAt 但 trigger 仍是 manual → Cron 永不扫到；运营以为「到点自动开」会失效。
  // 仅警告不阻断：仍可手动开奖；修复路径是改 drawTrigger=scheduled 或清空 drawAt。
  if (
    draw.activityKind === "lottery" &&
    draw.drawAt &&
    drawAt &&
    draw.drawTrigger !== "scheduled"
  ) {
    add(
      result.warnings,
      "basic",
      "basic.draw_at.orphan",
      "已填写开奖时间，但开奖触发仍为「手动」。系统不会到点自动开奖；请改为定时开奖，或依赖列表「立即开奖」",
    );
  }

  if (draw.maxParticipants !== null && draw.maxParticipants !== undefined && draw.maxParticipants < 1) {
    add(result.errors, "basic", "basic.capacity.invalid", "参与人数上限必须大于 0");
  }
}

async function validateParticipation(db: DbType, tenantId: string, draw: LotteryDraw, result: PublishCheckResult) {
  if (draw.participationMode === "password" && !String(draw.accessPassword || "").trim()) {
    add(result.errors, "participation", "participation.password.required", "密码参与模式必须设置访问密码");
  }

  if (draw.participationMode === "roster") {
    const [{ total }] = await db
      .select({ total: count() })
      .from(lotteryRosterMembers)
      .where(and(eq(lotteryRosterMembers.tenantId, tenantId), eq(lotteryRosterMembers.drawId, draw.id)));
    if (Number(total || 0) === 0) {
      add(result.errors, "participation", "participation.roster.empty", "名单模式需要先导入参与者名单");
    }
  }

  if (draw.participationMode === "invite_code") {
    const [{ total }] = await db
      .select({ total: count() })
      .from(lotteryInviteCodes)
      .where(and(
        eq(lotteryInviteCodes.tenantId, tenantId),
        eq(lotteryInviteCodes.drawId, draw.id),
        eq(lotteryInviteCodes.active, 1),
        sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
      ));
    if (Number(total || 0) === 0) {
      add(result.errors, "participation", "participation.invite_code.empty", "邀请码模式需要先生成可用邀请码");
    }
  }
}

async function validateLotteryPrizes(db: DbType, tenantId: string, draw: LotteryDraw, result: PublishCheckResult) {
  if (draw.activityKind !== "lottery") return;

  const isInstant = isInstantResultMode(draw.resultMode);
  const maxSpins = Number((draw as { maxSpinsPerEntry?: number }).maxSpinsPerEntry ?? 0);

  // docs/116：instant 必须配置每人抽奖次数；禁止依赖 scheduled 自动 performDraw
  if (isInstant) {
    if (!Number.isFinite(maxSpins) || maxSpins < 1) {
      add(result.errors, "basic", "basic.max_spins.required", "即时开奖必须设置每人抽奖次数（≥1）");
    }
    if (draw.drawTrigger === "scheduled") {
      add(
        result.errors,
        "basic",
        "basic.instant.scheduled_forbidden",
        "即时开奖活动不能使用定时统一开奖；请改为手动触发关闭，由用户 spin 出结果",
      );
    }
  }

  const tiers = await db
    .select({
      id: lotteryPrizeTiers.id,
      tierName: lotteryPrizeTiers.tierName,
      winnerCount: lotteryPrizeTiers.winnerCount,
      weight: lotteryPrizeTiers.weight,
      prizeId: lotteryPrizeTiers.prizeId,
      prizeName: prizes.name,
      prizeType: prizes.prizeType,
      imageUrl: prizes.imageUrl,
      valueText: prizes.valueText,
      active: prizes.active,
    })
    .from(lotteryPrizeTiers)
    .leftJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.tenantId, tenantId)))
    .where(and(eq(lotteryPrizeTiers.tenantId, tenantId), eq(lotteryPrizeTiers.drawId, draw.id)));

  if (tiers.length === 0) {
    add(result.errors, "prizes", "prizes.tiers.required", "抽奖活动必须至少配置一个奖项");
    return;
  }

  let tierWinnerTotal = 0;
  let weightSum = 0;
  for (const tier of tiers) {
    const tierName = tier.tierName || "未命名奖项";
    tierWinnerTotal += Math.max(0, Number(tier.winnerCount || 0));
    weightSum += Math.max(0, Number((tier as { weight?: number }).weight || 0));

    if (!tier.prizeId || !tier.prizeName || tier.active !== 1) {
      add(result.errors, "prizes", "prizes.tier.prize_missing", `奖项"${tierName}"未选择可用奖品`);
      continue;
    }

    if (tier.winnerCount < 1) {
      add(result.errors, "prizes", "prizes.tier.winner_count.invalid", `奖项"${tierName}"中奖名额必须大于 0`);
    }

    if (!String(tier.imageUrl || "").trim()) {
      add(result.infos, "prizes", "prizes.image.default", `奖品"${tier.prizeName}"未上传图片，公开页将使用默认图`);
    }

    if (!String(tier.valueText || "").trim()) {
      add(result.infos, "prizes", "prizes.value.empty", `奖品"${tier.prizeName}"未填写价值展示文案`);
    }

    if (tier.prizeType === "code") {
      const [{ total }] = await db
        .select({ total: count() })
        .from(prizeCodes)
        .where(and(
          eq(prizeCodes.tenantId, tenantId),
          eq(prizeCodes.prizeId, tier.prizeId),
          eq(prizeCodes.status, "available"),
        ));
      const available = Number(total || 0);
      if (available < tier.winnerCount) {
        add(result.errors, "prizes", "prizes.codes.insufficient", `奖项"${tierName}"可用码 ${available} 个，中奖名额 ${tier.winnerCount} 个，发布后会发放失败`);
      }
    }
  }

  if (isInstant && weightSum <= 0) {
    add(
      result.errors,
      "prizes",
      "prizes.instant.weight_required",
      "即时开奖至少需要一个奖项配置 weight>0，否则无法抽奖",
    );
  }

  if (draw.winnerCount !== tierWinnerTotal) {
    add(result.warnings, "prizes", "prizes.winner_count.mismatch", `活动中奖人数为 ${draw.winnerCount}，奖项名额合计为 ${tierWinnerTotal}，建议发布前统一`);
  }
}

async function validatePromotion(
  db: DbType,
  tenantId: string,
  draw: LotteryDraw,
  result: PublishCheckResult,
  options: PublishCheckOptions,
) {
  const promotionConfig = parseJsonObject(draw.promotionConfig);
  const legacyProductLink = parseJsonObject(draw.productLink);
  const viral = promotionConfig?.viral as Record<string, unknown> | undefined;

  // 完全无配置时提示
  if (!promotionConfig && !legacyProductLink) {
    add(result.warnings, "promotion", "promotion.empty", "未配置参与完成后的承接动作，活动导流和转化会变弱");
    return;
  }

  if (draw.promotionConfig && draw.promotionConfig !== "{}" && !promotionConfig) {
    add(result.errors, "promotion", "promotion.json.invalid", "导流配置不是合法 JSON 对象");
    return;
  }

  // 导流目标校验（仅在配置了 destination 时）
  const destination = promotionConfig?.destination as Record<string, unknown> | undefined;
  if (destination) {
    if (!isSafeHttpUrl(destination.url)) {
      add(result.errors, "promotion", "promotion.url.invalid", "导流链接必须是有效的 http/https 外部地址");
    }
    if (typeof destination.title !== "string" || !(destination.title as string).trim()) {
      add(result.warnings, "promotion", "promotion.title.empty", "导流承接缺少展示标题，参与者可能不清楚下一步动作");
    }
  }

  // 多状态 CTA 校验（中奖后/未中奖后的导流卡片）。
  // 为什么单独校验：这些 url 会在公开端结果弹窗中作为 <a href> 渲染，
  // 若运营者误配了 javascript: 等危险协议，点击会执行脚本（XSS 纵深防御）。
  const ctas = promotionConfig?.ctas as Record<string, { url?: string }> | undefined;
  if (ctas) {
    for (const key of ["after_win", "after_loss"] as const) {
      const cta = ctas[key];
      if (cta && typeof cta.url === "string" && cta.url.trim() && !isSafeHttpUrl(cta.url)) {
        add(result.errors, "promotion", `promotion.cta.${key}.invalid`, `${key === "after_win" ? "中奖后" : "未中奖后"}导流链接必须是有效的 http/https 外部地址`);
      }
    }
  }

  // docs/128 红线：手动/定时开奖禁止「扇面真奖名」——随机停格停在真奖名会让人
  // 误以为「停到即中」，属语义欺诈。公开端 resolvePrizePanelMode 已强制降级为
  // 仪式短语，此处直接阻断发布，防止运营以为「真奖名」配置已生效。
  const experience = promotionConfig?.experience as
    | { prizePanelMode?: string }
    | undefined;
  if (!isInstantResultMode(draw.resultMode) && experience?.prizePanelMode === "full_on_shell") {
    add(
      result.errors,
      "promotion",
      "promotion.experience.conflict",
      "手动/定时开奖禁止「扇面真奖名」：随机停格=假装中奖；请改用自动或仪式短语模式",
    );
  }

  // 裂变配置校验
  if (viral?.enabled) {
    const perInvite = Number(viral.extraEntriesPerInvite ?? 0);
    const maxExtra = Number(viral.maxExtraEntries ?? 0);
    if (perInvite < 1) {
      add(result.errors, "promotion", "viral.extra_entries.invalid", "裂变传播：每邀请额外次数必须大于 0");
    }
    if (maxExtra < 1) {
      add(result.errors, "promotion", "viral.max_extra.invalid", "裂变传播：最多额外次数必须大于 0");
    }
    if (perInvite > maxExtra) {
      add(result.warnings, "promotion", "viral.extra_exceeds_max", `裂变传播：每邀请 ${perInvite} 次超过了最多 ${maxExtra} 次上限，实际效果以最大值为准`);
    }
    // 裂变开启但排行榜未开启时提示
    // 与 isViralLeaderboardEnabled 一致：仅显式关闭才提示（缺省开启不误报 off）
    if (viral.enabled === true && viral.leaderboardEnabled === false) {
      add(result.infos, "promotion", "viral.leaderboard.off", "裂变传播：排行榜未开启，参与者无法看到排行对比");
    }
  }

  // docs/130：秒杀壳配置。lottery 侧只校验「限时限量参与 + 导流」语义，不校验 shop 库存。
  const flashParsed = parseFlashSaleConfig(promotionConfig || draw.promotionConfig);
  for (const item of flashParsed.issues) {
    add(result.errors, "promotion", item.code, item.message);
  }
  if (flashParsed.config) {
    // docs/166 红线：lottery 禁止与 paymentRequired 组合（任何 resultMode）。
    // lottery 的 performDraw 不校验 entry.paymentStatus，所有 entry 都在候选池中；
    // 若允许组合，未付款用户可进入候选池并被抽中（白嫖卡密），且支付回调已通过
    // direct fulfillment 发卡，导致 double-issuance。
    // claim 活动（activityKind=claim）的 paymentRequired 是「直付发卡」语义，
    // 通过支付回调发卡，不涉及 performDraw / spin，不受此限。
    if (draw.activityKind === "lottery" && flashParsed.config.paymentRequired === true) {
      add(
        result.errors,
        "promotion",
        "promotion.lottery_payment.conflict",
        "直付秒杀（需付款）不能与抽奖活动（lottery）组合：开奖结果机不校验付款状态，会导致未付款即中奖；请使用 claim 活动类型",
      );
    }

    const effective = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
    if (effective == null) {
      add(
        result.errors,
        "promotion",
        "flash_sale.stock.required",
        "秒杀活动必须设置名额上限（flashSale.stockLimit 或活动 maxParticipants）",
      );
    }
    // stockLimit 与 maxParticipants 同时存在且不一致：硬截单与进度均以 stockLimit 优先（join 与公开 runtime 同源）
    if (
      flashParsed.config.stockLimit != null &&
      draw.maxParticipants != null &&
      draw.maxParticipants > 0 &&
      flashParsed.config.stockLimit !== draw.maxParticipants
    ) {
      add(
        result.warnings,
        "promotion",
        "flash_sale.stock.mismatch",
        `秒杀 stockLimit=${flashParsed.config.stockLimit} 与 maxParticipants=${draw.maxParticipants} 不一致：进度与截单均按 stockLimit；建议二者对齐以免运营误解`,
      );
    }
    const destination = promotionConfig?.destination as Record<string, unknown> | undefined;
    const afterWin = (promotionConfig?.ctas as Record<string, { url?: string }> | undefined)?.after_win;
    const hasShopLink =
      isSafeHttpUrl(destination?.url) ||
      (typeof afterWin?.url === "string" && isSafeHttpUrl(afterWin.url)) ||
      isSafeHttpUrl(legacyProductLink?.url);
    if (!flashParsed.config.paymentRequired && !hasShopLink) {
      add(
        result.errors,
        "promotion",
        "flash_sale.destination.missing",
        "展示型秒杀必须配置安全的导流/购买链接（商品链接、destination 或 after_win CTA）；否则用户抢到后无法下单",
      );
    }
    if (!isFlashSaleExperience(draw.experienceType)) {
      add(
        result.infos,
        "promotion",
        "flash_sale.experience.hint",
        "已启用 flashSale 配置；建议 experience_type=flash_sale 以使用秒杀体验壳",
      );
    }
    await validateFlashSalePayment(db, tenantId, draw, flashParsed.config, effective, result, options);
  }
}

async function validateWebhooks(db: DbType, tenantId: string, result: PublishCheckResult) {
  const configs = await db
    .select({
      id: webhookConfigs.id,
      url: webhookConfigs.url,
      events: webhookConfigs.events,
      signingSecret: webhookConfigs.signingSecret,
    })
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, 1)))
    .limit(20);

  if (configs.length === 0) {
    add(result.infos, "webhook", "webhook.empty", "未配置 Webhook，外部系统不会自动接收参与和发放事件");
    return;
  }

  for (const config of configs) {
    if (!isSafeHttpUrl(config.url)) {
      add(result.errors, "webhook", "webhook.url.invalid", "存在无效的启用 Webhook URL");
    }

    let events: unknown;
    try {
      events = JSON.parse(config.events || "[]");
    } catch {
      events = null;
    }
    if (!Array.isArray(events) || events.length === 0 || events.some((event) => typeof event !== "string" || !event.trim())) {
      add(result.errors, "webhook", "webhook.events.invalid", "存在启用 Webhook 未配置有效事件列表");
    }

    if (!config.signingSecret) {
      add(result.warnings, "webhook", "webhook.signing_secret.empty", "存在启用 Webhook 尚未生成签名密钥，首次投递时会自动补齐");
    }
  }
}

function validateActivityConfig(draw: LotteryDraw, result: PublishCheckResult) {
  const validation = validateActivityConfigForPublish(draw.activityKind, draw.activityConfig);
  for (const item of validation.issues) {
    add(result.errors, "activity_config", item.code, item.message);
  }
  if ((draw.activityKind === "survey" || draw.activityKind === "vote") && validation.ok) {
    add(result.infos, "activity_config", `${draw.activityKind}.config.ready`, "活动配置已完成，公开提交会按后端规则校验");
  }
}

export async function buildPublishCheckForDraw(
  db: DbType,
  tenantId: string,
  draw: LotteryDraw,
  options: PublishCheckOptions = {},
): Promise<PublishCheckResult> {
  const result: PublishCheckResult = { canPublish: false, errors: [], warnings: [], infos: [] };

  validateBasic(draw, result);
  await validateParticipation(db, tenantId, draw, result);
  await validateLotteryPrizes(db, tenantId, draw, result);

  if (draw.activityKind === "signup_chain" && !draw.maxParticipants) {
    add(result.warnings, "activity_config", "signup_chain.capacity.default", "接龙活动未显式设置名额上限，将使用系统默认容量");
  }

  await validatePromotion(db, tenantId, draw, result, options);
  await validateWebhooks(db, tenantId, result);
  validateActivityConfig(draw, result);

  result.canPublish = result.errors.length === 0;
  return result;
}

export async function buildPublishCheck(
  db: DbType,
  tenantId: string,
  drawId: string,
  options: PublishCheckOptions = {},
): Promise<PublishCheckResult | null> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return null;
  return buildPublishCheckForDraw(db, tenantId, draw, options);
}

/** 从 systemConfig 读整数值，无配置则默认 fallback */
async function readSystemConfigInteger(db: DbType, key: string, fallback: number): Promise<number> {
  try {
    const [row] = await db
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);
    if (row) {
      const v = Number(row.value || "");
      if (Number.isFinite(v) && v >= 0) return Math.floor(v);
    }
  } catch { /* 表不存在或未迁移 → 默认 */ }
  return fallback;
}


function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}


async function readSystemConfigNumber(db: DbType, key: string, fallback: number): Promise<number> {
  try {
    const [row] = await db
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);
    if (row) { const v = Number(row.value || ""); if (Number.isFinite(v) && v >= 0) return v; }
  } catch { /* 表不存在 → 默认 */ }
  return fallback;
}
