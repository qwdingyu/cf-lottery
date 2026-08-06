/**
 * 公开页游戏壳奖品展示（与 src/lib/prize-shell-display.ts 算法对齐，docs/128）。
 *
 * 前端独立副本：避免 C 端打包拉入服务端树；单测锁契约防漂移。
 */

export type PrizePanelMode =
  | 'auto'
  | 'full_on_shell'
  | 'shell_ritual_pool_full'
  | 'shell_ritual_pool_summary'
  | 'ritual_only'

export type ResolvedPrizePanelMode =
  | 'full_on_shell'
  | 'shell_ritual_pool_full'
  | 'shell_ritual_pool_summary'
  | 'ritual_only'

/**
 * 默认中性四字/短语：互动氛围，禁止默认成「中奖/一等奖」。
 * 与 src/lib/prize-shell-display.ts 同步的副本——修改需两处一起改。
 */
export const DEFAULT_RITUAL_PHRASES: readonly string[] = [
  '好运连连',
  '感谢参与',
  '期待开奖',
  '好运加持',
  '参与有礼',
  '开奖见分晓',
  '幸运星',
  '再接再厉',
] as const

const MAX_PHRASE_LEN = 8
const MAX_PHRASE_COUNT = 16

/**
 * 与 src/lib/prize-shell-display.ts 同步的禁用词副本（docs/128 前后端双副本）。
 * 修改必须同步服务端与 growth-config.ts 管理端清洗，三处一起改防漂移。
 */
const FORBIDDEN_RITUAL_SUBSTRINGS = [
  '中奖',
  '一等奖',
  '二等奖',
  '三等奖',
  '特等奖',
  '大奖',
  '奖品是',
  '已中',
  '恭喜获得',
]

const RESOLVED_MODES: ResolvedPrizePanelMode[] = [
  'full_on_shell',
  'shell_ritual_pool_full',
  'shell_ritual_pool_summary',
  'ritual_only',
]

export function isInstantLotteryResultMode(resultMode: string | null | undefined): boolean {
  return (
    String(resultMode || '')
      .trim()
      .toLowerCase() === 'instant'
  )
}

export function sanitizeRitualPhrases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_PHRASE_COUNT) break
    const s = String(item ?? '')
      .replace(/\s+/g, '')
      .trim()
    if (!s) continue
    const clipped = s.slice(0, MAX_PHRASE_LEN)
    if (seen.has(clipped)) continue
    if (FORBIDDEN_RITUAL_SUBSTRINGS.some((bad) => clipped.includes(bad))) continue
    seen.add(clipped)
    out.push(clipped)
  }
  return out
}

export function parseExperienceShellConfig(promotionConfig: unknown): {
  prizePanelMode: PrizePanelMode
  ritualPhrases: string[]
} {
  let root: Record<string, unknown> | null = null
  if (promotionConfig && typeof promotionConfig === 'object' && !Array.isArray(promotionConfig)) {
    root = promotionConfig as Record<string, unknown>
  } else if (typeof promotionConfig === 'string' && promotionConfig.trim() && promotionConfig !== '{}') {
    try {
      const parsed = JSON.parse(promotionConfig) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
      }
    } catch {
      root = null
    }
  }

  const experience =
    root?.experience && typeof root.experience === 'object' && !Array.isArray(root.experience)
      ? (root.experience as Record<string, unknown>)
      : null

  const modeRaw = String(experience?.prizePanelMode || experience?.prize_panel_mode || 'auto')
    .trim()
    .toLowerCase()
  const allowed: PrizePanelMode[] = [
    'auto',
    'full_on_shell',
    'shell_ritual_pool_full',
    'shell_ritual_pool_summary',
    'ritual_only',
  ]
  const prizePanelMode = (allowed.includes(modeRaw as PrizePanelMode) ? modeRaw : 'auto') as PrizePanelMode

  return {
    prizePanelMode,
    ritualPhrases: sanitizeRitualPhrases(experience?.ritualPhrases ?? experience?.ritual_phrases),
  }
}

export function resolvePrizePanelMode(
  resultMode: string | null | undefined,
  configured: PrizePanelMode = 'auto',
): ResolvedPrizePanelMode {
  if (configured !== 'auto') {
    // docs/128 红线：真奖名只允许即时开奖上壳。delayed（手动/定时/空）随机停格
    // 若扇面是真奖名会「停格=中奖」误读，强制降级为仪式短语 + 奖池公示。
    // 与服务端 resolvePrizePanelMode 保持一致的对称降级。
    if (configured === 'full_on_shell' && !isInstantLotteryResultMode(resultMode)) {
      return 'shell_ritual_pool_full'
    }
    return configured
  }
  if (isInstantLotteryResultMode(resultMode)) return 'full_on_shell'
  return 'shell_ritual_pool_full'
}

export function shellUsesRealPrizes(mode: ResolvedPrizePanelMode): boolean {
  return mode === 'full_on_shell'
}

export function showPrizePoolStrip(mode: ResolvedPrizePanelMode): 'full' | 'summary' | 'hidden' {
  if (mode === 'ritual_only') return 'hidden'
  if (mode === 'shell_ritual_pool_summary') return 'summary'
  return 'full'
}

function padLabels(source: string[], minSlots: number): string[] {
  if (source.length === 0) return [...DEFAULT_RITUAL_PHRASES].slice(0, Math.max(minSlots, 4))
  if (minSlots <= source.length) return source.slice()
  const out: string[] = []
  for (let i = 0; i < minSlots; i++) out.push(source[i % source.length]!)
  return out
}

/**
 * 生成壳上展示用标签（扇面/卷轴格）。
 * - full_on_shell：用奖品名
 * - 其余：仪式短语（配置优先，否则默认）
 *
 * 索引对齐不变量（docs/128）：调用方保证 prizeNames 与 prizes 数组一一对应——
 * tierName 保存时三级兜底（`奖项 N` → 公开 API `name || tierName`）恒非空，
 * full_on_shell 标签第 i 项 ↔ prizes[i]，与 instant spin.prizeIndex 停扇对齐（docs/116）。
 * 不要在此过滤空名后重新索引（会破坏扇区与奖的对应）。
 */
export function buildShellLabels(input: {
  mode: ResolvedPrizePanelMode
  prizeNames: Array<string | null | undefined>
  ritualPhrases?: string[]
  minSlots?: number
}): string[] {
  const minSlots = Math.max(0, Math.floor(Number(input.minSlots) || 0))
  if (shellUsesRealPrizes(input.mode)) {
    const names = input.prizeNames.map((n) => String(n || '').trim()).filter(Boolean)
    if (names.length === 0) return padLabels(['谢谢参与'], Math.max(minSlots, 4))
    return padLabels(names, minSlots)
  }
  const phrases =
    input.ritualPhrases && input.ritualPhrases.length > 0
      ? input.ritualPhrases
      : [...DEFAULT_RITUAL_PHRASES]
  const slotCount = Math.max(
    minSlots,
    input.prizeNames.filter((n) => String(n || '').trim()).length,
    phrases.length,
    4,
  )
  return padLabels(phrases, slotCount)
}

export type PublicShellServerFields = {
  prizePanelMode?: string | null
  shellLabels?: string[] | null
  shellUsesRealPrizes?: boolean | null
  prizePoolDisplay?: string | null
}

/**
 * 组装公开页壳/奖池展示。优先信任服务端已解析字段（单一真相），本地仅作兜底。
 */
export function buildPublicPrizeShellPayload(input: {
  resultMode: string | null | undefined
  promotionConfig: unknown
  serverShell?: PublicShellServerFields | null
  prizes: Array<{
    name?: string | null
    tierName?: string | null
    winnerCount?: number | null
    imageUrl?: string | null
    valueText?: string | null
  }>
}): {
  prizePanelMode: ResolvedPrizePanelMode
  shellLabels: string[]
  shellUsesRealPrizes: boolean
  prizePoolDisplay: 'full' | 'summary' | 'hidden'
  shellPrizeItems: Array<{
    name: string
    color: string
    imageUrl: string
    valueText: string
  }>
  poolStripItems: Array<{ name: string; tierName?: string; winnerCount?: number }>
} {
  const cfg = parseExperienceShellConfig(input.promotionConfig)
  const serverMode = String(input.serverShell?.prizePanelMode || '').trim()
  // 服务端明确给出模式 → 模式与 labels 同为一次 API 计算的产物（配套可信）
  const hasServerMode = RESOLVED_MODES.includes(serverMode as ResolvedPrizePanelMode)
  const mode: ResolvedPrizePanelMode = hasServerMode
    ? (serverMode as ResolvedPrizePanelMode)
    : resolvePrizePanelMode(input.resultMode, cfg.prizePanelMode)

  const useRealOnShell = shellUsesRealPrizes(mode)
  const prizeNames = input.prizes.map((p) => p.name || p.tierName || '')

  // 服务端 labels 仅在 hasServerMode 时采用：缺失模式（旧版响应/中间层漏传）说明 labels 不可信，
  // 必须本地重建，避免误用与最终模式不配套的旧 labels。
  const serverLabels = Array.isArray(input.serverShell?.shellLabels)
    ? input.serverShell!.shellLabels!.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  let shellLabels: string[]
  if (hasServerMode && serverLabels.length > 0) {
    shellLabels = serverLabels
  } else {
    shellLabels = buildShellLabels({
      mode,
      prizeNames,
      ritualPhrases: cfg.ritualPhrases,
      minSlots: Math.max(prizeNames.filter(Boolean).length, 0),
    })
  }

  // 灾难（方向一）：非 full 模式却拿到与奖品名完全相同的 labels → 重建仪式短语
  if (!useRealOnShell) {
    const realNameSet = new Set(prizeNames.map((n) => String(n || '').trim()).filter(Boolean))
    const allLookLikePrizes =
      shellLabels.length > 0 &&
      shellLabels.every((l) => realNameSet.has(l)) &&
      realNameSet.size > 0
    if (allLookLikePrizes) {
      shellLabels = buildShellLabels({
        mode: 'shell_ritual_pool_full',
        prizeNames,
        ritualPhrases: cfg.ritualPhrases,
        minSlots: Math.max(shellLabels.length, prizeNames.filter(Boolean).length),
      })
    }
  } else {
    // 灾难（方向二，对称）：full_on_shell 却拿到全是仪式短语的 labels →
    // 重建为真奖名。否则会渲染「仪式词 + 真奖图」的组合（docs/115 语义红线）。
    // 用「全部不是奖名」而非「全部等于默认词」，避免奖名真叫「好运连连」时误伤。
    const realNameSet = new Set(prizeNames.map((n) => String(n || '').trim()).filter(Boolean))
    const ritualSet = new Set([
      ...DEFAULT_RITUAL_PHRASES,
      ...(cfg.ritualPhrases || []),
    ])
    const allNotReal = shellLabels.length > 0 && shellLabels.every((l) => !realNameSet.has(l))
    const allRitual = shellLabels.every((l) => ritualSet.has(l))
    if (allNotReal && allRitual && realNameSet.size > 0) {
      shellLabels = buildShellLabels({
        mode: 'full_on_shell',
        prizeNames,
        ritualPhrases: cfg.ritualPhrases,
        minSlots: Math.max(shellLabels.length, prizeNames.filter(Boolean).length),
      })
    }
  }

  const serverPool = String(input.serverShell?.prizePoolDisplay || '').trim()
  const prizePoolDisplay: 'full' | 'summary' | 'hidden' =
    serverPool === 'full' || serverPool === 'summary' || serverPool === 'hidden'
      ? serverPool
      : showPrizePoolStrip(mode)

  const shellPrizeItems = shellLabels.map((label, i) => {
    if (useRealOnShell) {
      const p = input.prizes[i]
      return {
        name: label,
        color: '',
        imageUrl: String(p?.imageUrl || ''),
        valueText: String(p?.valueText || ''),
      }
    }
    // delayed 仪式壳：绝不带奖品图，避免「图=奖」暗示
    return { name: label, color: '', imageUrl: '', valueText: '' }
  })

  let poolStripItems: Array<{ name: string; tierName?: string; winnerCount?: number }> = []
  if (prizePoolDisplay === 'full') {
    poolStripItems = input.prizes.map((p) => ({
      name: String(p.name || p.tierName || ''),
      tierName: p.tierName ? String(p.tierName) : undefined,
      winnerCount: p.winnerCount != null ? Number(p.winnerCount) : undefined,
    }))
  } else if (prizePoolDisplay === 'summary') {
    poolStripItems = input.prizes.map((p, i) => {
      const tier = String(p.tierName || '').trim()
      const name = String(p.name || '').trim()
      return {
        name: tier || name || `奖项${i + 1}`,
        tierName: tier || undefined,
        winnerCount: p.winnerCount != null ? Number(p.winnerCount) : undefined,
      }
    })
  }

  return {
    prizePanelMode: mode,
    shellLabels,
    shellUsesRealPrizes: useRealOnShell,
    prizePoolDisplay,
    shellPrizeItems,
    poolStripItems,
  }
}
