/**
 * 共享的当前时间 composable
 *
 * 多个组件（ProductCard、ProductConfirmSheet）需要展示倒计时时，
 * 共享同一个 60 秒定时器，避免 N 个组件创建 N 个 setInterval。
 *
 * 使用 ref 计数模式：仅当至少一个组件订阅时才启动定时器，
 * 所有组件卸载后自动清理。
 */
import { ref, onMounted, onUnmounted } from "vue";

const nowMs = ref(Date.now());
let timer: number | undefined;
let subscriberCount = 0;

export function useNow() {
  onMounted(() => {
    subscriberCount++;
    if (subscriberCount === 1) {
      timer = window.setInterval(() => {
        nowMs.value = Date.now();
      }, 60000);
    }
  });

  onUnmounted(() => {
    subscriberCount--;
    if (subscriberCount <= 0) {
      subscriberCount = 0;
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    }
  });

  return { nowMs };
}