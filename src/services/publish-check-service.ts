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
import { PAYMENT_PROVIDER_CATALOG, type PaymentProviderCatalogItem } from "@usethink/cf-pay/catalog";
import { decryptPaymentConfigValueResult, isEncryptedPaymentConfigValue } from "@usethink/cf-pay/config-store";
import {
  DIRECT_SALE_CODE_POOL_OCCUPYING_STATUSES,
  hasDirectSaleCodePoolConflict,
} from "./lottery/types";
import { normalizeLeaderboardRewards } from "./lottery/leaderboard-rewards";
import { isViralEnabled } from "./lottery/viral-weight";
import { normalizeDailyFreeSpinConfig, normalizePityConfig, normalizeReferralRewards } from "./lottery/spin-quota";
import { normalizeReferralRewardDefs, collectReferralRewardDefIssues } from "./lottery/referral-rewards-engine";

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
      inArray(lotteryDraws.status, DIRECT_SALE_CODE_POOL_OCCUPYING_STATUSES),
    ));
  if (hasDirectSaleCodePoolConflict(sharedPrizeDraws.length)) {
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
  if (draw.activityKind !== "lottery") {
    if (String(draw.experienceType || "").trim().toLowerCase() === "wheel") {
      add(
        result.errors,
        "basic",
        "basic.experience.wheel_requires_lottery",
        "大转盘体验只适用于抽奖活动（activity_kind=lottery）；领取、秒杀、问卷、投票等活动请使用对应体验",
      );
    }
    return;
  }

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
      if (isInstant && String(draw.experienceType || "").trim().toLowerCase() === "wheel") {
        add(
          result.warnings,
          "prizes",
          "prizes.instant_wheel.value_required",
          `即时大转盘奖品"${tier.prizeName}"未填写权益/价值说明；若用户无法理解奖品内容，请改用普通领取/结果展示体验`,
        );
      } else {
        add(result.infos, "prizes", "prizes.value.empty", `奖品"${tier.prizeName}"未填写价值展示文案`);
      }
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

  // 保底机制校验：仅支持即时开奖模式（result_mode=instant）。
  // 如果管理员在 delayed/manual 模式中配置了 pity.enabled=true，运行时
  // performInstantSpin 不会被调用，保底逻辑完全不执行，导致配置不生效的困惑。
  // 用 normalizePityConfig 判定「有效启用」而非裸读 enabled：与运行时同一来源，
  // 避免 enabled 幻值（"true"/1）绕过阻断、或 threshold 无效时误报「不支持」。
  const pityRaw = promotionConfig?.pity as Record<string, unknown> | undefined;
  const pity = normalizePityConfig(pityRaw);
  // 配置了开启意图但阈值无效被归一化禁用 → warning 告知，防止运营困惑「开了保底为什么不生效」
  if (pityRaw?.enabled === true && !pity.enabled) {
    add(result.warnings, "promotion", "promotion.pity.disabled_by_invalid_threshold", "保底机制已开启但阈值无效（需正整数 ≥1），保底不会生效");
  }
  if (pity.enabled && !isInstantResultMode(draw.resultMode)) {
    add(result.errors, "promotion", "promotion.pity.delayed_not_supported", "保底机制仅支持即时开奖模式（result_mode=instant），当前模式不会触发保底逻辑");
  }

  // 每日免费抽奖校验：与保底机制同理，仅支持即时开奖模式。
  // dailyFreeSpins 的领取逻辑在 performInstantSpin 事务内执行，delayed/manual
  // 模式不调用该函数，配置后不生效且无任何提示。
  const dailyFreeRaw = promotionConfig?.dailyFreeSpins as Record<string, unknown> | undefined;
  const dailyFree = normalizeDailyFreeSpinConfig(dailyFreeRaw);
  // 配置了开启意图但次数无效被归一化禁用 → warning 告知
  if (dailyFreeRaw?.enabled === true && !dailyFree.enabled) {
    add(result.warnings, "promotion", "promotion.dailyFree.disabled_by_invalid_count", "每日免费抽奖已开启但次数无效（需 ≥1），每日免费不会生效");
  }
  if (dailyFree.enabled && !isInstantResultMode(draw.resultMode)) {
    add(result.errors, "promotion", "promotion.dailyFree.delayed_not_supported", "每日免费抽奖仅支持即时开奖模式（result_mode=instant），当前模式不会触发每日免费逻辑");
  }

  // 推荐里程碑校验：与保底/每日免费同理，仅支持即时开奖模式。
  // processReferralMilestoneRewards 仅在 InstantSpin 体系（maxSpins>=1）中执行，
  // delayed/manual 模式配置后静默不生效且无提示。
  const referralRewards = promotionConfig?.referralRewards;
  if (Array.isArray(referralRewards) && referralRewards.length > 0 && !isInstantResultMode(draw.resultMode)) {
    add(result.errors, "promotion", "promotion.referralRewards.delayed_not_supported", "推荐里程碑奖励仅支持即时开奖模式（result_mode=instant），当前模式不会触发里程碑逻辑");
  }
  // P2 审查项：referralRewards 全为无效项（requireCount/rewardValue 越界或非 bonus_spin）时，
  // 与 pity/dailyFree 的 disabled_by_invalid_* 同语义，warning 告知"配了但不会生效"（防遗忘闭环）。
  // 用与运行时同一 normalizeReferralRewards 判定，杜绝"预检说有奖励、实际发放为零"偏差。
  if (
    isInstantResultMode(draw.resultMode) &&
    Array.isArray(referralRewards) &&
    referralRewards.length > 0 &&
    normalizeReferralRewards(referralRewards).length === 0
  ) {
    add(result.warnings, "promotion", "promotion.referralRewards.invalid_entries", "推荐里程碑配置了条目但全部无效（requireCount 需 1–100、rewardValue 需 1–1000 且类型为 bonus_spin），奖励不会发放");
  }

  // engine-powered 推荐奖励（docs/250）：referralRewardDefs 与 referralRewards 互斥。
  // 两者共用 shareRecords.rewardMilestonesGranted 做幂等标记，但存储格式不同
  // （referralRewards 存 requireCount 数值数组，referralRewardDefs 存 rewardId 字符串数组），
  // 同时配置会导致双方互读对方的标记而误解，必须拦截。
  const referralRewardDefs = promotionConfig?.referralRewardDefs;
  const hasReferralRewards = Array.isArray(referralRewards) && referralRewards.length > 0;
  const hasReferralRewardDefs = Array.isArray(referralRewardDefs) && referralRewardDefs.length > 0;
  if (hasReferralRewards && hasReferralRewardDefs) {
    add(result.errors, "promotion", "promotion.referralRewards.conflict", "不能同时配置 referralRewards 和 referralRewardDefs，请只保留一种推荐奖励配置");
  }
  // referralRewardDefs 全为无效项时 warning 告知（与 referralRewards.invalid_entries 同语义）
  if (hasReferralRewardDefs && normalizeReferralRewardDefs(referralRewardDefs).length === 0) {
    add(result.warnings, "promotion", "promotion.referralRewardDefs.invalid_entries", "推荐奖励配置了条目但全部无效（需包含 rewardId/type/target 且 rewardExit 为 bonus_spin 或 bonus_coupon），奖励不会发放");
  }
  // docs/255 §6.6（P1-3）：对每个非法条目单独报 error（含 conditions 校验原因），
  // 而非只在"全部无效"时给一条 warning——部分非法时运营能定位到具体 rewardId。
  if (hasReferralRewardDefs) {
    for (const issue of collectReferralRewardDefIssues(referralRewardDefs)) {
      add(result.errors, "promotion", "promotion.referralRewardDefs.invalid_entry", `推荐奖励 ${issue.rewardId} 配置无效：${issue.reason}`);
    }
  }

  // referralRewardDefs 的 rewardExit 与活动类型/结果模式的适配性校验（docs/252 §2.2）：
  // - bonus_spin 出口只对 lottery + instant 有效（performInstantSpin 严格限制 activityKind==="lottery"，
  //   非 lottery 活动即使加了 spins 也无法消费，spin 接口 400）
  // - bonus_coupon 出口需要租户有可用优惠券码池，否则奖励静默不发
  if (hasReferralRewardDefs) {
    const validDefs = normalizeReferralRewardDefs(referralRewardDefs);
    const isLotteryKind = draw.activityKind === "lottery";
    const isInstantMode = isInstantResultMode(draw.resultMode);
    for (const def of validDefs) {
      const meta = (def.metadata || {}) as Record<string, unknown>;
      const exit = String(meta.rewardExit || "bonus_spin");
      if (exit === "bonus_spin" && !isLotteryKind) {
        add(result.errors, "promotion", "promotion.referralRewardDefs.bonus_spin.not_lottery", `推荐奖励 ${def.rewardId} 使用 bonus_spin 出口，但当前活动类型不是 lottery，分享者无法消费抽奖次数（仅 lottery 支持即时抽奖）`);
      }
      if (exit === "bonus_spin" && isLotteryKind && !isInstantMode) {
        add(result.errors, "promotion", "promotion.referralRewardDefs.bonus_spin.not_instant", `推荐奖励 ${def.rewardId} 使用 bonus_spin 出口，但当前结果模式不是 instant，delayed 模式无 spins 体系，奖励不会发放`);
      }
      if (exit === "bonus_coupon") {
        add(result.warnings, "promotion", "promotion.referralRewardDefs.bonus_coupon.need_pool", `推荐奖励 ${def.rewardId} 使用 bonus_coupon 出口，请确保租户已导入优惠券码池（coupon_codes），否则奖励静默不发`);
      }
    }
  }

  // 裂变配置校验（P2 审查项：统一严格 ===true 判定，enabled="true" 字符串不视为启用）
  if (isViralEnabled(viral) && viral) {
    // 冲突检查（docs/254 审查发现）：viral.extraSpinsPerInvite（路径[1] grantViralSpinsToSharer）
    // 与 referralRewardDefs（路径[4] processReferralRewardsEngine）都是"邀请加 spins"语义，
    // 若同时配置，同一邀请会触发两次加次（各自 CAS 不超发，但语义重复、运营困惑）。
    // 必须二选一：用 referralRewardDefs 时，viral 的 per-invite 加次应关闭。
    if (hasReferralRewardDefs) {
      const perInvite = Number(viral.extraSpinsPerInvite ?? viral.extraEntriesPerInvite ?? 0);
      if (perInvite > 0) {
        add(result.errors, "promotion", "viral.extra_entries.conflict_with_reward_defs", "裂变传播：已配置 referralRewardDefs 引擎奖励，不能再配置 viral 每邀请加次（extraSpinsPerInvite/extraEntriesPerInvite），请二选一");
      }
    }
    // 邀请加次/加权数值仅对抽奖（lottery）有意义（instant 加 spins / delayed 开奖加权）；
    // 接龙/问卷/投票/签到/审批/预约等类型无 spins 与加权语义，前端已隐藏参数，
    // 此处同步跳过数值校验（排行榜能力仍校验），避免「UI 无入口却发布报错」的断链。
    if (draw.activityKind === "lottery") {
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
    }
    // 裂变开启但排行榜未开启时提示
    // 与 isViralLeaderboardEnabled 一致：仅显式关闭才提示（缺省开启不误报 off）
    if (viral.enabled === true && viral.leaderboardEnabled === false) {
      add(result.infos, "promotion", "viral.leaderboard.off", "裂变传播：排行榜未开启，参与者无法看到排行对比");
    }
    // 归一化排行榜奖励（与 grantLeaderboardRewards 共用 normalizeLeaderboardRewards，
    // 消除「发布预检说有奖励、实际发放为零」的校验与执行偏差）。
    const leaderboardRewards = normalizeLeaderboardRewards(viral.leaderboardRewards);
    // 排行榜奖励已配置但排行榜未开启：配置矛盾，警告运营奖励不会实际发放。
    // 注意：孤立紧跟在 leaderboard.off 之后，两个 info 同时出现会互相矛盾，因此用 warning 级别强调。
    if (viral.enabled === true && viral.leaderboardEnabled === false && leaderboardRewards.length > 0) {
      add(result.warnings, "promotion", "viral.leaderboard.rewards_require_enabled", "排行榜奖励已配置但排行榜未开启，奖励不会发放，请检查裂变配置");
    }
    // instant 模式排行榜奖励需管理员手动发放（delayed 在 performDraw 自动发放）。
    // 用 warning 而非 info：前端发布确认框只展示 errors + warnings（check.infos 无展示通道），
    // 若用 info 级，运营发布时看不到「需手动发放」提醒，奖励易被遗忘（docs/218 模式三防遗忘闭环失效）。
    // warning 语义也匹配：配置合法，仅提醒运营在活动收尾时到操作菜单手动触发。
    // ⚠️ 必须加 leaderboardEnabled !== false 守卫，避免与 leaderboard.off 矛盾：
    //    leaderboardEnabled=false 时 grantLeaderboardRewards 直接 return 不发放，
    //    若此时仍提示 manual_grant，运营会被误导去点按钮（结果 granted=0）。
    if (viral.leaderboardEnabled !== false && isInstantResultMode(draw.resultMode) && leaderboardRewards.length > 0) {
      add(result.warnings, "promotion", "viral.leaderboard.manual_grant", "即时开奖模式下排行榜奖励需在活动结束后手动发放（操作菜单 → 发放排行榜奖励），不会自动触发");
    }
  }

  // docs/130：秒杀壳配置。lottery 侧只校验「限时限量参与 + 导流」语义，不校验 shop 库存。
  const flashParsed = parseFlashSaleConfig(promotionConfig || draw.promotionConfig);
  for (const item of flashParsed.issues) {
    add(result.errors, "promotion", item.code, item.message);
  }
  if (flashParsed.config) {
    // flashSale 是“限时限量销售/导流”的完整业务体验，而非任意活动可附带的展示配置。
    // 后台会在切换活动类型时清理残留值，但旧数据、API 写入和未来导入都可能绕过前端；
    // 因而发布前必须只允许已定义过端到端语义的 lottery（免费登记）和 claim（导流/直付）。
    if (draw.activityKind !== "lottery" && draw.activityKind !== "claim") {
      add(
        result.errors,
        "promotion",
        "flash_sale.activity_kind.conflict",
        "秒杀体验仅支持 lottery（免费登记）或 claim（导流/直付）活动类型；请更换活动类型或关闭秒杀配置",
      );
    }

    // 不能仅靠 flashSale JSON 触发公开页购买逻辑：experienceType 是用户交互和后台字段可见性的事实来源。
    // 若允许两者不一致，运营会遇到“发布成功但预览不是秒杀页”或“UI 没有入口却运行直付”的断链。
    if (!isFlashSaleExperience(draw.experienceType)) {
      add(
        result.errors,
        "promotion",
        "flash_sale.experience.required",
        "已启用秒杀配置时，体验类型必须为 flash_sale；请切换为秒杀体验或关闭秒杀配置",
      );
    }

    // docs/222 红线：lottery 禁止与 paymentRequired 组合（任何 resultMode）。
    // 历史数据的开奖执行虽会额外过滤未付款 entry，但 lottery 的“抽奖结果”与直付的
    // “付款即履约”仍是两套结果与库存归属模型，不能作为正式可发布组合。
    // 直付发卡只能由 claim 承载，支付回调完成履约，不参与开奖或 spin。
    if (draw.activityKind === "lottery" && flashParsed.config.paymentRequired === true) {
      add(
        result.errors,
        "promotion",
        "promotion.lottery_payment.conflict",
        "直付秒杀（需付款）不能与抽奖活动（lottery）组合：抽奖开奖与付款即履约是两套结果和库存归属模型；请使用 claim 活动类型",
      );
    }
    if (flashParsed.config.paymentRequired === true && draw.activityKind !== "claim") {
      add(
        result.errors,
        "promotion",
        "flash_sale.payment.activity_kind.required",
        "站内直付秒杀只能使用 claim 活动类型；请切换为 claim 或关闭站内直付",
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
    // docs/239 方案 C 温和版：秒杀启用且 stockLimit 设置时，创建/编辑路由已自动联动
    // maxParticipants=stockLimit。此处兜底 API 直写 / 旧数据仍不一致的情况：
    // 从 warning 升级为 error（阻断发布），消除「名额 200 但 6 单截单」的运营误解。
    if (
      flashParsed.config.stockLimit != null &&
      draw.maxParticipants != null &&
      draw.maxParticipants > 0 &&
      flashParsed.config.stockLimit !== draw.maxParticipants
    ) {
      add(
        result.errors,
        "promotion",
        "flash_sale.stock.mismatch",
        `秒杀 stockLimit=${flashParsed.config.stockLimit} 与 maxParticipants=${draw.maxParticipants} 不一致，发布前请将活动参与上限改为 ${flashParsed.config.stockLimit} 以保持一致`,
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
  // 注意：不再添加 `${kind}.config.ready` info——"配置已完成"是发布的前置条件
  // （errors 已保证），无行动价值，纯确认性噪音；infos 通道只应承载运营可据此行动的提示。
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
