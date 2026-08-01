/**
 * 游戏注册表 — 可插拔游戏引擎核心。
 *
 * ## 架构
 * ```
 * LotteryView（抽奖页）
 *   └── component :is="getGameComponent(experienceType)"  ← 动态渲染
 *         ├── WheelGame   ← wheel 体验（大转盘）
 *         ├── SlotGame    ← slot 体验（老虎机）
 *         ├── ScratchGame ← scratch 体验（刮刮卡）
 *         └── CardGame    ← card 体验（卡片翻转）
 * ```
 *
 * ## 设计原则
 * 1. 每种体验类型映射到一个游戏组件；体验类型与资格模式解耦
 * 2. 所有游戏组件实现统一接口（见 types.ts）
 * 3. 新增游戏只需在此注册一行映射，无需修改 LotteryView
 * 4. 游戏动画是纯视觉，不决定中奖结果（结果由后端决定）
 *
 * ## 游戏生命周期
 * ```
 * 挂载 → 渲染奖品 → 用户操作 → emit('play') → disabled=true → 父组件调用 API
 *   ↑                                                              ↓
 *   结果弹窗 ← 后端返回结果 ← loading=false ← disabled=true ← 等待
 * ```
 *
 * ## 新增游戏步骤
 * 1. 创建 src/components/games/NewGame.vue
 * 2. 实现 GameProps 接口（prizes + disabled + loading）
 * 3. 用户操作后 emit('play')
 * 4. 在 GAME_MAP 中添加一行：'new_experience': () => import('./NewGame.vue')
 * 5. 无需修改 LotteryView 或其他代码
 */
import { defineAsyncComponent, type Component } from 'vue'

export type { GameProps, PrizeItem, GameEmits } from './types'

/** 体验类型 → 游戏组件的映射 */
const GAME_MAP: Record<string, () => Promise<Component>> = {
  'wheel':   () => import('./WheelGame.vue'),      // 大转盘
  'slot':    () => import('./SlotGame.vue'),       // 老虎机
  'scratch': () => import('./ScratchGame.vue'),    // 刮刮卡
  'card':    () => import('./CardGame.vue'),       // 卡片翻转
}

/**
 * 根据体验类型获取对应的游戏组件。
 * 未匹配到任何模式时返回 null，由调用方回退到默认按钮交互。
 * 使用 defineAsyncComponent 实现懒加载，减少首屏 JS 体积。
 */
export function getGameComponent(experienceType: string): Component | null {
  const loader = GAME_MAP[experienceType]
  if (!loader) return null
  return defineAsyncComponent(loader)
}