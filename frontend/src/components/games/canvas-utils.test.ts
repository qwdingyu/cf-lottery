import { describe, expect, it } from 'vitest'
import { cappedDevicePixelRatio } from './canvas-utils'

describe('cappedDevicePixelRatio', () => {
  it('无 window 或 devicePixelRatio 缺失 → 1', () => {
    expect(cappedDevicePixelRatio(null)).toBe(1)
    expect(cappedDevicePixelRatio({})).toBe(1)
    expect(cappedDevicePixelRatio({ devicePixelRatio: 0 })).toBe(1)
    expect(cappedDevicePixelRatio({ devicePixelRatio: -1 })).toBe(1)
  })
  it('正常 dpr 直接返回', () => {
    expect(cappedDevicePixelRatio({ devicePixelRatio: 1 })).toBe(1)
    expect(cappedDevicePixelRatio({ devicePixelRatio: 1.5 })).toBe(1.5)
  })
  it('dpr > 2 截断为 2', () => {
    expect(cappedDevicePixelRatio({ devicePixelRatio: 2 })).toBe(2)
    expect(cappedDevicePixelRatio({ devicePixelRatio: 3 })).toBe(2)
    expect(cappedDevicePixelRatio({ devicePixelRatio: 4 })).toBe(2)
  })
})
