<template>
  <Teleport to="body">
    <div v-if="show" class="game-result-overlay" @click.self="emit('close')">
      <div class="game-result-modal" :class="winner ? 'winner' : 'consolation'">
        <button class="result-close" @click="emit('close')">✕</button>

        <!-- 中奖 -->
        <template v-if="winner">
          <div class="result-icon">🎉</div>
          <h2 class="result-title">恭喜中奖！</h2>
          <p class="result-prize">{{ prizeName }}</p>
          <div v-if="prizeCode" class="result-code">
            <span class="code-label">卡密：</span>
            <code>{{ prizeCode }}</code>
          </div>
          <div class="result-actions">
            <button class="btn btn-primary" @click="emit('close')">知道了</button>
            <button class="btn btn-ghost" @click="copyShareLink">📤 分享</button>
          </div>
        </template>

        <!-- 未中奖 -->
        <template v-else>
          <div class="result-icon">😢</div>
          <h2 class="result-title">差一点就中了！</h2>
          <p class="result-hint">送你一张优惠券，下次好运</p>
          <div v-if="couponCode" class="result-code">
            <span class="code-label">优惠券：</span>
            <code>{{ couponCode }}</code>
          </div>
          <div class="result-actions">
            <button class="btn btn-primary" @click="emit('close')">好的</button>
            <button v-if="productUrl" class="btn btn-ghost" @click="goToProduct">🛍️ 去逛逛</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { writeClipboardText } from '@/composables/useClipboard'

defineProps<{
  show: boolean
  winner: boolean
  prizeName?: string
  prizeCode?: string
  couponCode?: string
  productUrl?: string
}>()

const emit = defineEmits<{ close: [] }>()

function copyShareLink() {
  writeClipboardText(window.location.href)
}

function goToProduct() {
  // todo: 跳转商品链接
}
</script>

<style scoped>
.game-result-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.game-result-modal { background: var(--tg-bg); border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 90%; text-align: center; position: relative; animation: modalIn .3s ease; }
.result-close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--tg-hint); }
.result-icon { font-size: 48px; margin-bottom: 12px; }
.result-title { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
.result-prize { font-size: 16px; color: var(--tg-text); margin-bottom: 12px; }
.result-hint { font-size: 14px; color: var(--tg-hint); margin-bottom: 12px; }
.result-code { background: var(--tg-surface); padding: 8px 12px; border-radius: 8px; margin-bottom: 16px; display: inline-block; }
.code-label { font-size: 12px; color: var(--tg-hint); }
.result-actions { display: flex; gap: 8px; justify-content: center; }
.winner .result-title { color: #f59e0b; }
@keyframes modalIn { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: scale(1); } }
</style>