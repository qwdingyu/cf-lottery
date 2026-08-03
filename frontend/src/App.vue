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
      // 获取 ID Token（logto SDK 的 getIdTokenClaims 返回 decoded claims，
      // 但后端需要原始 JWT 字符串。这里用 getAccessToken 获取 Access Token）
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
          showToast('Logto 登录成功')
          router.push('/admin')
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