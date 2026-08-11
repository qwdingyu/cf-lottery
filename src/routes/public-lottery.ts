/**
 * 公开参与路由
 *
 * 不需要登录，通过 public_slug 访问活动。
 * 支持 open / password / roster / invite_code / registered 等参与模式。
 * 裂变与接龙列表见 public-lottery-share.ts。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getClientIp, getEnv } from "../lib/platform";
import { getDb, ok, fail, isValidEmail } from "../lib/http";
import { lotteryDraws, lotteryEntries, lotteryWinners, emailAccessCodes, lotteryRosterMembers, lotteryPrizeTiers, prizes, systemConfig, prizeCodes, couponCodes, lotterySpins, tenants } from "../db/schema";
import { eq, and, count, asc, ne, desc, gt, inArray, sql } from "drizzle-orm";
import {
  getActivityOutcome,
  joinDraw,
  cancelSignupChainEntry,
  recordActivityEvent,
  performInstantSpin,
  SpinBusinessError,
  notifyInstantSpinWinner,
  type ActivityEventType,
} from "../services/lottery-service";
import { enqueuePlatformEvent } from "../services/platform/delivery";
import { verifyJwt } from "../middleware/auth";
import { sendAccessCode } from "../services/email-service";
import { parseActivityConfig, parseActivityOperationalConfig, validateSubmissionPayload } from "../lib/activity-config";
import {
  checkPublicRateLimit,
  checkPublicIdentityRateLimit,
  resolveParticipantIdentity,
  PUBLIC_EVENT_TYPES,
  generateCode,
  hashCode,
  maskIdentity,
  verifyEmailAccessCode,
  consumeEmailAccessCode,
  tryParseJson,
  escapeHtml,
  hashEventValue,
  ogDescriptionFallback,
} from "./public-lottery-helpers";
import { setupPublicShareRoutes } from "./public-lottery-share";
import { defaultExperienceForParticipation } from "./admin-lottery-helpers";
import { buildPublicPrizeShellPayload } from "../lib/prize-shell-display";
import { buildFlashSaleRuntime, parseFlashSaleConfig } from "../lib/flash-sale-config";
import {
  PAYMENT_ENTRY_CAPACITY_STATUSES,
  PAYMENT_ENTRY_STATUS,
} from "../services/payment/payment-status";

export const publicLotteryRoute = new Hono<AppEnv>();

/**
 * 公开参与页是动态数据入口，参与人数、个人结果、裂变榜都不能被浏览器或反代缓存。
 * 这里统一加响应头，避免用户参与成功后页面仍拿到旧的「已参与 0 人」。
 */
publicLotteryRoute.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  await next();
});

// 裂变 / 接龙 / 分享码子域
setupPublicShareRoutes(publicLotteryRoute);

function publicHttpUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function formatPublicAmount(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  const normalized = String(currency || "cny").trim().toUpperCase() || "CNY";
  if (amountMinor == null) return "";
  const n = Number(amountMinor);
  if (!Number.isFinite(n) || n < 0) return "";
  if (normalized === "JPY") return `¥${Math.round(n)}`;

  const value = n / 100;
  if (normalized === "CNY") return `¥${value.toFixed(2)}`;
  if (normalized === "USD") return `$${value.toFixed(2)}`;
  if (normalized === "EUR") return `€${value.toFixed(2)}`;
  if (normalized === "GBP") return `£${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${normalized}`;
}

function productFromPublicConfig(draw: {
  title: string;
  productLink?: string | null;
  promotionConfig?: string | null;
}) {
  const productLink = tryParseJson(draw.productLink || "{}") as Record<string, unknown> | null;
  const promotion = tryParseJson(draw.promotionConfig || "{}") as Record<string, unknown> | null;
  const destination = promotion?.destination && typeof promotion.destination === "object" && !Array.isArray(promotion.destination)
    ? promotion.destination as Record<string, unknown>
    : null;
  return {
    title: String(productLink?.title || destination?.title || draw.title || "").trim(),
    imageUrl: publicHttpUrl(productLink?.imageUrl || destination?.imageUrl),
    priceText: String(productLink?.price || productLink?.priceText || destination?.priceText || "").trim(),
    url: publicHttpUrl(productLink?.url || destination?.url),
  };
}

async function readGlobalJoinLimitPerMinute(db: ReturnType<typeof getDb>): Promise<number> {
  const [row] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "rate_limit_join_per_minute")).limit(1);
  return Math.min(Math.max(parseInt(row?.value || "", 10) || 10, 1), 100);
}

async function readGlobalAccessCodeLimitPerMinute(db: ReturnType<typeof getDb>): Promise<number> {
  const [row] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "rate_limit_access_code")).limit(1);
  return Math.min(Math.max(parseInt(row?.value || "", 10) || 5, 1), 100);
}

function activityJoinIpLimit(draw: { activityConfig?: string | null }, fallback: number): number {
  return parseActivityOperationalConfig(draw.activityConfig).joinIpLimitPerMinute ?? fallback;
}

function activityJoinIdentityLimit(draw: { activityConfig?: string | null }, fallback: number): number {
  return parseActivityOperationalConfig(draw.activityConfig).joinIdentityLimitPerMinute ?? fallback;
}

function activityAccessCodeIdentityLimit(draw: { activityConfig?: string | null }, fallback: number): number {
  return parseActivityOperationalConfig(draw.activityConfig).accessCodeIdentityLimitPerMinute ?? fallback;
}

/**
 * 公开首页活动流。
 *
 * 只暴露商家明确公开且当前可参与的活动，用于首页“活动货架”。
 * 不返回内部 draw.id / tenant_id / 支付密钥 / 卡密库存明细，避免把多租户后台信息带到公网。
 */
publicLotteryRoute.get("/home-activities", async (c) => {
  const db = getDb(c);
  // 从 systemConfig 读取首页活动矩阵最大展示数（闭环），未配则默认 24
  let maxItems = 24;
  try {
    const [row] = await db
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, "home_activities_max_items"))
      .limit(1);
    if (row) { const v = Number(row.value || ""); if (Number.isFinite(v) && v >= 1) maxItems = Math.floor(v); }
  } catch { /* 表不存在 → 默认 */ }
  const limit = Math.min(maxItems, Math.max(1, Number(c.req.query("limit")) || 12));
  const nowIso = new Date().toISOString();

  const rows = await db
    .select({
      publicSlug: lotteryDraws.publicSlug,
      title: lotteryDraws.title,
      description: lotteryDraws.description,
      status: lotteryDraws.status,
      activityKind: lotteryDraws.activityKind,
      experienceType: lotteryDraws.experienceType,
      participationMode: lotteryDraws.participationMode,
      startAt: lotteryDraws.startAt,
      endAt: lotteryDraws.endAt,
      showParticipantCount: lotteryDraws.showParticipantCount,
      maxParticipants: lotteryDraws.maxParticipants,
      activeParticipantCount: lotteryDraws.activeParticipantCount,
      productLink: lotteryDraws.productLink,
      promotionConfig: lotteryDraws.promotionConfig,
      tenantId: lotteryDraws.tenantId,
      internalId: lotteryDraws.id,
    })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.visible, 1),
      eq(lotteryDraws.status, "open"),
      ne(lotteryDraws.publicSlug, ""),
      gt(lotteryDraws.endAt, nowIso),
    ))
    .orderBy(asc(lotteryDraws.endAt), desc(lotteryDraws.createdAt))
    .limit(limit);

  const drawIds = rows.map((draw) => draw.internalId);
  const claimedByDrawId = new Map<string, number>();
  if (drawIds.length > 0) {
    const claimedRows = await db
      .select({
        drawId: lotteryEntries.drawId,
        total: count(),
      })
      .from(lotteryEntries)
      .where(and(
        inArray(lotteryEntries.drawId, drawIds),
        inArray(lotteryEntries.paymentStatus, [
          PAYMENT_ENTRY_STATUS.NONE,
          ...PAYMENT_ENTRY_CAPACITY_STATUSES,
        ]),
      ))
      .groupBy(lotteryEntries.drawId);
    for (const row of claimedRows) {
      claimedByDrawId.set(row.drawId, Number(row.total || 0));
    }
  }

  const activities = rows.map((draw) => {
    const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
    const claimed = flashParsed.config?.paymentRequired === true
      ? Number(draw.activeParticipantCount || 0)
      : (claimedByDrawId.get(draw.internalId) || 0);
    const flashSale = flashParsed.config
      ? buildFlashSaleRuntime(flashParsed.config, claimed, draw.maxParticipants)
      : null;
    const product = productFromPublicConfig(draw);
    // 直付秒杀补价格（docs/137 §2）：productLink 没设 price 时，从 flashSale.priceCents 补充
    if (!product.priceText && flashSale?.priceCents && flashSale.priceCents > 0) {
      product.priceText = formatPublicAmount(flashSale.priceCents, flashSale.currency);
    }
    return {
      publicSlug: draw.publicSlug,
      title: draw.title,
      description: draw.description,
      activityKind: draw.activityKind || "lottery",
      experienceType: draw.experienceType || defaultExperienceForParticipation(draw.participationMode),
      participationMode: draw.participationMode,
      startAt: draw.startAt,
      endAt: draw.endAt,
      claimed: draw.showParticipantCount ? claimed : undefined,
      product,
      flashSale,
    };
  });

  return ok(c, { activities });
});

// ── 店铺首页(docs/142):GET /api/public/shops/:storeSlug ──
publicLotteryRoute.get("/shops/:storeSlug", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("storeSlug");
  const [tenant] = await db.select({ id: tenants.id, name: tenants.name, brandConfig: tenants.brandConfig }).from(tenants).where(eq(tenants.storeSlug, slug)).limit(1);
  if (!tenant) return fail(c, "店铺不存在", 404);
  const nowIso = new Date().toISOString();
  const rows = await db
    .select({
      id: lotteryDraws.id,
      publicSlug: lotteryDraws.publicSlug,
      title: lotteryDraws.title,
      activityKind: lotteryDraws.activityKind,
      experienceType: lotteryDraws.experienceType,
      startAt: lotteryDraws.startAt,
      endAt: lotteryDraws.endAt,
      productLink: lotteryDraws.productLink,
      promotionConfig: lotteryDraws.promotionConfig,
      maxParticipants: lotteryDraws.maxParticipants,
      participationMode: lotteryDraws.participationMode,
      description: lotteryDraws.description,
      activeParticipantCount: lotteryDraws.activeParticipantCount,
    })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.tenantId, tenant.id),
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.visible, 1),
      sql`${lotteryDraws.endAt} > ${nowIso}`,
    ))
    .orderBy(desc(lotteryDraws.startAt))
    .limit(50);
  const drawIds = rows.map((r) => r.id);
  const claimedMap = new Map<string, number>();
  if (drawIds.length > 0) {
    const counts = await db
      .select({ drawId: lotteryEntries.drawId, count: count() })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, tenant.id),
        inArray(lotteryEntries.paymentStatus, [
          PAYMENT_ENTRY_STATUS.NONE,
          ...PAYMENT_ENTRY_CAPACITY_STATUSES,
        ]),
        inArray(lotteryEntries.drawId, drawIds),
      ))
      .groupBy(lotteryEntries.drawId);
    for (const c of counts) { claimedMap.set(c.drawId, c.count as number); }
  }
  const result = rows.map((row) => {
    const { config: flashSale } = parseFlashSaleConfig(row.promotionConfig);
    const product = productFromPublicConfig(row);
    const claimed = flashSale?.paymentRequired === true
      ? Number(row.activeParticipantCount || 0)
      : (claimedMap.get(row.id) || 0);
    const flashRuntime = flashSale?.enabled
      ? buildFlashSaleRuntime(flashSale, claimed, row.maxParticipants)
      : null;
    if (!product.priceText && flashRuntime?.priceCents && flashRuntime.priceCents > 0) {
      product.priceText = formatPublicAmount(flashRuntime.priceCents, flashRuntime.currency);
    }
    return {
      publicSlug: row.publicSlug,
      title: row.title,
      activityKind: row.activityKind,
      experienceType: row.experienceType,
      startAt: row.startAt,
      endAt: row.endAt,
      description: row.description,
      product,
      flashSale: flashRuntime,
      participationMode: row.participationMode,
    };
  });
  return ok(c, { store: { name: tenant.name, brand: tryParseJson(tenant.brandConfig) || {}, storeSlug: slug }, activities: result });
});

/**
 * join 成功响应附加 instant 次数字段（docs/116）。
 * delayed / 无 entry → 空对象，不污染 payload。
 */
async function instantJoinSpinFields(
  db: ReturnType<typeof getDb>,
  draw: { id: string; tenantId: string; resultMode?: string | null; maxSpinsPerEntry?: number | null },
  entryId: string | undefined,
): Promise<Record<string, number | undefined>> {
  if (String(draw.resultMode || "") !== "instant" || !entryId) return {};
  const [row] = await db
    .select({
      spinsLeft: lotteryEntries.spinsLeft,
      spinsTotalGranted: lotteryEntries.spinsTotalGranted,
    })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, entryId),
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
    ))
    .limit(1);
  if (!row) return {};
  const left = Number(row.spinsLeft ?? 0);
  const granted = Number(row.spinsTotalGranted ?? 0);
  return {
    spinsLeft: left,
    spinsUsed: Math.max(0, granted - left),
    maxSpinsPerEntry: Number(draw.maxSpinsPerEntry || 0) || undefined,
  };
}

// ═════════════════════════════════════════════════════════
// 公开活动详情
// ═════════════════════════════════════════════════════════

publicLotteryRoute.get("/draws/:slug", async (c) => {
  const db = getDb(c);
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, c.req.param("slug")))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "open" && draw.status !== "drawn") return fail(c, "活动未开放", 400);
  // docs/083：visible=0 时对公众与「未开放」同文案，不额外泄露「存在但隐藏」
  if (Number(draw.visible ?? 1) !== 1) return fail(c, "活动未开放", 400);

  const detailFlashConfig = parseFlashSaleConfig(draw.promotionConfig).config;
  // 直付秒杀直接读取活动计数器；普通活动才扫描 entries。
  let total = 0;
  if (detailFlashConfig?.paymentRequired === true) {
    total = Number(draw.activeParticipantCount || 0);
  } else {
    const [countRow] = await db
      .select({ total: count() })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.drawId, draw.id),
        eq(lotteryEntries.tenantId, draw.tenantId),
        inArray(lotteryEntries.paymentStatus, [
          PAYMENT_ENTRY_STATUS.NONE,
          ...PAYMENT_ENTRY_CAPACITY_STATUSES,
        ]),
      ));
    total = Number(countRow?.total || 0);
  }
  const publicParticipantCount = detailFlashConfig?.paymentRequired === true
    ? Number(draw.activeParticipantCount || 0)
    : total;

  const result: any = {
    id: draw.publicSlug, // 公开页面使用 publicSlug 作为标识，不暴露内部 ID
    publicSlug: draw.publicSlug,
    title: draw.title,
    description: draw.description,
    status: draw.status,
    activityKind: draw.activityKind || "lottery",
    participationMode: draw.participationMode,
    experienceType: draw.experienceType || defaultExperienceForParticipation(draw.participationMode),
    resultMode: draw.resultMode || draw.drawTrigger,
    allocationPolicy: draw.allocationPolicy || "capacity",
    policyVersion: draw.policyVersion || 1,
    startAt: draw.startAt,
    endAt: draw.endAt,
    drawAt: draw.drawAt,
    showParticipantCount: draw.showParticipantCount,
    showWinnerCount: draw.showWinnerCount,
    // 公开端可据此决定是否展示「中奖名单」区块；个人查结果不依赖此字段
    showWinnerList: draw.showWinnerList,
    participantCount: draw.showParticipantCount ? publicParticipantCount : undefined,
    winnerCount: draw.showWinnerCount ? draw.winnerCount : undefined,
    maxParticipants: draw.maxParticipants,
    // 导流：关联商品链接（仅在活动中开放时返回）
    productLink: draw.productLink && draw.productLink !== "{}" ? tryParseJson(draw.productLink) : undefined,
    promotionConfig: draw.promotionConfig && draw.promotionConfig !== "{}" ? tryParseJson(draw.promotionConfig) : undefined,
    // 公开端只接收经过后端白名单解析的配置；无效配置会由发布闸门阻断，不在这里暴露半成品。
    activityConfig: parseActivityConfig(draw.activityConfig) || undefined,
    // instant：每人抽奖次数硬顶（0=未配置/非 instant）
    maxSpinsPerEntry: Number(draw.maxSpinsPerEntry || 0) || undefined,
  };

  // docs/130：秒杀壳运行时快照（已抢/剩余/进度）。进度来自真实 entries，不造假。
  // 为什么在公开详情计算：前端倒计时用 startAt/endAt；进度条不能只靠配置静态数。
  {
    const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
    if (flashParsed.config) {
      const claimedForFlash =
        flashParsed.config.paymentRequired === true
          ? Number(draw.activeParticipantCount || 0)
          : Number(total);
      // 即使运营关闭了「展示参与人数」，秒杀进度仍需要真实 claimed 才能诚实；
      // 仅返回聚合进度，不额外暴露明文名单。
      result.flashSale = buildFlashSaleRuntime(
        flashParsed.config,
        claimedForFlash,
        draw.maxParticipants,
      );
    }
  }

  if (draw.activityKind === "lottery") {
    const prizeRows = await db
      .select({
        tierName: lotteryPrizeTiers.tierName,
        winnerCount: lotteryPrizeTiers.winnerCount,
        weight: lotteryPrizeTiers.weight,
        name: prizes.name,
        description: prizes.description,
        imageUrl: prizes.imageUrl,
        valueText: prizes.valueText,
      })
      .from(lotteryPrizeTiers)
      .leftJoin(prizes, and(
        eq(prizes.id, lotteryPrizeTiers.prizeId),
        eq(prizes.tenantId, draw.tenantId),
      ))
      .where(and(
        eq(lotteryPrizeTiers.drawId, draw.id),
        eq(lotteryPrizeTiers.tenantId, draw.tenantId),
      ))
      .orderBy(asc(lotteryPrizeTiers.sortOrder));

    result.prizes = prizeRows.map((row, index) => ({
      tierName: row.tierName,
      winnerCount: row.winnerCount,
      /** instant 停扇索引：与 spin.prizeIndex 对齐（按 sortOrder） */
      prizeIndex: index,
      weight: Number(row.weight || 0) || undefined,
      name: row.name || row.tierName,
      description: row.description || "",
      imageUrl: row.imageUrl || "",
      valueText: row.valueText || "",
    }));

    /**
     * 游戏壳展示策略（docs/128）：
     * - instant：壳用真奖名（+图由前端挂）
     * - manual/scheduled：壳用仪式短语，避免随机停格=中奖；奖池条默认可 full 公示目录
     * prizes 列表仍完整返回（信任/instant 索引）；壳文案以 shellLabels 为准。
     */
    const shell = buildPublicPrizeShellPayload({
      resultMode: result.resultMode,
      promotionConfig: draw.promotionConfig,
      prizes: result.prizes,
    });
    result.prizePanelMode = shell.prizePanelMode;
    result.shellLabels = shell.shellLabels;
    result.shellUsesRealPrizes = shell.shellUsesRealPrizes;
    result.prizePoolDisplay = shell.prizePoolDisplay;
  }

  // 开奖后展示中奖名单
  if (draw.status === "drawn" && draw.showWinnerList) {
    const winners = await db
      .select({ identityValue: lotteryWinners.identityValue })
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, draw.id), eq(lotteryWinners.tenantId, draw.tenantId)));
    result.winners = winners.map(w => ({ identity: maskIdentity(w.identityValue) }));
  }

  return ok(c, result);
});

// ═════════════════════════════════════════════════════════
// Open Graph 元数据端点（供社交爬虫抓取活动卡片）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.get("/draws/:slug/og", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const [draw] = await db
    .select({
      title: lotteryDraws.title,
      description: lotteryDraws.description,
      status: lotteryDraws.status,
    })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return c.html("<!DOCTYPE html><html><body><h1>活动不存在</h1></body></html>", 404);

  const title = escapeHtml(draw.title);
  // 有主办方描述用描述；否则按 status 兜底，终态不写「快来参与」（docs/104）
  const rawDesc =
    String(draw.description || "").trim() || ogDescriptionFallback(draw.status);
  const desc = escapeHtml(rawDesc);
  const origin = getEnv(c, "APP_ORIGIN") || "https://lucky.eforge.xyz";
  const pageUrl = `${origin}/lottery/${slug}`;

  return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${desc}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:site_name" content="运营活动引擎" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${desc}" />
  <meta http-equiv="refresh" content="0;url=${pageUrl}" />
</head>
<body>
  <p>正在跳转到活动页…<a href="${pageUrl}">点击这里</a></p>
</body>
</html>`);
});


/** 活动事件上报：只记录平台内事实，不把点击命名为成交 */
publicLotteryRoute.post("/draws/:slug/events", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{
    eventType: ActivityEventType;
    entryId?: string;
    source?: string;
    medium?: string;
    campaign?: string;
    refCode?: string;
    metadata?: Record<string, unknown>;
  }>();

  // ── 事件类型白名单校验 ──
  if (!PUBLIC_EVENT_TYPES.has(body.eventType)) {
    return fail(c, "活动事件类型无效", 400);
  }

  // ── 字段长度限制（防止滥用大 payload 消耗 rows written） ──
  if ((body.source?.length ?? 0) > 200) return fail(c, "source 过长", 400);
  if ((body.medium?.length ?? 0) > 200) return fail(c, "medium 过长", 400);
  if ((body.campaign?.length ?? 0) > 200) return fail(c, "campaign 过长", 400);
  if ((body.refCode?.length ?? 0) > 200) return fail(c, "refCode 过长", 400);
  if ((body.entryId?.length ?? 0) > 80) return fail(c, "entryId 过长", 400);
  if (body.metadata && JSON.stringify(body.metadata).length > 2048) {
    return fail(c, "metadata 过长", 400);
  }

  // ── 限流：同一 IP 每分钟最多 30 次事件上报 ──
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `events:${ip}`, 30, 60000))) {
    return fail(c, "请求过于频繁，请稍后再试", 429);
  }

  // ── 按事件类型限流：page_view 可更频繁，其他事件限制更严 ──
  const eventTypeLimits: Record<string, number> = {
    page_view: 30,
    participation_started: 10,
    participation_completed: 10,
    cta_impression: 20,
    cta_click: 10,
    share_click: 5,
    external_conversion_reported: 5,
  };
  const typeLimit = eventTypeLimits[body.eventType] ?? 10;
  if (!(await checkPublicRateLimit(db, `events:${ip}:${body.eventType}`, typeLimit, 60000))) {
    return fail(c, "该事件类型上报过于频繁", 429);
  }

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const ipHash = await hashEventValue(getClientIp(c) || "");
  await recordActivityEvent(db, {
    tenantId: draw.tenantId,
    drawId: draw.id,
    eventType: body.eventType,
    entryId: body.entryId,
    source: body.source,
    medium: body.medium,
    campaign: body.campaign,
    refCode: body.refCode,
    metadata: body.metadata,
    ipHash,
    userAgent: c.req.header("User-Agent") || "",
  });

  return ok(c, { recorded: true });
});

// ═════════════════════════════════════════════════════════
// 发送邮箱验证码
//
// 路径设计：
// 1. 限流 → 2. 邮箱格式校验 → 3. 活动存在/开放校验 → 4. 已参与检查
// 5. 参与模式校验（名单/密码）→ 6. 黑名单（在 joinDraw 中统一执行）
// 7. 生成验证码 → 8. 标记旧码失效 → 9. 发送邮件
//
// 为什么步骤 5-6 部分在 access-code 中提前校验？
// 提前拒绝无效请求可以节省邮件发送成本和验证码生成开销。
// 名单模式如果允许黑名单用户先拿到验证码再被拒，会浪费邮件额度。
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/access-code", async (c) => {
  const ip = getClientIp(c);
  const db = getDb(c);
  // 先用平台全局验证码限流挡住横向扫活动的请求；活动级覆盖在读取 draw 后再执行。
  const globalAccessCodeLimit = await readGlobalAccessCodeLimitPerMinute(db);
  if (!(await checkPublicRateLimit(db, `access-code:${ip}`, globalAccessCodeLimit, 60000))) {
    return fail(c, "请求过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  // accessPassword / inviteCode：邮箱验证关闭（bypass）直参时也要带上，否则 password/invite 模式永远失败
  // purpose=query：仅为 my-result 发码（已参与 / 已开奖仍可发）；默认 join 保持原语义
  const body = await c.req.json<{
    email?: string;
    submission?: Record<string, unknown>;
    accessPassword?: string;
    inviteCode?: string;
    refCode?: string;
    purpose?: string;
  }>();
  const email = String(body.email || "").trim().toLowerCase();
  const purpose = String(body.purpose || "join").trim().toLowerCase() === "query" ? "query" : "join";

  // 查询活动
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  // join：仅 open；query：开奖后仍需 OTP 证明邮箱，允许 open/paused/drawing/drawn
  if (purpose === "join") {
    if (draw.status !== "open") return fail(c, "活动已结束", 400);
  } else if (!["open", "paused", "drawing", "drawn"].includes(draw.status)) {
    return fail(c, "当前无法发送查询验证码", 400);
  }

  // ── 统一身份解析：registered → (user_id, userId)；其他 → (email, email) ──
  // 身份在端点层一步解析，joinDraw 只消费不再覆盖，杜绝"传 email 存 userId"的兼容 hack。
  const identity = await resolveParticipantIdentity(c, draw.participationMode, email);
  if (!identity) {
    return fail(c, purpose === "query" ? "此活动需要登录后查询" : "此活动需要登录后才能参与", 401);
  }
  if (identity.identityType === "email" && !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }
  const accessCodeLimit = activityAccessCodeIdentityLimit(draw, globalAccessCodeLimit);
  if (identity.identityType === "email" && !(await checkPublicIdentityRateLimit(db, "access-code", draw.id, email, accessCodeLimit, 60000))) {
    return fail(c, "请求过于频繁，请稍后再试", 429);
  }

  // 检查是否已参与（按统一身份键判重）
  // 纵深防御：同时限定 tenantId + drawId，即使 drawId 泄露也无法跨租户查询参与记录
  const [existing] = await db
    .select({ id: lotteryEntries.id, paymentStatus: lotteryEntries.paymentStatus })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityValue, identity.identityValue),
    ))
    .limit(1);
  // join 意图：已参与 → 409 + entryId（裂变身份可恢复，docs/110）；query 仍可发码
  const directFlashSale = parseFlashSaleConfig(draw.promotionConfig).config?.paymentRequired === true;
  const canReopenExpiredPaymentEntry = directFlashSale && existing?.paymentStatus === PAYMENT_ENTRY_STATUS.EXPIRED;
  if (purpose === "join" && existing && !canReopenExpiredPaymentEntry) {
    return c.json(
      {
        ok: false,
        message: "您已参与此活动",
        alreadyJoined: true,
        entryId: existing.id,
      },
      409,
    );
  }

  // 名单模式校验（仅邮箱身份；registered 与 roster 互斥，由参与模式控制）
  // query：未在名单且未参与则拒，避免给无关邮箱滥发码；已参与可发
  if (identity.identityType === "email" && draw.participationMode === "roster" && !existing) {
    const [inRoster] = await db
      .select({ id: lotteryRosterMembers.id })
      .from(lotteryRosterMembers)
      .where(and(
        eq(lotteryRosterMembers.tenantId, draw.tenantId),
        eq(lotteryRosterMembers.drawId, draw.id),
        eq(lotteryRosterMembers.identityValue, email),
      ))
      .limit(1);
    if (!inRoster) return fail(c, "您不在本次活动名单中", 403);
  }

  // ── registered 模式 ──
  if (identity.identityType === "user_id") {
    // 查结果：前端应带 JWT 直调 my-result，不经邮箱 OTP
    if (purpose === "query") {
      return fail(c, "登录用户请直接查询结果，无需邮箱验证码", 400);
    }
    try {
      // registered 也必须透传 refCode：否则登录用户裂变归因全断（docs/112）
      const result = await joinDraw(db, slug, identity.identityValue, "user_id", {
        ipHash: ip,
        userAgent: c.req.header("User-Agent") || "",
        refCode: body.refCode,
        submissionPayload: body.submission,
      });
      if (!result.joined) {
        // joinDraw 对 UNIQUE 会返回 alreadyJoined + entryId（docs/110）
        if ("alreadyJoined" in result && result.alreadyJoined) {
          return c.json(
            {
              ok: false,
              message: result.message || "您已参与此活动",
              alreadyJoined: true,
              entryId: "entryId" in result ? result.entryId : undefined,
            },
            409,
          );
        }
        // docs/130：秒杀售罄透传 soldOut，前端可刷新进度并映射 flashSoldOut
        if ("soldOut" in result && result.soldOut) {
          return c.json(
            {
              ok: false,
              message: result.message || "已抢光",
              error: result.message || "已抢光",
              soldOut: true,
              code: "code" in result ? result.code : "flash_sale.sold_out",
            },
            400,
          );
        }
        return fail(c, result.message || "参与失败", 400);
      }
      // 返回 entryId/outcome/resultMode（与 verify-join 对齐）：前端依赖它们弹出结果弹窗、
      // 生成归因分享链接（GameResultModal 的 :entry-id 与 share API 均需要）。
      const entryIdJoined = "entryId" in result ? result.entryId : undefined;
      return ok(c, {
        joined: true,
        entryId: entryIdJoined,
        activityKind: draw.activityKind,
        resultMode: draw.resultMode || draw.drawTrigger,
        outcome: "outcome" in result ? result.outcome : undefined,
        submissionId: "submissionId" in result ? result.submissionId : undefined,
        ...(await instantJoinSpinFields(db, draw, entryIdJoined)),
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) return fail(c, "您已参与此活动", 409);
      return fail(c, "参与失败，请稍后重试", 400);
    }
  }

  // ── 邮箱验证码开关：L3 可关闭以跳过邮件发码（测试环境 / Resend 不可用时） ──
  // 与 cf-auth **无关**：关闭时 open 系仅凭邮箱字符串 join（弱身份，生产务必 true）。
  // 错误审查「无 cf-auth 则无法参与 / 应探测 IdP 再回退发码」不成立——本分支从不读 CF_AUTH_*。
  // cf-auth 仅是可选：verify-join 带业务 JWT 可跳过 OTP；registered 模式才强制登录态。
  // purpose=query 时即使 bypass 也必须发码：my-result 仍靠 OTP 防枚举。
  const [emailBypassCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "enable_email_verification")).limit(1);
  const emailBypass = emailBypassCfg?.value === "false"; // 默认未配置时走正常流程

  // 邮箱验证码关闭 + 参与意图：跳过邮件发码，直接参与（测试环境专用，生产务必开启）
  if (purpose === "join" && emailBypass) {
    try {
      const result = await joinDraw(db, slug, email, "email", {
        accessPassword: body.accessPassword,
        inviteCode: body.inviteCode,
        refCode: body.refCode,
        ipHash: ip,
        userAgent: c.req.header("User-Agent") || "",
        submissionPayload: body.submission,
      });
      if (!result.joined) {
        if ("alreadyJoined" in result && result.alreadyJoined) {
          return c.json(
            {
              ok: false,
              message: result.message || "您已参与此活动",
              alreadyJoined: true,
              entryId: "entryId" in result ? result.entryId : undefined,
            },
            409,
          );
        }
        // docs/130：秒杀售罄透传 soldOut
        if ("soldOut" in result && result.soldOut) {
          return c.json(
            {
              ok: false,
              message: result.message || "已抢光",
              error: result.message || "已抢光",
              soldOut: true,
              code: "code" in result ? result.code : "flash_sale.sold_out",
            },
            400,
          );
        }
        return fail(c, result.message || "参与失败", 400);
      }
      const entryIdBypass = "entryId" in result ? result.entryId : undefined;
      return ok(c, {
        joined: true,
        entryId: entryIdBypass,
        activityKind: draw.activityKind,
        resultMode: draw.resultMode || draw.drawTrigger,
        outcome: "outcome" in result ? result.outcome : undefined,
        submissionId: "submissionId" in result ? result.submissionId : undefined,
        ...(await instantJoinSpinFields(db, draw, entryIdBypass)),
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) return fail(c, "您已参与此活动", 409);
      return fail(c, "参与失败，请稍后重试", 400);
    }
  }

  // 生成验证码（join 发码 或 query 查结果发码）
  const code = generateCode();
  const codeHash = await hashCode(code);
  // 验证码有效期：优先从系统配置读取（平台运营者可调整），默认 10 分钟。
  const [expireCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "access_code_expires_seconds")).limit(1);
  const expiresSeconds = Math.min(Math.max(parseInt(expireCfg?.value || "", 10) || 600, 60), 3600);
  const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();

  // 存储验证码（标记旧码为已使用）
  await db.update(emailAccessCodes)
    .set({ used: 1 })
    .where(and(eq(emailAccessCodes.email, email), eq(emailAccessCodes.drawId, draw.id), eq(emailAccessCodes.used, 0)));

  await db.insert(emailAccessCodes).values({
    id: crypto.randomUUID(),
    email,
    drawId: draw.id,
    codeHash,
    expiresAt,
  });

  // 发送邮件
  const emailEnv = {
    cfAuthIssuer: getEnv(c, "CF_AUTH_ISSUER") || "",
    cfAuthClientId: getEnv(c, "CF_AUTH_CLIENT_ID") || "",
    cfAuthClientSecret: getEnv(c, "CF_AUTH_CLIENT_SECRET") || "",
    resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
    emailFrom: getEnv(c, "EMAIL_FROM") || "",
  };
  const sendResult = await sendAccessCode(emailEnv, email, draw.title, code);

  return ok(c, {
    sent: sendResult.ok,
    message: sendResult.ok ? "验证码已发送" : "发送失败，请稍后重试",
    expiresInSeconds: expiresSeconds,
    purpose,
  });
});

// ═════════════════════════════════════════════════════════
// 验证邮箱并参与
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/verify-join", async (c) => {
  // 先用平台全局参与限流挡住横向扫活动的请求；活动级覆盖在读取 draw 后再执行。
  const ip = getClientIp(c);
  const db = getDb(c);
  const globalJoinLimit = await readGlobalJoinLimitPerMinute(db);
  if (!(await checkPublicRateLimit(db, `join:${ip}`, globalJoinLimit, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string; code: string; accessPassword?: string; inviteCode?: string; refCode?: string; submission?: Record<string, unknown> }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  if (!email || !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  // ── 业务 JWT 跳过验证码（cf-auth OAuth / 管理端登录自签 JWT，docs/059/093） ──
  // Authorization Bearer 验签通过，且 payload.email 与 body.email 一致（大小写不敏感）时，
  // 视为已完成身份认证，跳过 6 位邮箱 OTP。
  // 必须与 my-result 同策略：body.email 已 toLowerCase，JWT claim 也必须规范化后再比；
  // 否则 MixedCase claim 会误拒合法登录、把用户逼回 OTP（或空码失败）。
  // 不一致 / 无 email claim / 验签失败 → 不授信，继续 OTP（防拿别人 token 代参指定邮箱）。
  let bearerIdentityVerified = false;
  if (!code) {
    const bearerToken = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (bearerToken) {
      const jwtSecret = getEnv(c, "JWT_SECRET");
      if (jwtSecret) {
        try {
          const payload = await verifyJwt(bearerToken, jwtSecret);
          const tokenEmail = String(payload?.email || "").trim().toLowerCase();
          if (tokenEmail && tokenEmail === email) {
            bearerIdentityVerified = true;
          }
        } catch { /* token 无效，继续走验证码流程 */ }
      }
    }
  }

  // 无有效业务 JWT 时：必须提供 6 位验证码
  if (!bearerIdentityVerified && (!code || code.length !== 6)) {
    return fail(c, "请输入 6 位验证码", 400);
  }

  // 查询活动
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "open") return fail(c, "活动已结束", 400);
  const joinIpLimit = activityJoinIpLimit(draw, globalJoinLimit);
  if (!(await checkPublicRateLimit(db, `join:${draw.id}:${ip}`, joinIpLimit, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const joinLimit = activityJoinIdentityLimit(draw, globalJoinLimit);
  if (!(await checkPublicIdentityRateLimit(db, "join", draw.id, email, joinLimit, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }

  // ── registered 模式：必须用业务自签 JWT 的 sub 作为 user_id；否则 401 ──
  // registered 活动的验证码在 access-code 端点永不生成（该端点 JWT 直通），
  // 但活动从 open 改为 registered 时可能残留未过期的旧验证码。
  // 若不拦截，攻击者可用旧验证码经 verify-join 以 email 身份参与，绕过登录门槛。
  // cf-auth / 用户名密码登录签发的 JWT：sub 作为 user_id 身份参与。
  let identityType = "email" as string;
  let identityValue = email as string;
  if (draw.participationMode === "registered") {
    identityType = "user_id";
    // 从 Authorization 头解析自签 JWT
    const bearerToken = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!bearerToken) {
      return fail(c, "此活动需要登录后参与", 401);
    }
    const jwtSecret = getEnv(c, "JWT_SECRET");
    if (!jwtSecret) throw new Error("JWT_SECRET 未配置");
    try {
      const payload = await verifyJwt(bearerToken, jwtSecret);
      if (!payload?.sub) {
        return fail(c, "登录已过期，请重新登录", 401);
      }
      identityValue = payload.sub;
      bearerIdentityVerified = true; // registered + 有效 JWT：跳过邮箱 OTP
    } catch {
      return fail(c, "登录已过期，请重新登录", 401);
    }
  }

  // 验证验证码（持有匹配 email 的业务 JWT 时跳过）
  let validCode = null;
  if (!bearerIdentityVerified) {
    validCode = await verifyEmailAccessCode(db, email, draw.id, code);
    if (!validCode) return fail(c, "验证码无效或已过期", 400);
  }

  try {
    const submission = validateSubmissionPayload(draw.activityKind, draw.activityConfig, body.submission);
    if (!submission.ok) return fail(c, submission.message || "提交内容无效", 400);
    const result = await joinDraw(db, slug, identityValue, identityType, {
      accessPassword: body.accessPassword,
      inviteCode: body.inviteCode,
      ipHash: ip,
      refCode: body.refCode,
      userAgent: c.req.header("User-Agent") || "",
      submissionPayload: submission.payload,
      /** 验证码 ID：joinDraw 事务内标记已用；Bearer 身份跳过 OTP 时不传 */
      codeIdToConsume: validCode?.id,
    });
    if (!result.joined) {
      if ("alreadyJoined" in result && result.alreadyJoined) {
        return c.json(
          {
            ok: false,
            message: result.message || "您已参与此活动",
            alreadyJoined: true,
            entryId: "entryId" in result ? result.entryId : undefined,
          },
          409,
        );
      }
      // docs/130：秒杀售罄透传 soldOut
      if ("soldOut" in result && result.soldOut) {
        return c.json(
          {
            ok: false,
            message: result.message || "已抢光",
            error: result.message || "已抢光",
            soldOut: true,
            code: "code" in result ? result.code : "flash_sale.sold_out",
          },
          400,
        );
      }
      return fail(c, result.message || "参与失败", 400);
    }
    const entryIdVerify = "entryId" in result ? result.entryId : undefined;
    return ok(c, {
      joined: true,
      entryId: entryIdVerify,
      activityKind: draw.activityKind || "lottery",
      // 前端结果弹窗按 result_mode 分支文案（instant / scheduled / manual）
      resultMode: draw.resultMode || draw.drawTrigger,
      outcome: "outcome" in result ? result.outcome : undefined,
      submissionId: "submissionId" in result ? result.submissionId : undefined,
      ...(await instantJoinSpinFields(db, draw, entryIdVerify)),
    });
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) return fail(c, "您已参与此活动", 409);
    return fail(c, "参与失败，请稍后重试", 400);
  }
});

// ═════════════════════════════════════════════════════════
// 查询我的结果（输入邮箱+验证码，查看中奖卡密/安慰奖券）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/my-result", async (c) => {
  const db = getDb(c);
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `my-result:${ip}`, 10, 60000))) {
    return fail(c, "查询过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string; code: string }>();
  let email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      participationMode: lotteryDraws.participationMode,
      status: lotteryDraws.status,
      resultMode: lotteryDraws.resultMode,
      activityKind: lotteryDraws.activityKind,
      maxSpinsPerEntry: lotteryDraws.maxSpinsPerEntry,
    })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // docs/084：open 系对齐 verify-join——业务 JWT.email 可免 OTP；无 body.email 时用 JWT 邮箱。
  // 须在 resolveParticipantIdentity 之前解析，避免空 email 先写成错误身份键。
  let bearerEmailVerified = false;
  if (draw.participationMode !== "registered") {
    const bearerToken = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (bearerToken) {
      const jwtSecret = getEnv(c, "JWT_SECRET");
      if (jwtSecret) {
        try {
          const payload = await verifyJwt(bearerToken, jwtSecret);
          const tokenEmail = String(payload?.email || "").trim().toLowerCase();
          if (tokenEmail && isValidEmail(tokenEmail)) {
            if (!email) {
              email = tokenEmail;
              bearerEmailVerified = true;
            } else if (tokenEmail === email) {
              bearerEmailVerified = true;
            }
            // body.email 与 token.email 不一致：不授信 JWT，仍走 OTP（防拿别人 token 查指定邮箱）
          }
        } catch {
          /* token 无效，继续走 OTP */
        }
      }
    }
  }

  // ── 统一身份解析：registered → (user_id, userId)；其他 → (email, email) ──
  // registered：JWT 即身份证明，跳过验证码。无 JWT 直接拒绝。
  const identity = await resolveParticipantIdentity(c, draw.participationMode, email);
  if (!identity) return fail(c, "此活动需要登录后查询", 401);

  // 邮箱身份：无 JWT 免码时必须 email+OTP
  if (identity.identityType === "email" && !bearerEmailVerified) {
    if (!email || !code) return fail(c, "请输入邮箱和验证码", 400);
  }
  if (identity.identityType === "email" && !email) {
    return fail(c, "请输入邮箱和验证码", 400);
  }
  if (identity.identityType === "email" && !(await checkPublicIdentityRateLimit(db, "my-result", draw.id, email, 10, 60000))) {
    return fail(c, "查询过于频繁，请稍后再试", 429);
  }

  // 验证码：仅邮箱身份且未持有匹配 email 的业务 JWT（查询不消耗验证码，防枚举）
  if (identity.identityType === "email" && !bearerEmailVerified) {
    const validCode = await verifyEmailAccessCode(db, email, draw.id, code);
    if (!validCode) {
      return fail(c, "验证码无效或已过期", 400);
    }
  }

  const identityValue = identity.identityType === "email" ? email : identity.identityValue;
  const activityKind = draw.activityKind || "lottery";
  /**
   * 结果族：决定前端文案，禁止所有活动共用「未抽中奖品」。
   * - lottery：lottery_winners + 可选卡密
   * - assignment：接龙/候补等 activity_outcomes（占位/候补）
   * - review：审批类 outcome
   * - participation：问卷/投票/签到等「参与即完成」，无中奖语义
   */
  const resultFamily =
    activityKind === "lottery" || activityKind === "claim"
      ? "lottery"
      : activityKind === "signup_chain" || activityKind === "waitlist" || activityKind === "reservation"
        ? "assignment"
        : activityKind === "approval"
          ? "review"
          : "participation";

  const [entry] = await db
    .select({ id: lotteryEntries.id, joinedAt: lotteryEntries.joinedAt })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityValue, identityValue),
    ))
    .limit(1);

  // 1. 抽奖/领取：是否中奖 + 奖品信息 + 可选卡密
  // 人工履约（manual_fulfillment）无码池：仍必须 won=true，并返回奖品名/履约说明（docs/100）。
  let won = false;
  let prizeCode: string | null = null;
  let prizeName: string | null = null;
  let prizeType: string | null = null;
  let prizeValueText: string | null = null;
  let fulfillmentNote: string | null = null;
  let tierName: string | null = null;
  /** 接龙/审批等：与 join 返回的 outcome 同形，查结果必须能回放（docs/101） */
  let outcome: {
    id: string;
    outcomeType: string;
    status: string;
    sequenceNo: number | null;
    assignmentNo: number | null;
    resultLabel: string;
    decidedAt: string | null;
  } | null = null;

  /** instant 多奖：wins[]；兼容旧客户端保留首条到 won/prizeCode */
  const wins: Array<{
    winnerId: string;
    spinId: string | null;
    tierName: string | null;
    prizeName: string | null;
    prizeType: string | null;
    prizeCode: string | null;
    prizeValueText: string | null;
    fulfillmentNote: string | null;
    drawnAt: string | null;
  }> = [];

  let spinsLeft: number | null = null;
  let spinsUsed: number | null = null;
  let maxSpinsPerEntry: number | null = null;

  if (entry && resultFamily === "lottery") {
    const winnerRows = await db
      .select({
        id: lotteryWinners.id,
        spinId: lotteryWinners.spinId,
        prizeCodeId: lotteryWinners.prizeCodeId,
        tierId: lotteryWinners.tierId,
        drawnAt: lotteryWinners.drawnAt,
      })
      .from(lotteryWinners)
      .where(and(
        eq(lotteryWinners.tenantId, draw.tenantId),
        eq(lotteryWinners.drawId, draw.id),
        eq(lotteryWinners.entryId, entry.id),
      ));

    for (const winner of winnerRows) {
      let wTierName: string | null = null;
      let wPrizeName: string | null = null;
      let wPrizeType: string | null = null;
      let wPrizeValueText: string | null = null;
      let wFulfillmentNote: string | null = null;
      let wPrizeCode: string | null = null;
      if (winner.tierId) {
        const [tierRow] = await db
          .select({
            tierName: lotteryPrizeTiers.tierName,
            prizeId: lotteryPrizeTiers.prizeId,
            prizeName: prizes.name,
            prizeType: prizes.prizeType,
            valueText: prizes.valueText,
            fulfillmentNote: prizes.fulfillmentNote,
          })
          .from(lotteryPrizeTiers)
          .leftJoin(prizes, eq(prizes.id, lotteryPrizeTiers.prizeId))
          .where(and(
            eq(lotteryPrizeTiers.id, winner.tierId),
            eq(lotteryPrizeTiers.tenantId, draw.tenantId),
          ))
          .limit(1);
        if (tierRow) {
          wTierName = tierRow.tierName || null;
          wPrizeName = tierRow.prizeName || tierRow.tierName || null;
          wPrizeType = tierRow.prizeType || null;
          wPrizeValueText = tierRow.valueText || null;
          wFulfillmentNote = tierRow.fulfillmentNote || null;
        }
      }
      if (winner.prizeCodeId) {
        const [pc] = await db
          .select({ code: prizeCodes.code, secret: prizeCodes.secret })
          .from(prizeCodes)
          .where(and(eq(prizeCodes.id, winner.prizeCodeId), eq(prizeCodes.tenantId, draw.tenantId)))
          .limit(1);
        if (pc) wPrizeCode = pc.secret ? `${pc.code}:${pc.secret}` : pc.code;
      }
      wins.push({
        winnerId: winner.id,
        spinId: winner.spinId || null,
        tierName: wTierName,
        prizeName: wPrizeName,
        prizeType: wPrizeType,
        prizeCode: wPrizeCode,
        prizeValueText: wPrizeValueText,
        fulfillmentNote: wFulfillmentNote,
        drawnAt: winner.drawnAt || null,
      });
    }

    if (wins.length > 0) {
      won = true;
      const first = wins[0]!;
      prizeCode = first.prizeCode;
      prizeName = first.prizeName;
      prizeType = first.prizeType;
      prizeValueText = first.prizeValueText;
      fulfillmentNote = first.fulfillmentNote;
      tierName = first.tierName;
    }

    // instant 次数字段（delayed entry 上为 0，仍可回传便于前端统一）
    // 纵深防御：同时限定 id + tenantId，防止 entry.id 被跨租户枚举
    const [entrySpins] = await db
      .select({
        spinsLeft: lotteryEntries.spinsLeft,
        spinsTotalGranted: lotteryEntries.spinsTotalGranted,
      })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.id, entry.id), eq(lotteryEntries.tenantId, draw.tenantId)))
      .limit(1);
    if (entrySpins) {
      spinsLeft = Number(entrySpins.spinsLeft ?? 0);
      const granted = Number(entrySpins.spinsTotalGranted ?? 0);
      spinsUsed = Math.max(0, granted - spinsLeft);
    }
    if (String(draw.resultMode || "") === "instant") {
      maxSpinsPerEntry = Number(draw.maxSpinsPerEntry || 0) || null;
    }
  } else if (entry && (resultFamily === "assignment" || resultFamily === "review")) {
    // 接龙在 join 时已写 activity_outcomes；审批在后台写入。
    // 旧 my-result 只查 winners → 接龙永远 won=false → 前端「未获得奖品」（docs/101）。
    const row = await getActivityOutcome(db, draw.tenantId, draw.id, entry.id);
    if (row) {
      outcome = {
        id: row.id,
        outcomeType: row.outcomeType,
        status: row.status,
        sequenceNo: row.sequenceNo ?? null,
        assignmentNo: row.assignmentNo ?? null,
        resultLabel: row.resultLabel || "",
        decidedAt: row.decidedAt || null,
      };
      // 正式占位可视为「有结果成功」；候补/待审不是「未中奖」
      if (row.status === "assigned" || row.status === "approved") {
        won = false; // 语义上不是抽奖中奖；前端靠 resultFamily+outcome 展示
      }
    }
  }

  // 2. 安慰奖：仅抽奖类且未中奖（接龙/问卷不应套用「未中奖发券」查询语义干扰主结果）
  let consolationCoupon: string | null = null;
  if (resultFamily === "lottery" && !won) {
    const [coupon] = await db
      .select({ code: couponCodes.code, status: couponCodes.status })
      .from(couponCodes)
      .where(and(
        eq(couponCodes.tenantId, draw.tenantId),
        eq(couponCodes.drawId, draw.id),
        eq(couponCodes.recipientEmail, identityValue),
      ))
      .limit(1);
    if (coupon && coupon.status === "issued") {
      consolationCoupon = coupon.code;
    }
  }

  return ok(c, {
    joined: !!entry,
    /**
     * 裂变身份键：已参与必须返回 entryId。
     * 前端 hydrateJoinedState / queryMyResult / ViralLeaderboard / share 全链路依赖它；
     * 缺省会导致「已参与无 entry」只能看榜、无法生成 ?ref= 专属链接（docs/110）。
     */
    entryId: entry?.id || null,
    joinedAt: entry?.joinedAt || null,
    won,
    /** instant 多奖列表；无中奖时 []。旧客户端可只看 won/prizeCode（首条） */
    wins,
    activityKind,
    /** lottery | assignment | review | participation — 前端分支用，勿再默认「未抽中」 */
    resultFamily,
    /** 活动状态：open/drawing/drawn… 仅 lottery 终态可说「未中奖」 */
    drawStatus: draw.status,
    resultMode: draw.resultMode || null,
    prizeCode,
    prizeName,
    prizeType,
    prizeValueText,
    fulfillmentNote,
    tierName,
    consolationCoupon,
    outcome,
    spinsLeft,
    spinsUsed,
    maxSpinsPerEntry,
  });
});

// ═════════════════════════════════════════════════════════
// instant spin（docs/116）：独立结果机，与 performDraw 互斥
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/spin", async (c) => {
  const db = getDb(c);
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `spin:${ip}`, 20, 60000))) {
    return fail(c, "抽奖过于频繁，请稍后再试", 429);
  }

  const slug = c.req.param("slug");
  const body = await c.req.json<{
    email?: string;
    code?: string;
    idempotencyKey?: string;
  }>().catch(() => ({} as { email?: string; code?: string; idempotencyKey?: string }));

  let email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();
  const idempotencyKey =
    String(body.idempotencyKey || c.req.header("Idempotency-Key") || "").trim();

  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      title: lotteryDraws.title,
      participationMode: lotteryDraws.participationMode,
      resultMode: lotteryDraws.resultMode,
      activityKind: lotteryDraws.activityKind,
    })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "lottery" || String(draw.resultMode || "") !== "instant") {
    return fail(c, "该活动不支持即时抽奖", 400);
  }

  // 与 my-result 同策略：业务 JWT 可免 OTP
  let bearerEmailVerified = false;
  if (draw.participationMode !== "registered") {
    const bearerToken = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (bearerToken) {
      const jwtSecret = getEnv(c, "JWT_SECRET");
      if (jwtSecret) {
        try {
          const payload = await verifyJwt(bearerToken, jwtSecret);
          const tokenEmail = String(payload?.email || "").trim().toLowerCase();
          if (tokenEmail && isValidEmail(tokenEmail)) {
            if (!email) {
              email = tokenEmail;
              bearerEmailVerified = true;
            } else if (tokenEmail === email) {
              bearerEmailVerified = true;
            }
          }
        } catch {
          /* 继续 OTP */
        }
      }
    }
  }

  const identity = await resolveParticipantIdentity(c, draw.participationMode, email);
  if (!identity) return fail(c, "此活动需要登录后抽奖", 401);

  // 邮箱身份必须有 email（OTP 可在幂等回放时省略）
  if (identity.identityType === "email" && !email) {
    return fail(c, "请输入邮箱和验证码", 400);
  }
  if (identity.identityType === "email" && !(await checkPublicIdentityRateLimit(db, "spin", draw.id, email, 20, 60000))) {
    return fail(c, "抽奖过于频繁，请稍后再试", 429);
  }
  // 幂等键是 spin 的业务必需字段；必须在 OTP 核销前先拒绝明显无效请求，
  // 避免用户因缺 header/前端 bug 白白消耗验证码。
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return fail(c, "缺少有效的幂等键", 400);
  }

  /**
   * 幂等回放提前：同 Idempotency-Key 已有 spin 时免 OTP。
   * 避免「首次成功已核销码 → 弱网重试带同 key 却 400」；新 key 仍须 OTP。
   */
  if (idempotencyKey) {
    const [priorSpin] = await db
      .select({ id: lotterySpins.id })
      .from(lotterySpins)
      .where(and(
        eq(lotterySpins.tenantId, draw.tenantId),
        eq(lotterySpins.drawId, draw.id),
        eq(lotterySpins.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (priorSpin) {
      // 走 performInstantSpin 统一回放载荷（含码/次数），不再验 OTP、不核销
      try {
        const identityValueEarly =
          identity.identityType === "email" ? email : identity.identityValue;
        const result = await performInstantSpin(db, {
          slug,
          identityType: identity.identityType,
          identityValue: identityValueEarly,
          idempotencyKey,
          ipHash: await hashEventValue(ip),
        });
        return ok(c, result);
      } catch (err) {
        if (err instanceof SpinBusinessError) {
          return fail(c, err.message, err.httpStatus);
        }
        return fail(c, err instanceof Error ? err.message : "抽奖失败", 400);
      }
    }
  }

  // 弱会话首次 spin：必须 OTP，且在进入抽奖事务前先 CAS 核销。
  // 为什么不等成功后再核销：verify→spin→consume 会留下竞态窗口，同一验证码可被两个不同
  // Idempotency-Key 并发验证通过并各自完成一次 spin。先 used=0→1 领取验证码，只有第一个请求
  // 能继续抽奖；若后续业务失败，用户可重新获取验证码，优先保证“不重复扣次/发奖”的资金安全。
  if (identity.identityType === "email" && !bearerEmailVerified) {
    if (!code) return fail(c, "请输入邮箱和验证码", 400);
    const validCode = await verifyEmailAccessCode(db, email, draw.id, code);
    if (!validCode) return fail(c, "验证码无效或已过期", 400);
    const consumed = await consumeEmailAccessCode(db, validCode.id);
    if (!consumed) return fail(c, "验证码已被使用，请重新获取验证码", 400);
  }

  const identityValue = identity.identityType === "email" ? email : identity.identityValue;
  const ipHash = await hashEventValue(ip);

  try {
    const result = await performInstantSpin(db, {
      slug,
      identityType: identity.identityType,
      identityValue,
      idempotencyKey,
      ipHash,
    });

    // 业务层失败（如 quota exhausted）：返回错误信息，不进入后续流程
    // 用 409（Conflict）而非 400（Bad Request）表示"资源状态冲突（次数已用完）"：
    // 前端 LotteryView.vue 依赖 res.status === 409 将该活动剩余次数置 0，
    // 并避免误判为"验证码失效"（400 分支会打开登录弹窗）。这是发布契约，不可擅自改状态码。
    if (result.businessError) {
      return fail(c, result.businessError, 409);
    }

    // 中奖邮件：fire-and-forget，失败不回滚 spin；回放不重发（notificationStatus=sent 跳过）
    if (result.won && !result.replayed) {
      const emailEnv = {
        resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
        emailFrom: getEnv(c, "EMAIL_FROM") || "",
        emailFromName: getEnv(c, "EMAIL_FROM_NAME") || "",
        remoteEmailUrl: getEnv(c, "REMOTE_EMAIL_URL") || undefined,
        remoteEmailClientId: getEnv(c, "REMOTE_EMAIL_CLIENT_ID") || undefined,
        remoteEmailClientSecret: getEnv(c, "REMOTE_EMAIL_CLIENT_SECRET") || undefined,
      };
      void notifyInstantSpinWinner(db, draw.tenantId, draw.id, result.spinId, emailEnv).catch((err) => {
        console.error(`[public] notifyInstantSpinWinner failed for ${result.spinId}:`, err);
      });

      void enqueuePlatformEvent(db, {
        tenantId: draw.tenantId,
        drawId: draw.id,
        eventType: "outcome.assigned",
        eventId: `outcome:${result.spinId}`,
        data: {
          drawName: draw.title,
          userName: identity.identityType === "email"
            ? email
            : identity.identityValue,
          prizeName: result.prizeName || result.tierName || "中奖",
          claimHint: result.prizeCode ? "请在活动结果页查看卡密" : "",
        },
      }).catch((err) => {
        console.error(`[public] enqueuePlatformEvent outcome.assigned failed for ${result.spinId}:`, err);
      });
    }

    return ok(c, result);
  } catch (err) {
    if (err instanceof SpinBusinessError) {
      return fail(c, err.message, err.httpStatus);
    }
    console.error("[public] spin failed:", err);
    return fail(c, err instanceof Error ? err.message : "抽奖失败", 400);
  }
});

// ═════════════════════════════════════════════════════════
// 取消参与（接龙活动：退出 + 候补自动转正）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/cancel", async (c) => {
  const db = getDb(c);
  const ip = getClientIp(c);
  if (!(await checkPublicRateLimit(db, `cancel:${ip}`, 10, 60000))) {
    return fail(c, "取消操作过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string; code: string }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, activityKind: lotteryDraws.activityKind, participationMode: lotteryDraws.participationMode })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  // 仅接龙/报名类活动支持取消参与（抽奖参与后不可退出，防止刷量）
  if (draw.activityKind !== "signup_chain" && draw.activityKind !== "reservation") {
    return fail(c, "该活动不支持取消参与", 400);
  }

  // ── 统一身份解析：registered → (user_id, userId)；其他 → (email, email) ──
  const identity = await resolveParticipantIdentity(c, draw.participationMode, email);
  if (!identity) return fail(c, "此活动需要登录后取消", 401);

  // 邮箱+验证码必填：仅邮箱身份要求（JWT 身份无需验证码）
  if (identity.identityType === "email" && (!email || !code)) return fail(c, "请输入邮箱和验证码", 400);
  if (identity.identityType === "email" && !(await checkPublicIdentityRateLimit(db, "cancel", draw.id, email, 10, 60000))) {
    return fail(c, "取消操作过于频繁，请稍后再试", 429);
  }

  // 验证码校验（公共逻辑；取消操作不消耗验证码，防止他人冒用邮箱取消）：
  // 仅邮箱身份需要，JWT 即身份证明
  if (identity.identityType === "email") {
    const validCode = await verifyEmailAccessCode(db, email, draw.id, code);
    if (!validCode) return fail(c, "验证码无效或已过期", 400);
  }

  const result = await cancelSignupChainEntry(db, draw.tenantId, draw.id, identity.identityValue);
  if (!result.cancelled) return fail(c, "未找到您的参与记录", 404);

  // 记录取消事件（漏斗可追踪）
  await recordActivityEvent(db, {
    tenantId: draw.tenantId,
    drawId: draw.id,
    eventType: "participation_cancelled",
    entryId: "",
  });

  return ok(c, { cancelled: true, promoted: result.promoted });
});

// ═════════════════════════════════════════════════════════
// 快捷参与（公开模式，无需验证码）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/join", async (c) => {
  // 先用平台全局参与限流挡住横向扫活动的请求；活动级覆盖在读取 draw 后再执行。
  const ip = getClientIp(c);
  const db = getDb(c);
  const globalJoinLimit = await readGlobalJoinLimitPerMinute(db);
  if (!(await checkPublicRateLimit(db, `join:${ip}`, globalJoinLimit, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const body = await c.req.json<{ email: string; refCode?: string; submission?: Record<string, unknown> }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  try {
    const [draw] = await db
      .select({
        id: lotteryDraws.id,
        tenantId: lotteryDraws.tenantId,
        activityKind: lotteryDraws.activityKind,
        activityConfig: lotteryDraws.activityConfig,
        resultMode: lotteryDraws.resultMode,
        drawTrigger: lotteryDraws.drawTrigger,
        maxSpinsPerEntry: lotteryDraws.maxSpinsPerEntry,
      })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.publicSlug, c.req.param("slug")))
      .limit(1);
    if (!draw) return fail(c, "活动不存在", 404);
    const joinIpLimit = activityJoinIpLimit(draw, globalJoinLimit);
    if (!(await checkPublicRateLimit(db, `join:${draw.id}:${ip}`, joinIpLimit, 60000))) {
      return fail(c, "参与过于频繁，请稍后再试", 429);
    }
    const joinLimit2 = activityJoinIdentityLimit(draw, globalJoinLimit);
    if (!(await checkPublicIdentityRateLimit(db, "join", draw.id, email, joinLimit2, 60000))) {
      return fail(c, "参与过于频繁，请稍后再试", 429);
    }

    const submission = validateSubmissionPayload(draw.activityKind, draw.activityConfig, body.submission);
    if (!submission.ok) return fail(c, submission.message || "提交内容无效", 400);

    const result = await joinDraw(db, c.req.param("slug"), email, "email", {
      ipHash: ip,
      refCode: body.refCode,
      userAgent: c.req.header("User-Agent") || "",
      submissionPayload: submission.payload,
    });
    if (!result.joined) {
      if ("alreadyJoined" in result && result.alreadyJoined) {
        return c.json(
          {
            ok: false,
            message: result.message || "您已参与此活动",
            alreadyJoined: true,
            entryId: "entryId" in result ? result.entryId : undefined,
          },
          409,
        );
      }
      // docs/130：秒杀售罄透传 soldOut
      if ("soldOut" in result && result.soldOut) {
        return c.json(
          {
            ok: false,
            message: result.message || "已抢光",
            error: result.message || "已抢光",
            soldOut: true,
            code: "code" in result ? result.code : "flash_sale.sold_out",
          },
          400,
        );
      }
      return fail(c, result.message || "参与失败", 400);
    }
    const entryIdJoin = "entryId" in result ? result.entryId : undefined;
    return ok(c, {
      joined: true,
      entryId: entryIdJoin,
      activityKind: "activityKind" in result ? result.activityKind : undefined,
      resultMode: draw.resultMode || draw.drawTrigger,
      outcome: "outcome" in result ? result.outcome : undefined,
      submissionId: "submissionId" in result ? result.submissionId : undefined,
      ...(await instantJoinSpinFields(db, draw, entryIdJoin)),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return fail(c, "您已参与此活动", 409);
    }
    return fail(c, err instanceof Error ? err.message : "参与失败", 400);
  }
});

// ═════════════════════════════════════════════════════════
// 查询参与结果
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/result", async (c) => {
  const db = getDb(c);
  const ip = getClientIp(c);
  // ★ P0 安全：对齐 my-result，必须提供验证码防邮箱枚举
  if (!(await checkPublicRateLimit(db, `result:${ip}`, 10, 60000))) {
    return fail(c, "查询过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string; code: string }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  if (!email || !code) return fail(c, "请提供邮箱地址和验证码", 400);

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, status: lotteryDraws.status, activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (!(await checkPublicIdentityRateLimit(db, "result", draw.id, email, 10, 60000))) {
    return fail(c, "查询过于频繁，请稍后再试", 429);
  }

  // 验证码校验（仅验证身份，不消耗验证码）
  const validCode = await verifyEmailAccessCode(db, email, draw.id, code);
  if (!validCode) return fail(c, "验证码无效或已过期", 400);

  // 纵深防御：同时限定 tenantId + drawId，防止跨租户查询参与记录
  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityValue, email.toLowerCase().trim()),
    ))
    .limit(1);

  if (!entry) return fail(c, "未找到参与记录", 404);

  const result: any = { joined: true, joinedAt: entry.joinedAt, status: draw.status };

  if (draw.activityKind === "signup_chain") {
    const outcome = await getActivityOutcome(db, draw.tenantId, draw.id, entry.id);
    result.activityKind = draw.activityKind;
    result.outcome = outcome ? {
      id: outcome.id,
      outcomeType: outcome.outcomeType,
      status: outcome.status,
      sequenceNo: outcome.sequenceNo,
      assignmentNo: outcome.assignmentNo,
      resultLabel: outcome.resultLabel,
      decidedAt: outcome.decidedAt,
    } : undefined;
  } else if (draw.status === "drawn") {
    // 纵深防御：同时限定 tenantId + drawId + entryId，防止跨租户查询中奖结果
    const [winner] = await db
      .select()
      .from(lotteryWinners)
      .where(and(
        eq(lotteryWinners.tenantId, draw.tenantId),
        eq(lotteryWinners.drawId, draw.id),
        eq(lotteryWinners.entryId, entry.id),
      ))
      .limit(1);
    result.won = !!winner;
    if (winner) result.drawnAt = winner.drawnAt;
  }

  return ok(c, result);
});
