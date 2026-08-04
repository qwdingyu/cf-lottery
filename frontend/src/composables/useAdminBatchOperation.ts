import { ref } from 'vue'

/**
 * 管理台批量写操作（顺序执行 + 进度）。
 *
 * 为什么：Turso/CF free 下顺序打单条 API 可审计、不易打爆；
 * 与 useTableSelection / bulk-bar 配套，避免各页手写 for 循环丢进度。
 * 对齐 cf-shop useAdminBatchOperation。
 */
export interface AdminBatchOperationResult<T> {
  total: number
  success: number
  failed: number
  failedItems: T[]
}

export function useAdminBatchOperation() {
  const operating = ref(false)
  const completed = ref(0)
  const total = ref(0)

  async function runSequential<T>(
    items: T[],
    action: (item: T) => Promise<void>,
  ): Promise<AdminBatchOperationResult<T> | null> {
    // 防重复点击：上一批未结束时直接拒绝
    if (operating.value) return null
    operating.value = true
    completed.value = 0
    total.value = items.length
    const result: AdminBatchOperationResult<T> = {
      total: items.length,
      success: 0,
      failed: 0,
      failedItems: [],
    }

    try {
      for (const item of items) {
        try {
          await action(item)
          result.success += 1
        } catch {
          result.failed += 1
          result.failedItems.push(item)
        } finally {
          completed.value += 1
        }
      }
      return result
    } finally {
      operating.value = false
    }
  }

  return {
    operating,
    completed,
    total,
    runSequential,
  }
}
