<template>
  <div class="app">
    <main class="app-main">
      <RouterView />
    </main>
    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useHandleSignInCallback, useLogto } from '@logto/vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'

const router = useRouter()
const { showToast } = useToast()
const { setToken } = useAdminAuth()

// Logto 登录回调处理：useHandleSignInCallback 必须在 setup 顶层调用，
// 它自动检测 URL 中的 code/state 参数并完成 OIDC 回调流程。
// 不能在 onMounted 中调用（hooks 不支持 composable 嵌套调用）。
const { isAuthenticated } = useHandleSignInCallback()

// 监听认证状态变化：当 Logto 回调处理完成后，isAuthenticated 变为 true
watch(isAuthenticated, async (val) => {
  if (!val) return
  try {
    const logto = useLogto()
    const accessToken = await logto.getAccessToken()
    if (!accessToken) {
      showToast('Logto 登录失败', 'error')
      return
    }
    const res = await fetch('/api/auth/logto-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: accessToken }),
    })
    const data = await res.json()
    if (!data.ok || !data.token) {
      showToast(data.message || 'Logto 登录失败', 'error')
      return
    }
    setToken(data.token)
    // 与 cf-auth 对齐：参与页也写 lottery_registered_token（公开 Bearer 路径）
    if (data.token) {
      sessionStorage.setItem('lottery_registered_token', data.token)
      if (data.email) {
        sessionStorage.setItem('lottery_session_email', data.email)
        sessionStorage.setItem('logto_email', data.email)
      }
    }
    // 区分页面：管理后台登录页 → 跳转 /admin；活动页 → 通知 LotteryView 自动参与
    if (window.location.pathname.includes('/lottery/')) {
      window.dispatchEvent(new CustomEvent('logto-login-success', { detail: { email: data.email, token: data.token } }))
    } else {
      // Logto 交换 JWT 通常无 tenantId；与路由守卫一致，空租户进 onboarding
      showToast('Logto 登录成功')
      try {
        const parts = String(data.token).split('.')
        const b64 = (parts[1] || '').replace(/-/g, '+').replace(/_/g, '/')
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
        const payload = JSON.parse(atob(b64 + pad)) as { tenantId?: string }
        if (!String(payload.tenantId || '').trim()) {
          router.push('/admin/onboarding')
          return
        }
      } catch { /* 解析失败仍走 /admin，守卫会再拦 */ }
      router.push('/admin')
    }
  } catch (err) {
    console.error('[logto] callback error:', err)
    showToast('Logto 登录失败', 'error')
  }
})
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-main {
  flex: 1;
}
</style>
