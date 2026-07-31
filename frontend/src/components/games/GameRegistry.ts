/**
 * 游戏注册表 — 可插拔游戏引擎核心。
 *
 * 每种参与模式映射到一个游戏组件，新增游戏只需在此注册。
 * 游戏组件实现统一接口：接收 prizes/disabled/mode/draw props，emit play 事件。
 */
import { defineAsyncComponent, type Component } from 'vue'

/** 参与模式 → 游戏组件的映射 */
const GAME_MAP: Record<string, () => Promise<Component>> = {
  'open':        () => import('./WheelGame.vue'),      // 大转盘
  'invite_code': () => import('./SlotGame.vue'),       // 老虎机
  'password':    () => import('./SlotGame.vue'),       // 暂用老虎机
  'roster':      () => import('./WheelGame.vue'),      // 暂用大转盘
}

/**
 * 根据参与模式获取对应的游戏组件。
 * 未匹配到任何模式时返回 null，由调用方回退到默认按钮交互。
 */
export function getGameComponent(mode: string): Component | null {
  const loader = GAME_MAP[mode]
  if (!loader) return null
  return defineAsyncComponent(loader)
}