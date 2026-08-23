<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="toolbar-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ $t('platformL2Menus.refresh') }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">
        {{ $t('platformL2Menus.retry') }}
      </button>
    </div>

    <div v-if="!loadError" class="config-section">
      <div class="config-section-head">
        <div>
          <h3>{{ $t('platformL2Menus.title') }}</h3>
          <p>{{ $t('platformL2Menus.desc') }}</p>
        </div>
      </div>

      <div class="l2-menu-grid">
        <label
          v-for="item in menuCatalog"
          :key="item.key"
          class="l2-menu-item"
          :class="{ 'l2-menu-item--disabled': disabledSet.has(item.key) }"
        >
          <input
            v-model="disabledSet"
            type="checkbox"
            :value="item.key"
            :disabled="saving"
          />
          <span class="l2-menu-item-label">{{ item.label }}</span>
          <span class="l2-menu-item-key">{{ item.key }}</span>
        </label>
      </div>

      <div class="config-actions">
        <button
          class="btn btn-primary btn-sm"
          type="button"
          :disabled="saving || !dirty"
          @click="save"
        >
          {{ saving ? $t('platformL2Menus.saving') : $t('platformL2Menus.save') }}
        </button>
        <span v-if="saveStatus" class="config-status" :class="saveStatusOk ? 'config-status--success' : 'config-status--error'">
          {{ saveStatus }}
        </span>
      </div>

      <p class="config-help">{{ $t('platformL2Menus.effect') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminRequest } from '@/composables/useAdminRequest'
import { useToast } from '@usethink/cf-admin-fe/composables'

const { t } = useI18n()
const { showToast } = useToast()

const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const saveStatus = ref('')
const saveStatusOk = ref(true)

/** 菜单目录（后端返回，含 key + label，与后端 l2-menu-keys 同源） */
const menuCatalog = ref<Array<{ key: string; label: string }>>([])
/** 勾选中的禁用菜单集合（勾选 = 该菜单对 L2 隐藏） */
const disabledSet = ref<Set<string>>(new Set())

const dirty = computed(() => {
  if (!menuCatalog.value.length) return false
  const stored = new Set<string>(JSON.parse(localStorage.getItem('l2_menus_snapshot') || '[]'))
  if (stored.size !== disabledSet.value.size) return true
  for (const key of stored) if (!disabledSet.value.has(key)) return true
  return false
})

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ menuCatalog: Array<{ key: string; label: string }>; disabledMenus: string[] }>(
      '/api/platform/l2-menus',
    )
    menuCatalog.value = data.menuCatalog || []
    disabledSet.value = new Set(data.disabledMenus || [])
    // 快照用于 dirty 判断：仅当本次会话修改过才允许保存
    localStorage.setItem('l2_menus_snapshot', JSON.stringify(data.disabledMenus || []))
    saveStatus.value = ''
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  saveStatus.value = ''
  try {
    const disabledMenus = [...disabledSet.value]
    const data = await adminRequest<{ disabledMenus: string[] }>('/api/platform/l2-menus', {
      method: 'PATCH',
      body: JSON.stringify({ disabledMenus }),
    })
    disabledSet.value = new Set(data.disabledMenus)
    localStorage.setItem('l2_menus_snapshot', JSON.stringify(data.disabledMenus))
    saveStatusOk.value = true
    saveStatus.value = t('platformL2Menus.saved')
    showToast(t('platformL2Menus.saved'), 'success')
  } catch (err) {
    saveStatusOk.value = false
    saveStatus.value = err instanceof Error ? err.message : String(err)
    showToast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.l2-menu-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin: 12px 0;
}
.l2-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.l2-menu-item--disabled {
  border-color: var(--danger-color, #e05c5c);
  background: rgba(224, 92, 92, 0.06);
}
.l2-menu-item-label {
  font-weight: 500;
  font-size: 12px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.l2-menu-item-key {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted, #888);
  white-space: nowrap;
}
.config-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.config-help {
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-muted, #888);
}
.config-status--success {
  color: var(--success-color, #2e9e5b);
}
.config-status--error {
  color: var(--danger-color, #e05c5c);
}
</style>
