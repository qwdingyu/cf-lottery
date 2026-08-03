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
 * ## 游戏生命周期（docs/055a：先身份后氛围）
 * ```
 * 挂载 → 渲染奖品 → 用户操作 → emit('play') → 父组件身份/join
 *   成功 → celebrateKey++ → 可选氛围动画 + 结果弹窗
 *   需登录 → 弹窗（不播长动画）
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
  'wheel':   () => import('./WheelGame.vue'),      // 大转盘（抽奖）
  'slot':    () => import('./SlotGame.vue'),       // 老虎机（抽奖）
  'scratch': () => import('./ScratchGame.vue'),    // 刮刮卡（抽奖/即时开奖）
  'card':    () => import('./CardGame.vue'),       // 卡片翻转（抽奖/翻牌）
  'grid':    () => import('./GridGame.vue'),       // 九宫格（抽奖/盲盒）
  'submit':  () => import('./SubmitGame.vue'),     // 通用提交按钮（抽奖/接龙）
  'reveal':  () => import('./RevealGame.vue'),     // 领取/揭晓（资料领取/盲盒）
  'form':    () => import('./FormGame.vue'),       // 表单提交（问卷/调研/审核申请）
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