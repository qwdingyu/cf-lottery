/**
 * body 滚动锁定（docs/162 P2-4）：
 * 前端多处弹窗（登录/结果/支付/查结果）打开时，iOS 边缘橡皮筋滚动会穿透到背景页。
 * 用溢出计数实现多弹窗栈安全：仅第一个 open 时 lock，最后一个 close 时 unlock。
 *
 * 纯函数：计数器逻辑与 DOM 操作解耦，可单测核心状态；domLock / domUnlock 在 Node 测
 * 环境下被 nop 守卫。
 */

let lockCount = 0

function resetCount(value: number) {
  lockCount = value
}
const domLock = () => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = 'hidden'
}
const domUnlock = () => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = ''
}

/** 锁定 body 滚动（打开弹窗时调用）。多弹窗叠加 idempotent；锁状态只切一次。 */
export function lockBodyScroll(): void {
  lockCount++
  if (lockCount === 1) domLock()
}

/** 解锁 body 滚动（关闭弹窗时调用）。计数器归零时才真正恢复滚动。 */
export function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) domUnlock()
  // 负数防御：异常卸载时强制归零
  else if (lockCount < 0) {
    lockCount = 0
    domUnlock()
  }
}

/** 立即重置计数器并解锁（组件 Unmounted 时兜底，防止计数器残留导致永久锁定）。 */
export function forceUnlockBodyScroll(): void {
  resetCount(0)
  domUnlock()
}

/**
 * 【仅测试用】返回当前锁定计数。
 * 不要在生产代码中使用。
 */
export function getBodyScrollLockCount(): number {
  return lockCount
}
