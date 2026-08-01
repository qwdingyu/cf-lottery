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
      ],
    },
    {
      path: '/admin/:pathMatch(.*)*',
      redirect: '/admin',
    },
  ],
})

router.beforeEach((to) => {
  const adminToken = readAdminToken()

  const requiresAuth = to.meta.requiresAuth as boolean | undefined
  const requiresGuest = to.meta.requiresGuest as boolean | undefined

  if (requiresAuth && !adminToken) {
    return { name: 'AdminLogin', query: { redirect: to.fullPath }, replace: true }
  }

  if (requiresGuest && adminToken) {
    return { name: 'AdminDashboard', replace: true }
  }

  return true
})

export default router
