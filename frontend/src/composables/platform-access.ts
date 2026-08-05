/**
 * L3 平台路由准入决策（纯函数，可单测）。
 *
 * 产品不变量：
 * - /platform/* 仅活跃平台成员可进
 * - 未确认身份前不得渲染平台壳（菜单/空表）——「看得到壳、看不到数」不是可接受 UX
 * - 已确认非 L3 → 硬拒绝；未知 → 必须先 resolve 再决定
 */

/** 与后端 platform_members.role 对齐 */
export const ACTIVE_PLATFORM_ROLES = [
  'platform_owner',
  'platform_operator',
  'platform_support',
] as const

export type ActivePlatformRole = (typeof ACTIVE_PLATFORM_ROLES)[number]

/** 缓存态：string=角色；null=已确认非 L3；undefined=尚未解析 */
export type PlatformRoleCache = string | null | undefined

export type PlatformRouteGate =
  | { action: 'allow'; role: string }
  | { action: 'deny' }
  | { action: 'resolve' }

/** 是否为活跃 L3 角色字符串 */
export function isActivePlatformRole(role: unknown): role is ActivePlatformRole {
  return typeof role === 'string'
    && (ACTIVE_PLATFORM_ROLES as readonly string[]).includes(role)
}

/**
 * 根据本地缓存决定平台路由是否可立刻放行。
 * resolve：必须打 /api/auth/me（或等价）后再决策。
 */
export function resolvePlatformRouteGate(cachedRole: PlatformRoleCache): PlatformRouteGate {
  if (cachedRole === undefined) return { action: 'resolve' }
  if (isActivePlatformRole(cachedRole)) return { action: 'allow', role: cachedRole }
  return { action: 'deny' }
}

/**
 * 非 L3 被拒后的落点：有租户 → 租户后台；无租户 → onboarding。
 * 不把非 L3 留在 /platform 空壳。
 */
export function platformAccessDeniedTarget(hasTenant: boolean): {
  name: 'AdminDashboard' | 'Onboarding'
  query?: Record<string, string>
} {
  if (hasTenant) {
    return { name: 'AdminDashboard', query: { reason: 'not_platform' } }
  }
  return { name: 'Onboarding' }
}

/**
 * 解析 API 返回的 platformRole 字段为可缓存值。
 * 非活跃角色一律 null（含空串、未知字符串）。
 */
export function normalizePlatformRoleFromApi(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (isActivePlatformRole(raw)) return raw
  return null
}
