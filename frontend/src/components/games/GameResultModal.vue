<template>
  <Teleport to="body">
    <div v-if="show" class="game-result-overlay" @click.self="emit('close')">
      <div class="game-result-modal">
        <button class="result-close" @click="emit('close')">✕</button>

        <div class="result-icon">✅</div>
        <h2 class="result-title">参与成功！</h2>
        <p class="result-hint">开奖后将通过邮件通知您，请留意查收</p>
        <div class="result-actions">
          <button class="btn btn-primary" @click="emit('close')">知道了</button>
          <button class="btn btn-ghost" @click="copyShareLink">📤 分享活动</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { writeClipboardText } from '@/composables/useClipboard'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

function copyShareLink() {
  writeClipboardText(window.location.href)
}
</script>

<style scoped>
.game-result-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.game-result-modal { background: var(--tg-bg); border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 90%; text-align: center; position: relative; animation: modalIn .3s ease; }
.result-close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--tg-hint); }
.result-icon { font-size: 48px; margin-bottom: 12px; }
.result-title { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
.result-hint { font-size: 14px; color: var(--tg-hint); margin-bottom: 16px; }
.result-actions { display: flex; gap: 8px; justify-content: center; }
@keyframes modalIn { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: scale(1); } }
</style>