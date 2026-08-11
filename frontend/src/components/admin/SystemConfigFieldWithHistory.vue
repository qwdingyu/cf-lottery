<template>
  <div class="config-field-stack">
    <ConfigField
      :item="item"
      :value="value"
      :primary="primary"
      :status="status"
      @change="(key, nextValue) => $emit('change', key, nextValue)"
      @reset="(key) => $emit('reset', key)"
    />
    <div class="config-field-history-row">
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        :disabled="status === 'saving'"
        @click="$emit('history', item.key)"
      >
        {{ $t('adminConfigField.history') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import ConfigField from '@usethink/cf-admin-fe/components/ConfigField.vue'
import type { AdminSystemConfigDefinition } from '@/types/admin'

type ConfigFieldStatus = 'idle' | 'saving' | 'saved' | 'error'

defineProps<{
  item: AdminSystemConfigDefinition
  value: string
  primary?: boolean
  status?: ConfigFieldStatus
}>()

defineEmits<{
  change: [key: string, value: string]
  reset: [key: string]
  history: [key: string]
}>()
</script>

<style scoped>
.config-field-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.config-field-history-row {
  display: flex;
  justify-content: flex-end;
}
</style>
