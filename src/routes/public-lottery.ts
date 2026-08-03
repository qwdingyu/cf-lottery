/**
 * 公开参与路由
 *
 * 不需要登录，通过 public_slug 访问活动。
 * 支持四种参与模式：open（公开）、password（密码）、roster（名单）、invite_code（邀请码）
 * 所有参与模式均需邮箱验证码验证。
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../bindings";
import { getClientIp, getEnv } from "../lib/platform";
import { getDb, ok, fail, isValidEmail } from "../lib/http";
import type { DbType } from "../db/client";
import { lotteryDraws, lotteryEntries, lotteryWinners, emailAccessCodes, lotteryRosterMembers, shareRecords, lotteryPrizeTiers, prizes, systemConfig, prizeCodes, couponCodes } from "../db/schema";
import { eq, and, count, sql, asc, inArray } from "drizzle-orm";
import { getActivityOutcome, joinDraw, cancelSignupChainEntry, recordActivityEvent, type ActivityEventType } from "../services/lottery-service";
import { verifyJwt } from "../middleware/auth";
import { sendAccessCode } from "../services/email-service";
import { parseActivityConfig, validateSubmissionPayload } from "../lib/activity-config";
import { checkDbRateLimit } from "../lib/rate-limit";

export const publicLotteryRoute = new Hono<AppEnv>();

/** 简单内存限流：同一 IP 每分钟最多 10 次参与 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit = 10, windowMs = 60000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/**
 * 公开端统一限流入口：内存 Map 只做单实例快速预过滤，DB 限流才是跨实例的最终闸门。
 * 为什么保留两层：本地 Map 能减少明显刷接口时的 DB 写入，DB 记录能覆盖多 Worker/多 Node 实例。
 */
async function checkPublicRateLimit(db: DbType, key: string, limit = 10, windowMs = 60000): Promise<boolean> {
  if (!checkRateLimit(key, limit, windowMs)) return false;
  return checkDbRateLimit(db, key, limit, windowMs);
}

/**
 * 按活动 + 身份再加一层持久限流，避免攻击者绕过 IP 维度后持续猜测同一邮箱验证码。
 * 身份值只以 hash 写入 rate_limit_log，避免把邮箱明文扩大到运维日志类表。
 */
async function checkPublicIdentityRateLimit(
  db: DbType,
  action: string,
  drawId: string,
  identityValue: string,
  limit = 10,
  windowMs = 60000,
): Promise<boolean> {
  const identityHash = await hashEventValue(`${drawId}:${identityValue.trim().toLowerCase()}`);
  return checkDbRateLimit(db, `${action}:identity:${identityHash}`, limit, windowMs);
}

/**
 * 统一解析参与者身份（最佳实践：身份在端点层一步解析，业务层只消费）。
 *
 * - registered 模式：从 Authorization Bearer JWT 解析 userId → (user_id, userId)
 * - 其他模式：邮箱 → (email, email)
 *
 * 返回 null 表示未认证（registered 无 token / JWT 无效）。
 * 三处复用（access-code / my-result / cancel），杜绝每端点复制 JWT 解析逻辑。
 */
async function resolveParticipantIdentity(
  c: Context<AppEnv>,
  participationMode: string,
  email: string,
): Promise<{ identityType: string; identityValue: string } | null> {
  if (participationMode === "registered") {
    // 只从 Authorization 头取 JWT，绝不用 URL query 传递 token：
    // query 中的 token 会进入访问日志、浏览器历史与 Referer 头，是安全反模式。
    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    // JWT_SECRET 未配置时显式抛错（与 requireAuth 行为一致），避免空密钥静默验签
    const jwtSecret = getEnv(c, "JWT_SECRET");
    if (!jwtSecret) throw new Error("JWT_SECRET 未配置");
    try {
      const payload = await verifyJwt(token, jwtSecret);
      if (payload?.sub) return { identityType: "user_id", identityValue: payload.sub };
    } catch { /* JWT 无效 */ }
    return null;
  }
  return { identityType: "email", identityValue: email };
}

const PUBLIC_EVENT_TYPES = new Set<ActivityEventType>([
  "page_view",
  "participation_started",
  "participation_completed",
  "cta_impression",
  "cta_click",
  "share_click",
  "external_conversion_reported",
]);

/** 生成 6 位数字验证码 */
function generateCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num = new DataView(bytes.buffer).getUint32(0) % 1000000;
  return String(num).padStart(6, "0");
}

/** 对验证码做 SHA-256 hash */
async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 脱敏展示邮箱 */
function maskIdentity(value: string): string {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return name.slice(0, 2) + "***@" + domain;
  }
  return value.slice(0, 2) + "***";
}

/**
 * 校验邮箱验证码（公共逻辑，供参与/查询结果/取消参与复用）。
 *
 * 为什么抽取：verify-join、my-result、cancel 三处此前复制了相同的验证码查询代码，
 * 任何一处调整有效期/错误消息都容易遗漏其他处。抽取后逻辑单一来源。
 *
 * @returns 有效的验证码记录（调用方决定是否标记 used），无效返回 null
 */
async function verifyEmailAccessCode(
  db: DbType,
  email: string,
  drawId: string,
  code: string,
): Promise<typeof emailAccessCodes.$inferSelect | null> {
  const codeHash = await hashCode(code);
  const now = new Date().toISOString();
  const [validCode] = await db
    .select()
    .from(emailAccessCodes)
    .where(and(
      eq(emailAccessCodes.email, email),
      eq(emailAccessCodes.drawId, drawId),
      eq(emailAccessCodes.codeHash, codeHash),
      eq(emailAccessCodes.used, 0),
      sql`${emailAccessCodes.expiresAt} > ${now}`,
    ))
    .limit(1);
  return validCode || null;
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

  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, draw.id));

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
    participantCount: draw.showParticipantCount ? Number(total) : undefined,
    winnerCount: draw.showWinnerCount ? draw.winnerCount : undefined,
    maxParticipants: draw.maxParticipants,
    // 导流：关联商品链接（仅在活动中开放时返回）
    productLink: draw.productLink && draw.productLink !== "{}" ? tryParseJson(draw.productLink) : undefined,
    promotionConfig: draw.promotionConfig && draw.promotionConfig !== "{}" ? tryParseJson(draw.promotionConfig) : undefined,
    // 公开端只接收经过后端白名单解析的配置；无效配置会由发布闸门阻断，不在这里暴露半成品。
    activityConfig: parseActivityConfig(draw.activityConfig) || undefined,
  };

  if (draw.activityKind === "lottery") {
    const prizeRows = await db
      .select({
        tierName: lotteryPrizeTiers.tierName,
        winnerCount: lotteryPrizeTiers.winnerCount,
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

    result.prizes = prizeRows.map((row) => ({
      tierName: row.tierName,
      winnerCount: row.winnerCount,
      name: row.name || row.tierName,
      description: row.description || "",
      imageUrl: row.imageUrl || "",
      valueText: row.valueText || "",
    }));
  }

  // 开奖后展示中奖名单
  if (draw.status === "drawn" && draw.showWinnerList) {
    const winners = await db
      .select({ identityValue: lotteryWinners.identityValue })
      .from(lotteryWinners)
      .where(eq(lotteryWinners.drawId, draw.id));
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
    .select({ title: lotteryDraws.title, description: lotteryDraws.description })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return c.html("<!DOCTYPE html><html><body><h1>活动不存在</h1></body></html>", 404);

  const title = escapeHtml(draw.title);
  const desc = escapeHtml(draw.description || "快来参与活动吧！");
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

/** HTML 转义（防 XSS） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] ?? c));
}

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
  // 读取系统配置的验证码限流值（闭环：L3 配置 → 公开参与限流生效）
  const [rlCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "rate_limit_access_code")).limit(1);
  const accessCodeLimit = Math.min(Math.max(parseInt(rlCfg?.value || "", 10) || 3, 1), 100);
  if (!(await checkPublicRateLimit(db, `access-code:${ip}`, accessCodeLimit, 60000))) {
    return fail(c, "请求过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  // accessPassword / inviteCode：邮箱验证关闭（bypass）直参时也要带上，否则 password/invite 模式永远失败
  const body = await c.req.json<{
    email?: string;
    submission?: Record<string, unknown>;
    accessPassword?: string;
    inviteCode?: string;
    refCode?: string;
  }>();
  const email = String(body.email || "").trim().toLowerCase();

  // 查询活动
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "open") return fail(c, "活动已结束", 400);

  // ── 统一身份解析：registered → (user_id, userId)；其他 → (email, email) ──
  // 身份在端点层一步解析，joinDraw 只消费不再覆盖，杜绝"传 email 存 userId"的兼容 hack。
  const identity = await resolveParticipantIdentity(c, draw.participationMode, email);
  if (!identity) return fail(c, "此活动需要登录后才能参与", 401);
  if (identity.identityType === "email" && !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }
  if (identity.identityType === "email" && !(await checkPublicIdentityRateLimit(db, "access-code", draw.id, email, accessCodeLimit, 60000))) {
    return fail(c, "请求过于频繁，请稍后再试", 429);
  }

  // 检查是否已参与（按统一身份键判重）
  const [existing] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, draw.id), eq(lotteryEntries.identityValue, identity.identityValue)))
    .limit(1);
  if (existing) return fail(c, "您已参与此活动", 409);

  // 名单模式校验（仅邮箱身份；registered 与 roster 互斥，由参与模式控制）
  if (identity.identityType === "email" && draw.participationMode === "roster") {
    const [inRoster] = await db
      .select({ id: lotteryRosterMembers.id })
      .from(lotteryRosterMembers)
      .where(and(eq(lotteryRosterMembers.drawId, draw.id), eq(lotteryRosterMembers.identityValue, email)))
      .limit(1);
    if (!inRoster) return fail(c, "您不在本次活动名单中", 403);
  }

  // ── registered 模式：JWT 已认证，身份即 userId，跳过邮箱验证码直接参与 ──
  if (identity.identityType === "user_id") {
    try {
      const result = await joinDraw(db, slug, identity.identityValue, "user_id", {
        ipHash: ip,
        userAgent: c.req.header("User-Agent") || "",
        submissionPayload: body.submission,
      });
      if (!result.joined) return fail(c, result.message || "参与失败", 400);
      // 返回 entryId/outcome/resultMode（与 verify-join 对齐）：前端依赖它们弹出结果弹窗、
      // 生成归因分享链接（GameResultModal 的 :entry-id 与 share API 均需要）。
      return ok(c, {
        joined: true,
        entryId: "entryId" in result ? result.entryId : undefined,
        activityKind: draw.activityKind,
        resultMode: draw.resultMode || draw.drawTrigger,
        outcome: "outcome" in result ? result.outcome : undefined,
        submissionId: "submissionId" in result ? result.submissionId : undefined,
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) return fail(c, "您已参与此活动", 409);
      return fail(c, "参与失败，请稍后重试", 400);
    }
  }

  // ── 邮箱验证码开关：L3 可关闭以跳过邮件发码（测试环境 / Resend 不可用时） ──
  const [emailBypassCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "enable_email_verification")).limit(1);
  const emailBypass = emailBypassCfg?.value === "false"; // 默认未配置时走正常流程

  // 邮箱验证码关闭：跳过邮件发码，直接参与（测试环境专用，生产务必开启）
  if (emailBypass) {
    try {
      const result = await joinDraw(db, slug, email, "email", {
        accessPassword: body.accessPassword,
        inviteCode: body.inviteCode,
        refCode: body.refCode,
        ipHash: ip,
        userAgent: c.req.header("User-Agent") || "",
        submissionPayload: body.submission,
      });
      if (!result.joined) return fail(c, result.message || "参与失败", 400);
      return ok(c, {
        joined: true,
        entryId: "entryId" in result ? result.entryId : undefined,
        activityKind: draw.activityKind,
        resultMode: draw.resultMode || draw.drawTrigger,
        outcome: "outcome" in result ? result.outcome : undefined,
        submissionId: "submissionId" in result ? result.submissionId : undefined,
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) return fail(c, "您已参与此活动", 409);
      return fail(c, "参与失败，请稍后重试", 400);
    }
  }

  // 生成验证码
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
  const emailEnv = { resendApiKey: getEnv(c, "RESEND_API_KEY") || "", emailFrom: getEnv(c, "EMAIL_FROM") || "" };
  const sendResult = await sendAccessCode(emailEnv, email, draw.title, code);

  return ok(c, {
    sent: sendResult.ok,
    message: sendResult.ok ? "验证码已发送" : "发送失败，请稍后重试",
    expiresInSeconds: expiresSeconds,
  });
});

// ═════════════════════════════════════════════════════════
// 验证邮箱并参与
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/verify-join", async (c) => {
  // 限流：同一 IP 每分钟最多 N 次参与（由 platform system_config.rate_limit_join_per_minute 控制）
  const ip = getClientIp(c);
  const db = getDb(c);
  const [joinRlCfg] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "rate_limit_join_per_minute")).limit(1);
  const joinLimit = Math.min(Math.max(parseInt(joinRlCfg?.value || "", 10) || 10, 1), 100);
  if (!(await checkPublicRateLimit(db, `join:${ip}`, joinLimit, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string; code: string; accessPassword?: string; inviteCode?: string; refCode?: string; submission?: Record<string, unknown> }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  if (!email || !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  // ── Logto 用户跳过验证码（docs/051 方案） ──
  // 如果请求头包含有效的自签 JWT（由 /auth/logto-exchange 签发），且 JWT 中的 email
  // 与请求的 email 一致，则跳过 6 位验证码验证。Logto 用户已通过社交登录/邮箱密码
  // 完成了身份认证，不再需要二次验证码，从而减少邮件服务（Resend）的免费额度消耗。
  let logtoVerified = false;
  if (!code) {
    const bearerToken = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (bearerToken) {
      const jwtSecret = getEnv(c, "JWT_SECRET");
      if (jwtSecret) {
        try {
          const payload = await verifyJwt(bearerToken, jwtSecret);
          if (payload?.email === email) {
            logtoVerified = true;
          }
        } catch { /* token 无效，继续走验证码流程 */ }
      }
    }
  }

  // 非 Logto 用户：必须提供 6 位验证码
  if (!logtoVerified && (!code || code.length !== 6)) {
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
  if (!(await checkPublicIdentityRateLimit(db, "join", draw.id, email, joinLimit, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }

  // ── registered 模式：Logto 用户用自签 JWT 参与；否则返回 401 ──
  // registered 活动的验证码在 access-code 端点永不生成（该端点 JWT 直通），
  // 但活动从 open 改为 registered 时可能残留未过期的旧验证码。
  // 若不拦截，攻击者可用旧验证码经 verify-join 以 email 身份参与，绕过登录门槛。
  // Logto 用户（docs/051 方案）：通过自签 JWT 中的 sub（Logto 用户 ID）以 user_id 身份参与，
  // 与 registered 模式的预期行为一致（user_id 身份，非 email 身份）。
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
      logtoVerified = true; // registered 模式 Logto 用户跳过验证码
    } catch {
      return fail(c, "登录已过期，请重新登录", 401);
    }
  }

  // 验证验证码（Logto 用户跳过验证码检查，docs/051 方案）
  let validCode = null;
  if (!logtoVerified) {
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
      /** 验证码 ID：joinDraw 事务内标记为已使用，省一次 DB 往返；Logto 用户不传则跳过 */
      codeIdToConsume: validCode?.id,
    });
    if (!result.joined) return fail(c, result.message || "参与失败", 400);
    return ok(c, {
      joined: true,
      entryId: "entryId" in result ? result.entryId : undefined,
      activityKind: draw.activityKind || "lottery",
      // 前端结果弹窗按 result_mode 分支文案（instant / scheduled / manual）
      resultMode: draw.resultMode || draw.drawTrigger,
      outcome: "outcome" in result ? result.outcome : undefined,
      submissionId: "submissionId" in result ? result.submissionId : undefined,
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
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, participationMode: lotteryDraws.participationMode })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // ── 统一身份解析：registered → (user_id, userId)；其他 → (email, email) ──
  // registered 用户参与时 entry.identity_value 是 userId（UUID），邮箱+验证码无法匹配；
  // JWT 即身份证明，跳过验证码。无 JWT 直接拒绝。
  const identity = await resolveParticipantIdentity(c, draw.participationMode, email);
  if (!identity) return fail(c, "此活动需要登录后查询", 401);

  // 邮箱+验证码必填：仅邮箱身份要求（JWT 身份无需验证码）
  if (identity.identityType === "email" && (!email || !code)) return fail(c, "请输入邮箱和验证码", 400);
  if (identity.identityType === "email" && !(await checkPublicIdentityRateLimit(db, "my-result", draw.id, email, 10, 60000))) {
    return fail(c, "查询过于频繁，请稍后再试", 429);
  }

  // 验证码校验：仅邮箱身份需要（查询类操作不消耗验证码，仅校验身份防枚举）
  if (identity.identityType === "email") {
    const validCode = await verifyEmailAccessCode(db, email, draw.id, code);
    if (!validCode) {
      return fail(c, "验证码无效或已过期", 400);
    }
  }

  const identityValue = identity.identityValue;

  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityValue, identityValue),
    ))
    .limit(1);

  // 1. 是否中奖 + 中奖卡密
  let won = false;
  let prizeCode: string | null = null;
  if (entry) {
    const [winner] = await db
      .select({ prizeCodeId: lotteryWinners.prizeCodeId, identityValue: lotteryWinners.identityValue })
      .from(lotteryWinners)
      .where(and(
        eq(lotteryWinners.tenantId, draw.tenantId),
        eq(lotteryWinners.drawId, draw.id),
        eq(lotteryWinners.entryId, entry.id),
      ))
      .limit(1);
    if (winner) {
      won = true;
      if (winner.prizeCodeId) {
        const [pc] = await db
          .select({ code: prizeCodes.code, secret: prizeCodes.secret })
          .from(prizeCodes)
          .where(eq(prizeCodes.id, winner.prizeCodeId))
          .limit(1);
        if (pc) prizeCode = pc.secret ? `${pc.code}:${pc.secret}` : pc.code;
      }
    }
  }

  // 2. 安慰奖（未中奖自动发券）
  // 查询键与 entry 身份一致：registered 用户 coupon.recipient_email 存的是 userId
  let consolationCoupon: string | null = null;
  const [coupon] = await db
    .select({ code: couponCodes.code, status: couponCodes.status })
    .from(couponCodes)
    .where(and(
      eq(couponCodes.tenantId, draw.tenantId),
      eq(couponCodes.recipientEmail, identityValue),
    ))
    .limit(1);
  if (coupon && coupon.status === "issued") {
    consolationCoupon = coupon.code;
  }

  return ok(c, { joined: !!entry, won, prizeCode, consolationCoupon });
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
  // 限流：同一 IP 每分钟最多 N 次参与（由 platform system_config.rate_limit_join_per_minute 控制）
  const ip = getClientIp(c);
  const db = getDb(c);
  const [joinRlCfg2] = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, "rate_limit_join_per_minute")).limit(1);
  const joinLimit2 = Math.min(Math.max(parseInt(joinRlCfg2?.value || "", 10) || 10, 1), 100);
  if (!(await checkPublicRateLimit(db, `join:${ip}`, joinLimit2, 60000))) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const body = await c.req.json<{ email: string; refCode?: string; submission?: Record<string, unknown> }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  try {
    const [draw] = await db
      .select({ id: lotteryDraws.id, activityKind: lotteryDraws.activityKind, activityConfig: lotteryDraws.activityConfig })
      .from(lotteryDraws)
      .where(eq(lotteryDraws.publicSlug, c.req.param("slug")))
      .limit(1);
    if (!draw) return fail(c, "活动不存在", 404);
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
      return fail(c, result.message || "参与失败", 400);
    }
    return ok(c, {
      joined: true,
      entryId: "entryId" in result ? result.entryId : undefined,
      activityKind: "activityKind" in result ? result.activityKind : undefined,
      outcome: "outcome" in result ? result.outcome : undefined,
      submissionId: "submissionId" in result ? result.submissionId : undefined,
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

  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(
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
    const [winner] = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, draw.id), eq(lotteryWinners.entryId, entry.id)))
      .limit(1);
    result.won = !!winner;
    if (winner) result.drawnAt = winner.drawnAt;
  }

  return ok(c, result);
});
/** 安全解析 JSON 字符串 */
function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

/** 接龙模式：公开参与列表（按参与时间排序） */
publicLotteryRoute.get("/draws/:slug/signup-list", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");

  const [draw] = await db
    .select({ id: lotteryDraws.id, activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "signup_chain") return fail(c, "该活动不是接龙模式", 400);

  const entries = await db
    .select({
      identityValue: lotteryEntries.identityValue,
      joinedAt: lotteryEntries.joinedAt,
    })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, draw.id))
    .orderBy(lotteryEntries.joinedAt)
    .limit(200);  // 公开 API 上限，防止数据炸弹

  // 脱敏展示邮箱
  const masked = entries.map((e, i) => ({
    order: i + 1,
    identity: maskIdentity(e.identityValue),
    joinedAt: e.joinedAt,
  }));

  return ok(c, { entries: masked, total: entries.length });
});

// ═════════════════════════════════════════════════════════
// 裂变排行榜（公开，按邀请人数降序，脱敏展示）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.get("/draws/:slug/viral-leaderboard", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const entryId = c.req.query("entryId") || "";

  const [draw] = await db
    .select({ id: lotteryDraws.id, promotionConfig: lotteryDraws.promotionConfig })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 解析裂变配置，判断是否开启排行榜
  const pc = tryParseJson(draw.promotionConfig) as any;
  const viral = pc?.viral;
  if (!viral?.enabled || !viral?.leaderboardEnabled) {
    return fail(c, "该活动未开启裂变排行榜", 400);
  }

  // 查询所有分享记录，按分享者聚合邀请人数
  const shareRows = await db
    .select({
      sharerEntryId: shareRecords.sharerEntryId,
      joinedCount: shareRecords.joinedCount,
    })
    .from(shareRecords)
    .where(eq(shareRecords.drawId, draw.id));

  // 按 sharerEntryId 聚合 SUM(joinedCount)
  const aggMap = new Map<string, number>();
  for (const row of shareRows) {
    aggMap.set(row.sharerEntryId, (aggMap.get(row.sharerEntryId) || 0) + row.joinedCount);
  }
  if (aggMap.size === 0) {
    return ok(c, { entries: [], myRank: null });
  }

  // 查询参与者身份信息（脱敏展示）
  const entryIds = Array.from(aggMap.keys());
  const entryRows = await db
    .select({ id: lotteryEntries.id, identityValue: lotteryEntries.identityValue, displayName: lotteryEntries.displayName })
    .from(lotteryEntries)
    .where(inArray(lotteryEntries.id, entryIds));

  const identityMap = new Map<string, string>();
  for (const e of entryRows) {
    identityMap.set(e.id, e.displayName || maskIdentity(e.identityValue));
  }

  // 构建排行榜（按邀请人数降序，Top 20）
  const sorted = Array.from(aggMap.entries())
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const leaderboard = sorted.map(([sharerEntryId, count], index) => ({
    rank: index + 1,
    displayName: identityMap.get(sharerEntryId) || "***",
    invitedCount: count,
  }));

  // 查询"我"的排名
  let myRank: { rank: number; invitedCount: number } | null = null;
  if (entryId) {
    const myCount = aggMap.get(entryId) || 0;
    if (myCount > 0) {
      const rankIndex = sorted.findIndex(([id]) => id === entryId);
      if (rankIndex >= 0) {
        myRank = { rank: rankIndex + 1, invitedCount: myCount };
      } else {
        myRank = { rank: sorted.length + 1, invitedCount: myCount };
      }
    }
  }

  return ok(c, { entries: leaderboard, myRank });
});

// ═════════════════════════════════════════════════════════
// 我的裂变数据（公开，需要 entryId 查询自己的分享统计）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.get("/draws/:slug/my-viral-stats", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const entryId = c.req.query("entryId") || "";
  if (!entryId) return fail(c, "缺少参与记录 ID", 400);

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, promotionConfig: lotteryDraws.promotionConfig })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const pc = tryParseJson(draw.promotionConfig) as any;
  const viral = pc?.viral;
  if (!viral?.enabled) {
    return fail(c, "该活动未开启裂变", 400);
  }

  // 查询该参与者的分享记录
  const myShares = await db
    .select()
    .from(shareRecords)
    .where(and(eq(shareRecords.drawId, draw.id), eq(shareRecords.sharerEntryId, entryId)));

  // 聚合统计
  const totalClicked = myShares.reduce((s, r) => s + r.clickedCount, 0);
  const totalJoined = myShares.reduce((s, r) => s + r.joinedCount, 0);
  const extraEntriesPerInvite = viral?.extraEntriesPerInvite ?? 1;
  const maxExtraEntries = viral?.maxExtraEntries ?? 10;
  const extraEntriesEarned = Math.min(totalJoined, maxExtraEntries);

  // 取最新一条分享码作为默认链接
  const latestShare = myShares.length > 0 ? myShares[myShares.length - 1] : null;
  const shareCode = latestShare?.shareCode || "";
  const shareUrl = shareCode ? `/${slug}?ref=${shareCode}` : "";

  return ok(c, {
    shareCode,
    shareUrl,
    clickedCount: totalClicked,
    invitedCount: totalJoined,
    extraEntriesEarned,
    extraEntriesPerInvite,
    maxExtraEntries,
  });
});

/** 生成分享码（参与者分享活动链接） */
publicLotteryRoute.post("/draws/:slug/share", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ entryId: string }>();
  if (!body.entryId) return fail(c, "缺少参与记录 ID", 400);

  const [draw] = await db.select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId }).from(lotteryDraws).where(eq(lotteryDraws.publicSlug, slug)).limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const shareCode = crypto.randomUUID().slice(0, 12);
  await db.insert(shareRecords).values({
    id: crypto.randomUUID(),
    tenantId: draw.tenantId,
    drawId: draw.id,
    sharerEntryId: body.entryId,
    shareCode,
  });

  return ok(c, { shareCode, shareUrl: `/${slug}?ref=${shareCode}` });
});

/** 通过分享链接打开活动（记录点击） */
publicLotteryRoute.get("/draws/:slug/ref/:shareCode", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const shareCode = c.req.param("shareCode");

  const [share] = await db.select().from(shareRecords).where(eq(shareRecords.shareCode, shareCode)).limit(1);
  if (share) {
    await db.update(shareRecords).set({ clickedCount: share.clickedCount + 1 }).where(eq(shareRecords.id, share.id));
    await recordActivityEvent(db, {
      tenantId: share.tenantId,
      drawId: share.drawId,
      eventType: "share_click",
      refCode: shareCode,
      ipHash: await hashEventValue(getClientIp(c) || ""),
      userAgent: c.req.header("User-Agent") || "",
    });
  }

  return c.redirect(`/${slug}`);
});

async function hashEventValue(value: string): Promise<string> {
  if (!value) return "";
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
