/**
 * 公开参与路由
 *
 * 不需要登录，通过 public_slug 访问活动。
 * 使用 lottery-service 处理核心业务逻辑。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail } from "../lib/http";
import { lotteryDraws, lotteryEntries, lotteryWinners } from "../db/schema";
import { eq, and, count } from "drizzle-orm";
import { joinDraw } from "../services/lottery-service";

export const publicLotteryRoute = new Hono<AppEnv>();

/** 公开活动详情 */
publicLotteryRoute.get("/draws/:slug", async (c) => {
  const db = getDb(c);
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, c.req.param("slug")))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "open" && draw.status !== "drawn") return fail(c, "活动未开放", 404);

  // 参与人数
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
  };

  // 开奖后展示中奖名单
  if (draw.status === "drawn" && draw.showWinnerList) {
    const winners = await db
      .select({ identityValue: lotteryWinners.identityValue })
      .from(lotteryWinners)
      .where(eq(lotteryWinners.drawId, draw.id));
    // 脱敏：只展示部分邮箱
    result.winners = winners.map(w => ({
      identity: maskIdentity(w.identityValue),
    }));
  }

  return ok(c, result);
});

/** 参与抽奖 */
publicLotteryRoute.post("/draws/:slug/join", async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ email: string; accessPassword?: string; inviteCode?: string }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  try {
    const result = await joinDraw(db, c.req.param("slug"), email, "email", {
      accessPassword: body.accessPassword,
      inviteCode: body.inviteCode,
    });
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

/** 查询参与结果（是否需要登录/验证） */
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

  if (!entry) return fail(c, "未找到您的参与记录", 404);

  const result: any = {
    joined: true,
    joinedAt: entry.joinedAt,
    status: draw.status,
  };

  if (draw.status === "drawn") {
    const [winner] = await db
      .select()
      .from(lotteryWinners)
      .where(and(eq(lotteryWinners.drawId, draw.id), eq(lotteryWinners.entryId, entry.id)))
      .limit(1);

    if (winner) {
      result.won = true;
      result.drawnAt = winner.drawnAt;
    } else {
      result.won = false;
    }
  }

  return ok(c, result);
});

/** 脱敏展示 */
function maskIdentity(value: string): string {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return name.slice(0, 2) + "***@" + domain;
  }
  return value.slice(0, 2) + "***";
}