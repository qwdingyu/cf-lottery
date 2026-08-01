/**
 * 公开参与路由
 *
 * 不需要登录，通过 public_slug 访问活动。
 * 支持四种参与模式：open（公开）、password（密码）、roster（名单）、invite_code（邀请码）
 * 所有参与模式均需邮箱验证码验证。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail } from "../lib/http";
import { lotteryDraws, lotteryEntries, lotteryWinners, emailAccessCodes, lotteryRosterMembers, shareRecords, lotteryPrizeTiers, prizes } from "../db/schema";
import { eq, and, count, sql, asc } from "drizzle-orm";
import { getActivityOutcome, joinDraw, recordActivityEvent, type ActivityEventType } from "../services/lottery-service";
import { sendAccessCode } from "../services/email-service";

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
  if (draw.status !== "open" && draw.status !== "drawn") return fail(c, "活动未开放", 404);

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
    participantCount: draw.showParticipantCount ? Number(total) : undefined,
    winnerCount: draw.showWinnerCount ? draw.winnerCount : undefined,
    maxParticipants: draw.maxParticipants,
    // 导流：关联商品链接（仅在活动中开放时返回）
    productLink: draw.productLink && draw.productLink !== "{}" ? tryParseJson(draw.productLink) : undefined,
    promotionConfig: draw.promotionConfig && draw.promotionConfig !== "{}" ? tryParseJson(draw.promotionConfig) : undefined,
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
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!checkRateLimit(`events:${ip}`, 30, 60000)) {
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
  if (!checkRateLimit(`events:${ip}:${body.eventType}`, typeLimit, 60000)) {
    return fail(c, "该事件类型上报过于频繁", 429);
  }

  const [draw] = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  const ipHash = await hashEventValue(c.req.header("CF-Connecting-IP") || "");
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
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/access-code", async (c) => {
  // 限流：同一 IP 每分钟最多 3 次请求验证码
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!checkRateLimit(`access-code:${ip}`, 3, 60000)) {
    return fail(c, "请求过于频繁，请稍后再试", 429);
  }
  const db = getDb(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  // 查询活动
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "open") return fail(c, "活动已结束", 400);

  // 检查是否已参与
  const [existing] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, draw.id), eq(lotteryEntries.identityValue, email)))
    .limit(1);
  if (existing) return fail(c, "您已参与此活动", 409);

  // 校验参与模式
  if (draw.participationMode === "roster") {
    const [inRoster] = await db
      .select({ id: lotteryRosterMembers.id })
      .from(lotteryRosterMembers)
      .where(and(eq(lotteryRosterMembers.drawId, draw.id), eq(lotteryRosterMembers.identityValue, email)))
      .limit(1);
    if (!inRoster) return fail(c, "您不在本次活动名单中", 403);
  }

  // 生成验证码
  const code = generateCode();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 分钟有效期

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
  const emailEnv = { resendApiKey: c.env.RESEND_API_KEY || "", emailFrom: c.env.EMAIL_FROM || "" };
  const sendResult = await sendAccessCode(emailEnv, email, draw.title, code);

  return ok(c, {
    sent: sendResult.ok,
    message: sendResult.ok ? "验证码已发送" : "发送失败，请稍后重试",
    expiresInSeconds: 600,
  });
});

// ═════════════════════════════════════════════════════════
// 验证邮箱并参与
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/verify-join", async (c) => {
  // 限流：同一 IP 每分钟最多 10 次参与
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!checkRateLimit(`join:${ip}`, 10, 60000)) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const db = getDb(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string; code: string; accessPassword?: string; inviteCode?: string; refCode?: string; submission?: Record<string, unknown> }>();
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }
  if (!code || code.length !== 6) {
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

  // 验证验证码
  const codeHash = await hashCode(code);
  const now = new Date().toISOString();
  const [validCode] = await db
    .select()
    .from(emailAccessCodes)
    .where(and(
      eq(emailAccessCodes.email, email),
      eq(emailAccessCodes.drawId, draw.id),
      eq(emailAccessCodes.codeHash, codeHash),
      eq(emailAccessCodes.used, 0),
      sql`${emailAccessCodes.expiresAt} > ${now}`,
    ))
    .limit(1);

  if (!validCode) {
    return fail(c, "验证码无效或已过期", 400);
  }

  // 标记验证码为已使用（先占位，参与失败时恢复）
  await db.update(emailAccessCodes)
    .set({ used: 1 })
    .where(eq(emailAccessCodes.id, validCode.id));

  try {
    const result = await joinDraw(db, slug, email, "email", {
      accessPassword: body.accessPassword,
      inviteCode: body.inviteCode,
      ipHash: ip,
      refCode: body.refCode,
      userAgent: c.req.header("User-Agent") || "",
      // 传递动态表单提交 payload（问卷/投票/资料领取等）
      submissionPayload: body.submission,
    });
    if (!result.joined) {
      // 参与失败（容量满/名单不匹配/邀请码无效等）：恢复验证码，允许用户修改条件后重试
      await db.update(emailAccessCodes).set({ used: 0 }).where(eq(emailAccessCodes.id, validCode.id));
      return fail(c, result.message || "参与失败", 400);
    }
    return ok(c, {
      joined: true,
      activityKind: draw.activityKind || "lottery",
      outcome: "outcome" in result ? result.outcome : undefined,
      submissionId: "submissionId" in result ? result.submissionId : undefined,
    });
  } catch (err: any) {
    // 异常（UNIQUE 约束冲突等）：恢复验证码，允许用户重试
    await db.update(emailAccessCodes).set({ used: 0 }).where(eq(emailAccessCodes.id, validCode.id));
    if (err.message?.includes("UNIQUE constraint")) {
      return fail(c, "您已参与此活动", 409);
    }
    return fail(c, "参与失败，请稍后重试", 400);
  }
});

// ═════════════════════════════════════════════════════════
// 快捷参与（公开模式，无需验证码）
// ═════════════════════════════════════════════════════════

publicLotteryRoute.post("/draws/:slug/join", async (c) => {
  // 限流：同一 IP 每分钟最多 10 次参与
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!checkRateLimit(`join:${ip}`, 10, 60000)) {
    return fail(c, "参与过于频繁，请稍后再试", 429);
  }
  const db = getDb(c);
  const body = await c.req.json<{ email: string; refCode?: string; submission?: Record<string, unknown> }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  try {
    const result = await joinDraw(db, c.req.param("slug"), email, "email", {
      ipHash: ip,
      refCode: body.refCode,
      userAgent: c.req.header("User-Agent") || "",
      submissionPayload: body.submission,
    });
    if (!result.joined) {
      return fail(c, result.message || "参与失败", 400);
    }
    return ok(c, {
      joined: true,
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
  const slug = c.req.param("slug");
  const body = await c.req.json<{ email: string }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email) return fail(c, "请提供邮箱地址", 400);

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);

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
    .orderBy(lotteryEntries.joinedAt);

  // 脱敏展示邮箱
  const masked = entries.map((e, i) => ({
    order: i + 1,
    identity: maskIdentity(e.identityValue),
    joinedAt: e.joinedAt,
  }));

  return ok(c, { entries: masked, total: entries.length });
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
      ipHash: await hashEventValue(c.req.header("CF-Connecting-IP") || ""),
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
