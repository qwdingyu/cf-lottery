<template>
  <div class="app">
    <main class="app-main">
      <RouterView />
    </main>
    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
/**
 * 根壳：路由 + Toast。
 * 统一认证回调在 /auth/callback（cf-auth OAuth RP，docs/059）；不再挂 Logto SDK。
 */
import ToastContainer from '@usethink/cf-admin-fe/components/ToastContainer.vue'
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
