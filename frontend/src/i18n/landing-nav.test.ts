/**
 * 首页登录态导航依赖 landing 命名空间。
 * 这里锁住关键 key，避免页面回退显示 landing.xxx 这类原始键名。
 */
import { describe, expect, it } from 'vitest'
import zh from './zh-CN'
import en from './en'

describe('首页导航 i18n', () => {
  it('登录后店铺入口使用 landing.myShop', () => {
    expect(zh.landing.myShop).toBe('我的商铺')
    expect(en.landing.myShop).toBe('My Shop')
  })
})
