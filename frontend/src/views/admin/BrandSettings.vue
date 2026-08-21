<template>
  <div class="card card-flat brand-settings">
    <h3>{{ $t('brand.title') }}</h3>
    <div class="form-row">
      <label>{{ $t('brand.merchantName') }}</label>
      <div class="input-group">
        <input v-model="editingName" maxlength="100" :placeholder="$t('brand.merchantName')" class="form-input" />
        <button class="btn btn-sm btn-primary" :disabled="savingName" @click="saveName">{{ $t('brand.save') }}</button>
      </div>
      <small class="hint">{{ $t('brand.merchantNameHint') }}</small>
    </div>
    <div class="form-row">
      <label>{{ $t('brand.shopLink') }}</label>
      <div class="input-group">
        <input :value="shopUrl" readonly class="form-input" @focus="($event.target as HTMLInputElement).select()" />
        <button class="btn btn-sm" @click="copyShopUrl" :disabled="!!copyFeedback">{{ copyFeedback || $t('brand.copy') }}</button>
        <a
          v-if="shopFeatureEnabled && shopUrl && !shopUrl.includes($t('brand.notConfigured'))"
          :href="shopUrl"
          target="_blank"
          rel="noopener"
          class="btn btn-sm btn-primary"
        >{{ $t('brand.open') }}</a>
      </div>
      <small class="hint">{{ $t('brand.shopLinkHint') }}</small>
    </div>
    <div class="form-row">
      <label>{{ $t('brand.customLink') }}</label>
      <div class="input-group">
        <input v-model="editingSlug" maxlength="30" :placeholder="$t('brand.slugPlaceholder')" class="form-input" />
        <button class="btn btn-sm" @click="generateSlug">{{ $t('brand.random') }}</button>
        <button class="btn btn-sm btn-primary" :disabled="savingSlug" @click="saveSlug">{{ $t('brand.save') }}</button>
      </div>
      <small v-if="slugError" class="error">{{ slugError }}</small>
      <small v-else class="hint">{{ $t('brand.slugHint') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminRequest } from '@/composables/useAdminRequest'

const { t } = useI18n()
const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
const shopUrl = ref('')
const shopFeatureEnabled = ref(true)
const editingName = ref('')
const editingSlug = ref('')
const savingName = ref(false)
const savingSlug = ref(false)
const slugError = ref('')
const copyFeedback = ref('')

function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  editingSlug.value = s
  slugError.value = ''
}

async function saveName() {
  const v = editingName.value.trim()
  if (!v) return
  savingName.value = true
  try {
    const r = await adminRequest<{ name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify({ name: v, storeSlug: editingSlug.value, logo: '', primaryColor: '', companyName: '', domain: '' }),
    })
    editingName.value = r.name || ''
  } catch (e: any) {
    // silent
  } finally { savingName.value = false }
}

async function copyShopUrl() {
  try {
    await navigator.clipboard.writeText(shopUrl.value)
  } catch {
    const input = document.querySelector('.brand-settings input[readonly]') as HTMLInputElement
    if (input) { input.select(); document.execCommand('copy') }
  }
  copyFeedback.value = t('brand.copied')
  setTimeout(() => { copyFeedback.value = '' }, 2000)
}

async function load() {
  const data = await adminRequest<{ storeSlug?: string; name?: string; config?: any; shopFeatureEnabled?: boolean }>('/api/admin/brand')
  const slug = data.storeSlug || ''
  shopUrl.value = slug ? `${baseUrl}/shop/${slug}` : t('brand.notConfigured')
  shopFeatureEnabled.value = data.shopFeatureEnabled !== false
  editingName.value = data.name || ''
  editingSlug.value = slug
}

async function saveSlug() {
  const v = editingSlug.value.trim()
  if (v && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(v)) { slugError.value = t('brand.slugInvalid'); return }
  savingSlug.value = true; slugError.value = ''
  try {
    const r = await adminRequest<{ storeSlug?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify({ storeSlug: v, name: editingName.value, logo: '', primaryColor: '', companyName: '', domain: '' }),
    })
    editingSlug.value = r.storeSlug || ''
    shopUrl.value = r.storeSlug ? `${baseUrl}/shop/${r.storeSlug}` : ''
  } catch (e: any) {
    slugError.value = e.message || t('brand.saveFailed')
  } finally { savingSlug.value = false }
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