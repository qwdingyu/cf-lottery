<template>
  <div class="admin-layout">
    <aside class="admin-sidebar sidebar-open">
      <div class="sidebar-brand">{{ $t('app.title') }} - 平台</div>
      <nav class="sidebar-nav">
        <a v-for="item in menuItems" :key="item.to" class="nav-item" :class="{ active: currentName === item.name }" :href="item.to" @click.prevent="onNavClick(item.to)">
          <span class="nav-icon" v-html="item.icon" />
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
  { name: 'PlatformConfig', to: '/platform/config', label: '系统配置', icon: '&#x2699;&#xFE0F;' },
  { name: 'PlatformRedemptionCodes', to: '/platform/redemption-codes', label: '兑换码', icon: '&#x1F3B5;' },
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