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
import { lotteryDraws, prizes, prizeCodes, lotteryPrizeTiers, lotteryRosterMembers, lotteryInviteCodes, lotteryWinners, auditLogs, users, tenants } from "../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
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
// 运营台概览
// ═════════════════════════════════════════════════════════

/** 运营台概览：活动统计 + 待处理事项 */
adminLotteryRoute.get("/dashboard", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const now = new Date().toISOString();

  // 活动状态统计
  const [openRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
  const [draftRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "draft")));
  const [drawnRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "drawn")));

  // 到期待开奖的定时活动
  const [dueRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
      sql`${lotteryDraws.drawAt} <= ${now}`,
    ));

  // 通知失败的中奖者
  const [failedNotifyRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(lotteryWinners)
    .where(and(
      eq(lotteryWinners.tenantId, tenantId),
      eq(lotteryWinners.notificationStatus, "failed"),
    ));

  return ok(c, {
    openCount: Number(openRow?.count || 0),
    draftCount: Number(draftRow?.count || 0),
    drawnCount: Number(drawnRow?.count || 0),
    dueCount: Number(dueRow?.count || 0),
    failedNotifyCount: Number(failedNotifyRow?.count || 0),
  });
});

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
    const result = await performDraw(db, tenantId, drawId, userId, {
      resendApiKey: c.env.RESEND_API_KEY || "",
      emailFrom: c.env.EMAIL_FROM || "",
    });
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

// ═════════════════════════════════════════════════════════
// P0 运营工具：补发码 + 重发通知 + 发布前校验
// ═════════════════════════════════════════════════════════

/** 补发奖品码（中奖者无码时运营手动补发） */
adminLotteryRoute.post("/draws/:id/winners/:winnerId/retry-code", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [winner] = await db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.id, c.req.param("winnerId")), eq(lotteryWinners.tenantId, tenantId)))
    .limit(1);

  if (!winner) return fail(c, "中奖记录不存在", 404);
  if (winner.prizeCodeId) return fail(c, "已有奖品码，无需补发", 400);

  // 获取奖项配置，找到对应的奖品 ID
  const [tier] = await db
    .select({ prizeId: lotteryPrizeTiers.prizeId })
    .from(lotteryPrizeTiers)
    .where(eq(lotteryPrizeTiers.id, winner.tierId))
    .limit(1);

  if (!tier?.prizeId) return fail(c, "未配置奖品，无法补发", 400);

  // 原子锁码：从奖品码池中取一条 available 的记录
  const lockResult = await db
    .update(prizeCodes)
    .set({ status: "issued", winnerId: winner.entryId, issuedAt: new Date().toISOString() })
    .where(and(
      eq(prizeCodes.prizeId, tier.prizeId),
      eq(prizeCodes.status, "available"),
      eq(prizeCodes.tenantId, tenantId),
    ));

  if ((lockResult.rowsAffected ?? 0) === 0) {
    return fail(c, "奖品码库存不足", 400);
  }

  // 查询刚锁定的码
  const [lockedCode] = await db
    .select({ id: prizeCodes.id })
    .from(prizeCodes)
    .where(and(
      eq(prizeCodes.prizeId, tier.prizeId),
      eq(prizeCodes.winnerId, winner.entryId),
      eq(prizeCodes.tenantId, tenantId),
    ))
    .limit(1);

  // 更新中奖记录的 prize_code_id
  await db
    .update(lotteryWinners)
    .set({ prizeCodeId: lockedCode?.id || "" })
    .where(eq(lotteryWinners.id, winner.id));

  return ok(c, { prizeCodeId: lockedCode?.id || "" });
});

/** 重发中奖通知 */
adminLotteryRoute.post("/draws/:id/winners/:winnerId/resend", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [winner] = await db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.id, c.req.param("winnerId")), eq(lotteryWinners.tenantId, tenantId)))
    .limit(1);

  if (!winner) return fail(c, "中奖记录不存在", 404);

  // 重置通知状态
  await db
    .update(lotteryWinners)
    .set({ notificationStatus: "pending", notificationError: "" })
    .where(eq(lotteryWinners.id, winner.id));

  return ok(c, { retry: true });
});

/** 发布前校验 */
adminLotteryRoute.get("/draws/:id/publish-check", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const warnings: string[] = [];
  const errors: string[] = [];

  // 基础校验
  if (!draw.title) errors.push("活动标题不能为空");
  if (!draw.startAt || !draw.endAt) errors.push("请设置活动时间");
  if (draw.drawTrigger === "scheduled" && !draw.drawAt) errors.push("定时开奖必须设置开奖时间");

  // 参与模式校验
  if (draw.participationMode === "roster") {
    const [rosterRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(lotteryRosterMembers)
      .where(eq(lotteryRosterMembers.drawId, drawId));
    if (Number(rosterRow?.count || 0) === 0) errors.push("名单模式需要导入参与者名单");
  }

  if (draw.participationMode === "invite_code") {
    const [inviteRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(lotteryInviteCodes)
      .where(eq(lotteryInviteCodes.drawId, drawId));
    if (Number(inviteRow?.count || 0) === 0) errors.push("邀请码模式需要生成邀请码");
  }

  // 奖项校验
  const tiers = await db
    .select()
    .from(lotteryPrizeTiers)
    .where(eq(lotteryPrizeTiers.drawId, drawId));

  if (tiers.length > 0) {
    for (const tier of tiers) {
      if (tier.prizeId) {
        const [codeRow] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(prizeCodes)
          .where(and(eq(prizeCodes.prizeId, tier.prizeId), eq(prizeCodes.status, "available")));
        if (Number(codeRow?.count || 0) < tier.winnerCount) {
          warnings.push(`奖项"${tier.tierName}"可用码 ${codeRow?.count || 0} 个，中奖名额 ${tier.winnerCount} 个，码可能不足`);
        }
      }
    }
  }

  return ok(c, {
    canPublish: errors.length === 0,
    errors,
    warnings,
  });
});

/** 导入名单成员（roster 模式） */
adminLotteryRoute.post("/draws/:id/roster", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ members: Array<{ email: string; name?: string }> }>();

  if (!body.members || body.members.length === 0) {
    return fail(c, "请提供至少一个成员", 400);
  }

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "仅草稿状态的活动可导入名单", 400);

  let imported = 0;
  for (const m of body.members) {
    try {
      await db.insert(lotteryRosterMembers).values({
        id: crypto.randomUUID(),
        tenantId,
        drawId,
        identityValue: m.email.trim().toLowerCase(),
        displayName: m.name || "",
      });
      imported++;
    } catch { /* 重复跳过 */ }
  }

  return ok(c, { imported });
});

/** 生成邀请码（invite_code 模式） */
adminLotteryRoute.post("/draws/:id/invite-codes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ count?: number; maxUses?: number }>();

  const count = Math.min(body.count || 10, 1000);
  const maxUses = body.maxUses || 1;

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== "draft") return fail(c, "仅草稿状态的活动可生成邀请码", 400);

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomUUID().slice(0, 8).toUpperCase();
    await db.insert(lotteryInviteCodes).values({
      id: crypto.randomUUID(),
      tenantId,
      drawId,
      code,
      maxUses,
    });
    codes.push(code);
  }

  return ok(c, { codes, count: codes.length });
});

// ═════════════════════════════════════════════════════════
// 审计日志
// ═════════════════════════════════════════════════════════

/** 审计日志列表（支持按操作类型筛选） */
adminLotteryRoute.get("/logs", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const action = c.req.query("action") || "";
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));

  const conditions = [eq(auditLogs.tenantId, tenantId)];
  if (action) conditions.push(eq(auditLogs.action, action));

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { logs: rows });
});