/**
 * 邀请里程碑进度（docs/259 D2 ②）—— 纯计算，零 incentive-engine 依赖。
 *
 * 职责边界：
 * - 本模块只做「配置 + 已发标记 → 展示用进度」的推导，不发奖、不查库、不 import 引擎。
 *   引擎负责运行时「该不该发、发多少」；本模块负责前台「还差几人、已解锁哪几档」。
 * - 幂等标记的解析（整标记 / 部分标记）是唯一实现，referral-rewards-engine 从这里导入，
 *   避免"发放侧与展示侧各写一份解析"导致进度与实际发放漂移。
 *
 * 为什么阈值要从 conditions 反推而不是另存一个字段？
 * conditions 是引擎判定的唯一真相（`totalJoinedCount >= N`），
 * 若再存一份 requireCount，运营改了其一就会出现"UI 说 5 人、引擎按 3 人发"的错位。
 */

/** 幂等标记：整标记 = 已足额发完；部分标记 `rewardId:N` = 已发出 N 份（码池不足续发中） */
export type GrantedMarks = { full: Set<string>; partial: Map<string, number> };

/**
 * 解析已发放标记列表（JSON 数组，容错：非法回退空集）。
 * 存储在 shareRecords.rewardMilestonesGranted。
 */
export function parseGrantedRewardIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * 把幂等标记拆成"已发满"集合与"部分已发"计数表。
 *
 * `rewardId:N` 形式（N 为正整数）视为部分标记；其余一律视为整标记，
 * 因此 rewardId 自身含冒号时只会被当成整标记，不会误判成部分（保守方向：不重复发）。
 */
export function splitGrantedMarks(marks: string[]): GrantedMarks {
  const full = new Set<string>();
  const partial = new Map<string, number>();
  for (const mark of marks) {
    const idx = mark.lastIndexOf(":");
    const suffix = idx > 0 ? mark.slice(idx + 1) : "";
    if (idx > 0 && /^\d+$/.test(suffix) && Number(suffix) > 0) {
      const rewardId = mark.slice(0, idx);
      // 同一 rewardId 出现多个部分标记时取最大值（保守方向：不重复发）
      partial.set(rewardId, Math.max(partial.get(rewardId) ?? 0, Number(suffix)));
    } else {
      full.add(mark);
    }
  }
  return { full, partial };
}

/** 生成本次要写入的标记 token：发满写整标记，未发满写 `rewardId:已发数` */
export function buildGrantedMark(rewardId: string, issuedTotal: number, target: number): string {
  return issuedTotal >= target ? rewardId : `${rewardId}:${issuedTotal}`;
}

/** 里程碑阈值判定使用的字段名（与引擎 conditions 白名单一致） */
const THRESHOLD_FIELD = "totalJoinedCount";

/** referralRewardDefs 条目的结构化子集（不依赖引擎类型，字段名与引擎一致） */
export type MilestoneDefLike = {
  rewardId?: unknown;
  type?: unknown;
  fixedAmount?: unknown;
  conditions?: unknown;
  metadata?: unknown;
};

/**
 * 从 conditions 反推「需要邀请多少人」。
 *
 * 只识别可确定单一阈值的形态：顶层数组（隐式 AND）与显式 AND 节点内的
 * `totalJoinedCount GTE|GT N`；OR / NOT 无法归约成一个数字，返回 null（前台不展示阈值）。
 * 多个阈值同时出现时取最严格（最大值）——与引擎「AND 全部满足」语义一致。
 *
 * GT 语义换算：`> N` 即 `>= N+1`（邀请人数是整数）。
 */
export function extractMilestoneThreshold(conditions: unknown): number | null {
  if (!Array.isArray(conditions)) return null;
  let threshold: number | null = null;
  const visit = (nodes: unknown[], depth: number): void => {
    if (depth > 5) return;  // 与引擎 MAX_CONDITION_DEPTH 对齐，防深树
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as Record<string, unknown>;
      const nodeType = String(node.type || "COMPARE");
      if (nodeType === "AND" && Array.isArray(node.conditions)) {
        visit(node.conditions as unknown[], depth + 1);
        continue;
      }
      if (nodeType !== "COMPARE") continue;  // OR / NOT 不可归约
      if (String(node.field || "") !== THRESHOLD_FIELD) continue;
      const operator = String(node.operator || "");
      if (operator !== "GTE" && operator !== "GT") continue;
      const value = Number(node.value);
      if (!Number.isFinite(value)) continue;
      const required = operator === "GT" ? Math.floor(value) + 1 : Math.ceil(value);
      if (required < 1) continue;
      threshold = threshold == null ? required : Math.max(threshold, required);
    }
  };
  visit(conditions, 1);
  return threshold;
}

export type MilestoneProgressItem = {
  rewardId: string;
  /** 需要的有效邀请人数；conditions 无法归约时为 null */
  requireCount: number | null;
  /** 出口类型：bonus_spin / bonus_coupon */
  rewardExit: string;
  /** 券档位 label（仅 bonus_coupon） */
  couponLabel?: string;
  /**
   * 发放份数。仅 FIXED 类型可精确预告（fixedAmount 是常量）；
   * DIRECT/CUSTOM 的金额由引擎按事件值实时计算，此处返回 null 而不猜测，
   * 避免前台承诺与实际发放不一致。
   */
  amount: number | null;
  /** 邀请人数是否已达阈值（requireCount 为 null 时按未达标处理） */
  reached: boolean;
  /** 是否已足额发放（整标记） */
  granted: boolean;
  /** 已发出的份数（部分标记；未发放为 0，已发满时等于 amount 或 0） */
  grantedCount: number;
};

export type MilestoneProgress = {
  milestones: MilestoneProgressItem[];
  /** 下一个未达标的里程碑（按 requireCount 升序取第一个）；全部达标为 null */
  nextMilestone: MilestoneProgressItem | null;
  /** 已达标档数 */
  unlockedCount: number;
  /** 已足额发放档数 */
  grantedCount: number;
};

/**
 * 构建里程碑进度面（供 my-viral-stats 返回）。
 *
 * @param defs 已通过 normalizeReferralRewardDefs 校验的配置条目（非法条目不应传入）
 * @param totalJoined 该分享者名下累计有效邀请人数
 * @param marks shareRecords.rewardMilestonesGranted 的合并标记列表
 */
export function buildMilestoneProgress(input: {
  defs: MilestoneDefLike[];
  totalJoined: number;
  marks: string[];
}): MilestoneProgress {
  const joined = Math.max(0, Math.floor(Number(input.totalJoined) || 0));
  const { full, partial } = splitGrantedMarks(input.marks);

  const milestones: MilestoneProgressItem[] = [];
  for (const def of input.defs) {
    const rewardId = String(def?.rewardId || "");
    if (!rewardId) continue;
    const meta = (def?.metadata && typeof def.metadata === "object"
      ? def.metadata as Record<string, unknown>
      : {});
    const rewardExit = String(meta.rewardExit || "bonus_spin");
    const couponLabel = meta.couponLabel != null ? String(meta.couponLabel) : undefined;
    const requireCount = extractMilestoneThreshold(def?.conditions);
    const fixed = String(def?.type || "") === "FIXED" ? Math.floor(Number(def?.fixedAmount)) : NaN;
    const amount = Number.isFinite(fixed) && fixed > 0 ? fixed : null;
    milestones.push({
      rewardId,
      requireCount,
      rewardExit,
      ...(couponLabel ? { couponLabel } : {}),
      amount,
      reached: requireCount != null && joined >= requireCount,
      granted: full.has(rewardId),
      grantedCount: full.has(rewardId) ? (amount ?? 0) : (partial.get(rewardId) ?? 0),
    });
  }

  // 按 requireCount 升序（null 排最后），前台可直接按序渲染阶梯
  milestones.sort((a, b) => {
    if (a.requireCount == null) return b.requireCount == null ? 0 : 1;
    if (b.requireCount == null) return -1;
    return a.requireCount - b.requireCount;
  });

  const nextMilestone = milestones.find((m) => !m.reached && m.requireCount != null) ?? null;
  return {
    milestones,
    nextMilestone,
    unlockedCount: milestones.filter((m) => m.reached).length,
    grantedCount: milestones.filter((m) => m.granted).length,
  };
}
