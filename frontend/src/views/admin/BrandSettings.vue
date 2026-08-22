<template>
  <div class="card card-flat brand-settings">
    <h3>{{ $t('brand.title') }}</h3>

    <!-- ── 商户信息 ── -->
    <div class="form-section">
      <h4 class="section-title">{{ $t('brand.merchantInfo') }}</h4>
      <div class="form-row">
        <label>{{ $t('brand.merchantName') }}</label>
        <div class="input-group">
          <input v-model="editingName" maxlength="100" :placeholder="$t('brand.merchantName')" class="form-input" />
          <button class="btn btn-sm btn-primary" :disabled="savingName" @click="saveName">{{ $t('brand.save') }}</button>
        </div>
        <small class="hint">{{ $t('brand.merchantNameHint') }}</small>
        <small v-if="nameError" class="error">{{ nameError }}</small>
      </div>
    </div>

    <!-- ── 店铺链接 ── -->
    <div class="form-section">
      <h4 class="section-title">{{ $t('brand.shopLinkGroup') }}</h4>
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

    <!-- ── 品牌配置 ── -->
    <div class="form-section">
      <h4 class="section-title">{{ $t('brand.brandConfig') }}</h4>
      <div class="form-row">
        <label>{{ $t('brand.logo') }}</label>
        <div class="input-group">
          <input v-model="editingLogo" maxlength="500" :placeholder="$t('brand.logo')" class="form-input" />
        </div>
        <small class="hint">{{ $t('brand.logoHint') }}</small>
      </div>
      <div class="form-row">
        <label>{{ $t('brand.primaryColor') }}</label>
        <div class="input-group">
          <input v-model="editingPrimaryColor" maxlength="7" placeholder="#4F46E5" class="form-input" />
        </div>
        <small class="hint">{{ $t('brand.primaryColorHint') }}</small>
      </div>
      <div class="form-row">
        <label>{{ $t('brand.companyName') }}</label>
        <div class="input-group">
          <input v-model="editingCompanyName" maxlength="100" :placeholder="$t('brand.companyName')" class="form-input" />
        </div>
        <small class="hint">{{ $t('brand.companyNameHint') }}</small>
      </div>
      <div class="form-row">
        <label>{{ $t('brand.domain') }}</label>
        <div class="input-group">
          <input v-model="editingDomain" maxlength="200" :placeholder="$t('brand.domain')" class="form-input" />
        </div>
        <small class="hint">{{ $t('brand.domainHint') }}</small>
      </div>
      <div class="form-row input-group">
        <button class="btn btn-primary" :disabled="savingConfig" @click="saveBrandConfig">{{ $t('brand.saveConfig') }}</button>
        <small v-if="configError" class="error">{{ configError }}</small>
        <small v-if="configSuccess" class="success">{{ configSuccess }}</small>
      </div>
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
const editingCompanyName = ref('')
const editingLogo = ref('')
const editingPrimaryColor = ref('')
const editingDomain = ref('')
const editingSlug = ref('')
const savingName = ref(false)
const savingSlug = ref(false)
const savingConfig = ref(false)
const slugError = ref('')
const nameError = ref('')
const configError = ref('')
const configSuccess = ref('')
const copyFeedback = ref('')

function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  editingSlug.value = s
  slugError.value = ''
}

/** 构建完整请求体，包含所有字段（后端合并，前端全量发送避免清空） */
function buildPayload() {
  return {
    name: editingName.value.trim() || undefined,
    storeSlug: editingSlug.value,
    logo: editingLogo.value,
    primaryColor: editingPrimaryColor.value,
    companyName: editingCompanyName.value,
    domain: editingDomain.value,
  }
}

/** 校验自定义链接格式，无效时设置 slugError 并返回 false */
function validateSlug(): boolean {
  const v = editingSlug.value.trim().toLowerCase()
  if (v && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(v) && v.length > 1) {
    slugError.value = t('brand.slugInvalid')
    return false
  }
  // 自动转小写，与后端 normalization 一致
  editingSlug.value = v
  return true
}

async function saveName() {
  const v = editingName.value.trim()
  if (!v) { nameError.value = t('brand.saveFailed'); return }
  nameError.value = ''
  if (!validateSlug()) return
  savingName.value = true
  try {
    const r = await adminRequest<{ name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify(buildPayload()),
    })
    editingName.value = r.name || ''
  } catch (e: any) {
    nameError.value = e.message || t('brand.saveFailed')
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
  const data = await adminRequest<{ storeSlug?: string; name?: string; config?: Record<string, string>; shopFeatureEnabled?: boolean }>('/api/admin/brand')
  const slug = data.storeSlug || ''
  shopUrl.value = slug ? `${baseUrl}/shop/${slug}` : t('brand.notConfigured')
  shopFeatureEnabled.value = data.shopFeatureEnabled !== false
  editingName.value = data.name || ''
  editingSlug.value = slug
  const cfg = data.config || {}
  editingLogo.value = cfg.logo || ''
  editingPrimaryColor.value = cfg.primaryColor || ''
  editingCompanyName.value = cfg.companyName || ''
  editingDomain.value = cfg.domain || ''
}

async function saveSlug() {
  slugError.value = ''
  if (!validateSlug()) return
  savingSlug.value = true
  try {
    const r = await adminRequest<{ storeSlug?: string; name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify(buildPayload()),
    })
    editingName.value = r.name || ''
    editingSlug.value = r.storeSlug || ''
    shopUrl.value = r.storeSlug ? `${baseUrl}/shop/${r.storeSlug}` : ''
  } catch (e: any) {
    slugError.value = e.message || t('brand.saveFailed')
  } finally { savingSlug.value = false }
}

async function saveBrandConfig() {
  configError.value = ''
  configSuccess.value = ''
  if (!validateSlug()) { configError.value = t('brand.slugInvalid'); return }
  savingConfig.value = true
  try {
    const r = await adminRequest<{ config?: Record<string, string>; name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify(buildPayload()),
    })
    editingName.value = r.name || ''
    const cfg = r.config || {}
    editingLogo.value = cfg.logo || ''
    editingPrimaryColor.value = cfg.primaryColor || ''
    editingCompanyName.value = cfg.companyName || ''
    editingDomain.value = cfg.domain || ''
    configSuccess.value = t('brand.saveSuccess')
    setTimeout(() => { configSuccess.value = '' }, 3000)
  } catch (e: any) {
    configError.value = e.message || t('brand.saveFailed')
  } finally { savingConfig.value = false }
}

onMounted(load)
</script>

<style scoped>
.card { margin-bottom: 16px; }
.form-section { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.form-section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
.section-title { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: var(--text, #e0e0e0); }
.form-row { margin-bottom: 12px; }
.form-row:last-child { margin-bottom: 0; }
.input-group { display: flex; gap: 8px; align-items: center; }
.form-input { flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:4px; }
.hint { font-size: 12px; color: var(--muted, #9aa4b2); }
.error { font-size: 12px; color: var(--danger, #e11d48); }
.success { font-size: 12px; color: var(--success, #0a7); }
</style>