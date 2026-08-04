/**
 * 游戏注册表 — 可插拔游戏引擎核心。
 *
 * ## 架构
 * ```
 * LotteryView（公开活动页；抽奖是默认玩法）
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
  'wheel':   () => import('./WheelGame.vue'),      // 大转盘（体验壳，不决定结果）
  'slot':    () => import('./SlotGame.vue'),       // 老虎机（体验壳）
  'scratch': () => import('./ScratchGame.vue'),    // 刮刮卡（体验壳）
  'card':    () => import('./CardGame.vue'),       // 卡片翻转（体验壳）
  'grid':    () => import('./GridGame.vue'),       // 九宫格（体验壳）
  'submit':  () => import('./SubmitGame.vue'),     // 通用提交（多玩法共用）
  'reveal':  () => import('./RevealGame.vue'),     // 领取/揭晓（资料领取/盲盒）
  'form':    () => import('./FormGame.vue'),       // 表单提交（问卷/调研/审核申请）
  // ── 非抽奖语义的体验别名：后台可选 list/queue 等，公开页必须有主 CTA 壳 ──
  // 不另造重型组件：统一落到 Submit（一键参与）或 Form（问卷/投票已有字段区）
  'list':     () => import('./SubmitGame.vue'),    // 报名列表 → 主按钮参与
  'queue':    () => import('./SubmitGame.vue'),    // 候补队列
  'calendar': () => import('./SubmitGame.vue'),    // 预约占位（字段在 activity 区）
  'checkin':  () => import('./SubmitGame.vue'),    // 签到
  'ballot':   () => import('./FormGame.vue'),      // 投票：提示填上方选项后提交
}

/**
 * 根据体验类型获取对应的游戏组件。
 * 未匹配到任何模式时回退 SubmitGame，避免「无壳 + 底部双路径」断层（docs/096）。
 * 使用 defineAsyncComponent 实现懒加载，减少首屏 JS 体积。
 */
export function getGameComponent(experienceType: string): Component | null {
  const key = String(experienceType || '').trim().toLowerCase()
  const loader = GAME_MAP[key] || GAME_MAP.submit
  if (!loader) return null
  return defineAsyncComponent(loader)
}

/**
 * 是否已在注册表（含别名）。
 * 注意：getGameComponent 对未知 key 也会回退 Submit；本函数只答「是否显式映射」。
 */
export function hasRegisteredGameExperience(experienceType: string): boolean {
  const key = String(experienceType || '').trim().toLowerCase()
  return Boolean(key && GAME_MAP[key])
}
