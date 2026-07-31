/**
 * 管理端抽奖路由
 *
 * 所有路由需要登录认证，数据按 tenant_id 隔离。
 * 使用 lottery-service 处理核心业务逻辑。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { requireAuth } from "../middleware/auth";
import { getDb, ok, fail } from "../lib/http";
import { lotteryDraws, prizes, users, tenants } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  createDraw,
  publishDraw,
  pauseDraw,
  resumeDraw,
  cancelDraw,
  performDraw,
  getDraw,
  getDrawWinners,
  getEntries,
  getDrawEntriesCount,
  createPrize,
  importPrizeCodes,
} from "../services/lottery-service";

export const adminLotteryRoute = new Hono<AppEnv>();

// 所有管理端路由需要登录
adminLotteryRoute.use("*", requireAuth);

// ═════════════════════════════════════════════════════════
// 当前用户
// ═════════════════════════════════════════════════════════

/** 获取当前用户信息（含租户信息） */
adminLotteryRoute.get("/me", async (c) => {
  const db = getDb(c);
  const userId = c.get("userId") as string;
  const tenantId = c.get("tenantId") as string;

  const [user] = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return fail(c, "用户不存在", 404);

  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  return ok(c, {
    user,
    tenant: tenant || { id: tenantId, name: "", plan: "free" },
  });
});

// ═════════════════════════════════════════════════════════
// 奖品管理
// ═════════════════════════════════════════════════════════

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
  const body = await c.req.json<{ name: string; description?: string; prizeType?: string }>();
  const { id } = await createPrize(db, tenantId, body);
  return ok(c, { id });
});

/** 编辑奖品 */
adminLotteryRoute.patch("/prizes/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string; prizeType?: string }>();

  const [existing] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!existing) return fail(c, "奖品不存在", 404);

  await db
    .update(prizes)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.prizeType !== undefined ? { prizeType: body.prizeType } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)));

  return ok(c, { updated: true });
});

/** 导入奖品码 */
adminLotteryRoute.post("/prizes/:id/codes/import", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const prizeId = c.req.param("id");
  const body = await c.req.json<{ codes: Array<{ code: string; secret?: string }> }>();

  if (!body.codes || body.codes.length === 0) {
    return fail(c, "请提供至少一个码", 400);
  }

  await importPrizeCodes(db, tenantId, prizeId, body.codes);
  return ok(c, { imported: body.codes.length });
});

// ═════════════════════════════════════════════════════════
// 活动管理
// ═════════════════════════════════════════════════════════

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
  const draw = await getDraw(db, c.req.param("id"), tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  return ok(c, { draw });
});

/** 创建活动 */
adminLotteryRoute.post("/draws", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json();

  try {
    const { id, publicSlug } = await createDraw(db, tenantId, {
      title: String(body.title || ""),
      description: String(body.description || ""),
      participationMode: String(body.participationMode || "open"),
      drawTrigger: String(body.drawTrigger || "manual"),
      startAt: String(body.startAt || ""),
      endAt: String(body.endAt || ""),
      drawAt: body.drawAt || undefined,
      accessPassword: String(body.accessPassword || ""),
      maxParticipants: body.maxParticipants ? Number(body.maxParticipants) : undefined,
      winnerCount: body.winnerCount ? Number(body.winnerCount) : 1,
    });
    return ok(c, { id, publicSlug });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "创建活动失败", 400);
  }
});

/** 编辑活动 */
adminLotteryRoute.patch("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json();

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "只有草稿状态的活动可以编辑", 400);

  await db
    .update(lotteryDraws)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.participationMode !== undefined ? { participationMode: body.participationMode } : {}),
      ...(body.drawTrigger !== undefined ? { drawTrigger: body.drawTrigger } : {}),
      ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
      ...(body.drawAt !== undefined ? { drawAt: body.drawAt } : {}),
      ...(body.winnerCount !== undefined ? { winnerCount: Number(body.winnerCount) } : {}),
      ...(body.maxParticipants !== undefined ? { maxParticipants: body.maxParticipants ? Number(body.maxParticipants) : null } : {}),
      ...(body.accessPassword !== undefined ? { accessPassword: body.accessPassword } : {}),
      ...(body.showParticipantCount !== undefined ? { showParticipantCount: body.showParticipantCount ? 1 : 0 } : {}),
      ...(body.showWinnerCount !== undefined ? { showWinnerCount: body.showWinnerCount ? 1 : 0 } : {}),
      ...(body.showWinnerList !== undefined ? { showWinnerList: body.showWinnerList ? 1 : 0 } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

  return ok(c, { updated: true });
});

/** 发布活动（draft → open） */
adminLotteryRoute.post("/draws/:id/publish", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  try {
    const result = await publishDraw(db, tenantId, drawId);
    if (!result) return fail(c, "活动不存在或已发布", 400);
    return ok(c, { status: "open" });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "发布失败", 400);
  }
});

/** 暂停活动（open → paused） */
adminLotteryRoute.post("/draws/:id/pause", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const result = await pauseDraw(db, tenantId, drawId);
  if (!result) return fail(c, "活动不存在或未开启", 400);
  return ok(c, { status: "paused" });
});

/** 恢复活动（paused → open） */
adminLotteryRoute.post("/draws/:id/resume", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const result = await resumeDraw(db, tenantId, drawId);
  if (!result) return fail(c, "活动不存在或未暂停", 400);
  return ok(c, { status: "open" });
});

/** 取消活动（draft/open/paused → cancelled） */
adminLotteryRoute.post("/draws/:id/cancel", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  try {
    const result = await cancelDraw(db, tenantId, drawId);
    if (!result) return fail(c, "活动不存在或无法取消", 400);
    return ok(c, { status: "cancelled" });
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "取消失败", 400);
  }
});

/** 手动开奖 */
adminLotteryRoute.post("/draws/:id/draw", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const userId = c.get("userId") as string;
  const drawId = c.req.param("id");

  try {
    const result = await performDraw(db, tenantId, drawId, userId);
    return ok(c, result);
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : "开奖失败", 400);
  }
});

/** 中奖名单 */
adminLotteryRoute.get("/draws/:id/winners", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getDrawWinners(db, c.req.param("id"), tenantId);
  return ok(c, { winners: rows });
});

/** 候选池 */
adminLotteryRoute.get("/draws/:id/entries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getEntries(db, tenantId, c.req.param("id"));
  return ok(c, { entries: rows });
});

/** 候选池统计 */
adminLotteryRoute.get("/draws/:id/stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const entryCount = await getDrawEntriesCount(db, drawId);
  return ok(c, { entryCount });
});

/** 导出 CSV */
adminLotteryRoute.get("/draws/:id/export", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const winners = await getDrawWinners(db, drawId, tenantId);
  const entries = await getEntries(db, tenantId, drawId, 10000);

  // 构建 CSV 内容
  const lines: string[] = [
    "活动名称,状态,参与人数,中奖人数",
    `${draw.title},${draw.status},${entries.length},${winners.length}`,
    "",
    "参与者邮箱,参与时间",
    ...entries.map((e) => `${e.identityValue},${e.joinedAt}`),
    "",
    "中奖者邮箱,中奖时间",
    ...winners.map((w) => `${w.identityValue},${w.drawnAt}`),
  ];

  return c.text(lines.join("\n"), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="draw-${drawId}.csv"`,
  });
});

/** 删除活动（仅草稿状态可删除） */
adminLotteryRoute.delete("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "仅草稿状态的活动可删除", 400);

  await db
    .delete(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

  return ok(c, { deleted: true });
});