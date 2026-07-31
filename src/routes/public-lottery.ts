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
import { lotteryDraws, lotteryEntries, lotteryWinners, emailAccessCodes, lotteryRosterMembers, lotteryInviteCodes } from "../db/schema";
import { eq, and, count, sql } from "drizzle-orm";
import { joinDraw } from "../services/lottery-service";
import { sendAccessCode } from "../services/email-service";
import { hashAccessPassword } from "../services/lottery-service";

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
    title: draw.title,
    description: draw.description,
    status: draw.status,
    participationMode: draw.participationMode,
    startAt: draw.startAt,
    endAt: draw.endAt,
    drawAt: draw.drawAt,
    showParticipantCount: draw.showParticipantCount,
    showWinnerCount: draw.showWinnerCount,
    participantCount: draw.showParticipantCount ? Number(total) : undefined,
    winnerCount: draw.showWinnerCount ? draw.winnerCount : undefined,
  };

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
  const body = await c.req.json<{ email: string; code: string; accessPassword?: string; inviteCode?: string }>();
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

  // 标记验证码为已使用
  await db.update(emailAccessCodes)
    .set({ used: 1 })
    .where(eq(emailAccessCodes.id, validCode.id));

  // 校验参与模式：password 和 invite_code
  if (draw.participationMode === "password") {
    const inputHash = await hashAccessPassword(body.accessPassword || "");
    if (inputHash !== draw.accessPassword) {
      return fail(c, "访问密码错误", 403);
    }
  }
  if (draw.participationMode === "invite_code") {
    if (!body.inviteCode) {
      return fail(c, "请输入邀请码", 400);
    }
    // CAS 更新邀请码使用次数
    const updated = await db
      .update(lotteryInviteCodes)
      .set({ usedCount: sql`used_count + 1` })
      .where(and(
        eq(lotteryInviteCodes.drawId, draw.id),
        eq(lotteryInviteCodes.code, body.inviteCode),
        eq(lotteryInviteCodes.active, 1),
        sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
      ));
    if (updated.rowsAffected === 0) {
      return fail(c, "邀请码无效或已用完", 403);
    }
  }

  // 加入候选池
  try {
    await db.insert(lotteryEntries).values({
      id: crypto.randomUUID(),
      tenantId: draw.tenantId,
      drawId: draw.id,
      identityType: "email",
      identityValue: email,
      joinedAt: new Date().toISOString(),
    });
    return ok(c, { joined: true });
  } catch (err: any) {
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
  const body = await c.req.json<{ email: string }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  try {
    const result = await joinDraw(db, c.req.param("slug"), email, "email");
    if (!result.joined) {
      return fail(c, result.message || "参与失败", 400);
    }
    return ok(c, { joined: true });
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

publicLotteryRoute.get("/draws/:slug/result", async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");
  const email = c.req.query("email") || "";

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

  if (draw.status === "drawn") {
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