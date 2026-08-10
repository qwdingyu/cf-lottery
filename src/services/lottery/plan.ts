/**
 * 抽奖服务层 — 套餐配额模块（lottery-service 拆分，docs/049 #17）
 *
 * 套餐额度：硬编码 PLAN_LIMITS 基线 + system_config 动态覆盖（平台运营者配置）
 * + 租户兑换码额外额度（未过期部分），供活动创建/后台仪表盘做配额校验。
 */
import type { DbType } from "../../db/client";
import { and, eq, count, inArray, sql } from "drizzle-orm";
import { systemConfig, tenants, tenantMembers, lotteryDraws, webhookConfigs } from "../../db/schema";
import type { TenantPlanLimits } from "./types";

const PLAN_LIMITS: Record<string, Omit<TenantPlanLimits, "plan">> = {
  free: {
    maxActivities: 10,
    maxParticipantsPerActivity: 200,
    maxMembers: 2,
    maxWebhooks: 0,
    /* 社群功能（docs/180）：免费 1 群 × 200 人，促升级 */
    communityEnabled: true,
    maxPlatformTargets: 1,
    maxGroupMembers: 200,
  },
  pro: {
    maxActivities: 200,
    maxParticipantsPerActivity: 5000,
    maxMembers: 10,
    maxWebhooks: 3,
    /* 社群功能（docs/180）：pro 3 群 × 2000 人 */
    communityEnabled: true,
    maxPlatformTargets: 3,
    maxGroupMembers: 2000,
  },
  team: {
    maxActivities: 1000,
    maxParticipantsPerActivity: 20000,
    maxMembers: 50,
    maxWebhooks: 10,
    /* 社群功能（docs/180）：team 10 群 × 3000 人 */
    communityEnabled: true,
    maxPlatformTargets: 10,
    maxGroupMembers: 3000,
  },
  enterprise: {
    maxActivities: null,
    maxParticipantsPerActivity: 100000,
    maxMembers: null,
    maxWebhooks: null,
    /* 社群功能（docs/180）：企业版不设限 */
    communityEnabled: true,
    maxPlatformTargets: null,
    maxGroupMembers: null,
  },
};

export function getTenantPlanLimits(plan?: string | null): TenantPlanLimits {
  const normalized = String(plan || "free").trim().toLowerCase();
  const limits = PLAN_LIMITS[normalized] || PLAN_LIMITS.free!;
  return { plan: PLAN_LIMITS[normalized] ? normalized : "free", ...limits };
}

/**
 * 系统配置中套餐额度相关 key 的列表。
 * 平台运营者可在 /platform/config 页面修改这些值，动态覆盖硬编码的 PLAN_LIMITS。
 */
const PLAN_LIMITS_CONFIG_KEYS: string[] = [
  "plan_free_max_activities",
  "plan_free_max_participants_per_activity",
  "plan_pro_max_activities",
  "plan_pro_max_participants_per_activity",
  "plan_team_max_activities",
  "plan_team_max_participants_per_activity",
  "plan_enterprise_max_activities",
  "plan_enterprise_max_participants_per_activity",
  // MVP 推广期允许平台运营者单独调整 Free 套餐的 Webhook 数量，给用户试用体验。
  "free_plan_max_webhooks",
] as const;

/**
 * 从 system_config 表读取动态套餐额度配置，与硬编码 PLAN_LIMITS 合并。
 * 读取 system_config 是后台管理/配额校验操作，当前不在公开参与热路径。
 * max_activities 的 0 表示不限（对应 null）；单活动参与上限必须大于 0。
 * 未配置或非法的套餐项继续使用 PLAN_LIMITS 默认值。
 */
async function loadDynamicPlanLimits(db: DbType): Promise<Record<string, Omit<TenantPlanLimits, "plan">>> {
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, PLAN_LIMITS_CONFIG_KEYS));

  const configMap: Record<string, string> = {};
  for (const row of rows) {
    configMap[row.key] = row.value;
  }

  // 深拷贝硬编码默认值
  const merged: Record<string, Omit<TenantPlanLimits, "plan">> = {};
  for (const [planName, planValues] of Object.entries(PLAN_LIMITS)) {
    merged[planName] = { ...planValues };
  }

  // 用系统配置中的值覆盖（如果存在且有效）
  for (const planName of ["free", "pro", "team", "enterprise"] as const) {
    const maxActivitiesVal = configMap[`plan_${planName}_max_activities`];
    const maxParticipantsVal = configMap[`plan_${planName}_max_participants_per_activity`];

    if (maxActivitiesVal !== undefined && merged[planName]) {
      const parsed = parseInt(maxActivitiesVal, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        merged[planName].maxActivities = parsed === 0 ? null : parsed;
      }
    }
    if (maxParticipantsVal !== undefined && merged[planName]) {
      const parsed = parseInt(maxParticipantsVal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        merged[planName].maxParticipantsPerActivity = parsed;
      }
    }
  }

  // Free 套餐的 Webhook 数量通过系统配置单独覆盖（MVP 推广期给试用体验）
  const freeWebhooksVal = configMap["free_plan_max_webhooks"];
  if (freeWebhooksVal !== undefined && merged["free"]) {
    const parsed = parseInt(freeWebhooksVal, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      // Webhook 数量的 0 表示不允许创建，不等同于 maxActivities 中的“不限”。
      // Free 层如果误把 0 当作 null，会直接绕过套餐限制并放大外部投递成本。
      merged["free"].maxWebhooks = parsed;
    }
  }

  return merged;
}

export async function getTenantUsage(db: DbType, tenantId: string) {
  // 读取动态套餐额度配置（平台运营者在 /platform/config 中设置），覆盖硬编码默认值。
  const dynamicPlanLimits = await loadDynamicPlanLimits(db);
  // 查询租户信息，含兑换码购买的额外额度
  const [tenant] = await db
    .select({
      plan: tenants.plan,
      extraActivityQuota: tenants.extraActivityQuota,
      extraParticipantQuota: tenants.extraParticipantQuota,
      extraQuotaExpiresAt: tenants.extraQuotaExpiresAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const rawPlan = String(tenant?.plan || "free").trim().toLowerCase();
  const plan = PLAN_LIMITS[rawPlan] ? rawPlan : "free";
  // 优先使用动态套餐额度（平台运营者在 /platform/config 中设置），兜底用硬编码默认值。
  const dynamicPlan = dynamicPlanLimits[plan] || PLAN_LIMITS[plan] || PLAN_LIMITS.free!;
  const limits: TenantPlanLimits = { plan, ...dynamicPlan };

  const [{ total: activityCount }] = await db
    .select({ total: count() })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.tenantId, tenantId),
      sql`${lotteryDraws.status} <> 'cancelled'`,
    ));

  const [{ total: memberCount }] = await db
    .select({ total: count() })
    .from(tenantMembers)
    .where(eq(tenantMembers.tenantId, tenantId));

  const [{ total: webhookCount }] = await db
    .select({ total: count() })
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, 1)));

  // 兑换码额外额度仅在有效期内生效
  const extraValid = tenant?.extraQuotaExpiresAt ? new Date() < new Date(tenant.extraQuotaExpiresAt) : false;
  const extraActivities = extraValid ? (tenant?.extraActivityQuota || 0) : 0;
  const extraParticipants = extraValid ? (tenant?.extraParticipantQuota || 0) : 0;

  // 返回有效额度 = 套餐基础额度 + 兑换码额外额度（未过期）
  return {
    plan: limits.plan,
    limits: {
      ...limits,
      maxActivities: limits.maxActivities !== null ? limits.maxActivities + extraActivities : null,
      maxParticipantsPerActivity: limits.maxParticipantsPerActivity + extraParticipants,
    },
    usage: {
      activities: Number(activityCount || 0),
      members: Number(memberCount || 0),
      webhooks: Number(webhookCount || 0),
    },
  };
}

export async function enforceTenantActivityQuota(
  db: DbType,
  tenantId: string,
  requestedMaxParticipants?: number,
) {
  const usage = await getTenantUsage(db, tenantId);
  if (usage.limits.maxActivities !== null && usage.usage.activities >= usage.limits.maxActivities) {
    throw new Error(`当前套餐最多可保留 ${usage.limits.maxActivities} 个活动，请升级套餐或删除草稿活动`);
  }

  if (requestedMaxParticipants !== undefined && requestedMaxParticipants > usage.limits.maxParticipantsPerActivity) {
    throw new Error(`当前套餐单活动最多允许 ${usage.limits.maxParticipantsPerActivity} 人参与，请降低名额或升级套餐`);
  }

  return usage.limits;
}

