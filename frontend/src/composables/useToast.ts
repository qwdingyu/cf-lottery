import { ref } from 'vue'

type ToastType = 'success' | 'error' | 'info'

const toasts = ref<Array<{ id: number; message: string; type: ToastType }>>([])
let count = 0

const MAX_TOASTS = 5

function showToast(message: string, type: ToastType = 'info', duration = 3000) {
  const id = ++count
  // 堆叠上限：超过 MAX_TOASTS 条时移除最旧的
  if (toasts.value.length >= MAX_TOASTS) {
    toasts.value.shift()
  }
  toasts.value.push({ id, message, type })
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }, duration)
}

export function useToast() {
  return {
    toasts,
    showToast,
  }
}
