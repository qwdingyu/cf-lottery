<template>
  <!--
    docs/125：壳仅在路由守卫已 allow 后挂载。
    仍做纵深：未知/非 L3 不渲染菜单与 RouterView，只显示门禁态。
  -->
  <div class="admin-layout">
    <template v-if="gateState === 'ready'">
      <aside class="admin-sidebar sidebar-open">
        <div class="sidebar-brand">{{ $t('platformLayout.title') }}</div>
        <nav class="sidebar-nav">
          <a v-for="item in menuItems" :key="item.to" class="nav-item" :class="{ active: currentName === item.name }" :href="item.to" @click.prevent="onNavClick(item.to)">
            <span class="nav-icon">{{ item.icon }}</span>
            <span class="nav-label">{{ item.label }}</span>
          </a>
        </nav>
      </aside>
      <div class="admin-main">
        <header class="admin-header">
          <div class="admin-header-left">
            <h1 class="admin-header-title">{{ pageTitle }}</h1>
          </div>
          <div class="admin-header-actions">
            <RouterLink class="btn btn-ghost header-logout" to="/admin">{{ $t('platformLayout.backToTenant') }}</RouterLink>
            <div class="header-user" :title="$t('adminLayout.admin')">
              <span class="header-user-avatar" aria-hidden="true">P</span>
              <span class="header-user-name">{{ $t('adminLayout.admin') }}</span>
            </div>
            <button class="btn btn-ghost header-logout" type="button" @click="handleLogout">{{ $t('adminLayout.logout') }}</button>
          </div>
        </header>
        <main class="admin-content">
          <RouterView v-slot="{ Component }">
            <transition name="admin-fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </RouterView>
        </main>
      </div>
    </template>
    <div v-else class="platform-gate" role="status" aria-live="polite">
      <p v-if="gateState === 'checking'">{{ $t('platformLayout.checkingAccess') }}</p>
      <p v-else>{{ $t('platformLayout.accessDenied') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  ensurePlatformRole,
  readAdminToken,
  readPlatformRole,
  useAdminAuth,
} from '@/composables/useAdminAuth'
import {
  isActivePlatformRole,
  platformAccessDeniedTarget,
  resolvePlatformRouteGate,
} from '@/composables/platform-access'
import { useToast } from '@usethink/cf-admin-fe/composables'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { clearToken } = useAdminAuth()
const { showToast } = useToast()

/** checking | ready | denied — 默认 checking，避免闪一下完整菜单 */
const gateState = ref<'checking' | 'ready' | 'denied'>('checking')

/** 平台运营后台菜单（仅 L3 功能） */
const menuItems = computed(() => [
  { name: 'PlatformTenants', to: '/platform/tenants', label: t('platformLayout.menuTenants'), icon: '🏢' },
  { name: 'PlatformMembers', to: '/platform/members', label: t('platformLayout.menuMembers'), icon: '👥' },
  { name: 'PlatformConfig', to: '/platform/config', label: t('platformLayout.menuConfig'), icon: '⚙️' },
  { name: 'PlatformRedemptionCodes', to: '/platform/redemption-codes', label: t('platformLayout.menuRedemptionCodes'), icon: '🎵' },
  { name: 'PlatformAuditLogs', to: '/platform/audit-logs', label: t('platformLayout.menuAuditLogs'), icon: '📝' },
  { name: 'PlatformWebhookDeliveries', to: '/platform/webhook-deliveries', label: t('platformLayout.menuWebhookDeliveries'), icon: '📨' },
  { name: 'PlatformDataCleanup', to: '/platform/data-cleanup', label: t('platformLayout.menuDataCleanup'), icon: '🧹' },
])

const currentName = computed(() => route.name as string | undefined)
const pageTitle = computed(() => {
  const item = menuItems.value.find((i) => i.name === currentName.value)
  return item?.label || t('platformLayout.title')
})

function onNavClick(to: string) {
  if (route.fullPath === to) return
  router.push(to)
}

function handleLogout() {
  clearToken()
  showToast(t('adminLayout.loggedOut'), 'success')
  router.replace('/admin/login')
}

function jwtHasTenant(token: string): boolean {
  try {
    const payloadB64 = token.split('.')[1]
    if (!payloadB64) return false
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.tenantId === 'string' && payload.tenantId.length > 0
  } catch {
    return false
  }
}

onMounted(() => {
  void (async () => {
    const token = readAdminToken()
    if (!token) {
      gateState.value = 'denied'
      void router.replace({ name: 'AdminLogin', query: { redirect: route.fullPath } })
      return
    }
    let cached = readPlatformRole()
    let gate = resolvePlatformRouteGate(cached)
    if (gate.action === 'resolve') {
      const resolved = await ensurePlatformRole(token)
      cached = resolved === undefined ? readPlatformRole() : resolved
      gate = resolvePlatformRouteGate(
        isActivePlatformRole(cached) ? cached : cached === undefined ? null : cached,
      )
      if (resolved === undefined && cached === undefined) gate = { action: 'deny' }
    }
    if (gate.action === 'allow') {
      gateState.value = 'ready'
      return
    }
    gateState.value = 'denied'
    const denied = platformAccessDeniedTarget(jwtHasTenant(token))
    void router.replace({ name: denied.name, query: denied.query })
  })()
})
</script>

<style scoped>
/* ── 布局样式（与 AdminLayout 共享结构，类名一致） ── */
.admin-layout {
  display: flex;
  height: 100vh;
  background: var(--tg-bg, #0a0e17);
  overflow: hidden;
  color-scheme: dark;
}

.admin-sidebar {
  width: var(--admin-sidebar-w, 220px);
  background: #1a1a2e;
  color: #fff;
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 100;
  overflow-y: auto;
}

.sidebar-brand {
  padding: 16px 14px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.sidebar-nav {
  flex: 1;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  color: rgba(255, 255, 255, 0.72);
  text-decoration: none;
  font-size: 13px;
  transition: background 0.15s ease, color 0.15s ease;
  border-left: 3px solid transparent;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.nav-item.active {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-weight: 600;
  border-left-color: var(--admin-accent, #f59e0b);
}

.nav-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.admin-main {
  flex: 1;
  margin-left: var(--admin-sidebar-w, 220px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100vh;
  overflow: hidden;
}

.admin-header {
  position: sticky;
  top: 0;
  z-index: 50;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px var(--admin-content-pad, 12px);
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  backdrop-filter: saturate(180%) blur(12px);
  background: rgba(var(--tg-bg-rgb, 10, 14, 23), 0.88);
}

.admin-header-title {
  margin: 0;
  font-size: 15px;
}

.admin-content {
  flex: 1;
  padding: var(--admin-content-pad, 16px);
  overflow: hidden;
  min-width: 0;
}

.header-logout {
  flex-shrink: 0;
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  color: var(--tg-hint, #9aa4b2);
  background: transparent;
  cursor: pointer;
}

.header-logout:hover {
  color: var(--tg-text, #f0f2f5);
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.06);
}

.admin-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.header-user {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 160px;
  min-width: 0;
}

.header-user-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--admin-accent, #f59e0b);
  color: #111;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}

.header-user-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--tg-text, #f0f2f5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.admin-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.platform-gate {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  color: var(--tg-hint, #9aa4b2);
  font-size: 14px;
}

@media (max-width: 1023px) {
  .header-user-name {
    display: none;
  }
  .admin-sidebar {
    width: 260px;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
  }
  .admin-sidebar.sidebar-open {
    transform: translateX(0);
  }
  .admin-main {
    margin-left: 0;
  }
}
</style>