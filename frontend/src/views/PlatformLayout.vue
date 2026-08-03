<template>
  <div class="admin-layout">
    <aside class="admin-sidebar sidebar-open">
      <div class="sidebar-brand">{{ $t('platformLayout.title') }}</div>
      <nav class="sidebar-nav">
        <a v-for="item in menuItems" :key="item.to" class="nav-item" :class="{ active: currentName === item.name }" :href="item.to" @click.prevent="onNavClick(item.to)">
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </a>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-user">
          <span class="sidebar-user-avatar">P</span>
          <span class="sidebar-user-name">{{ $t('adminLayout.admin') }}</span>
        </div>
        <button class="btn btn-ghost btn-xs sidebar-logout" @click="handleLogout">{{ $t('adminLayout.logout') }}</button>
      </div>
    </aside>
    <div class="admin-main">
      <header class="admin-header">
        <div class="admin-header-left">
          <h1 class="admin-header-title">{{ pageTitle }}</h1>
        </div>
        <div class="admin-header-actions">
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { clearToken } = useAdminAuth()
const { showToast } = useToast()

/** 平台运营后台菜单（仅 L3 功能） */
const menuItems = computed(() => [
  { name: 'PlatformTenants', to: '/platform/tenants', label: t('platformLayout.menuTenants'), icon: '🏢' },
  { name: 'PlatformMembers', to: '/platform/members', label: t('platformLayout.menuMembers'), icon: '👥' },
  { name: 'PlatformConfig', to: '/platform/config', label: t('platformLayout.menuConfig'), icon: '⚙️' },
  { name: 'PlatformRedemptionCodes', to: '/platform/redemption-codes', label: t('platformLayout.menuRedemptionCodes'), icon: '🎵' },
  { name: 'PlatformAuditLogs', to: '/platform/audit-logs', label: t('platformLayout.menuAuditLogs'), icon: '📝' },
  { name: 'PlatformWebhookDeliveries', to: '/platform/webhook-deliveries', label: t('platformLayout.menuWebhookDeliveries'), icon: '📨' },
  { name: 'PlatformDataCleanup', to: '/platform/data-cleanup', label: '数据清理', icon: '🧹' },
])

const currentName = computed(() => route.name as string | undefined)
const pageTitle = computed(() => {
  const item = menuItems.value.find((i) => i.name === currentName.value)
  return item?.label || '平台运营'
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
  padding: 2px 6px;
  font-size: 11px;
  border-radius: var(--r-sm, 6px);
  color: var(--tg-hint, #9aa4b2);
}

.header-logout:hover {
  color: var(--tg-text, #f0f2f5);
  background: var(--surface-hover, rgba(255, 255, 255, 0.1));
}

.admin-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.admin-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-user-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
}

.sidebar-user-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.84);
}

.sidebar-logout {
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.64);
}

.sidebar-logout:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

@media (max-width: 1023px) {
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