<template>
  <div class="form-game">
    <p class="form-hint">{{ $t('lottery.gameFormHint') }}</p>
    <div class="form-fields">
      <label class="form-field">
        <span>{{ $t('lottery.gameFormNameLabel') }}</span>
        <input v-model="name" type="text" :placeholder="$t('lottery.gameFormNamePlaceholder')" maxlength="50" :disabled="disabled || loading" />
      </label>
      <label class="form-field">
        <span>{{ $t('lottery.gameFormEmailLabel') }}</span>
        <input v-model="email" type="email" :placeholder="$t('lottery.gameFormEmailPlaceholder')" maxlength="120" :disabled="disabled || loading" />
      </label>
    </div>
    <button class="btn btn-primary btn-lg form-btn" :disabled="disabled || loading || !name || !email" @click="submit">
      {{ loading ? $t('lottery.submitting') : $t('lottery.submit') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { GameProps, GameEmits } from './types'

defineProps<GameProps>()
const emit = defineEmits<GameEmits>()

const name = ref('')
const email = ref('')

function submit() {
  if (!name.value || !email.value) return
  emit('play')
}
</script>

<style scoped>
.form-game { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px 0; }
.form-hint { color: var(--tg-hint, #9aa4b2); font-size: 14px; }
.form-fields { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 320px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-field span { font-size: 13px; color: var(--tg-hint, #9aa4b2); }
.form-field input {
  padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border, rgba(255,255,255,0.1));
  background: var(--tg-bg, #1f2937); color: var(--tg-text, #f3f4f6); font-size: 14px;
}
.form-btn { min-width: 200px; margin-top: 8px; }
</style>