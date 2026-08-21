/**
 * instant 抽奖次数配额（纯函数，docs/116 §3.3.3）
 *
 * 不变量：
 * - maxSpinsPerEntry ≥ 1（instant 必填）
 * - granted ≤ maxSpinsPerEntry
 * - viralEarned ≤ maxExtraSpins
 * - used ≤ granted；left = granted - used（或行内维护等价）
 * - 裂变 actual = min(k, roomTotal, roomViral)
 *
 * 与 delayed viral-weight 分路径：此处只算「次数」，不算开奖袋权重。
 */

export const INSTANT_ALGORITHM_VERSION = "instant_weight_v1";

/** join 时默认发放次数；必须 ≤ maxSpinsPerEntry */
export const DEFAULT_INITIAL_SPINS_ON_JOIN = 1;

export type InstantSpinQuotaConfig = {
  maxSpinsPerEntry: number;
  initialSpinsOnJoin?: number;
  extraSpinsPerInvite?: number;
  maxExtraSpins?: number;
};

export type EntrySpinState = {
  spinsLeft: number;
  spinsTotalGranted: number;
  spinsViralEarned: number;
};

function floorNonNeg(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.floor(v));
}

/**
 * 归一化活动级次数配置。
 * maxSpins < 1 视为未配置（调用方应拒绝 spin / 发布）。
 */
export function normalizeInstantSpinQuota(
  raw?: Partial<InstantSpinQuotaConfig> | null,
): InstantSpinQuotaConfig {
  const maxSpinsPerEntry = floorNonNeg(raw?.maxSpinsPerEntry, 0);
  let initial = floorNonNeg(raw?.initialSpinsOnJoin, DEFAULT_INITIAL_SPINS_ON_JOIN);
  if (initial < 1) initial = DEFAULT_INITIAL_SPINS_ON_JOIN;
  if (maxSpinsPerEntry >= 1 && initial > maxSpinsPerEntry) {
    initial = maxSpinsPerEntry;
  }
  const extraSpinsPerInvite = floorNonNeg(raw?.extraSpinsPerInvite, 0);
  const maxExtraSpins = floorNonNeg(raw?.maxExtraSpins, 0);
  return {
    maxSpinsPerEntry,
    initialSpinsOnJoin: initial,
    extraSpinsPerInvite,
    maxExtraSpins,
  };
}

/** instant 是否已配置合法次数硬顶 */
export function isInstantSpinQuotaConfigured(maxSpinsPerEntry: unknown): boolean {
  const max = floorNonNeg(maxSpinsPerEntry, 0);
  return max >= 1;
}

/**
 * 首次 join 应写入的 spins 字段。
 * delayed（max=0）→ 全 0；instant → granted=left=initial。
 */
export function initialSpinsForJoin(maxSpinsPerEntry: number, initialSpinsOnJoin = DEFAULT_INITIAL_SPINS_ON_JOIN): EntrySpinState {
  if (!isInstantSpinQuotaConfigured(maxSpinsPerEntry)) {
    return { spinsLeft: 0, spinsTotalGranted: 0, spinsViralEarned: 0 };
  }
  const max = Math.floor(Number(maxSpinsPerEntry));
  let initial = floorNonNeg(initialSpinsOnJoin, DEFAULT_INITIAL_SPINS_ON_JOIN);
  if (initial < 1) initial = DEFAULT_INITIAL_SPINS_ON_JOIN;
  if (initial > max) initial = max;
  return {
    spinsLeft: initial,
    spinsTotalGranted: initial,
    spinsViralEarned: 0,
  };
}

/**
 * 有效邀请成功后，邀请人可增加的 spin 次数（可为 0：只涨榜不加次）。
 *
 * actual = min(extraSpinsPerInvite, maxSpins - granted, maxExtra - viralEarned)
 */
export function computeViralSpinGrant(input: {
  maxSpinsPerEntry: number;
  extraSpinsPerInvite: number;
  maxExtraSpins: number;
  spinsTotalGranted: number;
  spinsViralEarned: number;
}): { actual: number; nextGranted: number; nextViralEarned: number; nextLeftDelta: number } {
  const max = floorNonNeg(input.maxSpinsPerEntry, 0);
  const k = floorNonNeg(input.extraSpinsPerInvite, 0);
  const maxExtra = floorNonNeg(input.maxExtraSpins, 0);
  const granted = floorNonNeg(input.spinsTotalGranted, 0);
  const viral = floorNonNeg(input.spinsViralEarned, 0);

  if (max < 1 || k <= 0) {
    return { actual: 0, nextGranted: granted, nextViralEarned: viral, nextLeftDelta: 0 };
  }

  const roomTotal = Math.max(0, max - granted);
  const roomViral = Math.max(0, maxExtra - viral);
  const actual = Math.min(k, roomTotal, roomViral);

  return {
    actual,
    nextGranted: granted + actual,
    nextViralEarned: viral + actual,
    nextLeftDelta: actual,
  };
}

/** spin 前：是否还有剩余次数（行内 left 优先；也可传 used 校验） */
export function canConsumeSpin(spinsLeft: number): boolean {
  return floorNonNeg(spinsLeft, 0) >= 1;
}

/**
 * 加权抽样一档（含「谢谢参与」权重 0 档可显式加入）。
 * weight≤0 的档跳过；全跳过则返回 null（调用方视为未中）。
 */
export function weightedPickTier<T extends { id: string; weight: number }>(
  tiers: T[],
  random01: () => number,
): T | null {
  const pool = tiers
    .filter((t) => t && t.id && floorNonNeg(t.weight, 0) > 0)
    .map((t) => ({ item: t, weight: floorNonNeg(t.weight, 0) }));
  if (pool.length === 0) return null;

  let total = 0;
  for (const row of pool) total += row.weight;
  if (total <= 0) return null;

  let u = random01();
  if (!(u >= 0 && u < 1)) u = 0;
  let cursor = u * total;
  for (const row of pool) {
    cursor -= row.weight;
    if (cursor < 0) return row.item;
  }
  return pool[pool.length - 1]!.item;
}

/** CSPRNG → [0,1) */
export function random01Csprng(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! >>> 0) / 0x100000000;
}

/* ── 保底机制（docs/218 模式一） ───────────────────────────── */

export type PityConfig = {
  enabled: boolean;
  /** 连续未中达到该次数后触发保底（≥1）。缺省 / 非法 → 0 = 不启用 */
  threshold: number;
};

/**
 * 从 promotion_config 的 pity 节点解析保底配置。
 * 纯函数，缺省或非法时返回 { enabled: false, threshold: 0 }。
 */
export function normalizePityConfig(raw: unknown): PityConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, threshold: 0 };
  }
  const node = raw as Record<string, unknown>;
  const enabled = node.enabled === true || node.enabled === 1 || node.enabled === "true";
  if (!enabled) return { enabled: false, threshold: 0 };
  const threshold = Math.floor(Number(node.threshold) || 0);
  // 有效区间 2..100（与前端表单一致，growth-config.ts:599）；越界视为未启用，
  // 发布预检会以 disabled_by_invalid_threshold 警告运营（P2 审查项：防 API 直写绕过前端上限）。
  if (threshold < 2 || threshold > 100) return { enabled: false, threshold: 0 };
  return { enabled: true, threshold };
}

/* ── 每日免费抽奖（docs/218 模式二） ────────────────────────── */

export type DailyFreeSpinConfig = {
  enabled: boolean;
  /** 每日免费发放的 spin 次数（≥1）。缺省 / 非法 → 0 = 不启用 */
  count: number;
};

/**
 * 从 promotion_config 的 dailyFreeSpins 节点解析每日免费抽奖配置。
 * 纯函数，缺省或非法时返回 { enabled: false, count: 0 }。
 */
export function normalizeDailyFreeSpinConfig(raw: unknown): DailyFreeSpinConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, count: 0 };
  }
  const node = raw as Record<string, unknown>;
  const enabled = node.enabled === true || node.enabled === 1 || node.enabled === "true";
  if (!enabled) return { enabled: false, count: 0 };
  const count = Math.floor(Math.max(0, Number(node.count) || 0));
  // 有效区间 1..10（与前端表单一致，growth-config.ts:609）；越界视为未启用，
  // 发布预检会以 disabled_by_invalid_count 警告运营（P2 审查项：防 API 直写绕过前端上限）。
  if (count < 1 || count > 10) return { enabled: false, count: 0 };
  return { enabled: true, count };
}
