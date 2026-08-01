/**
 * 发布前预检服务。
 *
 * 设计边界：
 * - 这里是“能否正式发布”的统一门禁，路由和底层发布服务都复用它。
 * - 只检查当前活动必要的少量关联数据，避免在 Cloudflare Workers Free + Turso Free 上做全局扫描。
 * - 预检返回结构化 code/section，前端可以直接展示成运营清单，后续补问卷/投票配置时也只扩展本文件。
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { DbType } from "../db/client";
import {
  lotteryDraws,
  lotteryInviteCodes,
  lotteryPrizeTiers,
  lotteryRosterMembers,
  prizeCodes,
  prizes,
  webhookConfigs,
} from "../db/schema";
import { validateActivityConfigForPublish } from "../lib/activity-config";

export type PublishCheckSection =
  | "basic"
  | "participation"
  | "prizes"
  | "promotion"
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

  const tiers = await db
    .select({
      id: lotteryPrizeTiers.id,
      tierName: lotteryPrizeTiers.tierName,
      winnerCount: lotteryPrizeTiers.winnerCount,
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
  for (const tier of tiers) {
    const tierName = tier.tierName || "未命名奖项";
    tierWinnerTotal += Math.max(0, Number(tier.winnerCount || 0));

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

  if (draw.winnerCount !== tierWinnerTotal) {
    add(result.warnings, "prizes", "prizes.winner_count.mismatch", `活动中奖人数为 ${draw.winnerCount}，奖项名额合计为 ${tierWinnerTotal}，建议发布前统一`);
  }
}

function validatePromotion(draw: LotteryDraw, result: PublishCheckResult) {
  const promotionConfig = parseJsonObject(draw.promotionConfig);
  const legacyProductLink = parseJsonObject(draw.productLink);
  if (!promotionConfig && !legacyProductLink) {
    add(result.warnings, "promotion", "promotion.empty", "未配置参与完成后的承接动作，活动导流和转化会变弱");
    return;
  }

  if (draw.promotionConfig && draw.promotionConfig !== "{}" && !promotionConfig) {
    add(result.errors, "promotion", "promotion.json.invalid", "导流配置不是合法 JSON 对象");
    return;
  }

  const destination = promotionConfig?.destination as Record<string, unknown> | undefined;
  const destinationUrl = destination?.url ?? legacyProductLink?.url;
  if (!isSafeHttpUrl(destinationUrl)) {
    add(result.errors, "promotion", "promotion.url.invalid", "导流链接必须是有效的 http/https 外部地址");
  }

  const destinationTitle = destination?.title ?? legacyProductLink?.title;
  if (typeof destinationTitle !== "string" || !destinationTitle.trim()) {
    add(result.warnings, "promotion", "promotion.title.empty", "导流承接缺少展示标题，参与者可能不清楚下一步动作");
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

export async function buildPublishCheckForDraw(db: DbType, tenantId: string, draw: LotteryDraw): Promise<PublishCheckResult> {
  const result: PublishCheckResult = { canPublish: false, errors: [], warnings: [], infos: [] };

  validateBasic(draw, result);
  await validateParticipation(db, tenantId, draw, result);
  await validateLotteryPrizes(db, tenantId, draw, result);

  if (draw.activityKind === "signup_chain" && !draw.maxParticipants) {
    add(result.warnings, "activity_config", "signup_chain.capacity.default", "接龙活动未显式设置名额上限，将使用系统默认容量");
  }

  validatePromotion(draw, result);
  await validateWebhooks(db, tenantId, result);
  validateActivityConfig(draw, result);

  result.canPublish = result.errors.length === 0;
  return result;
}

export async function buildPublishCheck(db: DbType, tenantId: string, drawId: string): Promise<PublishCheckResult | null> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return null;
  return buildPublishCheckForDraw(db, tenantId, draw);
}
