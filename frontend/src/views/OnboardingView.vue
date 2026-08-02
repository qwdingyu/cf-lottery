<template>
  <div class="admin-login">
    <div class="login-card">
      <h1 class="login-title">欢迎使用抽奖活动平台</h1>
      <p class="login-subtitle">创建你的第一个工作空间，开始搭建活动</p>

      <form class="login-form" @submit.prevent="handleCreate">
        <label class="field-label">
          <span>工作空间名称</span>
          <input v-model="tenantName" type="text" placeholder="例如：我的团队" :disabled="creating" autofocus />
        </label>
        <button class="btn btn-primary login-btn" type="submit" :disabled="creating || !tenantName.trim()">
          {{ creating ? '创建中…' : '创建工作空间' }}
        </button>
        <p v-if="error" class="login-error">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminAuth } from '@/composables/useAdminAuth'

const router = useRouter()
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
      setToken(data.token)  // 切换到新租户的 JWT
      router.replace('/admin')
    } else {
      error.value = data.message || '创建失败'
    }
  } catch {
    error.value = '网络错误'
  } finally {
    creating.value = false
  }
}
</script>
