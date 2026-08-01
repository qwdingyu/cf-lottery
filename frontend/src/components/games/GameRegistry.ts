/**
 * 游戏注册表 — 可插拔游戏引擎核心。
 *
 * ## 设计原则
 * 1. 每种参与模式映射到一个游戏组件
 * 2. 所有游戏组件实现统一接口：
 *    - Props: { prizes: PrizeItem[], disabled?: boolean }
 *    - Emits: { play: [] }
 * 3. 新增游戏只需在此注册一行映射，无需修改 LotteryView
 *
 * ## 新增游戏步骤
 * 1. 创建 src/components/games/NewGame.vue
 * 2. 在 GAME_MAP 中添加一行：'new_mode': () => import('./NewGame.vue')
 * 3. 前端自动使用新游戏，无需其他修改
 *
 * ## 游戏组件规范
 * - 接收 prizes 数组，渲染奖品视觉元素
 * - disabled 为 true 时禁止交互
 * - 用户操作后 emit('play')，由父组件调用后端 API
 * - 游戏动画是纯视觉，不决定中奖结果（结果由后端决定）
 */
import { defineAsyncComponent, type Component } from 'vue'

/** 参与模式 → 游戏组件的映射 */
const GAME_MAP: Record<string, () => Promise<Component>> = {
  'open':        () => import('./WheelGame.vue'),      // 大转盘
  'invite_code': () => import('./SlotGame.vue'),       // 老虎机
  'password':    () => import('./ScratchGame.vue'),    // 刮刮卡
  'roster':      () => import('./CardGame.vue'),       // 卡片翻转
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