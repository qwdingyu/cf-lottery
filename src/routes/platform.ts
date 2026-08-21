/**
 * 平台运营后台路由（L3 平台运营者专用）
 *
 * 为平台运营者提供租户列表、审计日志、用量快照、失败投递等运营能力。
 * 所有路由需要 requireAuth + requirePlatformMember。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { withDbTransaction } from "../db/client";
import { clampInteger, fail, getDb, ok } from "../lib/http";
import { getEnv } from "../lib/platform";
import { requireAuth, requirePlatformMember, signJwt } from "../middleware/auth";
import { tenants, platformMembers, users, adminAuditLogs, webhookDeliveries, emailDeliveries, tenantUsageSnapshots, lotteryDraws, tenantMembers, lotteryEntries, lotteryWinners, lotteryPrizeTiers, prizes, prizeCodes, lotteryRosterMembers, lotteryInviteCodes, lotteryBlacklist, emailAccessCodes, auditLogs, activityEvents, activityOutcomes, activitySubmissions, shareRecords, externalConversions, apiKeys, webhookConfigs, couponCodes, redemptionCodes, redemptionRecords, rateLimitLog, systemConfig, tenantCommunityOverrides, communityMembers, platformTargets, platformDeliveries } from "../db/schema";
import { eq, and, desc, count, sql, type SQL } from "drizzle-orm";
import { writePlatformAudit } from "../services/admin/platform-audit";
import { readLatestTenantUsageSnapshotTotals } from "../services/admin/usage-snapshots";
import { dispatchWebhookDelivery, DRAW_STATUS } from "../services/lottery-service";
import { dispatchEmailDeliveries } from "../services/email-delivery";
import { dispatchPlatformDelivery } from "../services/platform/delivery";
import { L2_MENU_CATALOG, isL2MenuKey, DISABLED_L2_MENUS_KEY, readDisabledL2Menus } from "../lib/l2-menu-keys";

export const platformRoute = new Hono<AppEnv>();

// 所有平台路由需要登录 + 平台成员权限
platformRoute.use("*", requireAuth, requirePlatformMember(["platform_owner", "platform_operator", "platform_support"]));

function combinedWhere(conditions: SQL[]): SQL | undefined {
  return conditions.length > 0 ? and(...conditions) : undefined;
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

/** 平台成员列表（分页 + 搜索，与 tenants 风格一致） */
platformRoute.get("/members", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const search = c.req.query("search") || "";

  const conditions: SQL[] = [];
  if (search) {
    conditions.push(sql`(${platformMembers.userId} LIKE ${`%${search.replace(/[%_]/g, "\\$&")}%`} OR ${platformMembers.role} LIKE ${`%${search.replace(/[%_]/g, "\\$&")}%`})`);
  }

  const hasFilter = conditions.length > 0;
  const [{ total }] = hasFilter
    ? await db.select({ total: count() }).from(platformMembers).where(and(...conditions))
    : await db.select({ total: count() }).from(platformMembers);
  const rows = hasFilter
    ? await db.select().from(platformMembers).where(and(...conditions)).orderBy(desc(platformMembers.createdAt)).limit(limit).offset(offset)
    : await db.select().from(platformMembers).orderBy(desc(platformMembers.createdAt)).limit(limit).offset(offset);

  return ok(c, { members: rows, total });
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

/** 租户列表（分页 + 搜索） */
platformRoute.get("/tenants", async (c) => {
  const db = getDb(c);
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const status = c.req.query("status") || "";
  const plan = c.req.query("plan") || "";
  const search = c.req.query("search") || "";

  const conditions: SQL[] = [];
  if (status) conditions.push(eq(tenants.status, status));
  if (plan) conditions.push(eq(tenants.plan, plan));
  if (search) conditions.push(sql`(${tenants.name} LIKE ${`%${search.replace(/[%_]/g, "\\$&")}%`} OR ${tenants.id} LIKE ${`%${search.replace(/[%_]/g, "\\$&")}%`})`);

  const [{ total }] = await db.select({ total: count() }).from(tenants).where(combinedWhere(conditions));
  const rows = await db
    .select()
    .from(tenants)
    .where(combinedWhere(conditions))
    .orderBy(desc(tenants.createdAt))
    .limit(limit).offset(offset);

  return ok(c, { tenants: rows, total });
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
    .where(and(eq(lotteryDraws.tenantId, tenantId), sql`${lotteryDraws.status} <> ${DRAW_STATUS.CANCELLED}`));

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
// 租户登录模拟（平台运营者以租户身份登录，排查问题）
// ═════════════════════════════════════════════════════════

platformRoute.post("/tenants/:id/impersonate", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const tenantId = c.req.param("id");
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  if (!tenantId) return fail(c, "缺少租户 ID", 400);

  const [member] = await db
    .select({ userId: tenantMembers.userId, tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, "owner")))
    .limit(1);

  if (!member) return fail(c, "该租户没有 owner 成员，无法模拟登录", 404);

  const jwtSecret = getEnv(c, "JWT_SECRET");
  if (!jwtSecret) return fail(c, "服务未配置 JWT 密钥", 500);
  // email claim：模拟登录进活动页时 open 系亦可 Bearer 免 OTP（docs/093）
  const [impUser] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, member.userId))
    .limit(1);
  const token = await signJwt(
    {
      sub: member.userId,
      tenantId: member.tenantId,
      email: impUser?.email || "",
      impersonated: true,
    },
    jwtSecret,
    3600,
  );

  // 平台审计：模拟登录属于高风险操作，必须留痕
  await writePlatformAudit(db, {
    actorUserId,
    actorRole,
    action: "platform.tenant.impersonate",
    targetType: "tenant",
    targetId: tenantId,
    tenantId,
    metadata: { impersonatedUserId: member.userId },
  });

  return ok(c, { token, tenantId: member.tenantId, userId: member.userId });
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
// 社群功能覆写管理（docs/180 §3.4）
// ═════════════════════════════════════════════════════════

/**
 * PATCH /api/platform/tenants/:id/community — 覆写租户社群功能策略
 *
 * 平台运营者（platform_owner）可调整：communityEnabled、maxPlatformTargets、maxGroupMembers。
 * 防灾难红线：拒绝设 maxGroupMembers 低于任一群当前成员数。
 */
platformRoute.patch("/tenants/:id/community", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const tenantId = c.req.param("id");
  if (!tenantId) return fail(c, "缺少租户 ID", 400);

  // 校验租户存在
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return fail(c, "租户不存在", 404);

  const body = await c.req.json<{
    communityEnabled?: boolean;
    maxPlatformTargets?: number | null;
    maxGroupMembers?: number | null;
    note?: string;
  }>();

  const hasMeaningfulUpdate = body.communityEnabled !== undefined
    || body.maxPlatformTargets !== undefined
    || body.maxGroupMembers !== undefined
    || body.note !== undefined;
  if (!hasMeaningfulUpdate) return fail(c, "请提供至少一个可覆写的字段", 400);

  // ── 防灾难校验：拒绝设 maxGroupMembers 低于任一群当前成员数 ──
  if (body.maxGroupMembers !== undefined && body.maxGroupMembers !== null) {
    const targets = await db
      .select({ id: platformTargets.id })
      .from(platformTargets)
      .where(eq(platformTargets.tenantId, tenantId));
    for (const target of targets) {
      const [{ total: memberCount }] = await db
        .select({ total: count() })
        .from(communityMembers)
        .where(eq(communityMembers.platformTargetId, target.id));
      if (Number(memberCount || 0) > body.maxGroupMembers) {
        return fail(
          c,
          `目标群 ${target.id} 当前已有 ${memberCount} 名成员，不能设低于 ${memberCount} 的群人数上限`,
          400,
        );
      }
    }
  }

  // 清理 null 语义：写入 DB 时，null 表示不限，0 或负数视为无效
  // maxPlatformTargets/maxGroupMembers 只接受 null 或 >= 1 的整数
  if (body.maxPlatformTargets !== undefined && body.maxPlatformTargets !== null) {
    if (!Number.isInteger(body.maxPlatformTargets) || body.maxPlatformTargets < 1) {
      return fail(c, "maxPlatformTargets 必须为 null 或 ≥1 的整数", 400);
    }
  }
  if (body.maxGroupMembers !== undefined && body.maxGroupMembers !== null) {
    if (!Number.isInteger(body.maxGroupMembers) || body.maxGroupMembers < 1) {
      return fail(c, "maxGroupMembers 必须为 null 或 ≥1 的整数", 400);
    }
  }

  const now = new Date().toISOString();
  await withDbTransaction(db, async (tx) => {
    // UPSERT：存在则更新，不存在则插入
    const [existing] = await tx
      .select({ tenantId: tenantCommunityOverrides.tenantId })
      .from(tenantCommunityOverrides)
      .where(eq(tenantCommunityOverrides.tenantId, tenantId))
      .limit(1);

    if (existing) {
      const updates: Record<string, unknown> = { updatedAt: now, updatedBy: actorUserId };
      if (body.communityEnabled !== undefined) updates.communityEnabled = body.communityEnabled ? 1 : 0;
      if (body.maxPlatformTargets !== undefined) updates.maxPlatformTargets = body.maxPlatformTargets;
      if (body.maxGroupMembers !== undefined) updates.maxGroupMembers = body.maxGroupMembers;
      if (body.note !== undefined) updates.note = body.note;
      await tx.update(tenantCommunityOverrides).set(updates).where(eq(tenantCommunityOverrides.tenantId, tenantId));
    } else {
      await tx.insert(tenantCommunityOverrides).values({
        tenantId,
        communityEnabled: body.communityEnabled !== undefined ? (body.communityEnabled ? 1 : 0) : 1,
        maxPlatformTargets: body.maxPlatformTargets ?? null,
        maxGroupMembers: body.maxGroupMembers ?? null,
        note: body.note || "",
        updatedBy: actorUserId,
        updatedAt: now,
      });
    }

    // 平台审计
    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.tenant.community.override",
      targetType: "tenant_community_overrides",
      targetId: tenantId,
      tenantId,
      metadata: {
        communityEnabled: body.communityEnabled,
        maxPlatformTargets: body.maxPlatformTargets,
        maxGroupMembers: body.maxGroupMembers,
        note: body.note,
      },
    });
  });

  return ok(c, { updated: true });
});

/**
 * DELETE /api/platform/tenants/:id/community — 删除租户社群功能覆写（恢复套餐默认）
 */
platformRoute.delete("/tenants/:id/community", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const tenantId = c.req.param("id");
  if (!tenantId) return fail(c, "缺少租户 ID", 400);

  const [existing] = await db
    .select({ tenantId: tenantCommunityOverrides.tenantId })
    .from(tenantCommunityOverrides)
    .where(eq(tenantCommunityOverrides.tenantId, tenantId))
    .limit(1);
  if (!existing) return fail(c, "该租户没有社群功能覆写记录", 404);

  await withDbTransaction(db, async (tx) => {
    await tx.delete(tenantCommunityOverrides).where(eq(tenantCommunityOverrides.tenantId, tenantId));

    // 平台审计
    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.tenant.community.override.delete",
      targetType: "tenant_community_overrides",
      targetId: tenantId,
      tenantId,
      metadata: { deleted: true },
    });
  });

  return ok(c, { deleted: true });
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
  if (tenantId) conditions.push(eq(adminAuditLogs.tenantId, tenantId));
  if (action) conditions.push(eq(adminAuditLogs.action, action));
  if (actorUserId) conditions.push(eq(adminAuditLogs.actorUserId, actorUserId));

  // 平台 support 角色只读权限：必须指定租户(tenantId)，不传时返回空而非全部（docs/129 §五）
  if (c.get("platformRole") === "platform_support" && !tenantId) {
    return ok(c, { logs: [] });
  }

  const rows = await db
    .select()
    .from(adminAuditLogs)
    .where(combinedWhere(conditions))
    .orderBy(desc(adminAuditLogs.createdAt))
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

  // 平台 support 角色只读权限：必须指定租户(tenantId)，不传时返回空而非全部（docs/129 §五）
  if (c.get("platformRole") === "platform_support" && !tenantId) {
    return ok(c, { snapshots: [] });
  }

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

  // 平台 support 角色只读权限：必须指定租户(tenantId)，不传时返回空而非全部（docs/129 §五）
  if (c.get("platformRole") === "platform_support" && !tenantId) {
    return ok(c, { deliveries: [] });
  }

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

/** 邮件投递列表（分页，支持按租户、状态、模板筛选）。
 *
 * support 角色必须指定 tenantId，避免只读支持人员默认看到全站邮箱地址。
 */
platformRoute.get("/email-deliveries", async (c) => {
  const db = getDb(c);
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const tenantId = c.req.query("tenantId") || "";
  const status = c.req.query("status") || "";
  const template = c.req.query("template") || "";

  if (c.get("platformRole") === "platform_support" && !tenantId) {
    return ok(c, { deliveries: [] });
  }

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(emailDeliveries.tenantId, tenantId));
  if (status) conditions.push(eq(emailDeliveries.status, status));
  if (template) conditions.push(eq(emailDeliveries.template, template));

  const rows = await db
    .select({
      id: emailDeliveries.id,
      tenantId: emailDeliveries.tenantId,
      drawId: emailDeliveries.drawId,
      sourceType: emailDeliveries.sourceType,
      sourceId: emailDeliveries.sourceId,
      recipientEmail: emailDeliveries.recipientEmail,
      template: emailDeliveries.template,
      status: emailDeliveries.status,
      attemptCount: emailDeliveries.attemptCount,
      nextRetryAt: emailDeliveries.nextRetryAt,
      providerMessageId: emailDeliveries.providerMessageId,
      lastError: emailDeliveries.lastError,
      createdAt: emailDeliveries.createdAt,
      updatedAt: emailDeliveries.updatedAt,
      sentAt: emailDeliveries.sentAt,
    })
    .from(emailDeliveries)
    .where(combinedWhere(conditions))
    .orderBy(desc(emailDeliveries.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { deliveries: rows });
});

/** 平台手动重试邮件投递。
 *
 * 重试会真实调用邮件网关，权限与 Webhook 重试一致：support 只读，operator/owner 可执行。
 * 对 failed 记录先恢复为 pending，再交给统一发送器；sent 记录不重复发送。
 */
platformRoute.post("/email-deliveries/:id/retry", requirePlatformMember(["platform_owner", "platform_operator"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const deliveryId = c.req.param("id");
  if (!deliveryId) return fail(c, "缺少邮件投递记录 ID", 400);

  const [delivery] = await db
    .select({
      id: emailDeliveries.id,
      tenantId: emailDeliveries.tenantId,
      status: emailDeliveries.status,
      template: emailDeliveries.template,
      sourceType: emailDeliveries.sourceType,
    })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.id, deliveryId))
    .limit(1);
  if (!delivery) return fail(c, "邮件投递记录不存在", 404);
  if (delivery.status === "sent") return fail(c, "已发送邮件不能重复重试", 400);

  await db
    .update(emailDeliveries)
    .set({ status: "pending", nextRetryAt: null, lastError: "", updatedAt: new Date().toISOString() })
    .where(eq(emailDeliveries.id, delivery.id));

  const result = await dispatchEmailDeliveries(db, {
    resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
    emailFrom: getEnv(c, "EMAIL_FROM") || "",
    cfAuthIssuer: getEnv(c, "CF_AUTH_ISSUER") || "",
    cfAuthClientId: getEnv(c, "CF_AUTH_CLIENT_ID") || "",
    cfAuthClientSecret: getEnv(c, "CF_AUTH_CLIENT_SECRET") || "",
  }, {
    deliveryIds: [delivery.id],
    limit: 1,
  });

  await writePlatformAudit(db, {
    actorUserId,
    actorRole,
    action: "platform.email_delivery.retry",
    targetType: "email_delivery",
    targetId: delivery.id,
    tenantId: delivery.tenantId,
    metadata: { previousStatus: delivery.status, template: delivery.template, sourceType: delivery.sourceType, result },
  });

  return ok(c, result);
});

// ═════════════════════════════════════════════════════════
// 平台消息投递（platform_deliveries）管理
// ═════════════════════════════════════════════════════════

/**
 * GET /api/platform/platform-deliveries — 平台消息投递列表（分页 + 过滤）。
 *
 * 覆盖 QQ/Telegram 私聊与群事件消息（webhook_deliveries 只管 HTTP webhook）。
 * 过滤维度：tenantId / status / platform。与其它投递列表一致：
 * support 角色只读且必须指定 tenantId，不传时返回空而非全站数据。
 */
platformRoute.get("/platform-deliveries", async (c) => {
  const db = getDb(c);
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200);
  const offset = clampInteger(c.req.query("offset"), 0, 0, 100_000);
  const tenantId = c.req.query("tenantId") || "";
  const status = c.req.query("status") || "";
  const platform = c.req.query("platform") || "";

  // 平台 support 角色只读权限：必须指定租户(tenantId)，不传时返回空而非全部（docs/129 §五）
  if (c.get("platformRole") === "platform_support" && !tenantId) {
    return ok(c, { deliveries: [] });
  }

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(platformDeliveries.tenantId, tenantId));
  if (status) conditions.push(eq(platformDeliveries.status, status));
  if (platform) conditions.push(eq(platformDeliveries.platform, platform));

  const rows = await db
    .select({
      id: platformDeliveries.id,
      tenantId: platformDeliveries.tenantId,
      platformTargetId: platformDeliveries.platformTargetId,
      platform: platformDeliveries.platform,
      targetId: platformDeliveries.targetId,
      eventId: platformDeliveries.eventId,
      eventType: platformDeliveries.eventType,
      command: platformDeliveries.command,
      status: platformDeliveries.status,
      attemptCount: platformDeliveries.attemptCount,
      providerMessageId: platformDeliveries.providerMessageId,
      lastError: platformDeliveries.lastError,
      nextRetryAt: platformDeliveries.nextRetryAt,
      createdAt: platformDeliveries.createdAt,
      updatedAt: platformDeliveries.updatedAt,
      sentAt: platformDeliveries.sentAt,
    })
    .from(platformDeliveries)
    .where(combinedWhere(conditions))
    .orderBy(desc(platformDeliveries.createdAt))
    .limit(limit)
    .offset(offset);

  return ok(c, { deliveries: rows });
});

/**
 * POST /api/platform/platform-deliveries/:id/retry — 平台手动重试消息投递。
 *
 * 与 webhook/email 重试同权限：support 只读，owner/operator 可执行。
 * 流程：
 * 1. 非 sent 记录恢复为 pending + nextRetryAt=null + lastError=''（清空退避状态）；
 * 2. 调用 dispatchPlatformDelivery 单条投递（适配器真实发送，失败按退避策略重写状态）；
 * 3. 重试会真实触发出站请求，必须写平台审计。
 */
platformRoute.post("/platform-deliveries/:id/retry", requirePlatformMember(["platform_owner", "platform_operator"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const deliveryId = c.req.param("id");
  if (!deliveryId) return fail(c, "缺少投递记录 ID", 400);

  const [delivery] = await db
    .select({
      id: platformDeliveries.id,
      tenantId: platformDeliveries.tenantId,
      status: platformDeliveries.status,
      platform: platformDeliveries.platform,
      eventType: platformDeliveries.eventType,
    })
    .from(platformDeliveries)
    .where(eq(platformDeliveries.id, deliveryId))
    .limit(1);
  if (!delivery) return fail(c, "投递记录不存在", 404);
  if (delivery.status === "sent") return fail(c, "已发送的投递不能重复重试", 400);

  // 恢复为 pending 并清空退避/错误信息，交给统一投递器重新发送
  await db
    .update(platformDeliveries)
    .set({ status: "pending", nextRetryAt: null, lastError: "", updatedAt: new Date().toISOString() })
    .where(eq(platformDeliveries.id, delivery.id));

  const result = await dispatchPlatformDelivery(db, delivery.id, fetch, {
    credentialsEncryptionKey: getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
  });

  await writePlatformAudit(db, {
    actorUserId,
    actorRole,
    action: "platform.platform_delivery.retry",
    targetType: "platform_delivery",
    targetId: delivery.id,
    tenantId: delivery.tenantId,
    metadata: {
      previousStatus: delivery.status,
      platform: delivery.platform,
      eventType: delivery.eventType,
      result,
    },
  });

  return ok(c, result);
});

// 平台数据统计/清理用表映射：表名（代码常量，白名单语义）→ drizzle schema 表对象。
// 使用 ORM 代替手写 SQL（AGENTS.md 铁律），彻底消除拼接面；表对象来自 schema 定义，
// 与数据库迁移保持单一事实源。
const TABLE_MAP = {
  users, tenants, tenantMembers, platformMembers,
  lotteryDraws, lotteryEntries, lotteryWinners, lotteryPrizeTiers,
  prizes, prizeCodes, lotteryRosterMembers, lotteryInviteCodes,
  lotteryBlacklist, emailAccessCodes, auditLogs, adminAuditLogs,
  activityEvents, activityOutcomes, activitySubmissions, shareRecords,
  externalConversions, apiKeys, webhookConfigs, webhookDeliveries,
  couponCodes, redemptionCodes, redemptionRecords, rateLimitLog, systemConfig,
} as const;

/** 数据统计：各表行数概览（供 L3 数据清理页使用） */
platformRoute.get("/data/stats", async (c) => {
  const db = getDb(c);
  const stats: Record<string, number> = {};
  const snapshotTotals = await readLatestTenantUsageSnapshotTotals(db);
  // 只有当最新快照覆盖了全部活跃租户时，才允许用快照值替代热表精确统计。
  // 只看“有无快照”不够：半套快照会悄悄少算，清理页会把风险数据看小。
  const [activeTenantRow] = await db
    .select({ total: count() })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  const activeTenantCount = Number(activeTenantRow?.total ?? 0);
  const useSnapshotTotals = snapshotTotals.tenantCount > 0 && snapshotTotals.tenantCount === activeTenantCount;

  const exactCount = async (schemaTable: any) => {
    const [row] = await db.select({ total: count() }).from(schemaTable);
    return Number(row?.total ?? 0);
  };

  if (useSnapshotTotals) {
    stats.lotteryDraws = snapshotTotals.activityCount;
    stats.lotteryEntries = snapshotTotals.participantCount;
    stats.lotteryWinners = snapshotTotals.winnerCount;
    stats.activityEvents = snapshotTotals.eventCount;
    stats.webhookDeliveries = snapshotTotals.webhookCount;
  } else {
    stats.lotteryDraws = await exactCount(lotteryDraws);
    stats.lotteryEntries = await exactCount(lotteryEntries);
    stats.lotteryWinners = await exactCount(lotteryWinners);
    stats.activityEvents = await exactCount(activityEvents);
    stats.webhookDeliveries = await exactCount(webhookDeliveries);
  }

  for (const [tableName, schemaTable] of Object.entries(TABLE_MAP)) {
    if (
      tableName === "lotteryDraws"
      || tableName === "lotteryEntries"
      || tableName === "lotteryWinners"
      || tableName === "activityEvents"
      || tableName === "webhookDeliveries"
    ) {
      continue;
    }
    try {
      // ORM 计数：drizzle 编译为 SELECT COUNT(*) FROM <表>，表对象来自上方白名单
      const [row] = await db.select({ total: count() }).from(schemaTable);
      stats[tableName] = Number(row?.total ?? 0);
    } catch { stats[tableName] = -1; }
  }
  return ok(c, {
    stats,
    snapshotDate: snapshotTotals.latestSnapshotDate,
    snapshotTenantCount: snapshotTotals.tenantCount,
    snapshotized: useSnapshotTotals,
  });
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
    // 表名来自 allowed 白名单（代码常量），映射到 drizzle 表对象后 ORM 删除（无拼接面）
    const schemaTable = TABLE_MAP[table as keyof typeof TABLE_MAP];
    if (!schemaTable) continue;
    try {
      const result = await db.delete(schemaTable);
      results[table] = result.rowsAffected ?? 0;
    } catch { results[table] = -1; }
  }

  // 数据清理是敏感破坏性操作，必须留审计痕迹（统一到 cf-core admin_audit_logs，docs/091 P1-13）
  await writePlatformAudit(db, {
    actorUserId,
    actorRole: "platform_operator",
    action: "platform.data.cleanup",
    targetType: "data",
    targetId: targets.join(","),
    metadata: { targets, results },
  });

  return ok(c, { results });
});

// ═════════════════════════════════════════════════════════
// L2 菜单权限控制（L3 平台运营者 → 全局生效，docs/255）
// ═════════════════════════════════════════════════════════
// 存储：system_config.disabled_l2_menus（JSON 数组，默认 [] = 全部启用）。
// 对所有 L2 租户统一生效（不做按租户区分，保持简单）。
// 菜单 key 白名单来自 lib/l2-menu-keys.ts 代码常量（docs/026 §5.4：不做数据库权限矩阵）。
// 读取权限：owner/operator/support 均可；写入权限：仅 owner（破坏性/全局性配置）。
// readDisabledL2Menus / parseDisabledL2Menus 定义在 lib/l2-menu-keys.ts（与 L2 中间件共用）。

/** 菜单目录 + 当前禁用列表 */
platformRoute.get("/l2-menus", async (c) => {
  const db = getDb(c);
  const disabledMenus = await readDisabledL2Menus(db);
  return ok(c, { menuCatalog: L2_MENU_CATALOG, disabledMenus });
});

/** 保存禁用菜单列表（仅 owner；白名单校验非法 key 拒绝） */
platformRoute.patch("/l2-menus", requirePlatformMember(["platform_owner"]), async (c) => {
  const db = getDb(c);
  const actorUserId = c.get("userId") as string;
  const actorRole = c.get("platformRole") as string;
  const body = await c.req.json<{ disabledMenus?: unknown }>().catch(() => ({ disabledMenus: undefined }));
  if (!Array.isArray(body.disabledMenus)) {
    return fail(c, "disabledMenus 必须是菜单 key 数组", 400);
  }
  const unique = [...new Set(body.disabledMenus)];
  const invalid = unique.filter((key) => typeof key !== "string" || !isL2MenuKey(key));
  if (invalid.length > 0) {
    return fail(c, `包含不支持的菜单 key：${invalid.join(", ")}`, 400);
  }
  const now = new Date().toISOString();
  await withDbTransaction(db, async (tx) => {
    await tx
      .insert(systemConfig)
      .values({ key: DISABLED_L2_MENUS_KEY, value: JSON.stringify(unique), updatedAt: now })
      .onConflictDoUpdate({
        target: systemConfig.key,
        set: { value: JSON.stringify(unique), updatedAt: now },
      });
    // 全局菜单权限变更必须留审计（L3 权限矩阵 owner 可写）
    await writePlatformAudit(tx, {
      actorUserId,
      actorRole,
      action: "platform.l2.menus.update",
      targetType: "system_config",
      targetId: DISABLED_L2_MENUS_KEY,
      metadata: { disabledMenus: unique },
    });
  });
  return ok(c, { disabledMenus: unique });
});
