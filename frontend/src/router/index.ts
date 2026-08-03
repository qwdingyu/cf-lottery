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
import { readAdminToken } from '@/composables/useAdminAuth'
import { readPlatformRole } from '@/composables/useAdminAuth'

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

  // 平台路由额外要求平台成员身份。readPlatformRole() 返回 undefined 表示
  // 尚未从 API 获取（登录流程中会异步填充），此时允许通过但不渲染内容，
  // 由 PlatformLayout 自行处理 loading 状态。
  if (isPlatformRoute && adminToken) {
    const platRole = readPlatformRole()
    if (platRole === null) {
      // 已确认非平台成员，跳回租户后台首页
      return { name: 'AdminDashboard', replace: true }
    }
    // platRole === undefined 或 platRole === string 都放行
  }

  if (requiresGuest && adminToken) {
    return { name: 'AdminDashboard', replace: true }
  }

  return true
})

export default router
