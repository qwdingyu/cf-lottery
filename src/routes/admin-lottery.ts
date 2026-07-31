/**
 * 管理端抽奖路由
 *
 * 所有路由需要登录认证，数据按 tenant_id 隔离。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { requireAuth } from "../middleware/auth";
import { getDb, ok, fail } from "../lib/http";
import { lotteryDraws, lotteryEntries, lotteryWinners, prizes } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";

export const adminLotteryRoute = new Hono<AppEnv>();

// 所有管理端路由需要登录
adminLotteryRoute.use("*", requireAuth);

/** 活动列表 */
adminLotteryRoute.get("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.tenantId, tenantId))
    .orderBy(desc(lotteryDraws.createdAt))
    .limit(50);
  return ok(c, { draws: rows });
});

/** 活动详情 */
adminLotteryRoute.get("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, c.req.param("id")), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  return ok(c, { draw });
});

/** 创建活动 */
adminLotteryRoute.post("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json();

  const id = crypto.randomUUID();
  const publicSlug = crypto.randomUUID().slice(0, 8);

  await db.insert(lotteryDraws).values({
    id,
    tenantId,
    publicSlug,
    title: String(body.title || ""),
    description: String(body.description || ""),
    participationMode: String(body.participationMode || "open"),
    drawTrigger: String(body.drawTrigger || "manual"),
    startAt: String(body.startAt || ""),
    endAt: String(body.endAt || ""),
    drawAt: body.drawAt || null,
    winnerCount: Number(body.winnerCount || 1),
    maxParticipants: body.maxParticipants || null,
    accessPassword: String(body.accessPassword || ""),
  });

  return ok(c, { id, publicSlug });
});

/** 发布活动（draft → open） */
adminLotteryRoute.post("/draws/:id/publish", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const result = await db
    .update(lotteryDraws)
    .set({ status: "open" })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "draft")));

  if (result.rowsAffected === 0) return fail(c, "活动不存在或已发布", 400);
  return ok(c, { status: "open" });
});

/** 中奖名单 */
adminLotteryRoute.get("/draws/:id/winners", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, c.req.param("id")), eq(lotteryWinners.tenantId, tenantId)));
  return ok(c, { winners: rows });
});

/** 候选池 */
adminLotteryRoute.get("/draws/:id/entries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, c.req.param("id")), eq(lotteryEntries.tenantId, tenantId)))
    .limit(100);
  return ok(c, { entries: rows });
});

/** 奖品列表 */
adminLotteryRoute.get("/prizes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(prizes)
    .where(eq(prizes.tenantId, tenantId))
    .orderBy(desc(prizes.createdAt));
  return ok(c, { prizes: rows });
});

/** 创建奖品 */
adminLotteryRoute.post("/prizes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json();
  const id = crypto.randomUUID();

  await db.insert(prizes).values({
    id,
    tenantId,
    name: String(body.name || ""),
    description: String(body.description || ""),
    prizeType: String(body.prizeType || "code"),
  });

  return ok(c, { id });
});