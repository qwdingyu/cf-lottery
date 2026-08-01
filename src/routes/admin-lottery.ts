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
import { lotteryDraws, prizes, prizeCodes, lotteryPrizeTiers, lotteryRosterMembers, lotteryInviteCodes, lotteryWinners, lotteryEntries, lotteryBlacklist, apiKeys, webhookConfigs, couponCodes, shareRecords, auditLogs, tenantMembers, users, tenants } from "../db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
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
  getActivityOutcomes,
  getTenantUsage,
  hashAccessPassword,
  createPrize,
  importPrizeCodes,
} from "../services/lottery-service";

export const adminLotteryRoute = new Hono<AppEnv>();

const ACTIVITY_KINDS = new Set(["lottery", "signup_chain", "reservation", "vote", "survey", "checkin", "waitlist", "approval", "claim"]);
const PARTICIPATION_MODES = new Set(["open", "roster", "password", "invite_code"]);
const EXPERIENCE_TYPES = new Set([
  "submit",
  "wheel",
  "slot",
  "scratch",
  "card",
  "list",
  "calendar",
  "form",
  "ballot",
  "quiz",
  "checkin",
  "queue",
  "reveal",
  "grid",
]);
const DRAW_TRIGGERS = new Set(["manual", "scheduled"]);
const RESULT_MODES = new Set([
  "manual",
  "scheduled",
  "instant",
  "ordered_assignment",
  "capacity_assignment",
  "vote_tally",
  "review_decision",
  "no_result",
]);
const ALLOCATION_POLICIES = new Set(["capacity", "waitlist", "fifo", "priority", "random", "weighted_random", "approval"]);

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
  const tenantUsage = await getTenantUsage(db, tenantId);

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
    plan: tenantUsage.plan,
    limits: tenantUsage.limits,
    usage: tenantUsage.usage,
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
    quota: await getTenantUsage(db, tenantId),
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
    // 创建活动时校验 productLink
    if (body.productLink) {
      const err = validateProductLink(body.productLink);
      if (err) return fail(c, err, 400);
    }

    const activityKind = coerceEnum(body.activityKind, ACTIVITY_KINDS, "lottery");
    const participationMode = coerceEnum(body.participationMode, PARTICIPATION_MODES, "open");
    const drawTrigger = coerceEnum(body.drawTrigger, DRAW_TRIGGERS, "manual");

    const { id, publicSlug } = await createDraw(db, tenantId, {
      title: String(body.title || ""),
      description: String(body.description || ""),
      activityKind,
      participationMode,
      experienceType: body.experienceType !== undefined
        ? coerceEnum(body.experienceType, EXPERIENCE_TYPES, defaultExperienceForActivity(activityKind, participationMode))
        : undefined,
      drawTrigger,
      resultMode: body.resultMode !== undefined
        ? coerceEnum(body.resultMode, RESULT_MODES, defaultResultModeForActivity(activityKind, drawTrigger))
        : undefined,
      allocationPolicy: body.allocationPolicy !== undefined
        ? coerceEnum(body.allocationPolicy, ALLOCATION_POLICIES, "capacity")
        : undefined,
      policyVersion: 1,
      startAt: String(body.startAt || ""),
      endAt: String(body.endAt || ""),
      drawAt: body.drawAt || undefined,
      accessPassword: String(body.accessPassword || ""),
      maxParticipants: body.maxParticipants ? Number(body.maxParticipants) : undefined,
      winnerCount: body.winnerCount !== undefined ? Number(body.winnerCount) : undefined,
      productLink: body.productLink ? JSON.stringify(body.productLink) : "{}",
      promotionConfig: body.promotionConfig && typeof body.promotionConfig === "object" ? JSON.stringify(body.promotionConfig) : "{}",
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

  // 校验时间顺序（如果一起修改了时间）
  const startAt = body.startAt ?? draw.startAt;
  const endAt = body.endAt ?? draw.endAt;
  const drawAt = body.drawAt ?? draw.drawAt;
  if (new Date(startAt) >= new Date(endAt)) {
    return fail(c, "参与开始时间必须早于结束时间", 400);
  }
  if (drawAt && new Date(endAt) >= new Date(drawAt)) {
    return fail(c, "开奖时间必须在参与结束后", 400);
  }

  // 编辑时校验 productLink
  if (body.productLink !== undefined) {
    const err = validateProductLink(body.productLink);
    if (err) return fail(c, err, 400);
  }

  if (body.maxParticipants !== undefined && body.maxParticipants !== null) {
    const maxParticipants = Number(body.maxParticipants);
    const quota = await getTenantUsage(db, tenantId);
    if (maxParticipants > quota.limits.maxParticipantsPerActivity) {
      return fail(c, `当前套餐单活动最多允许 ${quota.limits.maxParticipantsPerActivity} 人参与，请降低名额或升级套餐`, 403);
    }
  }

  await db
    .update(lotteryDraws)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.activityKind !== undefined ? { activityKind: coerceEnum(body.activityKind, ACTIVITY_KINDS, "lottery") } : {}),
      ...(body.participationMode !== undefined ? { participationMode: coerceEnum(body.participationMode, PARTICIPATION_MODES, draw.participationMode) } : {}),
      ...(body.experienceType !== undefined ? { experienceType: coerceEnum(body.experienceType, EXPERIENCE_TYPES, draw.experienceType || defaultExperienceForActivity(draw.activityKind || "lottery", draw.participationMode)) } : {}),
      ...(body.drawTrigger !== undefined ? { drawTrigger: coerceEnum(body.drawTrigger, DRAW_TRIGGERS, draw.drawTrigger) } : {}),
      ...(body.resultMode !== undefined ? { resultMode: coerceEnum(body.resultMode, RESULT_MODES, draw.resultMode || draw.drawTrigger) } : {}),
      ...(body.allocationPolicy !== undefined ? { allocationPolicy: coerceEnum(body.allocationPolicy, ALLOCATION_POLICIES, draw.allocationPolicy || "capacity") } : {}),
      ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
      ...(body.drawAt !== undefined ? { drawAt: body.drawAt } : {}),
      ...(body.winnerCount !== undefined ? { winnerCount: Number(body.winnerCount) } : {}),
      ...(body.maxParticipants !== undefined ? { maxParticipants: body.maxParticipants ? Number(body.maxParticipants) : null } : {}),
      ...(body.accessPassword !== undefined ? { accessPassword: body.accessPassword ? await hashAccessPassword(String(body.accessPassword)) : "" } : {}),
      ...(body.showParticipantCount !== undefined ? { showParticipantCount: body.showParticipantCount ? 1 : 0 } : {}),
      ...(body.showWinnerCount !== undefined ? { showWinnerCount: body.showWinnerCount ? 1 : 0 } : {}),
      ...(body.showWinnerList !== undefined ? { showWinnerList: body.showWinnerList ? 1 : 0 } : {}),
      ...(body.productLink !== undefined ? { productLink: typeof body.productLink === "string" ? body.productLink : JSON.stringify(body.productLink) } : {}),
      ...(body.promotionConfig !== undefined ? { promotionConfig: typeof body.promotionConfig === "string" ? body.promotionConfig : JSON.stringify(body.promotionConfig) } : {}),
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
    const draw = await getDraw(db, drawId, tenantId);
    if (!draw) return fail(c, "活动不存在", 404);
    if (draw.activityKind !== "lottery") {
      return fail(c, "该活动类型不需要开奖", 400);
    }
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

/** 通用活动结果（接龙/预约/候补等非抽奖活动） */
adminLotteryRoute.get("/draws/:id/outcomes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  const rows = await getActivityOutcomes(db, tenantId, drawId);
  return ok(c, { outcomes: rows });
});

/** 候选池统计 */
adminLotteryRoute.get("/draws/:id/stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const entryCount = await getDrawEntriesCount(db, drawId, tenantId);
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
  const outcomes = draw.activityKind === "lottery" ? [] : await getActivityOutcomes(db, tenantId, drawId, 10000);

  // 构建 CSV 内容
  const lines: string[] = [
    "活动名称,状态,参与人数,中奖人数",
    `${draw.title},${draw.status},${entries.length},${draw.activityKind === "lottery" ? winners.length : outcomes.length}`,
    "",
    "参与者邮箱,参与时间",
    ...entries.map((e) => `${e.identityValue},${e.joinedAt}`),
  ];

  if (draw.activityKind === "lottery") {
    lines.push("", "中奖者邮箱,中奖时间", ...winners.map((w) => `${w.identityValue},${w.drawnAt}`));
  } else {
    lines.push(
      "",
      "参与记录ID,状态,参与顺序,名额序号,结果说明,确认时间",
      ...outcomes.map((o) => `${o.entryId},${o.status},${o.sequenceNo},${o.assignmentNo ?? ""},${o.resultLabel},${o.decidedAt || ""}`),
    );
  }

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

  if (draw.activityKind === "signup_chain") {
    if (!draw.maxParticipants) {
      warnings.push("接龙活动未设置名额上限，将按默认上限控制参与量");
    }
  } else {
    // 奖项校验只适用于抽奖活动
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
            .where(and(eq(prizeCodes.tenantId, tenantId), eq(prizeCodes.prizeId, tier.prizeId), eq(prizeCodes.status, "available")));
          if (Number(codeRow?.count || 0) < tier.winnerCount) {
            warnings.push(`奖项"${tier.tierName}"可用码 ${codeRow?.count || 0} 个，中奖名额 ${tier.winnerCount} 个，码可能不足`);
          }
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

/**
 * 校验商品链接配置（服务端校验，防止危险协议和超长字段）
 * 返回 null 表示通过，返回字符串表示错误消息
 */
function validateProductLink(link: any): string | null {
  if (!link || typeof link !== "object") return "商品链接配置无效";
  if (typeof link.url !== "string" || !link.url.trim()) return "商品链接不能为空";
  try {
    const url = new URL(link.url);
    if (!["https:", "http:"].includes(url.protocol)) {
      return "商品链接仅支持 http 和 https 协议";
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return "商品链接不能指向本地地址";
    }
    if (url.href.length > 2000) return "商品链接过长";
  } catch {
    return "商品链接格式无效";
  }
  if (typeof link.title === "string" && link.title.length > 200) return "商品名称过长";
  if (typeof link.imageUrl === "string" && link.imageUrl.length > 2000) return "图片链接过长";
  if (typeof link.price === "string" && link.price.length > 50) return "展示价格过长";
  return null;
}

function coerceEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === "signup_chain") return "list";
  if (activityKind === "reservation") return "calendar";
  if (activityKind === "vote") return "ballot";
  if (activityKind === "survey") return "form";
  if (activityKind === "checkin") return "checkin";
  if (activityKind === "waitlist") return "queue";
  if (activityKind === "approval") return "form";
  if (activityKind === "claim") return "reveal";
  return defaultExperienceForParticipation(participationMode);
}

function defaultResultModeForActivity(activityKind: string, drawTrigger: string): string {
  if (activityKind === "signup_chain") return "ordered_assignment";
  if (activityKind === "reservation") return "capacity_assignment";
  if (activityKind === "vote") return "vote_tally";
  if (activityKind === "survey") return "no_result";
  if (activityKind === "checkin") return "no_result";
  if (activityKind === "waitlist") return "ordered_assignment";
  if (activityKind === "approval") return "review_decision";
  if (activityKind === "claim") return "instant";
  if (activityKind === "assignment") return "ordered_assignment";
  return drawTrigger === "scheduled" ? "scheduled" : "manual";
}

/** 安全解析 JSON 字符串 */
function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ═════════════════════════════════════════════════════════
// 参与者黑名单
// ═════════════════════════════════════════════════════════

/** 黑名单列表 */
adminLotteryRoute.get("/blacklist", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));

  const rows = await db
    .select()
    .from(lotteryBlacklist)
    .where(eq(lotteryBlacklist.tenantId, tenantId))
    .orderBy(desc(lotteryBlacklist.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { items: rows });
});

/** 添加黑名单 */
adminLotteryRoute.post("/blacklist", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ identityValue: string; note?: string }>();
  const email = String(body.identityValue || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  await db.insert(lotteryBlacklist).values({
    id: crypto.randomUUID(),
    tenantId,
    identityValue: email,
    note: String(body.note || "").trim(),
  });

  return ok(c, { added: true });
});

/** 删除黑名单 */
adminLotteryRoute.delete("/blacklist/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const id = c.req.param("id");

  await db
    .delete(lotteryBlacklist)
    .where(and(eq(lotteryBlacklist.id, id), eq(lotteryBlacklist.tenantId, tenantId)));

  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 租户成员管理
// ═════════════════════════════════════════════════════════

/** 成员列表 */
adminLotteryRoute.get("/members", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;

  const rows = await db
    .select({
      userId: tenantMembers.userId,
      role: tenantMembers.role,
      username: users.username,
      createdAt: tenantMembers.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(tenantMembers.userId, users.id))
    .where(eq(tenantMembers.tenantId, tenantId))
    .orderBy(desc(tenantMembers.createdAt));

  return ok(c, { members: rows });
});

/** 添加成员 */
adminLotteryRoute.post("/members", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ username: string; role?: string }>();
  const username = String(body.username || "").trim();

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (!user) return fail(c, "用户不存在", 404);

  const [existing] = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, user.id)))
    .limit(1);
  if (existing) return fail(c, "该用户已是团队成员", 409);

  const quota = await getTenantUsage(db, tenantId);
  if (quota.limits.maxMembers !== null) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(tenantMembers)
      .where(eq(tenantMembers.tenantId, tenantId));
    if (Number(total || 0) >= quota.limits.maxMembers) {
      return fail(c, `当前套餐最多允许 ${quota.limits.maxMembers} 名团队成员`, 403);
    }
  }

  await db.insert(tenantMembers).values({
    tenantId,
    userId: user.id,
    role: body.role || "admin",
  });

  return ok(c, { added: true });
});

/** 删除成员 */
adminLotteryRoute.delete("/members/:userId", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const userId = c.req.param("userId");

  if (userId === c.get("userId")) return fail(c, "不能删除自己", 400);

  await db
    .delete(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));

  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 统计概览
// ═════════════════════════════════════════════════════════

/** 租户级别统计概览 */
adminLotteryRoute.get("/stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const tenantUsage = await getTenantUsage(db, tenantId);

  const [drawCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.tenantId, tenantId));

  const [openCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));

  const [drawnCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "drawn")));

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [recentEntries] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), sql`${lotteryEntries.joinedAt} >= ${sevenDaysAgo}`));

  const [winnerCount] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.tenantId, tenantId));

  return ok(c, {
    totalDraws: Number(drawCount?.total ?? 0),
    openDraws: Number(openCount?.total ?? 0),
    drawnDraws: Number(drawnCount?.total ?? 0),
    recentParticipants: Number(recentEntries?.total ?? 0),
    totalWinners: Number(winnerCount?.total ?? 0),
    plan: tenantUsage.plan,
    limits: tenantUsage.limits,
    usage: tenantUsage.usage,
  });
});

// ═════════════════════════════════════════════════════════
// 接龙模式：参与列表
// ═════════════════════════════════════════════════════════

/** 接龙参与列表（按参与时间排序） */
adminLotteryRoute.get("/draws/:id/signup-list", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ activityKind: lotteryDraws.activityKind })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "signup_chain") return fail(c, "该活动不是接龙模式", 400);

  const entries = await db
    .select({
      id: lotteryEntries.id,
      identityValue: lotteryEntries.identityValue,
      joinedAt: lotteryEntries.joinedAt,
    })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId)))
    .orderBy(lotteryEntries.joinedAt);

  return ok(c, { entries, total: entries.length });
});

// ═════════════════════════════════════════════════════════
// API 密钥管理
// ═════════════════════════════════════════════════════════

/** API 密钥列表 */
adminLotteryRoute.get("/api-keys", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select({ id: apiKeys.id, name: apiKeys.name, key: apiKeys.key, active: apiKeys.active, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.createdAt));
  return ok(c, { keys: rows });
});

/** 创建 API 密钥 */
adminLotteryRoute.post("/api-keys", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ name: string }>();
  const name = String(body.name || "").trim();
  if (!name) return fail(c, "请输入密钥名称", 400);

  const key = "cl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  await db.insert(apiKeys).values({ id: crypto.randomUUID(), tenantId, name, key });
  return ok(c, { key });
});

/** 删除 API 密钥 */
adminLotteryRoute.delete("/api-keys/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  await db.delete(apiKeys).where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.tenantId, tenantId)));
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// Webhook 配置管理
// ═════════════════════════════════════════════════════════

/** Webhook 列表 */
adminLotteryRoute.get("/webhooks", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await db
    .select()
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, tenantId))
    .orderBy(desc(webhookConfigs.createdAt));
  return ok(c, { webhooks: rows });
});

/** 创建 Webhook */
adminLotteryRoute.post("/webhooks", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ url: string; events?: string[] }>();
  const url = String(body.url || "").trim();
  if (!url) return fail(c, "请输入 Webhook URL", 400);
  try { new URL(url); if (url.startsWith("http")) {} else throw 1; } catch { return fail(c, "URL 格式无效", 400); }

  const quota = await getTenantUsage(db, tenantId);
  if (quota.limits.maxWebhooks !== null) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, 1)));
    if (Number(total || 0) >= quota.limits.maxWebhooks) {
      return fail(c, `当前套餐最多允许 ${quota.limits.maxWebhooks} 个 Webhook`, 403);
    }
  }

  await db.insert(webhookConfigs).values({
    id: crypto.randomUUID(),
    tenantId,
    url,
    events: JSON.stringify(body.events || ["draw.completed", "prize.issued"]),
  });
  return ok(c, { created: true });
});

/** 删除 Webhook */
adminLotteryRoute.delete("/webhooks/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  await db.delete(webhookConfigs).where(and(eq(webhookConfigs.id, c.req.param("id")), eq(webhookConfigs.tenantId, tenantId)));
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 优惠券码池管理
// ═════════════════════════════════════════════════════════

/** 优惠券列表 */
adminLotteryRoute.get("/coupons", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));
  const rows = await db
    .select()
    .from(couponCodes)
    .where(eq(couponCodes.tenantId, tenantId))
    .orderBy(desc(couponCodes.createdAt))
    .limit(limit).offset(offset);
  return ok(c, { coupons: rows });
});

/** 批量导入优惠券 */
adminLotteryRoute.post("/coupons/import", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ codes: string[]; label?: string; expiresAt?: string }>();
  if (!body.codes || body.codes.length === 0) return fail(c, "请提供至少一个码", 400);
  let count = 0;
  for (const code of body.codes) {
    try {
      await db.insert(couponCodes).values({
        id: crypto.randomUUID(), tenantId, code: code.trim(),
        label: body.label || "", expiresAt: body.expiresAt || null,
      });
      count++;
    } catch { /* 跳过重复码 */ }
  }
  return ok(c, { imported: count });
});

/** 核销优惠券 */
adminLotteryRoute.post("/coupons/redeem", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ code: string }>();
  const code = String(body.code || "").trim();
  if (!code) return fail(c, "请输入优惠券码", 400);

  const [coupon] = await db
    .select()
    .from(couponCodes)
    .where(and(eq(couponCodes.tenantId, tenantId), eq(couponCodes.code, code)))
    .limit(1);
  if (!coupon) return fail(c, "优惠券不存在", 404);
  if (coupon.status !== "available") return fail(c, "优惠券已使用或已过期", 400);

  await db.update(couponCodes).set({ status: "redeemed", redeemedAt: new Date().toISOString() })
    .where(eq(couponCodes.id, coupon.id));
  return ok(c, { redeemed: true, label: coupon.label });
});

// ═════════════════════════════════════════════════════════
// 租户品牌配置（白标）
// ═════════════════════════════════════════════════════════

/** 获取品牌配置 */
adminLotteryRoute.get("/brand", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const [tenant] = await db.select({ brandConfig: tenants.brandConfig }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);
  const config = tryParseJson(tenant.brandConfig);
  return ok(c, { config });
});

/** 更新品牌配置 */
adminLotteryRoute.put("/brand", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<any>();
  const config = {
    logo: body.logo || "",
    primaryColor: body.primaryColor || "",
    companyName: body.companyName || "",
    domain: body.domain || "",
  };
  await db.update(tenants).set({ brandConfig: JSON.stringify(config), updatedAt: new Date().toISOString() }).where(eq(tenants.id, tenantId));
  return ok(c, { config });
});

// ═════════════════════════════════════════════════════════
// 分享裂变统计
// ═════════════════════════════════════════════════════════

/** 分享统计 */
adminLotteryRoute.get("/draws/:id/shares", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const rows = await db
    .select()
    .from(shareRecords)
    .where(and(eq(shareRecords.tenantId, tenantId), eq(shareRecords.drawId, drawId)))
    .orderBy(desc(shareRecords.createdAt));
  const totalClicks = rows.reduce((s, r) => s + r.clickedCount, 0);
  const totalJoins = rows.reduce((s, r) => s + r.joinedCount, 0);
  return ok(c, { shares: rows, totalClicks, totalJoins, sharerCount: rows.length });
});
