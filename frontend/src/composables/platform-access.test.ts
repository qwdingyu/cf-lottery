import { describe, expect, it } from 'vitest'
import {
  isActivePlatformRole,
  normalizePlatformRoleFromApi,
  platformAccessDeniedTarget,
  resolvePlatformRouteGate,
} from './platform-access'

describe('platform-access（L3 路由 fail-closed）', () => {
  it('仅活跃平台角色 isActive', () => {
    expect(isActivePlatformRole('platform_owner')).toBe(true)
    expect(isActivePlatformRole('platform_operator')).toBe(true)
    expect(isActivePlatformRole('platform_support')).toBe(true)
    expect(isActivePlatformRole(null)).toBe(false)
    expect(isActivePlatformRole(undefined)).toBe(false)
    expect(isActivePlatformRole('owner')).toBe(false)
    expect(isActivePlatformRole('')).toBe(false)
  })

  it('缓存未知 → resolve；非 L3 → deny；L3 → allow', () => {
    expect(resolvePlatformRouteGate(undefined)).toEqual({ action: 'resolve' })
    expect(resolvePlatformRouteGate(null)).toEqual({ action: 'deny' })
    expect(resolvePlatformRouteGate('owner')).toEqual({ action: 'deny' })
    expect(resolvePlatformRouteGate('platform_owner')).toEqual({
      action: 'allow',
      role: 'platform_owner',
    })
  })

  it('拒绝落点：有租户回 AdminDashboard+reason；无租户 Onboarding', () => {
    expect(platformAccessDeniedTarget(true)).toEqual({
      name: 'AdminDashboard',
      query: { reason: 'not_platform' },
    })
    expect(platformAccessDeniedTarget(false)).toEqual({ name: 'Onboarding' })
  })

  it('normalize API：活跃保留，其它 null', () => {
    expect(normalizePlatformRoleFromApi('platform_operator')).toBe('platform_operator')
    expect(normalizePlatformRoleFromApi(null)).toBeNull()
    expect(normalizePlatformRoleFromApi('')).toBeNull()
    expect(normalizePlatformRoleFromApi('admin')).toBeNull()
  })
})
