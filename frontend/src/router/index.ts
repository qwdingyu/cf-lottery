/**
 * cf-lottery 前端路由配置
 *
 * 仅保留抽奖 SaaS 所需的路由，移除 cf-shop 电商路由。
 */
import { createRouter, createWebHistory } from 'vue-router'
import AdminLoginView from '@/views/AdminLoginView.vue'
import AdminRegisterView from '@/views/AdminRegisterView.vue'
import AdminLayout from '@/views/AdminLayout.vue'
import PlatformLayout from '@/views/PlatformLayout.vue'
import LandingView from '@/views/LandingView.vue'
import {
  ensurePlatformRole,
  readAdminToken,
} from '@/composables/useAdminAuth'
import {
  platformAccessDeniedTarget,
  resolvePlatformRouteGate,
} from '@/composables/platform-access'

/**
 * 从 JWT payload 解析 tenantId。
 * 路由守卫用它判断"已登录但无租户"（方案 C：新注册用户无租户），
 * 重定向到 onboarding，避免访问 /admin 撞后端 403"无租户上下文"。
 */
function jwtTenantId(token: string): string {
  try {
    const payloadB64 = token.split('.')[1]
    if (!payloadB64) return ''
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.tenantId === 'string' ? payload.tenantId : ''
  } catch {
    return ''
  }
}

/**
 * 解码 JWT payload（不验签——验签由后端完成；这里仅用于路由守卫读取声明做准入判断）。
 * 返回 null 表示格式非法。
 */
function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const payloadB64 = token.split('.')[1]
    if (!payloadB64) return null
    return JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'Landing',
      component: LandingView,
    },
    {
      path: '/lottery/:slug(.*)?',
      name: 'Lottery',
      component: () => import('@/views/LotteryView.vue'),
      props: (route) => ({ id: route.params.slug || undefined }),
    },
    {
      // 一次性卡密访问页（docs/179）：Bot 生成的 /我的卡密 链接指向此页
      path: '/access/card-codes',
      name: 'AccessCardCodes',
      component: () => import('@/views/AccessCardCodesView.vue'),
    },
    {
      path: '/shop/:storeSlug',
      name: 'Shop',
      component: () => import('@/views/ShopView.vue'),
    },
    {
      path: '/admin/login',
      name: 'AdminLogin',
      component: AdminLoginView,
      meta: { requiresGuest: true },
    },
    {
      // cf-auth OAuth 回调（docs/059）；须与 CF_AUTH_REDIRECT_URI 路径一致
      path: '/auth/callback',
      name: 'AuthCallback',
      component: () => import('@/views/AuthCallbackView.vue'),
    },
    {
      path: '/admin/register',
      name: 'AdminRegister',
      component: AdminRegisterView,
      meta: { requiresGuest: true },
    },
    {
      path: '/admin/onboarding',
      name: 'Onboarding',
      component: () => import('@/views/OnboardingView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/admin',
      component: AdminLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'AdminDashboard',
          component: () => import('@/views/admin/AdminDashboardView.vue'),
        },
        {
          path: 'draws',
          name: 'AdminLottery',
          component: () => import('@/views/admin/AdminLotteryView.vue'),
        },
        {
          path: 'prizes',
          name: 'AdminPrizes',
          component: () => import('@/views/admin/AdminPrizesView.vue'),
        },
        {
          path: 'logs',
          name: 'AdminLogs',
          component: () => import('@/views/admin/AdminLogsView.vue'),
        },
        {
          path: 'members',
          name: 'AdminMembers',
          component: () => import('@/views/admin/AdminMembersView.vue'),
        },
        {
          path: 'blacklist',
          name: 'AdminBlacklist',
          component: () => import('@/views/admin/AdminBlacklistView.vue'),
        },
        {
          path: 'quota-redeem',
          name: 'AdminQuotaRedeem',
          component: () => import('@/views/admin/AdminQuotaRedeemView.vue'),
        },
        {
          path: 'integrations',
          name: 'AdminIntegrations',
          component: () => import('@/views/admin/AdminIntegrationsView.vue'),
        },
        {
          path: 'platform-targets',
          name: 'AdminPlatformTarget',
          component: () => import('@/views/admin/AdminPlatformTargetView.vue'),
        },
        {
          path: 'payment-config',
          name: 'AdminPaymentConfig',
          component: () => import('@/views/admin/AdminPaymentConfig.vue'),
        },
        {
          path: 'brand',
          name: 'AdminBrand',
          component: () => import('@/views/admin/BrandSettings.vue'),
        },
        {
          path: 'payment-orders',
          name: 'AdminPaymentOrders',
          component: () => import('@/views/admin/AdminPaymentOrdersView.vue'),
        },
      ],
    },
    // 平台运营后台（L3），与租户后台（/admin）路由分离
    {
      path: '/platform',
      component: PlatformLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/platform/tenants',
        },
        {
          path: 'tenants',
          name: 'PlatformTenants',
          component: () => import('@/views/platform/PlatformTenantsView.vue'),
        },
        {
          path: 'members',
          name: 'PlatformMembers',
          component: () => import('@/views/platform/PlatformMembersView.vue'),
        },
        {
          path: 'config',
          name: 'PlatformConfig',
          component: () => import('@/views/admin/AdminSystemConfigView.vue'),
        },
        {
          path: 'redemption-codes',
          name: 'PlatformRedemptionCodes',
          component: () => import('@/views/admin/AdminRedemptionCodesView.vue'),
        },
        {
          path: 'audit-logs',
          name: 'PlatformAuditLogs',
          component: () => import('@/views/platform/PlatformAuditLogsView.vue'),
        },
        {
          path: 'webhook-deliveries',
          name: 'PlatformWebhookDeliveries',
          component: () => import('@/views/platform/PlatformWebhookDeliveriesView.vue'),
        },
        {
          path: 'email-deliveries',
          name: 'PlatformEmailDeliveries',
          component: () => import('@/views/platform/PlatformEmailDeliveriesView.vue'),
        },
        {
          path: 'data-cleanup',
          name: 'PlatformDataCleanup',
          component: () => import('@/views/platform/PlatformDataCleanupView.vue'),
        },
      ],
    },
    {
      path: '/admin/:pathMatch(.*)*',
      redirect: '/admin',
    },
    // C 端 404 兜底：必须放在 /admin/* 通配之后、其余全部未命中时生效
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
})

router.beforeEach((to) => {
  // 支持从 URL 参数注入 token（平台运营者模拟登录）
  const urlToken = to.query.token as string | undefined
  if (urlToken && to.path.startsWith('/admin')) {
    // 会话固定防护：只接受带 impersonated=true 声明的未过期 JWT（平台模拟登录签发，1 小时有效）。
    // 普通登录 token / 伪造声明 token 一律丢弃，防止任何人构造 /admin?token= 链接
    // 把攻击者会话写入受害者浏览器（会话固定）。
    const claims = jwtClaims(urlToken)
    const validImpersonation =
      claims?.impersonated === true &&
      typeof claims.exp === 'number' &&
      claims.exp * 1000 > Date.now()
    if (validImpersonation) {
      // 写入独立 key（impersonated_token）：不覆盖运营者自己的 admin_token 会话，
      // 保证运营者模拟租户身份后能随时清除模拟态返回平台（L3→L2 路径闭环）。
      localStorage.setItem('impersonated_token', JSON.stringify({ token: urlToken, expiry: Date.now() + 3600000 }))
    }
    // 无论 token 是否有效，都从 URL 移除，避免泄露到浏览器历史
    const cleanQuery = { ...to.query }
    delete cleanQuery.token
    return { path: to.path, query: cleanQuery, replace: true }
  }

  const adminToken = readAdminToken()

  const requiresAuth = to.meta.requiresAuth as boolean | undefined
  const requiresGuest = to.meta.requiresGuest as boolean | undefined
  const isPlatformRoute = to.path.startsWith('/platform')

  if (requiresAuth && !adminToken) {
    return { name: 'AdminLogin', query: { redirect: to.fullPath }, replace: true }
  }

  // ★ 045 方案 C 闭环：已登录但无租户的用户（新注册/未 onboarding），
  // 访问租户后台（/admin）时重定向 onboarding 引导创建租户。
  // 排除：
  // - /platform（L3 平台成员可能没有租户，不强制创建）
  // - onboarding 本身（避免死循环）
  if (requiresAuth && adminToken && !isPlatformRoute && to.path !== '/admin/onboarding' && !jwtTenantId(adminToken)) {
    return { name: 'Onboarding', replace: true }
  }

  // 平台路由：fail-closed（docs/125）。
  // 旧逻辑在 platformRole===undefined 时放行 → 非 L3 手输 URL 能看到完整壳+菜单+空表，仅 API 403。
  // 现：未知必须先 ensure；非活跃角色硬拒；未决网络错误也拒壳（避免「看得见菜单」）。
  if (isPlatformRoute && adminToken) {
    return (async () => {
      // 每次导航强制解析平台角色：缓存可能过时（被降级/移除后缓存仍为旧角色，
      // 会导致路由守卫放行而 API 403 的「看得见壳、看不见数」UX 违例，docs/129 §三）。
      // 失败时 fail-closed 拒壳，网络恢复后下次导航重试。
      const resolved = await ensurePlatformRole(adminToken, { force: true })
      const gate = resolvePlatformRouteGate(resolved === undefined ? null : resolved)
      if (gate.action === 'allow') return true
      const denied = platformAccessDeniedTarget(!!jwtTenantId(adminToken))
      return { name: denied.name, query: denied.query, replace: true }
    })()
  }

  if (requiresGuest && adminToken) {
    return { name: 'AdminDashboard', replace: true }
  }

  return true
})

export default router
