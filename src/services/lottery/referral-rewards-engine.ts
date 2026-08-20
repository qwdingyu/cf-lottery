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
 * 校验项（docs/254 + docs/255 §六 P1-3）：
 * - rewardId：非空字符串，且全局唯一（重复 rewardId 会导致幂等标记混乱）
 * - type：白名单 {FIXED, CUSTOM}（剔除 LEVEL：cf-lottery 恒传 ancestors=[]，数学上永不发放；
 *   剔除会在直接调用时抛异常的未知类型）
 * - target：白名单 {SOURCE}（剔除 PARENT：cf-lottery 恒传 directParent=null，永不发放）
 * - FIXED 类型必须有 fixedAmount > 0（否则静默不发奖）
 * - rewardExit：白名单 bonus_spin/bonus_coupon
 * - conditions：严格校验（非数组 FAIL-OPEN 根除；字段/算子白名单；逻辑节点递归；
 *   深度上限 5 防深树 DoS）
 */
const REWARD_TYPE_WHITELIST = new Set(["DIRECT", "FIXED", "CUSTOM"]);
const REWARD_TARGET_WHITELIST = new Set(["SOURCE"]);
const REWARD_EXIT_WHITELIST = new Set(["bonus_spin", "bonus_coupon"]);
/** conditions 字段白名单（对齐 referral-rewards-engine.ts:264-272 实际提供的 attrs） */
const CONDITION_FIELD_WHITELIST = new Set(["totalJoinedCount", "activityKind", "eventValue", "eventType"]);
/** 排序类算子：value 必须可解析数值（引擎比较时非数值会恒 false） */
const CONDITION_ORDERING_OPERATORS = new Set(["GTE", "GT", "LTE", "LT"]);
const CONDITION_OPERATOR_WHITELIST = new Set(["GTE", "GT", "LTE", "LT", "EQ", "NE"]);
const CONDITION_NODE_TYPE_WHITELIST = new Set(["COMPARE", "AND", "OR", "NOT"]);
const MAX_CONDITION_DEPTH = 5;

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
    const num = Number(n.value);
    if (typeof n.value !== "string" || n.value.trim() === "" || !Number.isFinite(num)) return false;
  }
  return true;
}

/** 校验 referralRewardDefs 的 conditions 是否合法（非数组 → fail-open 根除） */
function isValidConditions(conditions: unknown): boolean {
  // 缺省 / 空数组：语义合法（无条件档，幂等标记保证只发一次）
  if (conditions === undefined || conditions === null) return true;
  if (!Array.isArray(conditions)) return false; // 对象/字符串/数字 → FAIL-OPEN，必须剔除
  return conditions.every((c) => isValidConditionNode(c, 1, false));
}

export function normalizeReferralRewardDefs(raw: unknown): RewardDef[] {
  if (!Array.isArray(raw)) return [];
  const seenRewardIds = new Set<string>();
  return raw.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const def = item as Record<string, unknown>;
    // rewardId：非空字符串 + 全局唯一
    if (!def.rewardId || typeof def.rewardId !== "string") return false;
    if (seenRewardIds.has(def.rewardId)) return false; // 重复 rewardId 剔除
    // type：白名单（FIXED/CUSTOM/DIRECT；剔除 LEVEL 与未知类型）
    if (typeof def.type !== "string" || !REWARD_TYPE_WHITELIST.has(def.type)) return false;
    // target：白名单（SOURCE；剔除 PARENT）
    if (typeof def.target !== "string" || !REWARD_TARGET_WHITELIST.has(def.target)) return false;
    // FIXED 类型必须有 fixedAmount > 0（否则静默不发奖）
    if (def.type === "FIXED") {
      const fixedAmount = Number(def.fixedAmount);
      if (!(fixedAmount > 0)) return false;
    }
    // rewardExit：白名单（在 metadata 中）
    const meta = (def.metadata || {}) as Record<string, unknown>;
    const exit = String(meta.rewardExit || "bonus_spin");
    if (!REWARD_EXIT_WHITELIST.has(exit)) return false;
    // conditions：严格校验（非数组 fail-open 根除 + 白名单 + 递归 + 深度上限）
    if (!isValidConditions(def.conditions)) return false;
    seenRewardIds.add(def.rewardId);
    return true;
  }) as RewardDef[];
}

/**
 * 收集 referralRewardDefs 中每个非法条目的原因（docs/255 §6.6 P1-3）。
 * 供发布预检对每个非法条目单独报 error（而非只在"全部无效"时给一条 warning）。
 * @returns [{ rewardId, reason }] 非法条目列表；全部合法返回 []
 */
export function collectReferralRewardDefIssues(raw: unknown): Array<{ rewardId: string; reason: string }> {
  if (!Array.isArray(raw)) return [];
  const issues: Array<{ rewardId: string; reason: string }> = [];
  const seenRewardIds = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      issues.push({ rewardId: String((item as Record<string, unknown>)?.rewardId ?? "?"), reason: "条目不是对象" });
      continue;
    }
    const def = item as Record<string, unknown>;
    const rewardId = String(def.rewardId ?? "?");
    if (!def.rewardId || typeof def.rewardId !== "string") {
      issues.push({ rewardId, reason: "缺少 rewardId" });
      continue;
    }
    if (seenRewardIds.has(def.rewardId)) {
      issues.push({ rewardId, reason: "rewardId 重复" });
      continue;
    }
    if (typeof def.type !== "string" || !REWARD_TYPE_WHITELIST.has(def.type)) {
      issues.push({ rewardId, reason: `type 非法（仅支持 ${[...REWARD_TYPE_WHITELIST].join("/")}）` });
      continue;
    }
    if (typeof def.target !== "string" || !REWARD_TARGET_WHITELIST.has(def.target)) {
      issues.push({ rewardId, reason: `target 非法（仅支持 ${[...REWARD_TARGET_WHITELIST].join("/")}）` });
      continue;
    }
    if (def.type === "FIXED" && !(Number(def.fixedAmount) > 0)) {
      issues.push({ rewardId, reason: "FIXED 类型必须提供 fixedAmount > 0" });
      continue;
    }
    const meta = (def.metadata || {}) as Record<string, unknown>;
    const exit = String(meta.rewardExit || "bonus_spin");
    if (!REWARD_EXIT_WHITELIST.has(exit)) {
      issues.push({ rewardId, reason: `rewardExit 非法（仅支持 ${[...REWARD_EXIT_WHITELIST].join("/")}）` });
      continue;
    }
    if (!isValidConditions(def.conditions)) {
      issues.push({ rewardId, reason: "conditions 非法（必须为数组，字段/算子需在白名单内，逻辑节点需显式 type）" });
      continue;
    }
    seenRewardIds.add(def.rewardId);
  }
  return issues;
}

/**
 * 解析已发放的 rewardId 列表（JSON 数组，容错：非法回退空集）。
 * 与现有路径 [2] 的 parseGrantedMilestones 语义一致，但存储的是 rewardId 字符串而非 requireCount 数值。
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
 * @param currentGranted 当前已发放的 rewardId 列表（快照，用于计算新值）
 * @param newRewardId 本次新发放的 rewardId
 * @param oldValues 各 record 当前的 rewardMilestonesGranted 值（CAS 条件的基准）
 *   与 recordIds 一一对应，在 aggregateSharerData 阶段读取
 * @returns 全部 record 标记成功返回 true，任一失败返回 false
 */
async function markRewardIdsGranted(
  tx: DbType,
  recordIds: string[],
  currentGranted: string[],
  newRewardId: string,
  currentValues: string[],
): Promise<boolean> {
  const nextGranted = [...new Set([...currentGranted, newRewardId])].sort();
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

  const records = engine.Distribute.distributeByDefs({
    event,
    directParent: null,
    ancestors: [],
    rewardDefs,
  });
  if (records.length === 0) return;

  // 4. 幂等过滤 + 5. 执行奖励 + 6. 标记幂等
  // ── 三重防超发架构（docs/254 §3.1）──
  // 第一重（幂等层）：rewardMilestonesGranted 列表判断，同一 rewardId 只发放一次
  // 第二重（出口 CAS）：grantBonusSpin 的 spinsTotalGranted 乐观锁 /
  //                    grantBonusCoupon 的 couponCodes.status CAS
  // 第三重（总量约束）：maxSpins 总顶裁剪 / couponCodes 码池可用性
  // 三层独立保护，任何一层失效时仍有其他层兜底，不会超发。
  const maxSpins = Math.max(0, Math.floor(Number(draw.maxSpinsPerEntry || 0)));
  // 当前已发放的 rewardId 集合（从全部 share_record 的 rewardMilestonesGranted 聚合而来）
  const alreadyGranted = new Set(sharer.grantedRewardIds);

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
    // 幂等检查（第一重防护）：已发放的 rewardId 直接跳过，
    // 防止同一里程碑在同一分享者身上重复计算（如多次 join 触发同一奖励）。
    if (alreadyGranted.has(rewardId)) continue;

    // 从原始 rewardDef 读取 metadata：
    // 注意！incentive-engine 的 distributeByDefs 输出 record.snapshot 只包含计算字段
    // （rewardId/rewardType/target/rate/fixedAmount/sourceNodeId），不透传 rewardDef 的
    // metadata。因此必须用 rewardId → rewardDef 映射从原始配置读取 rewardExit/couponLabel。
    const def = defByRewardId.get(rewardId);
    const meta = ((def?.metadata || {}) as ReferralRewardMeta);
    const exit = meta.rewardExit || "bonus_spin";
    const amount = parseInt(String(record.amount || "0"), 10);

    // 非 lottery 类型 + bonus_spin 出口 → 跳过（见上方约束注释）
    if (exit === "bonus_spin" && !isLotteryKind) continue;

    // 按 rewardExit 分发到具体奖励出口。
    // 每个出口内部都有独立的 CAS 防护（第二重）：
    // - grantBonusSpin：spinsTotalGranted 乐观锁（行级）
    // - grantBonusCoupon：couponCodes.status='available' 原子更新
    // 奖励失败（如码池耗尽、spins 已达上限）返回 false，不抛异常。
    let success = false;
    switch (exit) {
      case "bonus_spin":
        success = await grantBonusSpin(
          tx, draw.tenantId, draw.id,
          sharer.sharerEntryId, amount, maxSpins, rewardId,
        );
        break;
      case "bonus_coupon":
        success = await grantBonusCoupon(
          tx, draw.tenantId, draw.id,
          sharer.sharerEntryId, meta.couponLabel, rewardId,
        );
        break;
      default:
        // 未知奖励出口（白名单校验已拦截，这里是防御性兜底）
        break;
    }

    // 标记幂等（仅奖励成功时标记，防止"标记了但没发"的错账）
    // 用 CAS 条件（rewardMilestonesGranted == 旧值）防止并发覆盖。
    // mark 失败时（CAS 冲突），grant 已由上游的 CAS 防护，不会重复发放，
    // 只是下次归因需要多一次 CAS 检查。见 docs/252 §2.1。
    if (success) {
      const markOk = await markRewardIdsGranted(
        tx, sharer.recordIds, [...alreadyGranted], rewardId, sharer.oldValues,
      );
      if (markOk) {
        alreadyGranted.add(rewardId);
      }
      // mark 失败时不加 alreadyGranted：下次归因 engine 会再次返回该 rewardId，
      // 但 grant 层的 CAS 会阻止重复发放（spinsTotalGranted / couponCodes.status）。
      // 这是"best effort"标记的权衡——宁可多一次 CAS 检查，不可多写一条误标记。
    }
  }
}