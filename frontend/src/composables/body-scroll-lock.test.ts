import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  lockBodyScroll,
  unlockBodyScroll,
  forceUnlockBodyScroll,
  getBodyScrollLockCount,
} from './body-scroll-lock'

describe('bodyScrollLock 计数器逻辑', () => {
  beforeEach(() => {
    // 每测前归零（生产代码在 Node 环境默认无 document，domLock 被 nop 守护）
    forceUnlockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(0)
  })
  afterEach(() => forceUnlockBodyScroll())

  it('lock → 计数器累加；unlock → 递减；归零时 0', () => {
    lockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(1)
    lockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(2)
    unlockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(1)
    unlockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(0)
  })

  it('unlock 不会低于 0；低于 0 会强制归零', () => {
    unlockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(0)
    // 模拟异常状态
    for (let i = 0; i < 10; i++) unlockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(0)
  })

  it('forceUnlock 归零', () => {
    lockBodyScroll()
    lockBodyScroll()
    forceUnlockBodyScroll()
    expect(getBodyScrollLockCount()).toBe(0)
  })
})
