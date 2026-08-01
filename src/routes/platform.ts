/**
 * 平台运营后台路由（L3 平台运营者专用）
 *
 * 为平台运营者提供租户列表、审计日志、用量快照、失败投递等运营能力。
 * 所有路由需要 requireAuth + requirePlatformMember。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok } from "../lib/http";
import { requireAuth, requirePlatformMember } from "../middleware/auth";
import { tenants, auditLogs, webhookDeliveries, tenantUsageSnapshots, lotteryDraws } from "../db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";

export const platformRoute = new Hono<AppEnv>();

// 所有平台路由需要登录 + 平台成员权限
platformRoute.use("*", requireAuth, requirePlatformMember(["platform_owner", "platform_operator", "platform_support"]));

// ═════════════════════════════════════════════════════════
// 租户管理
// ═════════════════════════════════════════════════════════

/** 租户列表（分页） */
platformRoute.get("/tenants", async (c) => {
  const db = getDb(c);
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));
  const status = c.req.query("status") || "";
  const plan = c.req.query("plan") || "";

  const conditions: any[] = [];
  if (status) conditions.push(eq(tenants.status, status));
  if (plan) conditions.push(eq(tenants.plan, plan));

  const rows = await db
    .select()
    .from(tenants)
    .where(and(...conditions))
    .orderBy(desc(tenants.createdAt))
    .limit(limit).offset(offset);

  return ok(c, { tenants: rows });
});

/** 单租户摘要（含最新快照用量） */
platformRoute.get("/tenants/:id/summary", async (c) => {
  const db = getDb(c);
  const tenantId = c.req.param("id");

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);

  // 读取最新快照
  const [snapshot] = await db
    .select()
    .from(tenantUsageSnapshots)
    .where(eq(tenantUsageSnapshots.tenantId, tenantId))
    .orderBy(desc(tenantUsageSnapshots.snapshotDate))
    .limit(1);

  // 实时 COUNT 兜底（快照缺失时）
  const [drawCount] = snapshot ? [] : await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.tenantId, tenantId), sql`${lotteryDraws.status} <> 'cancelled'`));

  return ok(c, {
    tenant,
    usage: snapshot ? {
      activities: snapshot.activityCount,
      participants: snapshot.participantCount,
      events: snapshot.eventCount,
      winners: snapshot.winnerCount,
      snapshotDate: snapshot.snapshotDate,
    } : {
      activities: Number(drawCount?.total ?? 0),
      participants: null,
      events: null,
      winners: null,
      snapshotDate: null,
    },
  });
});

// ═════════════════════════════════════════════════════════
// 平台审计日志
// ═════════════════════════════════════════════════════════

/** 平台审计日志（分页，支持按租户/操作筛选） */
platformRoute.get("/audit-logs", async (c) => {
  const db = getDb(c);
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));
  const tenantId = c.req.query("tenantId") || "";
  const action = c.req.query("action") || "";

  const conditions: any[] = [];
  if (tenantId) conditions.push(eq(auditLogs.tenantId, tenantId));
  if (action) conditions.push(eq(auditLogs.action, action));

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit).offset(offset);

  return ok(c, { logs: rows });
});

// ═════════════════════════════════════════════════════════
// 用量快照
// ═════════════════════════════════════════════════════════

/** 读取租户用量快照（按日期范围） */
platformRoute.get("/usage-snapshots", async (c) => {
  const db = getDb(c);
  const tenantId = c.req.query("tenantId") || "";
  const limit = Math.min(Number(c.req.query("limit") || "31"), 365);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));

  const conditions: any[] = [];
  if (tenantId) conditions.push(eq(tenantUsageSnapshots.tenantId, tenantId));

  const rows = await db
    .select()
    .from(tenantUsageSnapshots)
    .where(and(...conditions))
    .orderBy(desc(tenantUsageSnapshots.snapshotDate))
    .limit(limit).offset(offset);

  return ok(c, { snapshots: rows });
});

// ═════════════════════════════════════════════════════════
// 失败投递查询
// ═════════════════════════════════════════════════════════

/** 失败投递列表（分页，支持按租户筛选） */
platformRoute.get("/webhook-deliveries", async (c) => {
  const db = getDb(c);
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));
  const tenantId = c.req.query("tenantId") || "";
  const status = c.req.query("status") || "";

  const conditions: any[] = [];
  if (tenantId) conditions.push(eq(webhookDeliveries.tenantId, tenantId));
  if (status) conditions.push(eq(webhookDeliveries.status, status));

  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit).offset(offset);

  return ok(c, { deliveries: rows });
});