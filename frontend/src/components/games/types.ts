/**
 * 游戏引擎共享类型
 *
 * 所有游戏组件必须遵循此接口约定：
 * - Props: 接收 prizes 数组和 disabled 标志
 * - Emits: 用户操作后 emit('play')
 * - 游戏动画是纯视觉，不决定中奖结果（结果由后端 API 决定）
 *
 * ## 新增游戏步骤
 * 1. 创建 src/components/games/NewGame.vue
 * 2. 实现 GameProps 接口
 * 3. 在 GameRegistry.ts 注册映射
 * 4. 无需修改 LotteryView 或其他代码
 */

/** 奖品项（游戏组件渲染用） */
export interface PrizeItem {
  name: string
  color?: string
}

/** 游戏组件 Props 接口 */
export interface GameProps {
  /** 奖品列表，用于渲染游戏视觉元素 */
  prizes: PrizeItem[]
  /** 是否禁用交互（如正在参与中） */
  disabled?: boolean
}

/** 游戏组件 Emits 接口 */
export interface GameEmits {
  /** 用户触发游戏操作，父组件调用后端 API */
  play: []
}