<template>
  <div class="card card-flat brand-settings">
    <h3>品牌设置</h3>
    <div class="form-row">
      <label>店铺链接</label>
      <div class="input-group">
        <input :value="shopUrl" readonly class="form-input" @focus="($event.target as HTMLInputElement).select()" />
        <button class="btn btn-sm" @click="copyShopUrl">复制</button>
      </div>
      <small class="hint">将此链接分享到 QQ/微信/群公告，用户点击即可看到您的所有公开活动</small>
    </div>
    <div class="form-row">
      <label>自定义链接</label>
      <div class="input-group">
        <input v-model="editingSlug" maxlength="30" placeholder="输入英文名如 my-store" class="form-input" />
        <button class="btn btn-sm" @click="generateSlug">随机</button>
        <button class="btn btn-sm btn-primary" :disabled="saving" @click="saveSlug">保存</button>
      </div>
      <small v-if="slugError" class="error">{{ slugError }}</small>
      <small v-else class="hint">留空保存默认值;只能包含字母数字和短横线;修改后旧链接立即失效</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminRequest } from '@/composables/useAdminRequest'

const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
const shopUrl = ref('')
const editingSlug = ref('')
const saving = ref(false)
const slugError = ref('')

function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  editingSlug.value = s
  slugError.value = ''
}

async function copyShopUrl() {
  try {
    await navigator.clipboard.writeText(shopUrl.value)
  } catch {
    const input = document.querySelector('.brand-settings input[readonly]') as HTMLInputElement
    if (input) { input.select(); document.execCommand('copy') }
  }
}

async function load() {
  const data = await adminRequest<{ storeSlug?: string; config?: any }>('/api/admin/brand')
  const slug = data.storeSlug || ''
  shopUrl.value = slug ? `${baseUrl}/shop/${slug}` : '(未配置,创建租户后自动生成)'
  editingSlug.value = slug
}

async function saveSlug() {
  const v = editingSlug.value.trim()
  if (v && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(v)) { slugError.value = '只能包含小写字母、数字和短横线'; return }
  saving.value = true; slugError.value = ''
  try {
    const r = await adminRequest<{ storeSlug?: string }>('/api/admin/brand', { method:'PUT', body: JSON.stringify({ storeSlug: v, logo:'', primaryColor:'', companyName:'', domain:'' }) })
    editingSlug.value = r.storeSlug || ''
    shopUrl.value = r.storeSlug ? `${baseUrl}/shop/${r.storeSlug}` : ''
  } catch(e:any) {
    slugError.value = e.message || '保存失败'
  } finally { saving.value = false }
}

onMounted(load)
</script>

<style scoped>
.card { margin-bottom: 16px; }
.form-row { margin-bottom: 12px; }
.input-group { display: flex; gap: 8px; align-items: center; }
.form-input { flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:4px; }
.hint { font-size: 12px; color: var(--muted); }
.error { font-size: 12px; color: var(--danger); }
</style>