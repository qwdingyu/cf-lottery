/**
 * 游戏引擎共享类型
 *
 * 所有游戏组件必须遵循此接口约定。
 * 新增游戏只需创建组件 + 在 GameRegistry 注册一行映射。
 *
 * ## 游戏生命周期（join 主路径，docs/055a）
 * ```
 * 用户点击 ──→ emit('play') ──→ 父组件身份校验 / join API
 *                                    │
 *                    成功 ──→ celebrateKey++ ──→ 可选氛围动画（转盘/老虎机等）
 *                    失败 / 需登录 ──→ 不播氛围动画（避免「转完才要验证码」）
 * ```
 * - `loading`：请求进行中，文案「提交中」；允许**轻量 idle**（慢转/晃动/脉冲）给即时反馈，
 *   **不要**用 loading 驱动「假装开奖」的长庆祝动画（那是 celebrateKey 的职责）
 * - `celebrateKey`：参与成功后递增；组件 watch 后播放诚实的「参与氛围」动效
 * - `animation-complete`：氛围动画结束后通知父组件，父组件再展示成功/结果提示
 * - 动画**不得**在无服务端结果时宣称为个人中奖
 *
 * ## 新增游戏步骤
 * 1. 创建 src/components/games/NewGame.vue
 * 2. 实现 GameProps（prizes + disabled + loading + celebrateKey?）
 * 3. 用户操作只 emit('play')；成功氛围听 celebrateKey
 * 4. 在 GameRegistry.ts 注册映射
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

/**
 * 秒杀壳展示数据（docs/130）。
 * 由公开 API `flashSale` 下发；进度必须来自真实参与计数。
 */
export interface FlashSaleDisplay {
  enabled?: boolean
  sessionLabel?: string
  stockLimit?: number | null
  effectiveStockLimit?: number | null
  maxPerUser?: number
  showCountdown?: boolean
  showProgress?: boolean
  showStock?: boolean
  ctaLabel?: string
  paymentRequired?: boolean
  priceCents?: number | null
  currency?: string
  title?: string
  claimed?: number
  remaining?: number | null
  progressPercent?: number
}

/** 游戏组件 Props 接口 */
export interface GameProps {
  /** 奖品列表，用于渲染游戏视觉元素 */
  prizes: PrizeItem[]
  /** 是否禁用交互（如已参与 / 活动未开放） */
  disabled?: boolean
  /** 后端 join 请求进行中：显示「提交中」，不播长氛围动画 */
  loading?: boolean
  /**
   * 参与成功后由父组件递增。
   * 有氛围动画的组件 watch 此值再播放；与 loading 解耦，避免未验证就转盘。
   */
  celebrateKey?: number
  /**
   * instant spin 成功后的停扇索引（docs/116）。
   * 与 celebrateKey 同帧递增时：对准服务端 prizeIndex；未传则随机氛围（delayed）。
   * 无服务端索引时禁止宣称中奖。
   */
  targetSectorIndex?: number | null
  /** 秒杀运行时（仅 experience_type=flash_sale 时由父组件传入） */
  flashSale?: FlashSaleDisplay | null
  startAt?: string | null
  endAt?: string | null
}

/** 游戏组件 Emits 接口 */
export interface GameEmits {
  /** 用户触发参与意图，父组件负责身份与 join API */
  play: []
  /** 服务端确认成功后的氛围动画完成，父组件可安全展示结果提示 */
  'animation-complete': []
}
