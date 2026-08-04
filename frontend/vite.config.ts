import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  envDir: '../',  // 读取根目录 .env（含 VITE_* 构建变量），避免重复定义 frontend/.env
  resolve: {
    dedupe: ['vue'],
    alias: {
      // Single Vue instance for @usethink/cf-admin-fe peer types
      vue: resolve(__dirname, '../node_modules/vue'),
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    target: 'es2020',
    outDir: '../public',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})