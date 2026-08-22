/**
 * CTA 曝光去重追踪器（docs/262 T4：补充去重逻辑测试覆盖）
 *
 * 设计意图：同一 draw + mode 组合仅记录一次曝光事件，防止 watch
 * 因响应式依赖变化多次触发导致重复写入 activity_events。
 *
 * 用法：创建 tracker 实例，在 watch 回调中调用 tracker.track(key)，
 * 返回 true 表示首次曝光（应写入事件），false 表示已曝光过（跳过）。
 */

export function createCtaImpressionTracker() {
  const tracked = new Set<string>()

  return {
    /** 标记并返回是否为首次曝光 */
    track(key: string): boolean {
      if (tracked.has(key)) return false
      tracked.add(key)
      return true
    },
    /** 已曝光 key 数量（仅用于测试断言） */
    get size() { return tracked.size },
    /** 重置（仅用于测试） */
    reset() { tracked.clear() },
  }
}
