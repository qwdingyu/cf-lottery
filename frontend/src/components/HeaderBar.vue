<template>
  <header class="header" :class="headerClass">
    <!-- Telegram: platform-native navigation -->
    <template v-if="isTelegram">
      <!-- Mobile: bottom tab bar -->
      <nav v-if="isMobile" class="tg-tab-bar">
        <RouterLink :to="homePath" class="tg-tab-item" active-class="active">
          <span class="tg-tab-icon">&#x1F6D2;</span>
          <span class="tg-tab-label">{{ $t('nav.products') }}</span>
        </RouterLink>
        <RouterLink to="/redeem" class="tg-tab-item" active-class="active">
          <span class="tg-tab-icon">&#x1F3AB;</span>
          <span class="tg-tab-label">{{ $t('nav.redeem') }}</span>
        </RouterLink>
        <RouterLink to="/lottery" class="tg-tab-item" active-class="active">
          <span class="tg-tab-icon">&#x1F3B0;</span>
          <span class="tg-tab-label">{{ $t('nav.lottery') }}</span>
        </RouterLink>
        <RouterLink to="/lookup" class="tg-tab-item" active-class="active">
          <span class="tg-tab-icon">&#x1F50D;</span>
          <span class="tg-tab-label">{{ $t('nav.lookup') }}</span>
        </RouterLink>
        <RouterLink to="/refer" class="tg-tab-item" active-class="active">
          <span class="tg-tab-icon">&#x1F517;</span>
          <span class="tg-tab-label">{{ $t('nav.refer') }}</span>
        </RouterLink>
      </nav>

      <!-- Desktop: top horizontal nav -->
      <div v-else class="tg-desktop-header-actions">
        <nav class="tg-desktop-nav">
          <RouterLink :to="homePath" class="nav-link" active-class="active">{{ $t('nav.products') }}</RouterLink>
          <RouterLink to="/redeem" class="nav-link" active-class="active">{{ $t('nav.redeem') }}</RouterLink>
          <RouterLink to="/lottery" class="nav-link" active-class="active">{{ $t('nav.lottery') }}</RouterLink>
          <RouterLink to="/lookup" class="nav-link" active-class="active">{{ $t('nav.lookup') }}</RouterLink>
          <RouterLink to="/refer" class="nav-link" active-class="active">{{ $t('nav.refer') }}</RouterLink>
        </nav>
        <button
          v-if="showHeaderRecharge"
          class="btn btn-primary header-recharge"
          type="button"
          @click="openRecharge"
        >{{ $t('nav.recharge') }}</button>
        <select class="lang-select" :value="locale" @change="handleLanguageChange">
          <option value="zh-CN">{{ $t('nav.languageZh') }}</option>
          <option value="en">{{ $t('nav.languageEn') }}</option>
        </select>
      </div>
    </template>

    <!-- H5 Browser: brand + tabs -->
    <template v-else>
      <div class="h5-header">
        <RouterLink :to="homePath" class="brand">
          <img v-if="brandLogoUrl" :src="brandLogoUrl" alt="" class="brand-logo" />
          <span>{{ brandName }}</span>
        </RouterLink>
        <div class="h5-header-actions">
          <nav class="h5-tabs">
            <RouterLink :to="homePath" class="tab-link" active-class="active">{{ $t('nav.products') }}</RouterLink>
            <RouterLink to="/redeem" class="tab-link" active-class="active">{{ $t('nav.redeem') }}</RouterLink>
            <RouterLink to="/lottery" class="tab-link" active-class="active">{{ $t('nav.lottery') }}</RouterLink>
            <RouterLink to="/lookup" class="tab-link" active-class="active">{{ $t('nav.lookup') }}</RouterLink>
            <RouterLink to="/refer" class="tab-link" active-class="active">{{ $t('nav.refer') }}</RouterLink>
          </nav>
          <button
            v-if="showHeaderRecharge"
            class="btn btn-primary header-recharge"
            type="button"
            @click="openRecharge"
          >{{ $t('nav.recharge') }}</button>
          <select class="lang-select" :value="locale" @change="handleLanguageChange">
            <option value="zh-CN">{{ $t('nav.languageZh') }}</option>
            <option value="en">{{ $t('nav.languageEn') }}</option>
          </select>
        </div>
      </div>
    </template>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlatform } from '@/composables/usePlatform'
import { useShopConfig } from '@/composables/useShopConfig'
import { useRecharge } from '@/composables/useRecharge'
import { useStorefrontContext } from '@/composables/useStorefrontContext'
import { switchLanguage } from '@/i18n'

const { locale } = useI18n()
const { isTelegram, isMobile } = usePlatform()
const { shopName, balanceRechargeEnabled } = useShopConfig()
const { openRecharge } = useRecharge()
const { storefront, homePath: storefrontHomePath } = useStorefrontContext()
const homePath = computed(() => storefrontHomePath.value)
const brandName = computed(() => storefront.value?.name || shopName.value)
const brandLogoUrl = computed(() => storefront.value?.logoUrl || '')
const showHeaderRecharge = computed(() => balanceRechargeEnabled.value && !(isTelegram.value && isMobile.value))
const headerClass = computed(() => ({
  'is-telegram': isTelegram.value,
  'is-mobile': isMobile.value,
}))

function handleLanguageChange(e: Event) {
  const lang = (e.target as HTMLSelectElement).value as 'zh-CN' | 'en'
  switchLanguage(lang)
}
</script>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 500;
  background: var(--tg-header-bg);
  box-shadow: 0 1px 0 var(--border);
  isolation: isolate;
}

.header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -10px;
  height: 10px;
  pointer-events: none;
  background: linear-gradient(to bottom, var(--tg-header-bg), rgba(var(--tg-bg-rgb), 0));
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--tg-text);
}

.brand-logo {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: var(--r-sm);
  object-fit: contain;
}

.brand span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-header-actions,
.tg-desktop-header-actions {
  display: flex;
  align-items: center;
  min-width: 0;
}

.h5-header-actions {
  gap: 6px;
  flex: 0 0 auto;
}

.h5-header-actions .h5-tabs {
  flex: 0 0 auto;
}

.tg-desktop-header-actions {
  justify-content: flex-end;
}

.tg-desktop-header-actions .tg-desktop-nav {
  flex: 0 0 auto;
}

.tg-desktop-header-actions .header-recharge {
  margin-right: 20px;
}

.header-recharge {
  flex: 0 0 auto;
  padding: 6px 12px;
  font-size: 13px;
}

/* 语言切换下拉框 */
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
  flex: 0 0 auto;
}
.lang-select:focus-visible {
  border-color: var(--tg-link);
}
.lang-select option {
  background: var(--tg-secondary-bg);
  color: var(--tg-text);
}

@media (max-width: 420px) {
  .h5-header-actions {
    gap: 2px;
  }

  .header-recharge {
    padding-inline: 9px;
  }
}
</style>
