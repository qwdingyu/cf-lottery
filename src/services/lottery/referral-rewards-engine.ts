/**
 * 推荐奖励引擎适配器（docs/250 §3.2-3.3）
 *
 * 通过 @usethink/incentive-engine 的 distributeByDefs 纯计算函数，
 * 将 referralRewardDefs 配置翻译为具体的奖励发放（bonus_spin / bonus_coupon 等）。
 *
 * 相对于现有路径 [2] processReferralMilestoneRewards 的特点：
 * - 配置驱动：奖励规则通过 incentive-engine 的 rewardDefs 格式表达，支持
 *   FIXED/CUSTOM/DIRECT 类型 + conditions 条件树
 * - 奖励出口多样化：通过 metadata.rewardExit 控制发放类型（bonus_spin/bonus_coupon）
 * - 幂等性：已发放的 rewardId 写入 shareRecords.rewardMilestonesGranted（JSON 数组）
 * - 与现有路径 [2] 互斥：同一活动不能同时配置 referralRewards 和 referralRewardDefs
 *
 * 容错原则（与现有路径一致）：
 * - 奖励失败不影响参与主流程（由调用方 try/catch 包裹）
 * - 配置无效/为空时静默跳过
 * - 幂等标记失败时跳过但不抛异常
 */
import type { DbType } from "../../db/client";
import { and, eq } from "drizzle-orm";
import { shareRecords } from "../../db/schema";
import { grantBonusSpin, grantBonusCoupon } from "./reward-exits";

/**
 * 外部导入 @usethink/incentive-engine
 * 注意：该包是 CommonJS 模块，ESM 下只能使用 default import
 */
import engine, { type RewardDef } from "@usethink/incentive-engine";

/**
 * incentive-engine rewardDef 的 metadata 扩展字段（由 cf-lottery 定义）
 */
export interface ReferralRewardMeta {
  /** 奖励出口类型：bonus_spin / bonus_coupon */
  rewardExit?: string;
  /** 奖励出口说明（用于日志/审计） */
  exitLabel?: string;
  /** 优惠券 label（仅 rewardExit=bonus_coupon 时使用） */
  couponLabel?: string;
}

/**
 * 归一化 referralRewardDefs 配置。
 * 非法/空输入返回空数组（静默跳过）。
 *
 * 校验项（docs/254 + docs/255 §六 P1-3 + docs/255 二次审查 B1/B2）：
 * - rewardId：非空字符串，且全局唯一（重复 rewardId 会导致幂等标记混乱）
 * - type：白名单 {DIRECT, FIXED, CUSTOM}（剔除 LEVEL：cf-lottery 恒传 ancestors=[]，数学上永不发放；
 *   剔除会在直接调用时抛异常的未知类型）
 * - target：白名单 {SOURCE}（剔除 PARENT：cf-lottery 恒传 directParent=null，永不发放）
 * - 金额：必须是 Decimal 能安全解析的十进制且 > 0
 *   · FIXED → fixedAmount；DIRECT → rate；CUSTOM → amount 或 amountFrom
 *   · 引擎用 Decimal 比较，而 Decimal 对 " 5 " / true / "5%" 直接抛 DecimalError，
 *     异常会被 maybeTriggerReward 的 try/catch 吞掉 → 该分享者整批奖励静默丢失
 * - rewardExit：白名单 bonus_spin/bonus_coupon
 * - conditions：严格校验（非数组 FAIL-OPEN 根除；字段/算子白名单；逻辑节点递归；
 *   深度上限 5 防深树 DoS；排序算子 value 必须可解析数值；EQ/NE 必须有 value——
 *   NE 缺 value 时引擎恒返回 true，等于无条件超发）
 *
 * ⚠️ 单一真相：本函数与 collectReferralRewardDefIssues 共用 validateReferralRewardDef，
 * 禁止各写一份判断，否则预检与运行时会漂移（预检放行但运行时剔除，或反之）。
 */
const REWARD_TYPE_WHITELIST = new Set(["DIRECT", "FIXED", "CUSTOM"]);
const REWARD_TARGET_WHITELIST = new Set(["SOURCE"]);
const REWARD_EXIT_WHITELIST = new Set(["bonus_spin", "bonus_coupon"]);
/**
 * CUSTOM.amountFrom 白名单：只允许指向数值来源。
 * 指向 activityKind 等非数值字段时，resolveCustomAmount 会返回 "lottery"，
 * 随后 Decimal.gt("lottery","0") 抛 DecimalError（同样静默丢失整批奖励）。
 */
const CUSTOM_AMOUNT_FROM_WHITELIST = new Set(["eventValue", "event.attrs.totalJoinedCount"]);
/** conditions 字段白名单（对齐 processReferralRewardsEngine 实际提供的 attrs） */
const CONDITION_FIELD_WHITELIST = new Set(["totalJoinedCount", "activityKind", "eventValue", "eventType"]);
/** 排序类算子：value 必须可解析数值（引擎比较时非数值会恒 false） */
const CONDITION_ORDERING_OPERATORS = new Set(["GTE", "GT", "LTE", "LT"]);
const CONDITION_OPERATOR_WHITELIST = new Set(["GTE", "GT", "LTE", "LT", "EQ", "NE"]);
const CONDITION_NODE_TYPE_WHITELIST = new Set(["COMPARE", "AND", "OR", "NOT"]);
const MAX_CONDITION_DEPTH = 5;

/**
 * 金额是否为 Decimal 能安全解析的十进制值。
 *
 * 与引擎实现严格对齐（node_modules/@usethink/incentive-engine/src/decimal.js）：
 * Decimal 接受有限数字与纯十进制字符串，但对带空格（" 5 "）、布尔、百分号（"5%"）、
 * 空串直接抛 DecimalError。科学计数法（"1e3"）虽被 Decimal 接受，但运营配置里
 * 出现即为误写（UI 只产出 String(整数)），一并剔除以免发出意料之外的金额。
 */
function isSafeDecimalAmount(raw: unknown): boolean {
  if (typeof raw === "number") return Number.isFinite(raw);
  if (typeof raw !== "string") return false;
  if (raw === "" || raw !== raw.trim()) return false;
  return /^\d+(\.\d+)?$/.test(raw);
}

/** 金额是否安全且 > 0（<=0 时引擎不产生记录，属死配置） */
function isPositiveDecimalAmount(raw: unknown): boolean {
  return isSafeDecimalAmount(raw) && Number(raw) > 0;
}

/**
 * conditions 的 value 是否可解析为数值。
 * 引擎 _toComparable 会 String().trim()，因此数字与带空格数字串都可用，
 * 不应像金额那样严格（否则误杀 `{operator:"GTE", value: 3}` 这类合法配置）。
 */
function isNumericConditionValue(raw: unknown): boolean {
  if (typeof raw === "number") return Number.isFinite(raw);
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  return s !== "" && Number.isFinite(Number(s));
}

/** EQ/NE 的 value 是否存在（缺失时 _toComparable(undefined)="" → NE 恒 true，无条件超发） */
function isPresentConditionValue(raw: unknown): boolean {
  if (typeof raw === "number") return Number.isFinite(raw);
  return typeof raw === "string" && raw.trim() !== "";
}

/**
 * 递归校验单个 conditions 节点（元素）。
 * @param node 节点对象
 * @param depth 当前深度（顶层元素为 1）
 * @param isChild 是否作为逻辑节点的 children（子节点必须显式 type，引擎不会自动包装）
 */
function isValidConditionNode(
  node: unknown,
  depth: number,
  isChild: boolean,
): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  if (depth > MAX_CONDITION_DEPTH) return false; // 防深树 DoS
  const n = node as Record<string, unknown>;
  const type = n.type;

  // 逻辑节点（AND/OR/NOT）：children 必须是非空数组，子节点逐个递归校验（必须显式 type）
  if (typeof type === "string" && type !== "COMPARE" && CONDITION_NODE_TYPE_WHITELIST.has(type)) {
    if (!Array.isArray(n.children) || n.children.length === 0) return false;
    return n.children.every((child) => isValidConditionNode(child, depth + 1, true));
  }

  // COMPARE 节点（显式 type，或顶层无 type 由引擎包装）
  if (type !== undefined && typeof type !== "string") return false;
  if (typeof type === "string" && !CONDITION_NODE_TYPE_WHITELIST.has(type)) return false;

  // 子节点必须显式 type（引擎 evaluateCondition 对 !condition.type 返回 false，子节点不会被自动包装）
  if (isChild && type === undefined) return false;

  // field / operator 白名单
  if (typeof n.field !== "string" || !CONDITION_FIELD_WHITELIST.has(n.field)) return false;
  if (typeof n.operator !== "string" || !CONDITION_OPERATOR_WHITELIST.has(n.operator)) return false;
  // 排序类算子：value 必须可解析数值（引擎比较非数值恒 false，等于死配置）
  if (CONDITION_ORDERING_OPERATORS.has(n.operator)) {
    return isNumericConditionValue(n.value);
  }
  // EQ/NE：value 必须存在。缺失时引擎 _toComparable(undefined) 得 ""，
  // EQ 恒 false（死配置）、NE 恒 true（无条件发奖，资金风险）。
  return isPresentConditionValue(n.value);
}

/** 校验 referralRewardDefs 的 conditions 是否合法（非数组 → fail-open 根除） */
function isValidConditions(conditions: unknown): boolean {
  // 缺省 / 空数组：语义合法（无条件档，幂等标记保证只发一次）
  if (conditions === undefined || conditions === null) return true;
  if (!Array.isArray(conditions)) return false; // 对象/字符串/数字 → FAIL-OPEN，必须剔除
  return conditions.every((c) => isValidConditionNode(c, 1, false));
}

/**
 * 校验单条 referralRewardDef —— 校验逻辑的唯一实现。
 *
 * normalizeReferralRewardDefs（运行时剔除）与 collectReferralRewardDefIssues
 * （发布预检报错）都必须走本函数，禁止各自复制判断，否则两者会漂移：
 * 预检放行而运行时剔除（运营配了不生效），或预检报错而运行时会发（发不了却在发奖）。
 *
 * @param seenRewardIds 已出现过的 rewardId（用于唯一性判断）；校验通过时会写入
 * @returns null 表示合法；否则返回可直接展示给运营的中文原因
 */
function validateReferralRewardDef(item: unknown, seenRewardIds: Set<string>): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "条目不是对象";
  const def = item as Record<string, unknown>;

  // rewardId：非空字符串 + 全局唯一（rewardId 同时是幂等键，重复会导致标记混乱）
  if (!def.rewardId || typeof def.rewardId !== "string") return "缺少 rewardId";
  if (seenRewardIds.has(def.rewardId)) return "rewardId 重复";

  // type：白名单（DIRECT/FIXED/CUSTOM；剔除 LEVEL 与未知类型）
  if (typeof def.type !== "string" || !REWARD_TYPE_WHITELIST.has(def.type)) {
    return `type 非法（仅支持 ${[...REWARD_TYPE_WHITELIST].join("/")}）`;
  }
  // target：白名单（SOURCE；剔除 PARENT——cf-lottery 恒传 directParent=null）
  if (typeof def.target !== "string" || !REWARD_TARGET_WHITELIST.has(def.target)) {
    return `target 非法（仅支持 ${[...REWARD_TARGET_WHITELIST].join("/")}）`;
  }

  // 金额：必须是 Decimal 能安全解析的十进制且 > 0（否则抛 DecimalError 或恒不发放）
  if (def.type === "FIXED" && !isPositiveDecimalAmount(def.fixedAmount)) {
    return "fixedAmount 必须是大于 0 的十进制数（不允许空格/百分号/布尔/科学计数法）";
  }
  if (def.type === "DIRECT" && !isPositiveDecimalAmount(def.rate)) {
    return "rate 必须是大于 0 的十进制数（不允许空格/百分号/布尔/科学计数法）";
  }
  if (def.type === "CUSTOM") {
    const hasAmountFrom = def.amountFrom !== undefined && def.amountFrom !== null && def.amountFrom !== "";
    if (hasAmountFrom) {
      if (typeof def.amountFrom !== "string" || !CUSTOM_AMOUNT_FROM_WHITELIST.has(def.amountFrom)) {
        return `amountFrom 非法（仅支持 ${[...CUSTOM_AMOUNT_FROM_WHITELIST].join(" / ")}）`;
      }
      // amountFrom 取不到值时引擎会回退 amount，因此 amount 存在时也必须安全
      if (def.amount !== undefined && def.amount !== null && def.amount !== "" && !isSafeDecimalAmount(def.amount)) {
        return "amount 必须是十进制数（不允许空格/百分号/布尔/科学计数法）";
      }
    } else if (!isPositiveDecimalAmount(def.amount)) {
      return "CUSTOM 必须提供大于 0 的 amount，或指向数值来源的 amountFrom";
    }
  }

  // rewardExit：白名单（在 metadata 中）
  const meta = (def.metadata || {}) as Record<string, unknown>;
  const exit = String(meta.rewardExit || "bonus_spin");
  if (!REWARD_EXIT_WHITELIST.has(exit)) {
    return `rewardExit 非法（仅支持 ${[...REWARD_EXIT_WHITELIST].join("/")}）`;
  }

  // conditions：严格校验（非数组 fail-open 根除 + 白名单 + 递归 + 深度上限 + value 语义）
  if (!isValidConditions(def.conditions)) {
    return "conditions 非法（必须为数组，字段/算子需在白名单内，逻辑节点需显式 type，比较算子需有可用 value）";
  }

  seenRewardIds.add(def.rewardId);
  return null;
}

export function normalizeReferralRewardDefs(raw: unknown): RewardDef[] {
  if (!Array.isArray(raw)) return [];
  const seenRewardIds = new Set<string>();
  return raw.filter((item) => validateReferralRewardDef(item, seenRewardIds) === null) as RewardDef[];
}

/**
 * 收集 referralRewardDefs 中每个非法条目的原因（docs/255 §6.6 P1-3）。
 * 供发布预检对每个非法条目单独报 error（而非只在"全部无效"时给一条 warning）。
 *
 * 不变式：normalizeReferralRewardDefs 保留数 + 本函数报错数 === 输入条目数。
 *
 * @returns [{ rewardId, reason }] 非法条目列表；全部合法返回 []
 */
export function collectReferralRewardDefIssues(raw: unknown): Array<{ rewardId: string; reason: string }> {
  if (!Array.isArray(raw)) return [];
  const issues: Array<{ rewardId: string; reason: string }> = [];
  const seenRewardIds = new Set<string>();
  for (const item of raw) {
    const reason = validateReferralRewardDef(item, seenRewardIds);
    if (reason === null) continue;
    const rewardId = String(
      (item && typeof item === "object" ? (item as Record<string, unknown>).rewardId : undefined) ?? "?",
    );
    issues.push({ rewardId, reason });
  }
  return issues;
}

/**
 * 解析已发放的 rewardId 列表（JSON 数组，容错：非法回退空集）。
 * 与现有路径 [2] 的 parseGrantedMilestones 语义一致，但存储的是 rewardId 字符串而非 requireCount 数值。
 *
 * 标记有两种形态（docs/255 复审 A4）：
 * - 整标记 `rewardId`：该奖励已足额发完，之后不再发放
 * - 部分标记 `rewardId:N`：该奖励只发出了 N 份（码池不足），后续归因续发差额
 * 旧版本只写整标记，格式向后兼容。
 */
function parseGrantedRewardIds(raw: string | null | undefined): string[] {
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
function splitGrantedMarks(marks: string[]): { full: Set<string>; partial: Map<string, number> } {
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
function buildGrantedMark(rewardId: string, issuedTotal: number, target: number): string {
  return issuedTotal >= target ? rewardId : `${rewardId}:${issuedTotal}`;
}

/**
 * 分享者聚合信息：邀请总人数 + 名下全部 share_record id（幂等标记目标）
 */
interface SharerAggregate {
  totalJoined: number;
  sharerEntryId: string;
  recordIds: string[];
  grantedRewardIds: string[];
  /** 各 record 当前的 rewardMilestonesGranted 值（与 recordIds 一一对应，CAS 标记的基准） */
  oldValues: string[];
}

/**
 * 聚合分享者数据：按 sharerEntryId 汇总全部 shareRecords 的 joinedCount 和已发放奖励。
 *
 * 与现有路径 [2] 的聚合逻辑一致（P1 修复：按分享者聚合，而非按单条记录）。
 */
async function aggregateSharerData(
  tx: DbType,
  tenantId: string,
  drawId: string,
  shareRecordId: string,
): Promise<SharerAggregate | null> {
  // 先找触发本次归因的分享记录，定位分享者
  const [triggerShare] = await tx
    .select({ sharerEntryId: shareRecords.sharerEntryId })
    .from(shareRecords)
    .where(eq(shareRecords.id, shareRecordId))
    .limit(1);
  if (!triggerShare?.sharerEntryId) return null;

  const sharerEntryId = triggerShare.sharerEntryId;

  // 读取该分享者全部 share_record
  const sharerRecords = await tx
    .select({
      id: shareRecords.id,
      joinedCount: shareRecords.joinedCount,
      rewardMilestonesGranted: shareRecords.rewardMilestonesGranted,
    })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, tenantId),
      eq(shareRecords.drawId, drawId),
      eq(shareRecords.sharerEntryId, sharerEntryId),
    ));
  if (sharerRecords.length === 0) return null;

  const totalJoined = sharerRecords.reduce(
    (sum, r) => sum + Math.max(0, Math.floor(Number(r.joinedCount) || 0)),
    0,
  );
  const grantedSet = new Set<string>();
  for (const r of sharerRecords) {
    for (const id of parseGrantedRewardIds(r.rewardMilestonesGranted)) {
      grantedSet.add(id);
    }
  }

  return {
    totalJoined,
    sharerEntryId,
    recordIds: sharerRecords.map((r) => r.id),
    grantedRewardIds: [...grantedSet],
    oldValues: sharerRecords.map((r) => r.rewardMilestonesGranted ?? ""),
  };
}

/**
 * 标记已发放的 rewardId 到分享者的全部 share_record（幂等防护）。
 *
 * 采用 CAS 乐观锁：UPDATE 时带 `rewardMilestonesGranted == 旧值` 条件，
 * 防止并发下两个请求互相覆盖标记（审查 docs/252 §2.1）。
 *
 * 顺序：先 grant（CAS 防护），后 mark（CAS 防护，best effort）。
 * 如果 mark 的 CAS 失败（rowsAffected=0），说明其他请求已先一步标记，
 * 此时 grant 已成功（由 grant 层的 CAS 防护防止重复发放），
 * mark 标记在下次归因时由 grant 层的 CAS 兜底。
 *
 * @param tx 事务实例
 * @param tenantId 租户 ID
 * @param drawId 活动 ID
 * @param recordIds 该分享者名下全部 share_record id 列表
 * @param currentGranted 当前已发放的标记列表（快照，用于计算新值）
 * @param newMark 本次要写入的标记（整标记 `rewardId` 或部分标记 `rewardId:N`）
 * @param rewardId 本次奖励的 rewardId（用于清掉它的旧标记，避免 `c1:1` 与 `c1` 并存）
 * @param currentValues 各 record 当前的 rewardMilestonesGranted 值（CAS 条件的基准）
 *   与 recordIds 一一对应，在 aggregateSharerData 阶段读取
 * @returns 全部 record 标记成功返回 true，任一失败返回 false
 */
async function markRewardIdsGranted(
  tx: DbType,
  recordIds: string[],
  currentGranted: string[],
  newMark: string,
  rewardId: string,
  currentValues: string[],
): Promise<boolean> {
  // 先剔除同一 rewardId 的旧标记（整标记与任意部分标记），再写入本次标记，
  // 保证同一 rewardId 在列表里只有一条、且始终是最新进度。
  const stale = new Set<string>([rewardId]);
  const kept = currentGranted.filter((mark) => {
    if (stale.has(mark)) return false;
    const idx = mark.lastIndexOf(":");
    return !(idx > 0 && mark.slice(0, idx) === rewardId && /^\d+$/.test(mark.slice(idx + 1)));
  });
  const nextGranted = [...new Set([...kept, newMark])].sort();
  const nextGrantedJson = JSON.stringify(nextGranted);

  for (let i = 0; i < recordIds.length; i++) {
    const recordId = recordIds[i]!;
    const oldValue = currentValues[i] ?? "";
    const result = await tx
      .update(shareRecords)
      .set({ rewardMilestonesGranted: nextGrantedJson })
      .where(and(
        eq(shareRecords.id, recordId),
        eq(shareRecords.rewardMilestonesGranted, oldValue),
      ));
    // CAS 失败（rowsAffected=0）：其他请求已先一步修改了该记录。
    // 此时 grant 已由上游的 CAS 防护（spinsTotalGranted / couponCodes.status）
    // 防止重复发放，mark 不写不影响正确性，只是下次归因需要多一次 CAS 检查。
    if ((result.rowsAffected ?? 0) === 0) return false;
    // 更新 currentValues，使同事务内后续 mark 调用使用最新值（docs/253 修复）
    currentValues[i] = nextGrantedJson;
  }
  return true;
}

/**
 * 处理 engine-powered 推荐奖励（docs/250 §3.2）。
 *
 * 调用时机：归因成功后（maybeTriggerReward 内），与现有路径 [2] 同级。
 * 仅读取 promotionConfig.referralRewardDefs，与 referralRewards 互斥。
 *
 * 流程：
 * 1. 解析 referralRewardDefs 配置；非法/空 → 跳过
 * 2. 聚合分享者数据（totalJoinedCount + 已发放奖励列表）
 * 3. 构建 EngineEvent → 调用 distributeByDefs 计算奖励
 * 4. 幂等过滤：跳过已发放的 rewardId
 * 5. 按 rewardExit 分发到奖励出口
 * 6. 标记已发放的 rewardId
 *
 * @param tx 事务实例（与 joinDraw 同事务）
 * @param draw 活动对象
 * @param shareRecordId 本次归因的分享记录 id
 */
export async function processReferralRewardsEngine(
  tx: DbType,
  draw: {
    id: string;
    tenantId: string;
    activityKind?: string | null;
    maxSpinsPerEntry?: number | null;
    promotionConfig?: string | null;
  },
  shareRecordId: string,
): Promise<void> {
  // 1. 解析 referralRewardDefs 配置
  if (!shareRecordId) return;
  let rewardDefs: RewardDef[] = [];
  try {
    const pc = JSON.parse(draw.promotionConfig || "{}") as Record<string, unknown>;
    const raw = pc.referralRewardDefs;
    rewardDefs = normalizeReferralRewardDefs(raw);
  } catch {
    return;
  }
  if (rewardDefs.length === 0) return;

  // 2. 聚合分享者数据
  const sharer = await aggregateSharerData(tx, draw.tenantId, draw.id, shareRecordId);
  if (!sharer) return;

  // 3. 构建 EngineEvent 并调用 incentive-engine
  const event = {
    sourceNodeId: sharer.sharerEntryId,
    eventValue: String(sharer.totalJoined),
    eventType: "REFERRAL_JOIN",
    attrs: {
      totalJoinedCount: sharer.totalJoined,
      activityKind: draw.activityKind || "",
    },
  };

  // 引擎计算失败必须在本函数内收敛（docs/255 复审 B2）：
  // normalizeReferralRewardDefs 已把已知的抛异常路径（非法 type/target、Decimal 不接受的金额）
  // 挡在外面，但引擎是外部依赖（版本升级可能新增抛错分支），因此这里显式兜底：
  // 记录 rewardIds 以便定位是哪份配置触发，然后按"奖励失败不影响参与主流程"静默返回。
  let records: Array<{ rewardId?: string | null; amount?: string | number | null }> = [];
  try {
    // 4.0.0 破坏性变更（docs/255）：distributeByDefs 新增 sourceNode 必传校验。
    // target="SOURCE" 时 _resolveGateNode 要求 sourceNode 非空，否则抛错
    // （"请给 distributeByDefs 传入 sourceNode"）。cf-lottery 的 rewardDefs 全部用
    // target="SOURCE"，因此必须传 sourceNode = 分享者节点对象（id = sharerEntryId）。
    // 不传会导致升级后 distributeByDefs 抛错 → try/catch 捕获 → 邀请奖励全部静默失效。
    records = engine.Distribute.distributeByDefs({
      event,
      sourceNode: { id: sharer.sharerEntryId, attrs: event.attrs },
      directParent: null,
      ancestors: [],
      rewardDefs,
    });
  } catch (err) {
    console.error(
      `[lottery] distributeByDefs failed for ${draw.id} (rewardIds=${rewardDefs.map((d) => d.rewardId).join(",")}):`,
      err,
    );
    return;
  }
  if (records.length === 0) return;

  // 4. 幂等过滤 + 5. 执行奖励 + 6. 标记幂等
  // ── 三重防超发架构（docs/254 §3.1）──
  // 第一重（幂等层）：rewardMilestonesGranted 列表判断，同一 rewardId 只发放一次
  // 第二重（出口 CAS）：grantBonusSpin 的 spinsTotalGranted 乐观锁 /
  //                    grantBonusCoupon 的 couponCodes.status CAS
  // 第三重（总量约束）：maxSpins 总顶裁剪 / couponCodes 码池可用性
  // 三层独立保护，任何一层失效时仍有其他层兜底，不会超发。
  const maxSpins = Math.max(0, Math.floor(Number(draw.maxSpinsPerEntry || 0)));
  // 当前标记：full = 已足额发完；partial = 已发出的份数（码池不足时的续发进度，docs/255 A4）
  const { full: fullyGranted, partial: partiallyGranted } = splitGrantedMarks(sharer.grantedRewardIds);
  // 标记列表快照（写入时会剔除同 rewardId 的旧标记后重建）
  let grantedMarks = [...sharer.grantedRewardIds];

  // 关键约束（docs/251 §2.3）：bonus_spin 出口只对 lottery + instant 有效。
  // performInstantSpin 严格限制 activityKind === "lottery"（spin-execution.ts:70），
  // 非 lottery 活动即使给分享者加了 spins，分享者也无法消费（spin 接口 400）。
  // 因此非 lottery 类型时，bonus_spin 出口静默跳过（不发放、不标记），
  // 避免"发了但用不了"的奖励污染。发布预检会拦截这种配置（docs/252 §2.2）。
  const isLotteryKind = String(draw.activityKind || "") === "lottery";

  // 建立 rewardId → rewardDef 的映射，用于读取 metadata（engine 的 snapshot 不透传 metadata）
  const defByRewardId = new Map<string, RewardDef>();
  for (const def of rewardDefs) {
    const rid = String(def.rewardId || "");
    if (rid) defByRewardId.set(rid, def);
  }

  for (const record of records) {
    const rewardId = String(record.rewardId || "");
    if (!rewardId) continue;
    // 幂等检查（第一重防护）：已足额发完的 rewardId 直接跳过，
    // 防止同一里程碑在同一分享者身上重复计算（如多次 join 触发同一奖励）。
    // 部分标记（rewardId:N）不跳过——它表示"还差几份"，本次归因续发差额。
    if (fullyGranted.has(rewardId)) continue;

    // 从原始 rewardDef 读取 metadata：
    // 注意！incentive-engine 的 distributeByDefs 输出 record.snapshot 只包含计算字段
    // （rewardId/rewardType/target/rate/fixedAmount/sourceNodeId），不透传 rewardDef 的
    // metadata。因此必须用 rewardId → rewardDef 映射从原始配置读取 rewardExit/couponLabel。
    const def = defByRewardId.get(rewardId);
    const meta = ((def?.metadata || {}) as ReferralRewardMeta);
    const exit = meta.rewardExit || "bonus_spin";
    // 份数解析（docs/255 复审 B2）：引擎金额是十进制字符串（DIRECT 的 rate 是百分比，
    // Decimal.pct = eventValue × rate / 100，因此 rate=10 + 邀请 3 人算出 "0.3"）。
    // 奖励出口只能发整份（抽奖次数/优惠券张数），故向下取整；不足 1 份视为"尚未达标"：
    // 不发放也不写标记，等邀请人数涨够再发。
    // 反面示例（修复前）：bonus_coupon 侧 Math.max(1, 0) 把 0.3 份凑成 1 张并写整标记，
    // 等于提前超发且永久锁死该档；bonus_spin 侧则是 NaN/负数可能被带进 SQL 表达式。
    const amount = Math.floor(Number(record.amount ?? 0));
    if (!Number.isFinite(amount) || amount < 1) continue;

    // 非 lottery 类型 + bonus_spin 出口 → 跳过（见上方约束注释）
    if (exit === "bonus_spin" && !isLotteryKind) continue;

    // 按 rewardExit 分发到具体奖励出口。
    // 每个出口内部都有独立的 CAS 防护（第二重）：
    // - grantBonusSpin：spinsTotalGranted 乐观锁（行级）
    // - grantBonusCoupon：couponCodes.status='available' 原子更新
    // 奖励失败（如码池耗尽、spins 已达上限）不抛异常，只是发不出去。
    //
    // newMark 语义（docs/255 复审 A4）：
    // - bonus_spin：maxSpins 裁剪是活动硬顶，发少了也不该续发（续发会突破硬顶），
    //   因此成功即写整标记
    // - bonus_coupon：码池不足属临时缺货，写部分标记 `rewardId:已发份数`，
    //   补货后下次归因续发差额；发满才写整标记
    let newMark: string | null = null;
    // 单条奖励级容错（docs/255 复审 B2）：出口抛异常（如底层 DB 错误）时只丢这一条奖励，
    // 不能让同一分享者的其他 rewardId 跟着丢失。修复前异常直接冒泡到
    // maybeTriggerReward 的 try/catch，records 里排在后面的奖励全部静默丢失。
    try {
      switch (exit) {
        case "bonus_spin": {
          const ok = await grantBonusSpin(
            tx, draw.tenantId, draw.id,
            sharer.sharerEntryId, amount, maxSpins, rewardId,
          );
          if (ok) newMark = rewardId;
          break;
        }
        case "bonus_coupon": {
          const target = amount;
          const alreadyIssued = partiallyGranted.get(rewardId) ?? 0;
          const remaining = target - alreadyIssued;
          if (remaining <= 0) {
            // 运营把张数改小了：已发的比现配置还多 → 直接收敛为整标记，不再发放
            newMark = rewardId;
            break;
          }
          const issued = await grantBonusCoupon(
            tx, draw.tenantId, draw.id,
            sharer.sharerEntryId, meta.couponLabel, rewardId, remaining,
          );
          if (issued > 0) {
            newMark = buildGrantedMark(rewardId, alreadyIssued + issued, target);
          }
          // issued === 0（码池空）：不写任何标记，保持可重试
          break;
        }
        default:
          // 未知奖励出口（白名单校验已拦截，这里是防御性兜底）
          break;
      }
    } catch (err) {
      console.error(`[lottery] referral reward exit ${exit} failed for ${draw.id} reward ${rewardId}:`, err);
      continue;
    }

    // 标记幂等（仅奖励成功时标记，防止"标记了但没发"的错账）
    // 用 CAS 条件（rewardMilestonesGranted == 旧值）防止并发覆盖。
    // mark 失败时（CAS 冲突），grant 已由上游的 CAS 防护，不会重复发放，
    // 只是下次归因需要多一次 CAS 检查。见 docs/252 §2.1。
    if (newMark) {
      const markOk = await markRewardIdsGranted(
        tx, sharer.recordIds, grantedMarks, newMark, rewardId, sharer.oldValues,
      );
      if (markOk) {
        // 同步内存快照：同事务内后续 rewardId 的标记要基于最新列表计算
        grantedMarks = [
          ...grantedMarks.filter((m) => m !== rewardId && !(m.startsWith(`${rewardId}:`))),
          newMark,
        ];
        if (newMark === rewardId) {
          fullyGranted.add(rewardId);
          partiallyGranted.delete(rewardId);
        } else {
          partiallyGranted.set(rewardId, Number(newMark.slice(rewardId.length + 1)));
        }
      }
      // mark 失败时不更新内存快照：下次归因 engine 会再次返回该 rewardId，
      // 但 grant 层的 CAS 会阻止重复发放（spinsTotalGranted / couponCodes.status）。
      // 这是"best effort"标记的权衡——宁可多一次 CAS 检查，不可多写一条误标记。
    }
  }
}