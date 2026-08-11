/**
 * 管理端 — 租户运维域（审计 / 黑名单 / 成员 / 用量统计）。
 *
 * 从 admin-lottery 拆出：与单场活动 CRUD/开奖弱相关，主文件只保留活动闭环。
 */
import type { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { getDb, ok, fail, isValidEmail } from "../lib/http";
import {
  auditLogs, lotteryBlacklist, lotteryDraws, lotteryEntries, lotteryWinners,
  tenantMembers, users,
} from "../db/schema";
import { eq, and, desc, sql, count, inArray } from "drizzle-orm";
import { DRAW_STATUS, getTenantUsage } from "../services/lottery-service";
import {
  parseAdminPagination,
  parseTenantMemberRole,
  recordTenantAudit,
  parseBatchDeleteIds,
} from "./admin-lottery-helpers";

export function setupTenantOpsRoutes(adminLotteryRoute: Hono<AppEnv>) {
// ═════════════════════════════════════════════════════════
// 审计日志
// ═════════════════════════════════════════════════════════

/** 审计日志列表（支持按操作类型筛选） */
adminLotteryRoute.get("/logs", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const action = c.req.query("action") || "";
  const { limit, offset } = parseAdminPagination(c);

  const conditions = [eq(auditLogs.tenantId, tenantId)];
  if (action) conditions.push(eq(auditLogs.action, action));

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(auditLogs)
    .where(and(...conditions));

  return ok(c, { logs: rows, total: Number(total) });
});

/**
 * 批量删除租户审计日志（docs/082 P2）。
 * - 仅本租户；ids 上限见 parseBatchDeleteIds
 * - 删除后写入一条汇总审计（不会被本次 ids 删掉，因新 id）
 * - 不支持「清空全部」；全量清理由平台 data/cleanup 承担
 */
adminLotteryRoute.post("/logs/batch-delete", async (c) => {
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

  const existing = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), inArray(auditLogs.id, parsed.ids)));

  const existingIds = existing.map((r) => r.id);
  const existingSet = new Set(existingIds);
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of parsed.ids) {
    if (!existingSet.has(id)) {
      failed.push({ id, reason: "日志不存在" });
    }
  }

  let deletedCount = 0;
  if (existingIds.length > 0) {
    const result = await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantId), inArray(auditLogs.id, existingIds)));
    deletedCount = Number(result.rowsAffected ?? existingIds.length);
  }

  await recordTenantAudit(c, "logs.batch_delete", "audit_log", "batch", {
    requested: parsed.ids.length,
    deleted: deletedCount,
    failed: failed.length,
    deletedIds: existingIds.slice(0, 50),
    failedSample: failed.slice(0, 20),
  });

  return ok(c, {
    deleted: deletedCount,
    failed: failed.length,
    deletedIds: existingIds,
    failedItems: failed,
  });
});

// ═════════════════════════════════════════════════════════
// 参与者黑名单
// ═════════════════════════════════════════════════════════

/** 黑名单列表 */
adminLotteryRoute.get("/blacklist", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c);

  const rows = await db
    .select()
    .from(lotteryBlacklist)
    .where(eq(lotteryBlacklist.tenantId, tenantId))
    .orderBy(desc(lotteryBlacklist.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryBlacklist)
    .where(eq(lotteryBlacklist.tenantId, tenantId));

  return ok(c, { items: rows, total: Number(total) });
});

/** 添加黑名单 */
adminLotteryRoute.post("/blacklist", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ identityValue: string; note?: string }>();
  const email = String(body.identityValue || "").trim().toLowerCase();

  if (!email || !isValidEmail(email)) {
    return fail(c, "请输入有效的邮箱地址", 400);
  }

  const blacklistId = crypto.randomUUID();
  await db.insert(lotteryBlacklist).values({
    id: blacklistId,
    tenantId,
    identityValue: email,
    note: String(body.note || "").trim(),
  });

  await recordTenantAudit(c, "blacklist.add", "blacklist", blacklistId, { identityValue: email });
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

  await recordTenantAudit(c, "blacklist.remove", "blacklist", id);
  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 租户成员管理
// ═════════════════════════════════════════════════════════

/** 成员列表 */
adminLotteryRoute.get("/members", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const { limit, offset } = parseAdminPagination(c, 50, 200);

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
    .orderBy(desc(tenantMembers.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(tenantMembers)
    .where(eq(tenantMembers.tenantId, tenantId));

  return ok(c, { members: rows, total: Number(total) });
});

/** 添加成员 */
adminLotteryRoute.post("/members", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const body = await c.req.json<{ username: string; role?: string }>();
  const username = String(body.username || "").trim();
  const role = parseTenantMemberRole(body.role);
  if (!role) return fail(c, "成员角色无效，仅支持 owner/admin/viewer", 400);

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
    role,
  });

  return ok(c, { added: true });
});

/** 修改成员角色（仅 owner；禁止自我降权，避免租户后台无人可管） */
adminLotteryRoute.patch("/members/:userId", async (c) => {
  const db = getDb(c);
  const tenantId = c.get("tenantId") as string;
  const targetUserId = c.req.param("userId");
  const body = await c.req.json<{ role: string }>();
  const role = parseTenantMemberRole(body.role, "");

  if (!role) return fail(c, "成员角色无效，仅支持 owner/admin/viewer", 400);
  // 角色变更是租户安全边界操作；禁止 owner 把自己改成 viewer/admin 后失去管理入口。
  if (targetUserId === c.get("userId")) return fail(c, "不能修改自己的角色", 400);

  const result = await db
    .update(tenantMembers)
    .set({ role })
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, targetUserId)));
  if ((result.rowsAffected ?? 0) === 0) return fail(c, "成员不存在", 404);
  return ok(c, { updated: true });
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
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.OPEN)));

  const [drawnCount] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.DRAWN)));

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [recentEntries] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), sql`${lotteryEntries.joinedAt} >= ${sevenDaysAgo}`));

  // 后台低频概览允许做租户级 COUNT：它消耗 Turso rows read 和等待时间，
  // 但不应被误判为 Worker CPU 热点。公开参与热路径仍禁止依赖该类累计统计。
  const [totalEntries] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.tenantId, tenantId));

  const [winnerCount] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.tenantId, tenantId));

  return ok(c, {
    totalDraws: Number(drawCount?.total ?? 0),
    openDraws: Number(openCount?.total ?? 0),
    drawnDraws: Number(drawnCount?.total ?? 0),
    totalParticipants: Number(totalEntries?.total ?? 0),
    recentParticipants: Number(recentEntries?.total ?? 0),
    totalWinners: Number(winnerCount?.total ?? 0),
    plan: tenantUsage.plan,
    limits: tenantUsage.limits,
    usage: { ...tenantUsage.usage, participants: Number(totalEntries?.total ?? 0) },
  });
});
}
