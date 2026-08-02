/**
 * 平台运营后台路由（L3 平台运营者专用）
 *
 * 为平台运营者提供租户列表、审计日志、用量快照、失败投递等运营能力。
 * 所有路由需要 requireAuth + requirePlatformMember。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { fail, getDb, ok } from "../lib/http";
import { requireAuth, requirePlatformMember } from "../middleware/auth";
import { tenants, platformMembers, users, platformAuditLogs, webhookDeliveries, tenantUsageSnapshots, lotteryDraws } from "../db/schema";
import { eq, and, desc, count, sql, type SQL } from "drizzle-orm";
import { writePlatformAudit } from "../services/admin/platform-audit";
import { dispatchWebhookDelivery } from "../services/lottery-service";

export const platformRoute = new Hono<AppEnv>();

// 所有平台路由需要登录 + 平台成员权限
platformRoute.use("*", requireAuth, requirePlatformMember(["platform_owner", "platform_operator", "platform_support"]));

function combinedWhere(conditions: SQL[]): SQL | undefined {
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

const PLATFORM_ROLES = ["platform_owner", "platform_operator", "platform_support"];
const TENANT_PLANS = ["free", "pro", "team", "enterprise"];
const TENANT_STATUSES = ["active", "suspended", "disabled"];

function isSafeQuotaIncrement(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= 1_000_000;
}

// ═════════════════════════════════════════════════════════
// 平台成员管理（仅 platform_owner）
// ═════════════════════════════════════════════════════════

/** 平台成员列表 */
platformRoute.get("/members", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const rows = await db
    .select()
    .from(platformMembers)
    .orderBy(desc(platformMembers.createdAt));

  return ok(c, { members: rows });
});

/** 添加平台成员（按用户名或邮箱查找用户，加入平台成员表） */
platformRoute.post("/members", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const body = await c.req.json<{ username?: string; email?: string; role?: string }>();
  const role = String(body.role || "platform_operator");
  if (!PLATFORM_ROLES.includes(role)) return fail(c, "无效的平台角色", 400);

  // 按用户名或邮箱查找用户
  const conditions: SQL[] = [];
  if (body.username) conditions.push(eq(users.username, String(body.username).trim()));
  if (body.email) conditions.push(eq(users.email, String(body.email).trim().toLowerCase()));
  if (conditions.length === 0) return fail(c, "请提供用户名或邮箱", 400);

  const [user] = await db.select().from(users).where(and(...conditions)).limit(1);
  if (!user) return fail(c, "用户不存在，请确认用户名或邮箱", 404);

  // 检查是否已是平台成员
  const [existing] = await db
    .select({ userId: platformMembers.userId })
    .from(platformMembers)
    .where(eq(platformMembers.userId, user.id))
    .limit(1);
  if (existing) return fail(c, "该用户已是平台成员", 409);

  await withDbTransaction(db, async (tx) => {
    // 加入平台成员和审计必须同事务完成；平台权限变更不能出现“变了但无审计”的状态。
    await tx.insert(platformMembers).values({
      userId: user.id,
      role,
      status: "active",
    });

    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.member.create",
      targetType: "platform_member",
      targetId: user.id,
      metadata: { username: user.username, role },
    });
  });

  return ok(c, { userId: user.id, username: user.username, role });
});

/** 修改平台成员角色或状态 */
platformRoute.patch("/members/:userId", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const targetUserId = c.req.param("userId");
  if (!targetUserId) return fail(c, "缺少用户 ID", 400);
  const body = await c.req.json<{ role?: string; status?: string }>();

  // 不能修改自己的角色（防止 owner 自降级导致平台失控）
  if (targetUserId === actorUserId) return fail(c, "不能修改自己的平台角色", 400);

  if (body.role !== undefined && (typeof body.role !== "string" || !PLATFORM_ROLES.includes(body.role))) return fail(c, "无效的平台角色", 400);
  if (body.status !== undefined && (typeof body.status !== "string" || !["active", "disabled"].includes(body.status))) return fail(c, "无效的状态", 400);
  if (body.role === undefined && body.status === undefined) return fail(c, "请提供要更新的角色或状态", 400);

  const [existing] = await db
    .select()
    .from(platformMembers)
    .where(eq(platformMembers.userId, targetUserId))
    .limit(1);
  if (!existing) return fail(c, "平台成员不存在", 404);

  await withDbTransaction(db, async (tx) => {
    await tx.update(platformMembers)
      .set({
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(platformMembers.userId, targetUserId));

    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.member.update",
      targetType: "platform_member",
      targetId: targetUserId,
      metadata: { role: body.role, status: body.status },
    });
  });

  return ok(c, { updated: true });
});

/** 移除平台成员 */
platformRoute.delete("/members/:userId", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const targetUserId = c.req.param("userId");
  if (!targetUserId) return fail(c, "缺少用户 ID", 400);

  // 不能移除自己（防止平台无人管理）
  if (targetUserId === actorUserId) return fail(c, "不能移除自己", 400);

  const [existing] = await db
    .select({ userId: platformMembers.userId })
    .from(platformMembers)
    .where(eq(platformMembers.userId, targetUserId))
    .limit(1);
  if (!existing) return fail(c, "平台成员不存在", 404);

  await withDbTransaction(db, async (tx) => {
    await tx.delete(platformMembers).where(eq(platformMembers.userId, targetUserId));

    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.member.delete",
      targetType: "platform_member",
      targetId: targetUserId,
    });
  });

  return ok(c, { deleted: true });
});

// ═════════════════════════════════════════════════════════
// 租户管理
// ═════════════════════════════════════════════════════════

/** 租户列表（分页） */
platformRoute.get("/tenants", async (c) => {
  const db = getDb(c);
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const status = c.req.query("status") || "";
  const plan = c.req.query("plan") || "";

  const conditions: SQL[] = [];
  if (status) conditions.push(eq(tenants.status, status));
  if (plan) conditions.push(eq(tenants.plan, plan));

  const rows = await db
    .select()
    .from(tenants)
    .where(combinedWhere(conditions))
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

/** 调整租户套餐/状态/额外额度（平台运营者用于人工售卖、补偿、暂停租户）
 *
 * 可调整字段：
 * - plan: 套餐（free/pro/team/enterprise）
 * - status: 状态（active/suspended/disabled）
 * - extraActivityQuota: 额外活动次数（追加）
 * - extraParticipantQuota: 额外参与人数（追加）
 * - extraQuotaExpiresAt: 额外额度到期时间
 */
platformRoute.patch("/tenants/:id", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const tenantId = c.req.param("id");
  if (!tenantId) return fail(c, "缺少租户 ID", 400);
  const body = await c.req.json<{
    plan?: string;
    status?: string;
    extraActivityQuota?: number;
    extraParticipantQuota?: number;
    extraQuotaExpiresAt?: string | null;
  }>();

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);

  if (body.plan !== undefined && (typeof body.plan !== "string" || !TENANT_PLANS.includes(body.plan))) return fail(c, "无效的套餐", 400);
  if (body.status !== undefined && (typeof body.status !== "string" || !TENANT_STATUSES.includes(body.status))) return fail(c, "无效的状态", 400);
  if (!isSafeQuotaIncrement(body.extraActivityQuota)) return fail(c, "额外活动次数必须是 1 到 1000000 的整数", 400);
  if (!isSafeQuotaIncrement(body.extraParticipantQuota)) return fail(c, "额外参与人数必须是 1 到 1000000 的整数", 400);
  if (body.extraQuotaExpiresAt !== undefined
    && body.extraQuotaExpiresAt !== null
    && (typeof body.extraQuotaExpiresAt !== "string" || !body.extraQuotaExpiresAt.trim() || Number.isNaN(new Date(body.extraQuotaExpiresAt).getTime()))) {
    return fail(c, "额外额度到期时间格式无效", 400);
  }

  const hasMeaningfulUpdate = body.plan !== undefined
    || body.status !== undefined
    || body.extraActivityQuota !== undefined
    || body.extraParticipantQuota !== undefined
    || body.extraQuotaExpiresAt !== undefined;
  if (!hasMeaningfulUpdate) return fail(c, "请提供要调整的套餐、状态或额度", 400);

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.plan !== undefined) updates.plan = body.plan;
  if (body.status !== undefined) updates.status = body.status;
  // 额外额度：只允许追加，不支持隐式扣减。
  // 扣减/回收属于高风险运营动作，未来如确实需要应设计独立接口和二次确认。
  if (typeof body.extraActivityQuota === "number") updates.extraActivityQuota = sql`${tenants.extraActivityQuota} + ${body.extraActivityQuota}`;
  if (typeof body.extraParticipantQuota === "number") updates.extraParticipantQuota = sql`${tenants.extraParticipantQuota} + ${body.extraParticipantQuota}`;
  if (body.extraQuotaExpiresAt !== undefined) updates.extraQuotaExpiresAt = body.extraQuotaExpiresAt;

  await withDbTransaction(db, async (tx) => {
    await tx.update(tenants).set(updates).where(eq(tenants.id, tenantId));
    // 平台审计：调整租户套餐是敏感操作，必须和业务更新同事务写入。
    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.tenant.update",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      metadata: { plan: body.plan, status: body.status, extraActivityQuota: body.extraActivityQuota, extraParticipantQuota: body.extraParticipantQuota },
    });
  });

  return ok(c, { updated: true });
});

// ═════════════════════════════════════════════════════════
// 平台审计日志
// ═════════════════════════════════════════════════════════

/** 平台审计日志（分页，支持按租户/操作筛选） */
platformRoute.get("/audit-logs", async (c) => {
  const db = getDb(c);
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const tenantId = c.req.query("tenantId") || "";
  const action = c.req.query("action") || "";
  const actorUserId = c.req.query("actorUserId") || "";

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(platformAuditLogs.tenantId, tenantId));
  if (action) conditions.push(eq(platformAuditLogs.action, action));
  if (actorUserId) conditions.push(eq(platformAuditLogs.actorUserId, actorUserId));

  const rows = await db
    .select()
    .from(platformAuditLogs)
    .where(combinedWhere(conditions))
    .orderBy(desc(platformAuditLogs.createdAt))
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
  const limit = clampInteger(c.req.query("limit"), 31, 1, 365);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(tenantUsageSnapshots.tenantId, tenantId));

  const rows = await db
    .select()
    .from(tenantUsageSnapshots)
    .where(combinedWhere(conditions))
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
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const tenantId = c.req.query("tenantId") || "";
  const status = c.req.query("status") || "";

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(webhookDeliveries.tenantId, tenantId));
  if (status) conditions.push(eq(webhookDeliveries.status, status));

  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(combinedWhere(conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit).offset(offset);

  return ok(c, { deliveries: rows });
});

/** 平台手动重试 Webhook 投递。
 *
 * 这是平台运营排障能力，不属于租户后台：
 * - platform_support 只能看，不能触发外部请求。
 * - 重试会真实访问租户配置的 Webhook URL，因此必须写平台审计。
 */
platformRoute.post("/webhook-deliveries/:id/retry", requirePlatformMember(["platform_owner", "platform_operator"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const deliveryId = c.req.param("id");
  if (!deliveryId) return fail(c, "缺少 Webhook 投递记录 ID", 400);

  const [delivery] = await db
    .select({
      id: webhookDeliveries.id,
      tenantId: webhookDeliveries.tenantId,
      status: webhookDeliveries.status,
      eventType: webhookDeliveries.eventType,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  if (!delivery) return fail(c, "Webhook 投递记录不存在", 404);

  const result = await dispatchWebhookDelivery(db, delivery.tenantId, delivery.id);
  await writePlatformAudit(db, {
    actorUserId,
    actorRole,
    action: "platform.webhook_delivery.retry",
    targetType: "webhook_delivery",
    targetId: delivery.id,
    tenantId: delivery.tenantId,
    metadata: { previousStatus: delivery.status, eventType: delivery.eventType, result },
  });

  return ok(c, result);
});

/** 数据统计：各表行数概览（供 L3 数据清理页使用） */
platformRoute.get("/data/stats", async (c) => {
  const db = getDb(c);
  // 表名白名单（代码常量，非用户输入）：sql.raw 仅拼接白名单内的表名，无注入风险
  const tables = [
    "users", "tenants", "tenant_members", "platform_members",
    "lottery_draws", "lottery_entries", "lottery_winners", "lottery_prize_tiers",
    "prizes", "prize_codes", "lottery_roster_members", "lottery_invite_codes",
    "lottery_blacklist", "email_access_codes",
    "audit_logs", "platform_audit_logs", "activity_events", "activity_outcomes",
    "activity_submissions", "share_records", "external_conversions",
    "api_keys", "webhook_configs", "webhook_deliveries", "coupon_codes",
    "redemption_codes", "redemption_records", "rate_limit_log", "system_config",
  ];
  const stats: Record<string, number> = {};
  for (const table of tables) {
    try {
      const [row] = await db.$client.execute<{ count: number }>(sql`SELECT COUNT(*) AS count FROM ${sql.raw(table)}`);
      stats[table] = Number(row?.count || 0);
    } catch { stats[table] = -1; }
  }
  return ok(c, { stats });
});

/** 数据清理：删除指定类型的数据（仅平台 owner，用于重置测试环境）
 *
 * 为什么仅 owner：删除数据是破坏性操作，support/operator 应只有只读权限。
 * 表名白名单校验（代码常量，非用户输入），防止注入。
 */
platformRoute.post("/data/cleanup", requirePlatformMember(["platform_owner"]), async (c) => {
  const body = await c.req.json<{ targets: string[] }>();
  const allowed = new Set(["email_access_codes", "rate_limit_log", "audit_logs", "platform_audit_logs", "activity_events", "webhook_deliveries"]);
  const targets = (body.targets || []).filter(t => allowed.has(t));
  if (targets.length === 0) return fail(c, "未指定有效清理目标", 400);

  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const results: Record<string, number> = {};
  for (const table of targets) {
    try {
      const result = await db.$client.execute(sql`DELETE FROM ${sql.raw(table)}`);
      results[table] = result.rowsAffected ?? 0;
    } catch { results[table] = -1; }
  }

  // 数据清理是敏感破坏性操作，必须留审计痕迹
  await db.insert(platformAuditLogs).values({
    id: crypto.randomUUID(),
    actorUserId,
    action: "platform.data.cleanup",
    targetType: "data",
    targetId: targets.join(","),
    metadataJson: JSON.stringify({ targets, results }),
  });

  return ok(c, { results });
});
