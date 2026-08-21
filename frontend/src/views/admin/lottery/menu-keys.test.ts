/**
 * 前端 L2 菜单目录镜像一致性测试：
 * 前端 menu-keys.ts 必须与后端 src/lib/l2-menu-keys.ts 的 L2_MENU_CATALOG 完全一致
 * （防命名漂移导致 L3 配置的 key 与前端菜单失配）。
 */
import { describe, expect, it } from 'vitest'
import { L2_MENU_CATALOG, filterL2MenusByDisabled } from './menu-keys'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('L2 菜单目录镜像一致性', () => {
  it('前端 L2_MENU_CATALOG 与后端 src/lib/l2-menu-keys.ts 完全一致', () => {
    // 读取后端常量源码，提取 L2_MENU_CATALOG 数组字面量（避免运行期 import 后端 TS 的路径复杂度）
    const backendFile = path.resolve(__dirname, '../../../../../src/lib/l2-menu-keys.ts')
    const source = fs.readFileSync(backendFile, 'utf8')
    const match = source.match(/export const L2_MENU_CATALOG: Array<\{ key: string; label: string \}> = \[([\s\S]*?)\];/)
    expect(match, '后端 L2_MENU_CATALOG 定义未找到，请检查 src/lib/l2-menu-keys.ts').not.toBeNull()
    const entries = [...(match?.[1] || '').matchAll(/\{ key: "([^"]+)", label: "([^"]+)" \}/g)].map((m) => ({ key: m[1], label: m[2] }))
    expect(entries.length).toBeGreaterThanOrEqual(12)
    expect(L2_MENU_CATALOG).toEqual(entries)
  })

  it('L2_MENU_KEYS 无重复', () => {
    const keys = L2_MENU_CATALOG.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('filterL2MenusByDisabled 正确过滤', () => {
    const filtered = filterL2MenusByDisabled(L2_MENU_CATALOG, ['AdminLogs', 'AdminMembers'])
    const keys = filtered.map((item) => item.key)
    expect(keys).not.toContain('AdminLogs')
    expect(keys).not.toContain('AdminMembers')
    expect(keys).toContain('AdminLottery')
    expect(keys.length).toBe(L2_MENU_CATALOG.length - 2)
  })

  it('空禁用列表 = 全部菜单可见（默认安全）', () => {
    const filtered = filterL2MenusByDisabled(L2_MENU_CATALOG, [])
    expect(filtered.length).toBe(L2_MENU_CATALOG.length)
  })
})
