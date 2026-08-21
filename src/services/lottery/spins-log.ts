/**
 * spins 流水日志写入模块（docs/172 §5.5 P1）。
 *
 * 提供统一的 recordSpinLog 函数，在 spinsLeft 变动时写入 spins_log 表。
 * 所有写入点（签到/抽奖/裂变/join 初始）都应调用此模块，确保审计链完整。
 *
 * 约定：
 * - delta > 0 为收入（签到奖励/裂变邀请/join 初始），delta < 0 为支出（抽奖消耗）
 * - balanceAfter 为本次变动后的余额快照，由调用方在写入前计算
 * - reason 严格限定枚举值，不允许自定义 reason 字符串
 */
import type { DbType } from "../../db/client";
import { logError } from "../../lib/logger";
import { spinsLog } from "../../db/schema";

/** spins 变动原因枚举 */
export type SpinLogReason = "join" | "checkin" | "spin" | "viral" | "purchase" | "daily_free";

/** 写入 spins_log 的参数 */
export interface RecordSpinLogInput {
  tenantId: string;
  entryId: string;
  /** 用户标识（identityType + identityValue 的面向用户口径） */
  userId: string;
  /** 本次变动量（正=收入，负=支出） */
  delta: number;
  /** 变动后余额快照 */
  balanceAfter: number;
  /** 变动原因 */
  reason: SpinLogReason;
  /** 关联单据号（spin 关联 lottery_spins.id，裂变关联邀请事件等） */
  refId?: string;
}

/**
 * 写入一条 spins 流水日志。
 * 只追加不更新，不承担任何业务逻辑（不参与去重、不阻塞后续流程）。
 * 写入失败不抛出异常（仅 console.error），避免影响主流程。
 */
export async function recordSpinLog(
  db: DbType,
  input: RecordSpinLogInput,
): Promise<void> {
  try {
    await db.insert(spinsLog).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      entryId: input.entryId,
      userId: input.userId,
      delta: input.delta,
      balanceAfter: input.balanceAfter,
      reason: input.reason,
      refId: input.refId ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // 日志写入失败不应影响主流程（签到/抽奖等已成功），仅打印错误供排查。
    logError("spins-log", "写入失败", err);
  }
}