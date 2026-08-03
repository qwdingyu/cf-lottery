<template>
  <div class="app">
    <main class="app-main">
      <RouterView />
    </main>
    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useHandleSignInCallback, useLogto } from '@logto/vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const { showToast } = useToast()

// Logto 登录回调处理：当 Logto 登录成功后回调到 SPA，
// 携带 code 和 state 参数，用 useHandleSignInCallback 获取 ID Token，
// 然后调用后端 /auth/logto-exchange 交换自签 JWT。
onMounted(() => {
  const url = new URL(window.location.href)
  if (url.searchParams.has('code') && url.searchParams.has('state')) {
    handleLogtoCallback()
  }
})

async function handleLogtoCallback() {
  try {
    const { isAuthenticated } = await useHandleSignInCallback()
    if (isAuthenticated) {
      const logto = useLogto()
      const accessToken = await logto.getAccessToken()
      if (accessToken) {
        const res = await fetch('/api/auth/logto-exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: accessToken }),
        })
        const data = await res.json()
        if (data.ok && data.token) {
          localStorage.setItem('admin_token', data.token)
          // 区分页面：管理后台登录页 → 跳转 /admin；活动页 → 通知 LotteryView 自动参与
          if (window.location.pathname.includes('/lottery/')) {
            sessionStorage.setItem('logto_email', data.email)
            window.dispatchEvent(new CustomEvent('logto-login-success', { detail: { email: data.email, token: data.token } }))
          } else {
            showToast('Logto 登录成功')
            router.push('/admin')
          }
          return
        }
      }
    }
    showToast('Logto 登录失败', 'error')
  } catch (err) {
    console.error('[logto] callback error:', err)
    showToast('Logto 登录失败', 'error')
  }
}
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