<template>
  <div class="onboarding-page">
    <div class="onboarding-card">
      <!-- P3：L1/L2 入口选择 —— 注册后首先让用户明确身份 -->
      <template v-if="!roleChosen">
        <div class="onboarding-hero">
          <div class="onboarding-icon">🎯</div>
          <h1 class="onboarding-title">{{ $t('onboarding.welcomeTitle') }}</h1>
          <p class="onboarding-desc">{{ $t('onboarding.welcomeDesc') }}</p>
        </div>

        <div class="role-choice">
          <button type="button" class="role-card role-card--merchant" @click="chooseL2">
            <span class="role-icon">🏪</span>
            <span class="role-name">{{ $t('onboarding.roleMerchant') }}</span>
            <span class="role-desc">{{ $t('onboarding.roleMerchantDesc') }}</span>
          </button>
          <button type="button" class="role-card role-card--participant" @click="chooseL1">
            <span class="role-icon">🎟️</span>
            <span class="role-name">{{ $t('onboarding.roleParticipant') }}</span>
            <span class="role-desc">{{ $t('onboarding.roleParticipantDesc') }}</span>
          </button>
        </div>

        <div class="onboarding-footer">
          <button type="button" class="btn btn-ghost btn-sm" @click="handleLogout">{{ $t('onboarding.logout') }}</button>
        </div>
      </template>

      <!-- L2：商户创建工作空间表单 -->
      <template v-else>
        <div class="onboarding-hero">
          <div class="onboarding-icon">🏪</div>
          <h1 class="onboarding-title">{{ $t('onboarding.title') }}</h1>
          <p class="onboarding-desc">
            {{ $t('onboarding.descLine1') }}<br />
            {{ $t('onboarding.descLine2') }}
          </p>
        </div>

        <form class="onboarding-form" @submit.prevent="handleCreate">
          <label class="field-label">
            <span>{{ $t('onboarding.workspaceName') }}</span>
            <input
              v-model="tenantName"
              type="text"
              :placeholder="$t('onboarding.workspacePlaceholder')"
              maxlength="30"
              :disabled="creating"
              autofocus
            />
            <small class="field-hint">{{ $t('onboarding.workspaceHint') }}</small>
          </label>

          <button
            class="btn btn-primary onboarding-btn"
            type="submit"
            :disabled="creating || !tenantName.trim()"
          >
            {{ creating ? $t('onboarding.creating') : $t('onboarding.createButton') }}
          </button>
          <p class="onboarding-next-hint">{{ $t('onboarding.nextHint') }}</p>

          <p v-if="error" class="onboarding-error" role="alert">{{ error }}</p>
        </form>

        <div class="onboarding-footer">
          <a href="#" class="btn btn-ghost btn-sm" @click.prevent="roleChosen = false">{{ $t('onboarding.backToChoose') }}</a>
          <button type="button" class="btn btn-ghost btn-sm" @click="handleLogout">{{ $t('onboarding.logout') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { onboardingSuccessPath } from '@/composables/admin-list-ux'

const router = useRouter()
const { t } = useI18n()
const { token, setToken, clearToken } = useAdminAuth()
const { showToast } = useToast()

/** P3：L1/L2 入口选择状态 —— false 未选，true 已选商户路径 */
const roleChosen = ref(false)
const tenantName = ref('')
const creating = ref(false)
const error = ref('')

/** L1（参与者）：跳过 onboarding，直接回到首页参与活动 */
function chooseL1() {
  showToast(t('onboarding.l1Welcome'), 'success')
  router.replace('/')
}

/** L2（商户）：进入创建工作空间表单 */
function chooseL2() {
  roleChosen.value = true
}

async function handleCreate() {
  if (!tenantName.value.trim()) return
  creating.value = true
  error.value = ''
  try {
    const res = await fetch('/api/auth/create-tenant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token.value },
      body: JSON.stringify({ name: tenantName.value.trim() }),
    })
    const data = await res.json()
    if (data.ok && data.token) {
      setToken(data.token)
      // 上线前 UX：建完工作空间直接进「选模板创建活动」，少一次「运营台空态再点一次」。
      // ?new=true 由 AdminLotteryView onMounted 打开模板选择（docs/074）。
      showToast(t('onboarding.createSuccess'), 'success')
      router.replace(onboardingSuccessPath())
    } else {
      error.value = data.message || t('onboarding.createFailed')
    }
  } catch {
    error.value = t('onboarding.networkError')
  } finally {
    creating.value = false
  }
}

/** 退出登录：完整清业务会话，避免卡在「有 token 无租户」无法换号 */
function handleLogout() {
  clearToken()
  showToast(t('onboarding.loggedOut'), 'success')
  router.replace('/admin/login')
}
</script>

<style scoped>
.onboarding-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--tg-bg, #0a0e17);
  padding: 20px;
}

.onboarding-card {
  width: 100%;
  max-width: 440px;
  background: #1a1a2e;
  border-radius: 16px;
  padding: 40px 32px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.onboarding-hero {
  text-align: center;
  margin-bottom: 32px;
}

.onboarding-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.onboarding-title {
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  margin: 0 0 8px;
}

.onboarding-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.6;
  margin: 0;
}

/* P3：L1/L2 入口选择卡片 */
.role-choice {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.role-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 16px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  text-align: center;
}

.role-card:hover {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.08);
}

.role-card--merchant:hover {
  border-color: var(--admin-accent, #f59e0b);
}

.role-card--participant:hover {
  border-color: #10b981;
}

.role-icon {
  font-size: 28px;
}

.role-name {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
}

.role-desc {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  line-height: 1.4;
}

.onboarding-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label span {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  font-weight: 500;
}

.field-label input {
  min-height: 48px;
  height: 48px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font-size: 16px;
  outline: none;
  transition: border-color 0.2s;
}

.field-label input:focus {
  border-color: var(--admin-accent, #f59e0b);
}
.field-label input:focus-visible {
  outline: 2px solid var(--admin-accent, #f59e0b);
  outline-offset: 2px;
}

.field-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}

.onboarding-btn {
  min-height: 48px;
  height: 48px;
  font-size: 15px;
  border-radius: 8px;
  width: 100%;
}
.onboarding-btn:focus-visible {
  outline: 2px solid var(--admin-accent, #f59e0b);
  outline-offset: 2px;
}
.onboarding-next-hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.45);
  text-align: center;
}

.onboarding-error {
  font-size: 13px;
  color: var(--tg-danger, #ef4444);
  text-align: center;
  margin: 0;
}

.onboarding-footer {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
