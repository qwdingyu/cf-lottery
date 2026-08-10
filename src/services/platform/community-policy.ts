/**
 * 社群功能策略服务层（docs/180）。
 *
 * 提供三个核心函数：
 * 1. getTenantCommunityPolicy — 获取租户生效的社群策略（套餐默认 + 租户覆写合并）
 * 2. canTenantCreatePlatformTarget — 校验群绑定数上限（POST/PUT 拦增量）
 * 3. enforceGroupMemberCap — 运行时强制群人数上限（inbound 命令层校验）
 *
 * 防灾难红线：
 * - 群数上限（maxPlatformTargets）：只拦新增，不阻断存量（grandfathering）
 * - 群人数上限（maxGroupMembers）：运行时强制，只拦新成员，不伤存量成员
 */
import type { DbType } from "../../db/client";
import { and, eq, count } from "drizzle-orm";
import { withDbTransaction } from "../../db/client";
import { getTenantPlanLimits, getTenantUsage } from "../lottery/plan";
import { tenantCommunityOverrides, communityMembers, platformTargets } from "../../db/schema";

/**
 * 社群功能策略（合并套餐默认 + 租户覆写后的生效值）。
 */
export type CommunityPolicy = {
  communityEnabled: boolean;
  maxPlatformTargets: number | null;
  maxGroupMembers: number | null;
  source: "plan" | "override";
};

/**
 * 获取租户生效的社群功能策略（docs/180 §3.1）。
 *
 * 优先级：租户覆写（tenant_community_overrides）> 套餐默认（PLAN_LIMITS）
 * 覆写只覆盖传入字段，未覆写的字段仍用套餐默认。
 */
export async function getTenantCommunityPolicy(
  db: DbType,
  tenantId: string,
): Promise<CommunityPolicy> {
  const planLimits = getTenantPlanLimits(await getTenantPlanName(db, tenantId));

  // 读取覆写记录
  const [override] = await db
    .select()
    .from(tenantCommunityOverrides)
    .where(eq(tenantCommunityOverrides.tenantId, tenantId))
    .limit(1);

  if (!override) {
    return {
      communityEnabled: planLimits.communityEnabled,
      maxPlatformTargets: planLimits.maxPlatformTargets,
      maxGroupMembers: planLimits.maxGroupMembers,
      source: "plan",
    };
  }

  return {
    communityEnabled: override.communityEnabled === 1,
    maxPlatformTargets: override.maxPlatformTargets,
    maxGroupMembers: override.maxGroupMembers,
    source: "override",
  };
}

/**
 * 获取租户的套餐名称（从 getTenantUsage 中提取，避免重复查询）。
 */
async function getTenantPlanName(db: DbType, tenantId: string): Promise<string | undefined> {
  const usage = await getTenantUsage(db, tenantId);
  return usage.plan;
}

/**
 * 校验租户是否可新建群绑定（docs/180 §3.2）。
 *
 * 在 POST/PUT 创建绑定时调用，拦新增不阻断存量。
 * 返回 { ok: true } 或 { ok: false, message }。
 */
export async function canTenantCreatePlatformTarget(
  db: DbType,
  tenantId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const policy = await getTenantCommunityPolicy(db, tenantId);

  // 社群功能全局开关在路由层（admin-lottery-platform.ts）已校验，此处再检查覆写层
  if (!policy.communityEnabled) {
    return { ok: false, message: "当前租户未开通社群功能，请联系平台运营者" };
  }

  // 不限群数，直接放行
  if (policy.maxPlatformTargets === null) {
    return { ok: true };
  }

  // 统计当前已绑定群数
  const [{ total: bindings }] = await db
    .select({ total: count() })
    .from(platformTargets)
    .where(eq(platformTargets.tenantId, tenantId));

  if (Number(bindings || 0) >= policy.maxPlatformTargets) {
    return {
      ok: false,
      message: `当前套餐最多绑定 ${policy.maxPlatformTargets} 个群，请升级套餐或联系平台运营者扩容`,
    };
  }

  return { ok: true };
}

/**
 * 运行时强制群人数上限（docs/180 §3.3）。
 *
 * 调用点：executeBuiltinPlatformCommand 内，命令分发前。
 * 流程：事务内检查 community_members 注册表，新成员超限拒绝，存量成员放行。
 *
 * @param input.tenantId — 租户 ID
 * @param input.platformTargetId — 群绑定 ID
 * @param input.userId — 用户本地 users.id（Phase B 稳定 ID，可为空降级）
 * @returns { ok: true } 或 { ok: false, reply }
 */
export async function enforceGroupMemberCap(
  db: DbType,
  input: { tenantId: string; platformTargetId: string; userId?: string },
): Promise<{ ok: true } | { ok: false; reply: string }> {
  // provisioning 失败降级（userId 为空）：不阻断命令，避免僵尸用户卡死
  if (!input.userId) return { ok: true };

  const policy = await getTenantCommunityPolicy(db, input.tenantId);
  // 不限人数，直接放行；先将值提取到局部变量，规避事务闭包内的 TS 类型收窄问题
  const maxMembers = policy.maxGroupMembers;
  if (maxMembers === null) return { ok: true };

  let over = false;
  await withDbTransaction(db, async (tx) => {
    // 1. 是否已是存量成员
    const [existing] = await tx
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(and(
        eq(communityMembers.platformTargetId, input.platformTargetId),
        eq(communityMembers.userId, input.userId!),
      ))
      .limit(1);
    if (existing) return; // 存量成员放行（grandfathering）

    // 2. 新成员：先计数，超限则标记不插入
    const [{ total: currentCount }] = await tx
      .select({ total: count() })
      .from(communityMembers)
      .where(eq(communityMembers.platformTargetId, input.platformTargetId));

    if (Number(currentCount || 0) >= maxMembers) {
      over = true;
      return;
    }

    // 3. 未超限：插入成员注册
    await tx.insert(communityMembers).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      platformTargetId: input.platformTargetId,
      userId: input.userId!,
      identityValue: input.userId!,
    });
  });

  if (over) {
    return {
      ok: false,
      reply: `当前群参与人数已达上限（${maxMembers} 人），升级套餐可扩容群人数。`,
    };
  }
  return { ok: true };
}