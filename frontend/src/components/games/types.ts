/**
 * 游戏引擎共享类型
 *
 * 所有游戏组件必须遵循此接口约定。
 * 新增游戏只需创建组件 + 在 GameRegistry 注册一行映射。
 *
 * ## 游戏生命周期
 * ```
 * 初始态 ──→ 用户操作 ──→ play 事件 ──→ 后端 API ──→ 结果弹窗
 *   ↑                        ↑
 * 展示 prizes             emit('play')
 * disabled=false          disabled=true（防止重复提交）
 * ```
 *
 * ## 新增游戏步骤
 * 1. 创建 src/components/games/NewGame.vue
 * 2. 实现 GameProps 接口（prizes + disabled + loading）
 * 3. emit('play') 触发用户操作
 * 4. 在 GameRegistry.ts 注册映射
 * 5. 无需修改 LotteryView 或其他代码
 */

/** 奖品项（游戏组件渲染用） */
export interface PrizeItem {
  /** 奖品名称 */
  name: string
  /** 奖品颜色（可选，用于组件配色） */
  color?: string
  /** 奖品图片 URL（可选，未提供时展示层使用默认图） */
  imageUrl?: string
  /** 奖品展示价值文案（可选，不参与金额计算） */
  valueText?: string
}

/** 游戏组件 Props 接口 */
export interface GameProps {
  /** 奖品列表，用于渲染游戏视觉元素 */
  prizes: PrizeItem[]
  /** 是否禁用交互（如正在参与中） */
  disabled?: boolean
  /** 是否加载中（后端 API 调用中） */
  loading?: boolean
}

/** 游戏组件 Emits 接口 */
export interface GameEmits {
  /** 用户触发游戏操作，父组件调用后端 API */
  play: []
}
