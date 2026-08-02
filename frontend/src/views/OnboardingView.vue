<template>
  <div class="onboarding-page">
    <div class="onboarding-card">
      <div class="onboarding-hero">
        <div class="onboarding-icon">🎯</div>
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

        <p v-if="error" class="onboarding-error">{{ error }}</p>
      </form>

      <div class="onboarding-footer">
        <a href="#" class="btn btn-ghost btn-sm" @click.prevent="handleSkip">{{ $t('onboarding.skip') }}</a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAdminAuth } from '@/composables/useAdminAuth'

const router = useRouter()
const { t } = useI18n()
const { token, setToken } = useAdminAuth()
const tenantName = ref('')
const creating = ref(false)
const error = ref('')

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
      router.replace('/admin')
    } else {
      error.value = data.message || t('onboarding.createFailed')
    }
  } catch {
    error.value = t('onboarding.networkError')
  } finally {
    creating.value = false
  }
}

function handleSkip() {
  // 允许暂不创建租户离开（如 registered 参与者只参与活动、无需管理后台）。
  // 后续访问 /admin 时路由守卫会再次引导 onboarding。
  router.replace('/')
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
  height: 42px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.field-label input:focus {
  border-color: var(--admin-accent, #f59e0b);
}

.field-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}

.onboarding-btn {
  height: 44px;
  font-size: 15px;
  border-radius: 8px;
  width: 100%;
}

.onboarding-error {
  font-size: 13px;
  color: var(--tg-danger, #ef4444);
  text-align: center;
  margin: 0;
}

.onboarding-footer {
  margin-top: 20px;
  text-align: center;
}
</style>
