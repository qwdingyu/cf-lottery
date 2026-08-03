<template>
  <div class="form-game">
    <!--
      Form 体验：不另建一套姓名/邮箱（会与参与身份、activityConfig 脱节）。
      问卷字段在 LotteryView 的 activity-submission 区填写；此处只做诚实主 CTA。
    -->
    <p class="form-hint">{{ $t('lottery.gameFormHint') }}</p>
    <button
      type="button"
      class="btn btn-primary btn-lg form-btn"
      :disabled="disabled || loading"
      @click="emit('play')"
    >
      {{ loading ? $t('lottery.gameSubmitSubmitting') : $t('lottery.gameSubmitJoin') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { GameProps, GameEmits } from './types'

withDefaults(defineProps<GameProps>(), {
  disabled: false,
  loading: false,
  celebrateKey: 0,
})
const emit = defineEmits<GameEmits>()
</script>

<style scoped>
.form-game { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px 0; width: 100%; }
.form-hint { color: var(--tg-hint, #9aa4b2); font-size: 14px; text-align: center; padding: 0 12px; max-width: 28em; line-height: 1.45; }
.form-btn {
  min-width: min(200px, 80vw);
  min-height: 48px;
  margin-top: 4px;
  width: min(280px, 90vw);
}
</style>
