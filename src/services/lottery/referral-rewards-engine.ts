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
 */
export function normalizeReferralRewardDefs(raw: unknown): RewardDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const def = item as Record<string, unknown>;
    // 必须包含 rewardId、type、target
    if (!def.rewardId || typeof def.rewardId !== "string") return false;
    if (!def.type || typeof def.type !== "string") return false;
    if (!def.target || typeof def.target !== "string") return false;
    // 检查 rewardExit（在 metadata 中）
    const meta = (def.metadata || {}) as Record<string, unknown>;
    const exit = String(meta.rewardExit || "bonus_spin");
    // 是否在白名单中
    if (!["bonus_spin", "bonus_coupon"].includes(exit)) return false;
    return true;
  }) as RewardDef[];
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
  };
}

/**
 * 标记已发放的 rewardId 到分享者的全部 share_record（幂等防护）。
 * 与现有路径 [2] 的标记方式一致：写入全部记录，保证"按分享者聚合 + 按分享者幂等"
 * 在任意后续记录上成立。
 */
async function markRewardIdsGranted(
  tx: DbType,
  tenantId: string,
  drawId: string,
  recordIds: string[],
  currentGranted: string[],
  newRewardId: string,
): Promise<boolean> {
  const nextGranted = [...new Set([...currentGranted, newRewardId])].sort();
  const nextGrantedJson = JSON.stringify(nextGranted);

  let allSucceeded = true;
  for (const recordId of recordIds) {
    const result = await tx
      .update(shareRecords)
      .set({ rewardMilestonesGranted: nextGrantedJson })
      .where(eq(shareRecords.id, recordId));
    if ((result.rowsAffected ?? 0) === 0) {
      allSucceeded = false;
    }
  }
  return allSucceeded;
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
  const maxSpins = Math.max(0, Math.floor(Number(draw.maxSpinsPerEntry || 0)));
  const alreadyGranted = new Set(sharer.grantedRewardIds);

  // 建立 rewardId → rewardDef 的映射，用于读取 metadata（engine 的 snapshot 不透传 metadata）
  const defByRewardId = new Map<string, RewardDef>();
  for (const def of rewardDefs) {
    const rid = String(def.rewardId || "");
    if (rid) defByRewardId.set(rid, def);
  }

  for (const record of records) {
    const rewardId = String(record.rewardId || "");
    if (!rewardId) continue;
    // 幂等检查：已发放则跳过
    if (alreadyGranted.has(rewardId)) continue;

    // 从原始 rewardDef 读取 metadata（engine 的 snapshot 不透传 metadata）
    const def = defByRewardId.get(rewardId);
    const meta = ((def?.metadata || {}) as ReferralRewardMeta);
    const exit = meta.rewardExit || "bonus_spin";
    const amount = parseInt(String(record.amount || "0"), 10);

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
        // 未知奖励出口，跳过
        break;
    }

    // 标记幂等（仅奖励成功时标记，防止"标记了但没发"的错账）
    if (success) {
      await markRewardIdsGranted(
        tx, draw.tenantId, draw.id,
        sharer.recordIds, [...alreadyGranted], rewardId,
      );
      alreadyGranted.add(rewardId);
    }
  }
}