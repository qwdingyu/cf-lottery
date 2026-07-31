/**
 * 公开参与路由
 *
 * 不需要登录，通过 public_slug 访问活动。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail } from "../lib/http";
import { lotteryDraws, lotteryEntries, lotteryWinners } from "../db/schema";
import { eq, and, count } from "drizzle-orm";

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
  const body = await c.req.json<{ email: string }>();
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, c.req.param("slug")))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "open") return fail(c, "活动已结束", 400);
  if (draw.participationMode !== "open") return fail(c, "此活动需要特定参与方式", 400);

  // 检查是否已参与
  const [existing] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, draw.id), eq(lotteryEntries.identityValue, email)))
    .limit(1);
  if (existing) return fail(c, "您已参与此活动", 409);

  // 插入候选池
  await db.insert(lotteryEntries).values({
    id: crypto.randomUUID(),
    tenantId: draw.tenantId,
    drawId: draw.id,
    identityType: "email",
    identityValue: email,
  });

  return ok(c, { joined: true });
});

/** 脱敏展示 */
function maskIdentity(value: string): string {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return name.slice(0, 2) + "***@" + domain;
  }
  return value.slice(0, 2) + "***";
}