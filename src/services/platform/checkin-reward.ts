/**
 * 签到奖励配置解析与计算（docs/172）。
 *
 * 设计目标：把「签到派多少 spins + 是否连续递增」的规则收敛到一个模块，
 * 让 admin API（parseBuiltinCommandsInput）、targets.ts（parseBuiltinCommandConfig）
 * 与 commands.ts（executeCheckinCommand）三处共用同一套语义，避免解析漂移。
 *
 * 奖励模式（dailyCheckinPolicy.rewardConfig.mode）：
 *   daily  : 每日固定值或区间随机，无连续递增（min===max 即固定值）
 *   linear : 线性递增，第 N 天 = base + (N-1) * increment，封顶 cap
 *   step   : 阶梯递增，每 stepDays 天提升一次（步长为 increment），封顶 cap
 *   cycle  : 周期循环，第 cycleDays 天额外发放 cycleBonus 后重置连续天数
 *
 * baseRange：所有模式通用。min===max 取固定值；min<max 在该区间随机取整数。
 * 递增模式中 baseRange 决定「第 1 天」的基础值，递增部分在其上累加。
 */
import type { BuiltinCommandConfig } from "./types";

/** 合法的签到奖励模式 */
export type CheckinRewardMode = "daily" | "linear" | "step" | "cycle";

/** 奖励基础值范围：min===max 为固定值，min<max 为区间随机 */
export type CheckinBaseRange = { min: number; max: number };

/** 连续签到递增配置（docs/172） */
export type CheckinStreakConfig = {
  /** 奖励模式 */
  mode: CheckinRewardMode;
  /** 基础值范围 [min, max] */
  baseRange: CheckinBaseRange;
  /** 每日递增量（linear/step 模式） */
  increment?: number;
  /** 封顶值（递增模式的最大奖励，防止通胀） */
  cap?: number;
  /** 阶梯天数（step 模式，每 N 天提升一次） */
  stepDays?: number;
  /** 周期天数（cycle 模式） */
  cycleDays?: number;
  /** 周期额外奖励（cycle 模式，第 cycleDays 天额外发放） */
  cycleBonus?: number;
};

/**
 * 从任意 JSON 值中安全解析「签到奖励配置」。
 * 返回 undefined 表示未配置或非法。所有字段都做防御式校验，
 * 非法/越界字段省略，保证持久化和读取两端语义一致。
 */
export function parseStoredCheckinPolicy(raw: unknown): BuiltinCommandConfig["dailyCheckinPolicy"] {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  // 1. 兼容旧字段 grantSpinCount（简单固定值）
  const grantSpinCount = toNonNegInt(obj.grantSpinCount);

  // 2. 解析 rewardConfig
  const rc = obj.rewardConfig && typeof obj.rewardConfig === "object"
    ? obj.rewardConfig as Record<string, unknown>
    : undefined;
  const streak = rc ? parseStreakConfig(rc) : undefined;

  // 3. 组装：rewardConfig 优先；否则回退 grantSpinCount
  if (streak) {
    return { ...(grantSpinCount !== undefined ? { grantSpinCount } : {}), rewardConfig: streak };
  }
  if (grantSpinCount !== undefined) {
    return { grantSpinCount };
  }
  return undefined;
}

/** 解析 rewardConfig 为合法 CheckinStreakConfig；非法返回 undefined */
function parseStreakConfig(rc: Record<string, unknown>): CheckinStreakConfig | undefined {
  const mode = rc.mode as CheckinRewardMode;
  if (!isValidMode(mode)) return undefined;

  const base = rc.baseRange && typeof rc.baseRange === "object"
    ? rc.baseRange as { min?: unknown; max?: unknown }
    : undefined;
  const min = base ? toNonNegInt(base.min) : undefined;
  const max = base ? toNonNegInt(base.max) : undefined;
  const baseMin = min !== undefined ? min : (max !== undefined ? max : undefined);
  const baseMax = max !== undefined ? max : (min !== undefined ? min : undefined);
  if (baseMin === undefined || baseMax === undefined || baseMax < baseMin) return undefined;

  const increment = toNonNegInt(rc.increment);
  const cap = toNonNegInt(rc.cap);
  const stepDays = toPositiveInt(rc.stepDays);
  const cycleDays = toPositiveInt(rc.cycleDays);
  const cycleBonus = toNonNegInt(rc.cycleBonus);

  const cfg: CheckinStreakConfig = {
    mode,
    baseRange: { min: baseMin, max: baseMax },
    ...(increment !== undefined ? { increment } : {}),
    ...(cap !== undefined ? { cap } : {}),
    ...(stepDays !== undefined ? { stepDays } : {}),
    ...(cycleDays !== undefined ? { cycleDays } : {}),
    ...(cycleBonus !== undefined ? { cycleBonus } : {}),
  };
  return cfg;
}

function isValidMode(mode: unknown): mode is CheckinRewardMode {
  return mode === "daily" || mode === "linear" || mode === "step" || mode === "cycle";
}

/** 非负整数解析：非法/负数 → undefined */
function toNonNegInt(value: unknown): number | undefined {
  if (!Number.isFinite(Number(value))) return undefined;
  const n = Math.trunc(Number(value));
  return n >= 0 ? n : undefined;
}

/** 正整数解析：非法/≤0 → undefined */
function toPositiveInt(value: unknown): number | undefined {
  if (!Number.isFinite(Number(value))) return undefined;
  const n = Math.trunc(Number(value));
  return n > 0 ? n : undefined;
}

/**
 * 计算某次签到应发放的 spins 数量。
 *
 * @param streakConfig 递增配置（undefined 表示无递增，只有 grantSpinCount）
 * @param grantSpinCount 旧字段固定值（rewardConfig 缺省时的兜底）
 * @param streakDays 本次签到前的连续签到天数（0 = 首次）
 * @param _nextStreakDays 本次签到后的连续天数（由调用方根据断签/周期计算）
 * @param random01 随机源（可注入便于测试；默认 Math.random）
 * @returns 本次应发放的 spins 数（≥0）
 */
export function computeCheckinReward(
  streakConfig: CheckinStreakConfig | undefined,
  grantSpinCount: number | undefined,
  streakDays: number,
  _nextStreakDays: number,
  random01: () => number = Math.random,
): number {
  // 无递增配置：直接返回固定值（或 0）
  if (!streakConfig) return grantSpinCount && grantSpinCount > 0 ? grantSpinCount : 0;

  const { baseRange, mode } = streakConfig;
  // 基础值：min===max 取固定值，否则区间随机
  const base = baseRange.min === baseRange.max
    ? baseRange.min
    : randInt(baseRange.min, baseRange.max, random01);

  switch (mode) {
    case "daily":
      // 每日固定值/区间随机，无递增
      return base;
    case "linear": {
      // 第 N 天 = base + (N-1) * increment（N 为本次签到后的连续天数）
      const inc = streakConfig.increment ?? 0;
      const n = Math.max(1, streakDays + 1);
      return applyCap(base + (n - 1) * inc, streakConfig.cap);
    }
    case "step": {
      // 每 stepDays 天提升一次：base + floor((N-1)/stepDays) * increment
      const inc = streakConfig.increment ?? 0;
      const days = streakConfig.stepDays ?? 7;
      const n = Math.max(1, streakDays + 1);
      const stepIdx = Math.floor((n - 1) / days);
      return applyCap(base + stepIdx * inc, streakConfig.cap);
    }
    case "cycle": {
      // 第 cycleDays 天额外发放 cycleBonus；达到周期天数后由调用方重置在下一天
      const days = streakConfig.cycleDays ?? 7;
      const bonus = streakConfig.cycleBonus ?? 0;
      const n = Math.max(1, streakDays + 1);
      return applyCap(base + (n >= days ? bonus : 0), streakConfig.cap);
    }
    default:
      return base;
  }
}

/** 对 non-neg 结果应用封顶（cap 未配置则原样返回） */
function applyCap(value: number, cap: number | undefined): number {
  const v = Math.max(0, value);
  return cap !== undefined && v > cap ? cap : v;
}

/** 在闭区间 [min, max] 取随机整数 */
function randInt(min: number, max: number, random01: () => number): number {
  if (max <= min) return min;
  return min + Math.floor(random01() * (max - min + 1));
}

/**
 * 根据上次签到日期计算本次签到后的连续天数。
 *
 * @param lastCheckinDate 上次签到日期（YYYY-MM-DD，NULL=从未签到）
 * @param currentStreak 当前 stored 连续天数
 * @param today 今天（YYYY-MM-DD）
 * @returns 本次签到应存储的连续天数（断签重置为 1，连续则 +1）
 */
export function nextStreakAfterCheckin(
  lastCheckinDate: string | null | undefined,
  currentStreak: number,
  today: string,
): number {
  // 从未签到：连续天数 = 1
  if (!lastCheckinDate) return 1;
  // 昨天签过：连续 +1
  if (isYesterday(lastCheckinDate, today)) return (currentStreak > 0 ? currentStreak : 0) + 1;
  // 断签（更早或同日）：重置为 1
  return 1;
}

/** 判断 prev 是否为 today 的前一天（YYYY-MM-DD 字符串按日期比较） */
function isYesterday(prev: string, today: string): boolean {
  const p = new Date(`${prev}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  const diffDays = Math.round((t.getTime() - p.getTime()) / 86400_000);
  return diffDays === 1;
}

/** 计算「今天」的 YYYY-MM-DD（本地时区） */
export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
}