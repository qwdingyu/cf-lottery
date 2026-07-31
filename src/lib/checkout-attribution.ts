/**
 * 结账归因（campaign / referral）— 与现有订单字段贯通的轻量层。
 *
 * ## 核心边界（发布门禁：不可破坏）
 * 1. **不挡交易**：未知/未登记/停用码不得导致下单 4xx 或前端拦截结账
 * 2. **不校验 registry**：不读 campaigns / referral_codes 表决定能否支付
 * 3. **结账路径不发奖**：建单不改余额；可选 L1 返佣仅在支付成功后由服务端处理（默认关）
 * 4. **支付主路径独立**：本模块失败（storage 不可用等）不得阻断 resolve 出空归因后继续下单
 *
 * ## 契约
 * - **出站只写短键**：`campaign` / `ref`（单一真相）
 * - **入站兼容长别名**：`campaignCode`、`referral`、`referralCode`（短键优先）
 * - 规范化：trim + 小写 + 最长 80，对齐后端 normalizeCode
 * - 持久：sessionStorage（关标签即清）+ 内存回退
 * - 下单解析：当前 URL 非空键优先，缺口用会话补齐
 * - 路由：长别名可 canonicalize 为仅短键（ShopView watch）
 */

/** 写回购买链 / 规范化 URL 时用的规范短键（便于引流宝 / 人工拼链） */
export const CAMPAIGN_QUERY_KEY = 'campaign' as const
export const REFERRAL_QUERY_KEY = 'ref' as const

/**
 * 仅长别名（出站禁止再写；入站仍读）。
 * 维护时只改此处与短键常量，勿在业务侧散落字符串。
 */
export const CAMPAIGN_QUERY_LONG_ALIASES = ['campaignCode'] as const
export const REFERRAL_QUERY_LONG_ALIASES = ['referral', 'referralCode'] as const

/** 入站可读的全部键：短键优先，后接长别名 */
export const CAMPAIGN_QUERY_KEYS = [CAMPAIGN_QUERY_KEY, ...CAMPAIGN_QUERY_LONG_ALIASES] as const
export const REFERRAL_QUERY_KEYS = [REFERRAL_QUERY_KEY, ...REFERRAL_QUERY_LONG_ALIASES] as const

export const ATTRIBUTION_STORAGE_KEY = 'checkout_attribution'
/** 会话内最长保留 7 天（sessionStorage 关标签即清；TTL 防脏数据） */
export const ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ATTRIBUTION_CODE_MAX_LEN = 80

export type CheckoutAttribution = {
  campaignCode: string
  referralCode: string
  capturedAt: string
}

export type BuyLinkAttribution = {
  campaignCode?: string
  referralCode?: string
}

/** 进程内回退：sessionStorage 写入失败或不可用时，同标签页下单仍可读到最近一次捕获 */
let memoryAttribution: CheckoutAttribution | null = null

/** 与后端 normalizeCode 对齐：trim + lowercase */
export function normalizeAttributionCode(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().slice(0, ATTRIBUTION_CODE_MAX_LEN)
}

function firstQueryString(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

function readQueryAlias(
  query: Record<string, unknown> | { [key: string]: unknown },
  keys: readonly string[],
): string {
  for (const key of keys) {
    const code = normalizeAttributionCode(firstQueryString(query[key]))
    if (code) return code
  }
  return ''
}

function emptyAttribution(now = new Date().toISOString()): CheckoutAttribution {
  return { campaignCode: '', referralCode: '', capturedAt: now }
}

function isFresh(capturedAt: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(capturedAt)
  if (!Number.isFinite(ts)) return false
  return nowMs - ts <= ATTRIBUTION_TTL_MS
}

function isUsableSnapshot(row: CheckoutAttribution | null | undefined): row is CheckoutAttribution {
  if (!row) return false
  if (!row.capturedAt || !isFresh(row.capturedAt)) return false
  return Boolean(row.campaignCode || row.referralCode)
}

/** 从路由 query 解析归因码（不写 storage） */
export function parseAttributionFromQuery(
  query: Record<string, unknown> | { [key: string]: unknown },
): BuyLinkAttribution {
  return {
    campaignCode: readQueryAlias(query, CAMPAIGN_QUERY_KEYS) || undefined,
    referralCode: readQueryAlias(query, REFERRAL_QUERY_KEYS) || undefined,
  }
}

/** 从 location.search 解析（Pay 时兜底；SSR/无 window 返回空） */
export function parseAttributionFromLocationSearch(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): BuyLinkAttribution {
  try {
    const params = new URLSearchParams(search.startsWith('?') || search === '' ? search : `?${search}`)
    const query: Record<string, string> = {}
    params.forEach((value, key) => {
      // 同键多次时保留首次（与 Vue query 数组取 [0] 语义一致）
      if (!(key in query)) query[key] = value
    })
    return parseAttributionFromQuery(query)
  } catch {
    return {}
  }
}

export function hasAttributionCodes(attr: BuyLinkAttribution | null | undefined): boolean {
  return Boolean(attr?.campaignCode || attr?.referralCode)
}

/**
 * 合并两段归因：primary 非空键覆盖，否则 secondary。
 * 用于「URL last-touch + 会话补缺」。
 */
export function mergeAttribution(
  primary: BuyLinkAttribution | null | undefined,
  secondary: BuyLinkAttribution | null | undefined,
): BuyLinkAttribution {
  const campaignCode = normalizeAttributionCode(primary?.campaignCode)
    || normalizeAttributionCode(secondary?.campaignCode)
    || undefined
  const referralCode = normalizeAttributionCode(primary?.referralCode)
    || normalizeAttributionCode(secondary?.referralCode)
    || undefined
  return {
    ...(campaignCode ? { campaignCode } : {}),
    ...(referralCode ? { referralCode } : {}),
  }
}

function readSessionSnapshot(): CheckoutAttribution | null {
  try {
    const raw = sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const row = parsed as Partial<CheckoutAttribution>
    const capturedAt = typeof row.capturedAt === 'string' ? row.capturedAt : ''
    if (!capturedAt || !isFresh(capturedAt)) {
      sessionStorage.removeItem(ATTRIBUTION_STORAGE_KEY)
      return null
    }
    const snapshot: CheckoutAttribution = {
      campaignCode: normalizeAttributionCode(row.campaignCode),
      referralCode: normalizeAttributionCode(row.referralCode),
      capturedAt,
    }
    if (!snapshot.campaignCode && !snapshot.referralCode) return null
    return snapshot
  } catch {
    return null
  }
}

/** 读取会话归因：sessionStorage 优先，过期/损坏则内存回退，再空 */
export function readCheckoutAttribution(): CheckoutAttribution {
  const fromSession = readSessionSnapshot()
  if (fromSession) {
    memoryAttribution = fromSession
    return fromSession
  }
  if (isUsableSnapshot(memoryAttribution)) {
    return memoryAttribution
  }
  memoryAttribution = null
  return emptyAttribution()
}

/**
 * 清空会话归因（sessionStorage + 内存）。
 * 用于：下单成功后消费归因、URL 显式空参重置。
 */
export function clearCheckoutAttribution(): void {
  memoryAttribution = null
  try {
    sessionStorage.removeItem(ATTRIBUTION_STORAGE_KEY)
  } catch {
    // 忽略 storage 不可用
  }
}

/**
 * 判断 query 是否「显式携带」某一归因键（含空串 / 仅空白）。
 * 与 parse 不同：空值表示「调用方有意清空该维度」，而非「未出现」。
 */
export function queryHasAttributionKey(
  query: Record<string, unknown> | { [key: string]: unknown },
  keys: readonly string[],
): boolean {
  for (const key of keys) {
    if (!(key in query)) continue
    const raw = query[key]
    // Vue query 可能是 string | string[] | null；键存在即视为显式
    if (raw === undefined) continue
    return true
  }
  return false
}

/**
 * 将 URL 上的归因写入 sessionStorage + 内存。
 * 合并策略：
 * - 本次 URL 非空键 → 覆盖该维度
 * - 本次 URL 未出现的键 → 保留会话旧值（二次深链不丢半参）
 * - 本次 URL 显式空参（campaign= / ref=）→ 清空该维度（最佳实践：可重置）
 * - 两维最终皆空 → 清除 storage（返回 null）
 * - URL 无任何归因键 → 不触碰 storage（返回 null）
 */
export function captureAttributionFromQuery(
  query: Record<string, unknown> | { [key: string]: unknown },
): CheckoutAttribution | null {
  const hasCampaignKey = queryHasAttributionKey(query, CAMPAIGN_QUERY_KEYS)
  const hasReferralKey = queryHasAttributionKey(query, REFERRAL_QUERY_KEYS)
  if (!hasCampaignKey && !hasReferralKey) return null

  const fromUrl = parseAttributionFromQuery(query)
  const prev = readCheckoutAttribution()
  const next: CheckoutAttribution = {
    campaignCode: hasCampaignKey
      ? (fromUrl.campaignCode || '')
      : (prev.campaignCode || ''),
    referralCode: hasReferralKey
      ? (fromUrl.referralCode || '')
      : (prev.referralCode || ''),
    capturedAt: new Date().toISOString(),
  }

  if (!next.campaignCode && !next.referralCode) {
    clearCheckoutAttribution()
    return null
  }

  memoryAttribution = next
  try {
    sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // storage 满/隐私模式：内存仍保留，同页下单可读
  }
  return next
}

/**
 * 下单前统一解析归因（最佳实践入口）。
 * 1) 当前 URL 非空键（product scrub 后 campaign/ref 通常仍在）
 * 2) 会话/内存补缺
 * 可选传入 route.query，避免仅依赖 window（便于单测）。
 */
export function resolveAttributionForCheckout(
  query?: Record<string, unknown> | { [key: string]: unknown } | null,
): BuyLinkAttribution {
  const fromUrl = query
    ? parseAttributionFromQuery(query)
    : parseAttributionFromLocationSearch()
  const fromSession = readCheckoutAttribution()
  return mergeAttribution(fromUrl, {
    campaignCode: fromSession.campaignCode || undefined,
    referralCode: fromSession.referralCode || undefined,
  })
}

/** 去掉全部归因 query 键（短+长），保留其余（含 product）；业务默认不 scrub 归因 */
export function stripAttributionQuery<T extends Record<string, unknown>>(
  query: T,
): Omit<T, typeof CAMPAIGN_QUERY_KEYS[number] | typeof REFERRAL_QUERY_KEYS[number]> {
  const next = { ...query } as Record<string, unknown>
  for (const key of CAMPAIGN_QUERY_KEYS) delete next[key]
  for (const key of REFERRAL_QUERY_KEYS) delete next[key]
  return next as Omit<T, typeof CAMPAIGN_QUERY_KEYS[number] | typeof REFERRAL_QUERY_KEYS[number]>
}

/** 路由 query 是否仍携带长别名（需 canonicalize，避免双键并存） */
export function attributionRouteQueryHasLongAliases(
  query: Record<string, unknown> | { [key: string]: unknown },
): boolean {
  return queryHasAttributionKey(query, CAMPAIGN_QUERY_LONG_ALIASES)
    || queryHasAttributionKey(query, REFERRAL_QUERY_LONG_ALIASES)
}

/**
 * 将路由 query 归一为「仅短键 campaign/ref」+ 其余业务键。
 * 入站长别名读入同一字段后再写出短键；空码不写键。
 * 幂等：已是短键形态时结构等价（调用方应用 hasLongAliases 门闩避免无意义 replace）。
 */
export function canonicalizeAttributionRouteQuery<T extends Record<string, unknown>>(
  query: T,
): T {
  const attr = parseAttributionFromQuery(query)
  const next = stripAttributionQuery(query) as Record<string, unknown>
  if (attr.campaignCode) next[CAMPAIGN_QUERY_KEY] = attr.campaignCode
  if (attr.referralCode) next[REFERRAL_QUERY_KEY] = attr.referralCode
  return next as T
}

/** 将归因写入 URLSearchParams（**仅**短键 campaign / ref；并剥离长别名） */
export function applyAttributionToSearchParams(
  params: URLSearchParams,
  attribution?: BuyLinkAttribution | null,
): void {
  const campaign = normalizeAttributionCode(attribution?.campaignCode)
  const referral = normalizeAttributionCode(attribution?.referralCode)
  if (campaign) params.set(CAMPAIGN_QUERY_KEY, campaign)
  else params.delete(CAMPAIGN_QUERY_KEY)
  if (referral) params.set(REFERRAL_QUERY_KEY, referral)
  else params.delete(REFERRAL_QUERY_KEY)
  // 单一真相：长别名一律删除，避免 ?ref=a&referralCode=b 双写
  for (const key of CAMPAIGN_QUERY_LONG_ALIASES) params.delete(key)
  for (const key of REFERRAL_QUERY_LONG_ALIASES) params.delete(key)
}

/** 下单 API 用的干净载荷（空串省略） */
export function attributionForPayPayload(attr?: CheckoutAttribution | BuyLinkAttribution | null): {
  campaignCode?: string
  referralCode?: string
} {
  const campaignCode = normalizeAttributionCode(attr?.campaignCode)
  const referralCode = normalizeAttributionCode(attr?.referralCode)
  return {
    ...(campaignCode ? { campaignCode } : {}),
    ...(referralCode ? { referralCode } : {}),
  }
}

/** 测试用：清空内存快照（不直接操作 sessionStorage） */
export function resetCheckoutAttributionMemoryForTests(): void {
  memoryAttribution = null
}
