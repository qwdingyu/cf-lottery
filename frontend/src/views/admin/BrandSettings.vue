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

// ── 店铺链接 ──
const shopUrl = ref('')
const shopFeatureEnabled = ref(true)

// ── 商户信息（editingName → tenant.name） ──
const editingName = ref('')

// ── 品牌配置（editing* → tenant.brandConfig 中的字段） ──
// 这四个字段与 PUT /brand 的 config 体对应，后端合并更新
const editingCompanyName = ref('')
const editingLogo = ref('')
const editingPrimaryColor = ref('')
const editingDomain = ref('')

// ── 自定义链接（editingSlug → tenant.storeSlug） ──
const editingSlug = ref('')

// ── 保存状态（分别控制按钮 disabled） ──
// 三组操作共享同一个 PUT /brand 端点，但按钮的 loading 状态各自独立
const savingName = ref(false)
const savingSlug = ref(false)
const savingConfig = ref(false)

// ── 错误/成功提示 ──
// slugError 由 validateSlug 设置，在自定义链接行显示
// nameError 在商户名称行显示
// configError/configSuccess 在品牌配置保存按钮行显示
const slugError = ref('')
const nameError = ref('')
const configError = ref('')
const configSuccess = ref('')
const copyFeedback = ref('')

/** 生成随机 8 位小写字母数字组合作为自定义链接建议值 */
function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  editingSlug.value = s
  slugError.value = ''
}

/**
 * 构建完整请求体，包含所有字段
 * 三个保存按钮（saveName/saveSlug/saveBrandConfig）都调用此函数，确保全量发送。
 * 后端 PUT /brand 会合并配置，未提供的字段保留原值，因此前端不必担心「只改一个字段导致其他字段清空」。
 *
 * name 为空时发送 undefined（JSON.stringify 自动移除该 key），
 * 后端收到 undefined 后不会更新 tenant.name，保留数据库原值。
 */
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

/**
 * 校验自定义链接格式，无效时设置 slugError 并返回 false
 *
 * 规则：
 * - 只能包含小写字母、数字和短横线
 * - 短横线不能在首尾（如 -abc、abc- 非法）
 * - 单个字符（如 "a"）合法
 * - 自动转小写，与后端 normalization（system-config-registry.ts）一致
 * - 空字符串合法（留空 = 使用默认值）
 */
function validateSlug(): boolean {
  const v = editingSlug.value.trim().toLowerCase()
  // 正则要求至少 2 字符；v.length > 1 条件绕过单字符限制
  if (v && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(v) && v.length > 1) {
    slugError.value = t('brand.slugInvalid')
    return false
  }
  // 自动转小写，与后端 normalization 一致
  editingSlug.value = v
  return true
}

/** 保存商户名称 */
async function saveName() {
  const v = editingName.value.trim()
  if (!v) { nameError.value = t('brand.merchantNameRequired'); return }
  nameError.value = ''
  // 虽只需保存名称，但 buildPayload 全量发送所有字段，slug 格式必须合法
  if (!validateSlug()) return
  savingName.value = true
  try {
    const r = await adminRequest<{ name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify(buildPayload()),
    })
    // 从响应同步名称（后端返回 name: name || tenant.name，始终为实际值）
    editingName.value = r.name || ''
  } catch (e: any) {
    nameError.value = e.message || t('brand.saveFailed')
  } finally { savingName.value = false }
}

/** 复制店铺链接到剪贴板 */
async function copyShopUrl() {
  try {
    await navigator.clipboard.writeText(shopUrl.value)
  } catch {
    // Clipboard API 不可用时回退到传统 execCommand
    const input = document.querySelector('.brand-settings input[readonly]') as HTMLInputElement
    if (input) { input.select(); document.execCommand('copy') }
  }
  copyFeedback.value = t('brand.copied')
  setTimeout(() => { copyFeedback.value = '' }, 2000)
}

/**
 * 加载页面数据
 * 注意：API 失败时无错误处理（onMounted 调用，无法捕获），
 * 这沿用原始代码风格，保持与项目其他页面一致。
 */
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

/** 保存自定义链接 */
async function saveSlug() {
  slugError.value = ''
  if (!validateSlug()) return
  savingSlug.value = true
  try {
    const r = await adminRequest<{ storeSlug?: string; name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify(buildPayload()),
    })
    // 同步名称与链接，避免「保存链接后名称未刷新」的显示不一致
    editingName.value = r.name || ''
    editingSlug.value = r.storeSlug || ''
    shopUrl.value = r.storeSlug ? `${baseUrl}/shop/${r.storeSlug}` : ''
  } catch (e: any) {
    slugError.value = e.message || t('brand.saveFailed')
  } finally { savingSlug.value = false }
}

/** 保存品牌配置（logo/primaryColor/companyName/domain） */
async function saveBrandConfig() {
  configError.value = ''
  configSuccess.value = ''
  // 品牌配置不涉及 slug，但 buildPayload 全量发送，slug 格式必须合法
  if (!validateSlug()) return
  savingConfig.value = true
  try {
    const r = await adminRequest<{ config?: Record<string, string>; name?: string }>('/api/admin/brand', {
      method: 'PUT',
      body: JSON.stringify(buildPayload()),
    })
    // 从响应同步名称 + 品牌配置字段
    editingName.value = r.name || ''
    const cfg = r.config || {}
    editingLogo.value = cfg.logo || ''
    editingPrimaryColor.value = cfg.primaryColor || ''
    editingCompanyName.value = cfg.companyName || ''
    editingDomain.value = cfg.domain || ''
    configSuccess.value = t('brand.saveSuccess')
    // 3 秒后自动清除成功提示
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