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

  const isInstant = String(draw.resultMode || "") === "instant";
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

function validatePromotion(draw: LotteryDraw, result: PublishCheckResult) {
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
  if (draw.resultMode !== "instant" && experience?.prizePanelMode === "full_on_shell") {
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
