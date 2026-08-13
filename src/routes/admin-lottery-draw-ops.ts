/**
 * 管理端抽奖路由 — 活动运营数据域
 *
 * 中奖/候选池/审核/统计/导出/删除/奖项/名单/邀请码等。
 * 主文件保留：dashboard / me / 活动 CRUD / 发布开奖状态机。
 * 通过 setupDrawOpsRoutes 挂载，中间件已在主路由 use("*") 覆盖。
 */
import { Hono } from "hono";
import { isInstantResultMode, isFlashSaleExperience } from "../lib/activity-utils";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { getDb, ok, fail, clampInteger } from "../lib/http";
import { getEnv } from "../lib/platform";
import {
  lotteryDraws,
  prizes,
  prizeCodes,
  lotteryPrizeTiers,
  lotteryRosterMembers,
  lotteryInviteCodes,
  lotteryWinners,
  lotteryEntries,
  activityOutcomes,
  activitySubmissions,
  couponCodes,
} from "../db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
import {
  getDraw,
  getDrawWinners,
  getEntries,
  getActivityOutcomes,
  getActivityEventSummary,
  getExternalConversionSummary,
  listExternalConversions,
  sendWinnerNotifications,
  healDrawingState,
  DRAW_STATUS,
  grantLeaderboardRewards,
} from "../services/lottery-service";
import { buildPublishCheck } from "../services/publish-check-service";
import { parseActivityConfig } from "../lib/activity-config";
import {
  recordTenantAudit,
  parseAdminPagination,
  decorateIdentityDisplay,
  csvEscape,
  isUniqueConstraintError,
  cascadeDeleteDraw,
  DrawDeletionBlockedError,
  isDrawStatusDeletable,
  parseBatchDeleteIds,
} from "./admin-lottery-helpers";

export function setupDrawOpsRoutes(route: Hono<AppEnv>) {
  const DRAW_EXPORT_MAX_ROWS = 10_000;

  function buildCsvResponse(c: Context<AppEnv>, filename: string, lines: string[]) {
    const encodedName = encodeURIComponent(filename);
    return c.body("\uFEFF" + lines.join("\n"), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
    });
  }

/** 中奖名单 */
route.get("/draws/:id/winners", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getDrawWinners(db, c.req.param("id"), tenantId);
  // L2 可读性：user_id 身份（registered）解析为用户名(邮箱)，email 身份原样
  await decorateIdentityDisplay(db, rows);
  return ok(c, { winners: rows });
});

/** 候选池 */
route.get("/draws/:id/entries", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const rows = await getEntries(db, tenantId, c.req.param("id"));
  await decorateIdentityDisplay(db, rows);
  return ok(c, { entries: rows });
});

/** 审核申请：批准或拒绝（仅 approval 活动可用）
 *
 * 审核流程：
 * 1. 用户提交申请 → 创建 lottery_entry 参与记录
 * 2. 管理员审查 → 调用此 API 批准或拒绝
 * 3. 审批结果写入 activity_outcomes 表，outcomeType='review'
 * 4. 通过后可通过 Webhook 通知用户（需额外配置）
 *
 * 注意：审批结果一旦写入不可撤回，如需重新审核需重新提交申请。
 */
route.post("/draws/:id/review", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ entryId: string; decision: "approved" | "rejected"; reason?: string }>();
  if (!body.entryId || !body.decision) return fail(c, "请指定参与记录和审批结果", 400);

  // 校验活动存在且是审批类型
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "approval") return fail(c, "仅审核活动支持审批操作", 400);

  // 校验参与记录存在且属于该活动
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.id, body.entryId)))
    .limit(1);
  if (!entry) return fail(c, "参与记录不存在", 404);

  const now = new Date().toISOString();
  // 写入审批结果到 activity_outcomes 表
  // outcomeType='review' 区分于接龙的 'assignment'
  // status 记录审批结论：approved/rejected
  await db.insert(activityOutcomes).values({
    id: crypto.randomUUID(),
    tenantId,
    drawId,
    entryId: body.entryId,
    outcomeType: "review",          // 区分于接龙的 assignment
    status: body.decision,          // approved | rejected
    sequenceNo: 0,                  // 审批不涉及排序
    resultKey: body.decision,       // 与 status 一致，便于前端按 resultKey 筛选
    resultLabel: body.decision === "approved" ? "已通过" : "已拒绝",
    metadataJson: JSON.stringify({ reason: body.reason || "" }), // 审批理由存 metadata
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return ok(c, { reviewed: true, decision: body.decision });
});

/** 通用活动结果（接龙/预约/候补等非抽奖活动） */
route.get("/draws/:id/outcomes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  const rows = await getActivityOutcomes(db, tenantId, drawId);
  return ok(c, { outcomes: rows });
});

/** 候选池统计 */
route.get("/draws/:id/stats", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const [entryRow] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.tenantId, tenantId)));
  const entryCount = Number(entryRow?.total ?? 0);
  const events = await getActivityEventSummary(db, tenantId, drawId);
  const externalConversions = await getExternalConversionSummary(db, tenantId, drawId);

  // ★ P1-3: 未中奖承接看板（docs/211）—— 统计安慰券发放与核销
  const [issuedResult] = await db
    .select({ total: count() })
    .from(couponCodes)
    .where(and(
      eq(couponCodes.tenantId, tenantId),
      eq(couponCodes.drawId, drawId),
      eq(couponCodes.status, "issued"),
    ));
  const [redeemedResult] = await db
    .select({ total: count() })
    .from(couponCodes)
    .where(and(
      eq(couponCodes.tenantId, tenantId),
      eq(couponCodes.drawId, drawId),
      eq(couponCodes.status, "redeemed"),
    ));
  const consolation = {
    issued: Number(issuedResult?.total ?? 0),
    redeemed: Number(redeemedResult?.total ?? 0),
  };

  return ok(c, { entryCount, events, externalConversions, consolation });
});

/** 活动事件汇总：导流漏斗基础事实，不代表外部成交 */
route.get("/draws/:id/events/summary", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  return ok(c, await getActivityEventSummary(db, tenantId, drawId));
});

/**
 * 活动提交记录（问卷答案/投票选项/资料领取 payload）。
 * 033 基线：所有玩法的动态表单数据统一走 activity_submissions 表。
 */
route.get("/draws/:id/submissions", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const { limit, offset } = parseAdminPagination(c, 50, 200);

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const [{ total: totalCount }] = await db
    .select({ total: count() })
    .from(activitySubmissions)
    .where(and(eq(activitySubmissions.tenantId, tenantId), eq(activitySubmissions.drawId, drawId)));

  const rows = await db
    .select()
    .from(activitySubmissions)
    .where(and(eq(activitySubmissions.tenantId, tenantId), eq(activitySubmissions.drawId, drawId)))
    .orderBy(desc(activitySubmissions.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { submissions: rows, total: Number(totalCount) });
});

/** 投票统计：按活动配置中的固定选项统计票数（仅 vote 活动可用）
 *
 * 投票参与者身份仍然是邮箱/手机号，不能再用 lottery_entries.identity_value 当选项统计。
 * 正式投票选择只允许来自 activity_config.options，并保存到 activity_submissions.payload_json.optionId。
 */
route.get("/draws/:id/tally", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  // 校验活动存在且是投票类型
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.activityKind !== "vote") return fail(c, "仅投票活动支持票数统计", 400);

  const config = parseActivityConfig(draw.activityConfig);
  if (!config || config.kind !== "vote") return fail(c, "投票选项配置无效", 400);
  const optionIds = new Set(config.options.map((option) => option.id));

  // 管理后台统计是低频查询，允许数据库侧 GROUP BY；热路径提交不做此类聚合。
  const rows = await db
    .select({
      optionId: sql<string>`json_extract(${activitySubmissions.payloadJson}, '$.optionId')`,
      count: count(),
    })
    .from(activitySubmissions)
    .where(and(eq(activitySubmissions.tenantId, tenantId), eq(activitySubmissions.drawId, drawId)))
    .groupBy(sql`json_extract(${activitySubmissions.payloadJson}, '$.optionId')`)
    .orderBy(desc(count()));

  const tally = config.options.map((option) => {
    const row = rows.find((item) => String(item.optionId || "") === option.id);
    return {
      optionId: option.id,
      label: option.label,
      description: option.description,
      imageUrl: option.imageUrl,
      count: Number(row?.count || 0),
    };
  });
  const unknown = rows
    .filter((row) => row.optionId && !optionIds.has(String(row.optionId)))
    .map((row) => ({ optionId: String(row.optionId), count: Number(row.count || 0) }));

  return ok(c, { tally, unknown, total: tally.reduce((sum, row) => sum + row.count, 0) });
});

/** 外部转化回传列表：只展示外部系统显式回传的事实 */
route.get("/draws/:id/conversions", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const { limit, offset } = parseAdminPagination(c);

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);

  const conversions = await listExternalConversions(db, tenantId, drawId, limit, offset);
  const summary = await getExternalConversionSummary(db, tenantId, drawId);
  return ok(c, { conversions, summary });
});

/** 导出 CSV
 *
 * 限制：单次导出最多 10,000 条参与记录，超出时提示用户缩小范围。
 * 10ms CPU 和 128MB 内存不适合一次性生成大文件，大活动应分批导出。
 * 安全：所有用户输入字段经 csvEscape 转义，防止公式注入。
 */
route.get("/draws/:id/export", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const scope = String(c.req.query("scope") || "all");
  const limit = clampInteger(c.req.query("limit"), DRAW_EXPORT_MAX_ROWS, 1, DRAW_EXPORT_MAX_ROWS);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 1_000_000);

  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) return fail(c, "活动不存在", 404);
  if (!["all", "entries", "winners", "outcomes"].includes(scope)) {
    return fail(c, "导出范围无效", 400);
  }

  // 同步 CSV 严格限制单次行数；大活动通过 offset/limit 分批拉取，避免 Worker 内存和 Turso rows read 失控。
  const winners = (scope === "all" || scope === "winners") && draw.activityKind === "lottery"
    ? await getDrawWinners(db, drawId, tenantId, { limit: limit + 1, offset })
    : [];
  const entries = scope === "all" || scope === "entries"
    ? await getEntries(db, tenantId, drawId, limit + 1, offset)
    : [];
  const outcomes = (scope === "all" || scope === "outcomes") && draw.activityKind !== "lottery"
    ? await getActivityOutcomes(db, tenantId, drawId, limit + 1, offset)
    : [];
  const exportedBusinessRows = entries.length + winners.length + outcomes.length;
  if (
    entries.length > limit
    || winners.length > limit
    || outcomes.length > limit
    || exportedBusinessRows > limit
  ) {
    return fail(c, `单次导出超过 ${limit} 行，请使用 offset/limit 分批导出`, 400);
  }
  // L2 可读性：CSV 中的参与者/中奖者用可读身份（registered 用户显示用户名(邮箱)）
  await decorateIdentityDisplay(db, winners);
  await decorateIdentityDisplay(db, entries);

  // 构建 CSV 内容（所有用户输入经 csvEscape 转义）
  const lines: string[] = [
    "活动名称,状态,参与人数,中奖人数",
    `${csvEscape(draw.title)},${csvEscape(draw.status)},${entries.length},${draw.activityKind === "lottery" ? winners.length : outcomes.length}`,
  ];

  if (scope === "all" || scope === "entries") {
    lines.push(
      "",
      "参与者,参与时间",
      ...entries.map((e) => `${csvEscape((e as any).identityDisplay || e.identityValue)},${csvEscape(e.joinedAt)}`),
    );
  }

  if ((scope === "all" || scope === "winners") && draw.activityKind === "lottery") {
    // docs/102：导出含奖品/卡密/履约，避免只有身份+时间、运营以为没发码
    lines.push(
      "",
      "中奖者,奖品,档位,履约类型,卡密,中奖时间,邮件状态",
      ...winners.map((w) => {
        const anyW = w as any;
        return [
          csvEscape(anyW.identityDisplay || w.identityValue),
          csvEscape(anyW.prizeName || ""),
          csvEscape(anyW.tierName || ""),
          csvEscape(anyW.fulfillmentKind || ""),
          csvEscape(anyW.prizeCode || anyW.cardAccountLabel || ""),
          csvEscape(w.drawnAt),
          csvEscape(w.notificationStatus),
        ].join(",");
      }),
    );
  } else if ((scope === "all" || scope === "outcomes") && draw.activityKind !== "lottery") {
    lines.push(
      "",
      "参与记录ID,状态,参与顺序,名额序号,结果说明,确认时间",
      ...outcomes.map((o) => `${csvEscape(o.entryId)},${csvEscape(o.status)},${csvEscape(o.sequenceNo)},${csvEscape(o.assignmentNo ?? "")},${csvEscape(o.resultLabel)},${csvEscape(o.decidedAt || "")}`),
    );
  }

  return buildCsvResponse(c, `draw-${drawId}-${scope}.csv`, lines);
});

/**
 * 删除活动（draft/paused/drawn/cancelled；open/drawing 禁止，无 force）。
 * 级联逻辑见 cascadeDeleteDraw，与 batch-delete 同源。
 */
route.delete("/draws/:id", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (!isDrawStatusDeletable(draw.status)) {
    return fail(c, "进行中的活动不可删除，请先暂停或取消", 400);
  }

  try {
    await withDbTransaction(db, async (tx) => {
      await cascadeDeleteDraw(tx, tenantId, drawId);
    });
  } catch (err) {
    if (err instanceof DrawDeletionBlockedError) {
      return fail(c, err.message, 409);
    }
    throw err;
  }

  await recordTenantAudit(c, "draw.delete", "lottery_draw", drawId);
  return ok(c, { deleted: true });
});

/**
 * 批量删除活动（docs/082 P2）。
 * - 同单条：open/drawing 计入 failed，不 force
 * - 顺序逐条级联（每条独立事务），避免长事务锁死
 * - 一条审计汇总：draw.batch_delete
 */
route.post("/draws/batch-delete", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求体无效", 400);
  }
  const parsed = parseBatchDeleteIds(body);
  if (parsed.error) return fail(c, parsed.error, 400);

  const deleted: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const drawId of parsed.ids) {
    const [draw] = await db
      .select({ status: lotteryDraws.status })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);

    if (!draw) {
      failed.push({ id: drawId, reason: "活动不存在" });
      continue;
    }
    if (!isDrawStatusDeletable(draw.status)) {
      failed.push({ id: drawId, reason: "进行中的活动不可删除，请先暂停或取消" });
      continue;
    }
    try {
      await withDbTransaction(db, async (tx) => {
        await cascadeDeleteDraw(tx, tenantId, drawId);
      });
      deleted.push(drawId);
    } catch (err) {
      console.error("[admin] draw batch-delete item failed:", drawId, err);
      failed.push({
        id: drawId,
        reason: err instanceof DrawDeletionBlockedError ? err.message : "删除失败",
      });
    }
  }

  await recordTenantAudit(c, "draw.batch_delete", "lottery_draw", "batch", {
    requested: parsed.ids.length,
    deleted: deleted.length,
    failed: failed.length,
    deletedIds: deleted.slice(0, 50),
    failedSample: failed.slice(0, 20),
  });

  return ok(c, {
    deleted: deleted.length,
    failed: failed.length,
    deletedIds: deleted,
    failedItems: failed,
  });
});

// ═════════════════════════════════════════════════════════
// P0 运营工具：补发码 + 重发通知 + 发布前校验
// ═════════════════════════════════════════════════════════

/** 奖项配置：替换活动的整组奖项 */
route.post("/draws/:id/tiers", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{
    tiers: Array<{ prizeId: string; tierName?: string; winnerCount?: number; sortOrder?: number; weight?: number }>;
  }>();

  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      status: lotteryDraws.status,
      activityKind: lotteryDraws.activityKind,
      resultMode: lotteryDraws.resultMode,
      experienceType: lotteryDraws.experienceType,
    })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  // 奖项配置适用于两类活动：
  // ① lottery（抽奖奖档）；② claim + flash_sale（直付秒杀绑定唯一卡密奖品，发卡目标）。
  // 其他活动（资料领取、问卷、报名等）不需要奖项，拒绝保存。
  const isFlashSaleDirect = draw.activityKind === "claim" && isFlashSaleExperience(draw.experienceType);
  if (draw.activityKind !== "lottery" && !isFlashSaleDirect) {
    return fail(c, "只有抽奖活动或直付秒杀需要配置奖项", 400);
  }
  if (draw.status !== DRAW_STATUS.DRAFT) return fail(c, "只有草稿状态的活动可以配置奖项", 400);
  if (!Array.isArray(body.tiers) || body.tiers.length === 0) return fail(c, "请至少配置一个奖项", 400);
  if (body.tiers.length > 10) return fail(c, "单个活动最多配置 10 个奖项", 400);

  const isInstant = isInstantResultMode(draw.resultMode);
  const normalizedTiers: Array<{
    id: string;
    tenantId: string;
    drawId: string;
    prizeId: string;
    tierName: string;
    winnerCount: number;
    sortOrder: number;
    weight: number;
  }> = [];
  const seenPrizeIds = new Set<string>();

  for (const [index, tier] of body.tiers.entries()) {
    const prizeId = String(tier.prizeId || "").trim();
    const tierName = String(tier.tierName || `奖项 ${index + 1}`).trim().slice(0, 50);
    const winnerCount = Number(tier.winnerCount ?? 1);
    const sortOrder = Number(tier.sortOrder ?? (index + 1) * 100);
    // instant：未传 weight 时默认 1，避免运营只配名额无法抽；delayed 忽略 weight
    const weightRaw = tier.weight !== undefined && tier.weight !== null ? Number(tier.weight) : (isInstant ? 1 : 0);
    const weight = Number.isFinite(weightRaw) ? Math.max(0, Math.floor(weightRaw)) : 0;

    if (!prizeId) return fail(c, "奖项必须选择奖品", 400);
    if (seenPrizeIds.has(prizeId)) return fail(c, "同一奖品不能重复配置为多个奖项", 400);
    if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 1000) return fail(c, "中奖名额必须是 1-1000 的整数", 400);
    if (!Number.isFinite(sortOrder)) return fail(c, "奖项排序值无效", 400);
    if (weight > 100000) return fail(c, "奖项权重过大", 400);

    const [prize] = await db
      .select({ id: prizes.id })
      .from(prizes)
      .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId), eq(prizes.active, 1)))
      .limit(1);
    if (!prize) return fail(c, "奖品不存在或已停用", 404);

    seenPrizeIds.add(prizeId);
    normalizedTiers.push({
      id: crypto.randomUUID(),
      tenantId,
      drawId,
      prizeId,
      tierName,
      winnerCount,
      sortOrder: Math.trunc(sortOrder),
      weight,
    });
  }

  // 替换整组奖项比逐条增删改更适合轻量 SaaS：前端保存当前表格即可，避免复杂同步状态。
  await withDbTransaction(db, async (tx) => {
    await tx.delete(lotteryPrizeTiers).where(and(eq(lotteryPrizeTiers.drawId, drawId), eq(lotteryPrizeTiers.tenantId, tenantId)));
    await tx.insert(lotteryPrizeTiers).values(normalizedTiers);
  });

  return ok(c, { tiers: normalizedTiers });
});

/** 补发奖品码（中奖者无码时运营手动补发） */
route.post("/draws/:id/winners/:winnerId/retry-code", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const winnerId = c.req.param("winnerId");
  const now = new Date().toISOString();

  const result = await withDbTransaction(db, async (tx) => {
    const [winner] = await tx
      .select()
      .from(lotteryWinners)
      .where(and(
        eq(lotteryWinners.id, winnerId),
        eq(lotteryWinners.tenantId, tenantId),
        eq(lotteryWinners.drawId, drawId),
      ))
      .limit(1);

    if (!winner) return { ok: false as const, status: 404, message: "中奖记录不存在" };
    if (winner.prizeCodeId) return { ok: false as const, status: 400, message: "已有奖品码，无需补发" };

    const [tier] = await tx
      .select({ prizeId: lotteryPrizeTiers.prizeId })
      .from(lotteryPrizeTiers)
      .where(and(
        eq(lotteryPrizeTiers.id, winner.tierId),
        eq(lotteryPrizeTiers.tenantId, tenantId),
        eq(lotteryPrizeTiers.drawId, drawId),
      ))
      .limit(1);

    if (!tier?.prizeId) return { ok: false as const, status: 400, message: "未配置奖品，无法补发" };

    // 原子锁码：必须用子查询 LIMIT 1，否则 UPDATE prize_id/status 会把同奖品所有可用码一次性发出。
    const [lockedCode] = await tx
      .update(prizeCodes)
      .set({ status: "issued", winnerId: winner.entryId, issuedAt: now })
      .where(and(
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.status, "available"),
        eq(prizeCodes.id, sql<string>`(
          SELECT id FROM prize_codes
          WHERE tenant_id = ${tenantId}
            AND prize_id = ${tier.prizeId}
            AND status = 'available'
          ORDER BY id
          LIMIT 1
        )`),
      ))
      .returning({ id: prizeCodes.id });

    if (!lockedCode) return { ok: false as const, status: 400, message: "奖品码库存不足" };

    const updatedWinner = await tx
      .update(lotteryWinners)
      .set({ prizeCodeId: lockedCode.id })
      .where(and(
        eq(lotteryWinners.id, winner.id),
        eq(lotteryWinners.tenantId, tenantId),
        eq(lotteryWinners.drawId, drawId),
        eq(lotteryWinners.prizeCodeId, ""),
      ))
      .returning({ id: lotteryWinners.id });
    if (updatedWinner.length === 0) throw new Error("中奖记录状态已变化，请刷新后重试");

    return { ok: true as const, prizeCodeId: lockedCode.id };
  });

  if (!result.ok) return fail(c, result.message, result.status);
  return ok(c, { prizeCodeId: result.prizeCodeId });
});

/**
 * 单条：重置为 pending 后同步投递（历史上只改状态、无 cron 扫通知 → 永久 pending）。
 * 实际发送走 sendWinnerNotifications（跳过已 sent，可顺带处理同活动其它 failed）。
 */
route.post("/draws/:id/winners/:winnerId/resend", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const [winner] = await db
    .select()
    .from(lotteryWinners)
    .where(and(
      eq(lotteryWinners.id, c.req.param("winnerId")),
      eq(lotteryWinners.tenantId, tenantId),
      eq(lotteryWinners.drawId, drawId),
    ))
    .limit(1);

  if (!winner) return fail(c, "中奖记录不存在", 404);

  await db
    .update(lotteryWinners)
    .set({ notificationStatus: "pending", notificationError: "", notificationRetryCount: 0 })
    .where(and(
      eq(lotteryWinners.id, winner.id),
      eq(lotteryWinners.tenantId, tenantId),
      eq(lotteryWinners.drawId, drawId),
    ));

  // 同步发送：无独立「pending 邮件」cron，只重置状态等于空操作
  const result = await sendWinnerNotifications(db, tenantId, drawId, {
    resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
    emailFrom: getEnv(c, "EMAIL_FROM") || "",
  });
  await recordTenantAudit(c, "draw.winner_resend", "lottery_winner", winner.id);
  return ok(c, { retry: true, sent: result.sent, failed: result.failed });
});

/**
 * 批量重发中奖通知（管理端「重发邮件」主路径）。
 * 前端契约：POST /api/admin/draws/:id/retry-email → { sent, failed }
 * 证据：docs/078 前此路由缺失，运营台按钮 404。
 */
route.post("/draws/:id/retry-email", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  // drawn 才有 winners；drawing 中途不发；其它状态无结果可通知
  if (draw.status !== DRAW_STATUS.DRAWN) {
    return fail(c, "仅已开奖活动可重发中奖通知", 400);
  }

  const result = await sendWinnerNotifications(db, tenantId, drawId, {
    resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
    emailFrom: getEnv(c, "EMAIL_FROM") || "",
  });
  await recordTenantAudit(c, "draw.retry_email", "lottery_draw", drawId);
  return ok(c, { sent: result.sent, failed: result.failed });
});

/**
 * drawing 卡死恢复（管理端「恢复」）。
 * 有中奖 → drawn（不二次开奖）；无中奖 → open。
 * staleMs=0：运营手动点恢复即 force，不要求等 5 分钟超时。
 * 证据：docs/078 前此路由缺失，前端 recoverLotteryDraw 404。
 */
route.post("/draws/:id/recover", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== DRAW_STATUS.DRAWING) {
    return fail(c, "仅 drawing 状态的活动可恢复", 400);
  }

  const healed = await healDrawingState(db, drawId, tenantId, { force: true });
  if (!healed) return fail(c, "无法恢复该活动状态", 400);
  await recordTenantAudit(c, "draw.recover", "lottery_draw", drawId);
  return ok(c, { healed });
});

/** 发布前校验 */
route.get("/draws/:id/publish-check", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const check = await buildPublishCheck(db, tenantId, drawId, {
    credentialsEncryptionKey: getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
  });
  if (!check) return fail(c, "活动不存在", 404);
  return ok(c, check);
});

/** 查询名单成员（roster 模式） */
route.get("/draws/:id/roster", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ id: lotteryDraws.id })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);

  // 读取现有名单成员，供编辑回显（identity_email/display_name 与 POST 导入一致）
  const members = await db
    .select({
      identityValue: lotteryRosterMembers.identityValue,
      displayName: lotteryRosterMembers.displayName,
      createdAt: lotteryRosterMembers.createdAt,
    })
    .from(lotteryRosterMembers)
    .where(and(
      eq(lotteryRosterMembers.tenantId, tenantId),
      eq(lotteryRosterMembers.drawId, drawId),
    ))
    .orderBy(lotteryRosterMembers.createdAt);

  return ok(c, { members, totalCount: members.length });
});
/** 导入名单成员（roster 模式） */
route.post("/draws/:id/roster", async (c) => {
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
  if (draw.status !== DRAW_STATUS.DRAFT) return fail(c, "仅草稿状态的活动可导入名单", 400);

  let imported = 0;
  let skipped = 0;
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
    } catch (err) {
      // 只把唯一索引冲突视为“重复名单”跳过；数据库锁、字段缺失等真实故障不能静默吞掉。
      if (!isUniqueConstraintError(err)) throw err;
      skipped++;
    }
  }

  return ok(c, { imported, skipped });
});

/** 查询邀请码（invite_code 模式） */
route.get("/draws/:id/invite-codes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select({ id: lotteryDraws.id })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);

  // 读取现有邀请码，供编辑回显数量（used_count/active 一并返回，运营可评估码池健康度）
  const codes = await db
    .select({
      code: lotteryInviteCodes.code,
      maxUses: lotteryInviteCodes.maxUses,
      usedCount: lotteryInviteCodes.usedCount,
      active: lotteryInviteCodes.active,
      createdAt: lotteryInviteCodes.createdAt,
    })
    .from(lotteryInviteCodes)
    .where(and(
      eq(lotteryInviteCodes.tenantId, tenantId),
      eq(lotteryInviteCodes.drawId, drawId),
    ))
    .orderBy(lotteryInviteCodes.createdAt);

  return ok(c, { codes, totalCount: codes.length });
});

/** 生成邀请码（invite_code 模式） */
route.post("/draws/:id/invite-codes", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");
  const body = await c.req.json<{ count?: number; maxUses?: number }>();

  const count = clampInteger(body.count, 10, 1, 1000);
  const maxUses = clampInteger(body.maxUses, 1, 1, 1000);

  const [draw] = await db
    .select({ id: lotteryDraws.id, status: lotteryDraws.status })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) return fail(c, "活动不存在", 404);
  if (draw.status !== DRAW_STATUS.DRAFT) return fail(c, "仅草稿状态的活动可生成邀请码", 400);

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
// 接龙模式：参与列表
// ═════════════════════════════════════════════════════════

/** 接龙参与列表（按参与时间排序） */
route.get("/draws/:id/signup-list", async (c) => {
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
      identityType: lotteryEntries.identityType,
      identityValue: lotteryEntries.identityValue,
      joinedAt: lotteryEntries.joinedAt,
    })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId)))
    .orderBy(lotteryEntries.joinedAt);

  // L2 可读性：registered（user_id 身份）解析为用户名(邮箱)
  await decorateIdentityDisplay(db, entries);

  return ok(c, { entries, total: entries.length });
});

/** 发放排行榜奖励（docs/218 模式三）—— 仅对 result_mode=instant 的活动手动调用 */
route.post("/draws/:id/leaderboard-rewards", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const drawId = c.req.param("id");

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return fail(c, "活动不存在", 404);

  // 仅 instant 模式需要手动发放；delayed/manual 在 performDraw 收尾自动发放，
  // 手动调用可能在开奖前提前发放（后续 join 不再计入排名），故直接拒绝。
  if (draw.resultMode !== "instant") {
    return fail(c, "非即时开奖模式的排行榜奖励由开奖流程自动发放，无需手动操作", 400);
  }

  const result = await grantLeaderboardRewards(db, draw);
  return ok(c, result);
});
}
