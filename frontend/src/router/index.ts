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
      props: true,
    },
    {
      path: '/admin/login',
      name: 'AdminLogin',
      component: AdminLoginView,
      meta: { requiresGuest: true },
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
    localStorage.setItem('admin_token', JSON.stringify({ value: urlToken, expiresAt: Date.now() + 3600000 }))
    // 去掉 token 参数，避免泄露到浏览器历史
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
