<template>
  <div class="admin-layout">
    <!-- 侧边栏遮罩（小屏打开侧边栏时显示） -->
    <div v-if="isMobile && sidebarOpen" class="sidebar-overlay" @click="sidebarOpen = false" />

    <!-- 侧边栏：小屏时默认隐藏，通过 hamburger 切换 -->
    <aside class="admin-sidebar" :class="{ 'sidebar-open': sidebarOpen }">
      <div class="sidebar-brand">{{ $t('app.title') }}</div>
      <nav class="sidebar-nav" @click="isMobile && (sidebarOpen = false)">
        <a
          v-for="item in menuItems"
          :key="item.to"
          class="nav-item"
          :class="{ active: currentName === item.name }"
          :href="item.to"
          :title="item.label"
          @click.prevent="onNavClick(item.to)"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </a>
        <!-- L3 平台运营入口：仅 platform_owner/operator/support 可见 -->
        <RouterLink v-if="isPlatformMember" to="/platform/tenants" class="nav-item nav-item--platform">
          <span class="nav-icon">🏢</span>
          <span class="nav-label">{{ $t('adminLayout.menuPlatform') }}</span>
        </RouterLink>
      </nav>
    </aside>

    <div class="admin-main" :class="{ 'sidebar-open': sidebarOpen }">
      <header class="admin-header">
        <div class="admin-header-left">
          <!-- Hamburger button（小屏显示） -->
          <button v-if="isMobile" class="btn-hamburger" @click="toggleSidebar" type="button" :aria-label="$t('adminLayout.toggleSidebar')">
            <span class="hamburger-line" />
            <span class="hamburger-line" />
            <span class="hamburger-line" />
          </button>
          <h1 class="admin-header-title">{{ pageTitle }}</h1>
        </div>
        <div class="admin-header-actions">
          <select class="lang-select" :value="locale" @change="onLanguageChange">
            <option value="zh-CN">{{ $t('adminLayout.langZh') }}</option>
            <option value="en">{{ $t('adminLayout.langEn') }}</option>
          </select>
          <div class="header-user" :title="$t('adminLayout.admin')">
            <span class="header-user-avatar" aria-hidden="true">A</span>
            <span class="header-user-name">{{ $t('adminLayout.admin') }}</span>
          </div>
          <button
            class="btn btn-ghost header-logout"
            type="button"
            @click="handleLogout"
          >{{ $t('adminLayout.logout') }}</button>
        </div>
      </header>

      <main class="admin-content">
        <!-- 非 L3 手输 /platform 被拒后带回：一次说明，不渲染平台空壳 -->
        <div v-if="notPlatformBanner" class="access-denied-banner" role="status">
          <span>{{ $t('adminLayout.notPlatformMember') }}</span>
          <button class="btn btn-ghost btn-xs" type="button" @click="dismissNotPlatformBanner">{{ $t('adminLayout.dismiss') }}</button>
        </div>
        <RouterView v-slot="{ Component }">
          <transition name="admin-fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </RouterView>
      </main>
    </div>

    <!-- 模拟登录横幅（L3→L2 路径）：平台运营者以租户身份查看时全屏提示，
         所有操作将以该租户 owner 身份执行；提供"返回平台"清除模拟态回到运营者会话 -->
    <div v-if="impersonating" class="impersonate-banner" role="alert">
      <span class="impersonate-banner-text">{{ $t('adminLayout.impersonateBanner') }}</span>
      <button class="btn btn-primary btn-xs" type="button" @click="handleReturnToPlatform">{{ $t('adminLayout.returnToPlatform') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { switchLanguage } from '@/i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import {
  ensurePlatformRole,
  isImpersonating,
  clearImpersonation,
  readAdminToken,
  readPlatformRole,
} from '@/composables/useAdminAuth'
import { isActivePlatformRole } from '@/composables/platform-access'
import { useToast } from '@usethink/cf-admin-fe/composables'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const { clearToken } = useAdminAuth()
const { showToast } = useToast()
/** L3 入口：缓存 + 挂载时 ensure；仅活跃角色显示 */
const isPlatformMember = ref(isActivePlatformRole(readPlatformRole()))
// 模拟登录态（L3→L2 路径）：挂载时读取；模拟会话存在时显示横幅 + 返回平台按钮
const impersonating = ref(isImpersonating())
const notPlatformBanner = ref(false)

function dismissNotPlatformBanner() {
  notPlatformBanner.value = false
  if (route.query.reason === 'not_platform') {
    const q = { ...route.query }
    delete q.reason
    void router.replace({ path: route.path, query: q })
  }
}

watch(
  () => route.query.reason,
  (reason) => {
    if (reason === 'not_platform') notPlatformBanner.value = true
  },
  { immediate: true },
)

/** 语言切换：模板内 $event.target 在 vue-tsc 下可能为 null，收口到 handler */
function onLanguageChange(event: Event) {
  const value = (event.target as HTMLSelectElement | null)?.value
  if (value === 'zh-CN' || value === 'en') switchLanguage(value)
}

/** 返回平台：清除模拟态（impersonated_token），回到运营者自己的会话并跳转平台租户列表 */
function handleReturnToPlatform() {
  clearImpersonation()
  showToast(t('adminLayout.impersonateExitToast'), 'success')
  router.push('/platform/tenants')
}

// ── 侧边栏响应式控制 ──
/** 是否小屏（<1024px），侧边栏默认隐藏，通过 hamburger 切换 */
const isMobile = ref(false)
/** 侧边栏是否展开（仅对小屏有效） */
const sidebarOpen = ref(false)

let mql: MediaQueryList | null = null
function onMqChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches
  if (!e.matches) {
    // 切回大屏时恢复侧边栏
    sidebarOpen.value = false
  }
}

onMounted(() => {
  mql = window.matchMedia('(max-width: 1023px)')
  onMqChange(mql)
  mql.addEventListener('change', onMqChange)
  // 会话恢复 / 旧登录未写 platform_role：补一次 resolve，再决定「平台运营」入口
  void (async () => {
    const token = readAdminToken()
    if (!token) {
      isPlatformMember.value = false
      return
    }
    const role = await ensurePlatformRole(token)
    isPlatformMember.value = isActivePlatformRole(role ?? readPlatformRole())
  })()
})

onUnmounted(() => {
  mql?.removeEventListener('change', onMqChange)
})

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

// ── 菜单数据（租户后台 L2 专属，平台后台功能迁移到 /platform/*） ──
const menuItems = computed(() => [
  { name: 'AdminDashboard', to: '/admin', label: t('adminLayout.menuDashboard'), icon: '📊' },
  { name: 'AdminLottery', to: '/admin/draws', label: t('adminLayout.menuLottery'), icon: '🎰' },
  { name: 'AdminPrizes', to: '/admin/prizes', label: t('adminLayout.menuPrizes'), icon: '🎁' },
  { name: 'AdminBrand', to: '/admin/brand', label: t('adminLayout.menuBrand'), icon: '🏪' },
  { name: 'AdminPaymentConfig', to: '/admin/payment-config', label: t('adminLayout.menuPaymentConfig'), icon: '💳' },
  { name: 'AdminPaymentOrders', to: '/admin/payment-orders', label: t('adminLayout.menuPaymentOrders'), icon: '🧾' },
  { name: 'AdminQuotaRedeem', to: '/admin/quota-redeem', label: t('adminLayout.menuQuotaRedeem'), icon: '🎟' },
  { name: 'AdminIntegrations', to: '/admin/integrations', label: t('adminLayout.menuIntegrations'), icon: '🔗' },
  { name: 'AdminPlatformTarget', to: '/admin/platform-targets', label: t('adminLayout.menuPlatformTarget'), icon: '🤖' },
  { name: 'Shop', to: 'https://lucky.eforge.xyz/shop/shop_43c49ec9', label: t('adminLayout.menuShop'), icon: '🛍️' },
  { name: 'AdminMembers', to: '/admin/members', label: t('adminLayout.menuMembers'), icon: '👥' },
  { name: 'AdminBlacklist', to: '/admin/blacklist', label: t('adminLayout.menuBlacklist'), icon: '🚫' },
  { name: 'AdminLogs', to: '/admin/logs', label: t('adminLayout.menuLogs'), icon: '📝' },
])

const currentName = computed(() => {
  const name = route.name as string | undefined
  // pending-tasks 路由复用运营台组件，导航上视为运营台，确保标题和高亮正确
  if (name === 'AdminPendingTasks') return 'AdminDashboard'
  return name
})

const pageTitle = computed(() => {
  const item = menuItems.value.find((item) => item.name === currentName.value)
  return item?.label || t('adminLayout.title')
})

function onNavClick(to: string) {
  // 外链（商铺链接等）：直接打开新标签页，不干扰当前路由
  if (to.startsWith("http://") || to.startsWith("https://")) {
    window.open(to, "_blank", "noopener");
    return;
  }
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
.admin-layout {
  display: flex;
  height: 100vh;
  /* 整页底：用实色 token，勿用半透明 surface（会透出下层且分层发虚） */
  background: var(--tg-bg, #0a0e17);
  overflow: hidden;
  /* 原生 select/option 按暗色系统面板渲染，避免选中/列表字发灰看不清 */
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

/* 平台运营入口：视觉上分隔于常规菜单 */
.nav-item--platform {
  margin-top: auto;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0;
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

/* ── 语言切换 ── */
.lang-select {
  background: transparent; color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; outline: none;
}
.lang-select option { background: #1a1a2e; color: #fff; }

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

/* ── 右上角操作区（语言 + 用户 + 退出） ── */
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

.lang-select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 6px);
  background: var(--tg-secondary-bg);
  color: var(--tg-text);
  font-size: 12px;
  color-scheme: dark;
  cursor: pointer;
  outline: none;
}
.lang-select:focus-visible {
  border-color: var(--admin-accent);
}
.lang-select option {
  background: var(--tg-secondary-bg);
  color: var(--tg-text);
}

/* ── Hamburger button ── */
.btn-hamburger {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 24px;
  height: 24px;
  padding: 4px;
  border: none;
  border-radius: var(--r-sm, 4px);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-hamburger:hover {
  background: var(--surface-hover, rgba(255, 255, 255, 0.1));
}

.hamburger-line {
  display: block;
  width: 100%;
  height: 1.5px;
  background: var(--tg-text, #f0f2f5);
  border-radius: 1px;
  transition: transform var(--duration-fast, 0.15s) ease;
}

/* Header left 区域（hamburger + 标题） */
.admin-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── 模拟登录横幅（L3→L2 路径） ── */
.impersonate-banner {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 6px 12px;
  background: #7c2d12;
  color: #fff;
  font-size: 12px;
}

.impersonate-banner-text {
  font-weight: 500;
}

.impersonate-banner .btn {
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: #fff;
}

.impersonate-banner .btn:hover {
  background: rgba(255, 255, 255, 0.26);
}

/* ── 侧边栏遮罩（小屏） ── */
.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
}

/* ── 小屏响应式（< 1024px） ── */
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
