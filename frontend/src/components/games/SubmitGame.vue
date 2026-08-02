<template>
  <div class="submit-game">
    <button
      class="btn btn-primary btn-lg submit-btn"
      :disabled="disabled || loading"
      @click="emit('play')"
    >
      {{ loading ? $t('lottery.gameSubmitSubmitting') : $t('lottery.gameSubmitJoin') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { GameProps, GameEmits } from './types'

const props = defineProps<GameProps>()
const emit = defineEmits<GameEmits>()
</script>

<style scoped>
.submit-game { display: flex; justify-content: center; padding: 20px 0; }
.submit-btn { min-width: 200px; font-size: 16px; padding: 12px 32px; }
</style>