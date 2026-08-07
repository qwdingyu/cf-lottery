<template>
  <div class="admin-page">
    <div class="toolbar">
      <h2 class="page-title">支付设置</h2>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadData">刷新</button>
      </div>
    </div>

    <div v-if="loading" class="skeleton-list">
      <div class="skeleton-line w-60" />
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" @click="loadData">重试</button>
    </div>

    <div v-if="!loading && !loadError" class="provider-list">
      <div v-for="item in providers" :key="item.name" class="provider-card">
        <div class="provider-header">
          <div>
            <h3 class="provider-name">{{ item.displayName }}</h3>
            <p class="provider-desc">{{ item.description }}</p>
          </div>
          <span class="tag" :class="item.enabled ? 'tag-success' : 'tag-muted'">
            {{ item.enabled ? '已启用' : '未启用' }}
          </span>
        </div>

        <label class="toggle-row">
          <input type="checkbox" v-model="item.enabled" :disabled="saving" />
          <span>启用该收款方式</span>
        </label>

        <form class="provider-fields" @submit.prevent="saveProvider">
          <div v-for="field in item.fields" :key="field.key" class="form-field">
            <label class="form-label">{{ field.label }}<span v-if="field.required" class="req">*</span></label>
            <input
              :type="field.type === 'password' ? 'password' : 'text'"
              v-model="item.saved.fields[field.key]"
              class="form-input"
              :placeholder="field.placeholder || ''"
              :disabled="saving"
            />
            <small v-if="field.hint" class="field-hint">{{ field.hint }}</small>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="saving">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminRequest } from '@/composables/useAdminRequest'
import { useToast } from '@usethink/cf-admin-fe/composables'

const { showToast } = useToast()

interface ProviderFieldMeta {
  key: string
  label: string
  type?: string
  required: boolean
  sensitive: boolean
  placeholder?: string
  hint?: string
}

interface ProviderConfig {
  name: string
  displayName: string
  description: string
  supportedCurrencies: string[]
  fields: ProviderFieldMeta[]
  enabled: boolean
  configured: boolean
  saved: { enabled: boolean; fields: Record<string, string> }
}

const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const providers = ref<ProviderConfig[]>([])

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ providers: ProviderConfig[] }>('/api/admin/payment-config')
    providers.value = data.providers.map((p) => ({
      ...p,
      saved: p.saved || { enabled: !!p.enabled, fields: {} },
    }))
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function saveProvider() {
  if (saving.value) return
  saving.value = true
  try {
    await adminRequest('/api/admin/payment-config', {
      method: 'PUT',
      body: JSON.stringify({
        providers: providers.value.map((p) => ({
          name: p.name,
          enabled: p.enabled,
          fields: p.saved.fields,
        })),
      }),
    })
    showToast('支付配置已保存', 'success')
    await loadData()
  } catch (err) {
    showToast(err instanceof Error ? err.message : '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.provider-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.provider-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.provider-name { margin: 0 0 4px; font-size: 16px; }
.provider-desc { margin: 0; color: var(--muted); font-size: 13px; }
.toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.provider-fields { display: grid; gap: 12px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-label { font-size: 13px; }
.req { color: var(--danger); }
.form-input { padding: 8px; border: 1px solid var(--border); border-radius: 4px; }
.field-hint { color: var(--muted); font-size: 12px; }
.form-actions { display: flex; justify-content: flex-end; }
</style>