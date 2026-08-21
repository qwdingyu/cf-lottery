/**
 * 抽奖服务层 — 核心业务逻辑。
 *
 * 【设计原则】
 * - 只操作抽奖相关表，不涉及电商概念（订单/支付/余额/返佣）
 * - 所有函数接受 tenant_id 参数，确保多租户数据隔离
 * - 开奖流程：随机抽取候选池 → 原子锁定奖品码 → 写入中奖记录 → 异步通知
 * - 不产生订单、不涉及支付、不扣余额
 *
 * 【状态机】
 *   draft → open → drawing → drawn
 *   open → paused → open
 *   draft/open/paused → cancelled
 *   drawing 失败 → open（记录 failureReason，禁止永久卡死）
 *
 * 【并发安全】
 * - 参与去重：UNIQUE(tenant_id, draw_id, identity_type, identity_value)
 * - 开奖防双发：CAS 更新 status（open → drawing）
 * - 邀请码防超发：条件 UPDATE WHERE used_count < max_uses
 * - 锁码防重：条件 UPDATE WHERE status = 'available'
 */
import type { DbType } from "../db/client";
import { logError } from "../lib/logger";
import { and, eq, inArray, sql } from "drizzle-orm";
import { enqueueEmailDelivery, dispatchEmailDeliveries } from "./email-delivery";
import type { EmailEnv } from "./email-service";
import {
  lotteryDraws,          // 抽奖活动表
  lotteryEntries,        // 候选池表
  prizes,                // 奖品表
  prizeCodes,            // 奖品码池表
  systemConfig,          // 系统配置（含动态套餐额度）
} from "../db/schema";

// ── 拆分模块（docs/049 #17：除奖品/定时兜底外已全部迁至 services/lottery/） ──
// 内部使用：定时兜底（processDueDraws）复用开奖核心域
import { performDraw, healDrawingState } from "./lottery/draw-execution";
import { DRAW_STATUS } from "./lottery/types";
import { runBounded } from "./../lib/concurrency";

// re-export：保持既有导出 API 不变（外部 import 本文件的符号继续可用）
export * from "./lottery/types";
export * from "./lottery/plan";
export * from "./lottery/utils";
export * from "./lottery/integration";
export * from "./lottery/draws";
export * from "./lottery/participation";
export * from "./lottery/draw-execution";
export * from "./lottery/spin-execution";
export * from "./lottery/spin-quota";
export * from "./lottery/penalty";
export * from "./lottery/reward";
export * from "./lottery/leaderboard-rewards";

/* ── 奖品管理 ────────────────────────────────────────────── */

/**
 * 创建奖品。
 */
export async function createPrize(
  db: DbType,
  tenantId: string,
  data: { name: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string },
) {
  const name = String(data.name || "").trim();
  if (!name) throw new Error("奖品名称不能为空");

  const id = crypto.randomUUID();
  await db.insert(prizes).values({
    id,
    tenantId,
    name,
    description: String(data.description || "").trim(),
    imageUrl: String(data.imageUrl || "").trim(),   // 奖品图片 URL（可选）
    valueText: String(data.valueText || "").trim(), // 展示价值文案，不参与金额计算
    prizeType: data.prizeType || "code",            // 默认卡密类型
  });
  return { id };
}

/**
 * 导入奖品码（批量）。
 *
 * P0 修复（2026-08 审查）：
 * - 旧实现注释声称"重复码通过 UNIQUE 约束自动跳过"（:99,117-133），但 prize_codes 无 code 唯一约束，
 *   去重 catch 是死代码 → 重复卡密被静默入库，同一张卡可发给两人。
 * - 现在：① 迁移 0063 已建 UNIQUE(tenant_id, prize_id, code) 硬约束（硬兜底）；
 *   ② 本函数导入前显式查重，跳过已存在的码并返回 { imported, skipped }，运营可见跳过数。
 * - 批次内重复码也只插入一次。
 *
 * @returns 实际插入数与跳过（重复/空码）数
 */
export async function importPrizeCodes(
  db: DbType,
  tenantId: string,
  prizeId: string,
  codes: Array<{ code: string; secret?: string }>,
): Promise<{ imported: number; skipped: number }> {
  // 校验奖品存在且属于当前租户
  const [prize] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!prize) throw new Error("奖品不存在");

  // 1) 清洗 + 批次内去重（同 code 只取第一条）
  const trimmed = codes.map((item) => ({
    code: (item.code || "").trim(),
    secret: (item.secret || "").trim(),
  }));
  const uniqueInBatch = new Map<string, { code: string; secret: string }>();
  for (const item of trimmed) {
    if (!item.code) continue; // 空码跳过
    if (!uniqueInBatch.has(item.code)) uniqueInBatch.set(item.code, item);
  }
  const candidates = [...uniqueInBatch.values()];
  const batchSkipped = trimmed.length - candidates.length; // 批次内重复 + 空码

  // 2) 显式查重：同租户同奖品已存在的码跳过（防重复发放）
  let toInsert = candidates;
  let existingSkipped = 0;
  if (candidates.length > 0) {
    const existingRows = await db
      .select({ code: prizeCodes.code })
      .from(prizeCodes)
      .where(and(
        eq(prizeCodes.tenantId, tenantId),
        eq(prizeCodes.prizeId, prizeId),
        inArray(prizeCodes.code, candidates.map((c) => c.code)),
      ));
    const existingSet = new Set(existingRows.map((r) => r.code));
    toInsert = candidates.filter((c) => !existingSet.has(c.code));
    existingSkipped = candidates.length - toInsert.length;
  }

  // 3) 批量 INSERT（一次写入替代 N 次往返）；唯一约束冲突（并发导入等竞态）回退逐条跳过
  let imported = 0;
  const BATCH_SIZE = 200;
  for (let offset = 0; offset < toInsert.length; offset += BATCH_SIZE) {
    const batch = toInsert.slice(offset, offset + BATCH_SIZE);
    const values = batch.map((item) => ({
      id: crypto.randomUUID(),
      tenantId,
      prizeId,
      code: item.code,
      secret: item.secret,
      status: "available" as const,
      createdAt: new Date().toISOString(),
    }));
    try {
      await db.insert(prizeCodes).values(values);
      imported += batch.length;
    } catch (err: any) {
      // UNIQUE 约束冲突（并发下另一请求已插入同码）：回退逐条插入，冲突单条跳过
      for (const item of batch) {
        try {
          await db.insert(prizeCodes).values({
            id: crypto.randomUUID(),
            tenantId,
            prizeId,
            code: item.code,
            secret: item.secret,
            status: "available",
            createdAt: new Date().toISOString(),
          });
          imported++;
        } catch { /* 跳过重复 */ }
      }
    }
  }

  // 更新奖品 total_count（闭环：P0-1 已修复）
  if (imported > 0) {
    await db.update(prizes)
      .set({ totalCount: sql`total_count + ${imported}`, updatedAt: new Date().toISOString() })
      .where(eq(prizes.id, prizeId));
  }

  return { imported, skipped: batchSkipped + existingSkipped };
}

/* ── 定时开奖兜底 ─────────────────────────────────────────── */

/**
 * 处理到期活动（Cron 定时调用）。
 *
 * 每次最多处理 limit 个活动，避免单次 Worker 请求 CPU 超限。
 * 失败的活动不影响其他活动，每个活动独立 try/catch。
 *
 * 调用频率：建议每 5 分钟执行一次（Cloudflare Cron Triggers）。
 */
export async function processDueDraws(
  db: DbType,
  options?: { limit?: number; emailEnv?: EmailEnv },
): Promise<{ processed: number; failed: number; errors: Array<{ drawId: string; message: string }> }> {
  // 单次最多处理 50 个，默认 20 个
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
  const emailEnv = options?.emailEnv;
  const now = new Date().toISOString();

  // ── 到期关闭（docs/244）：非 lottery 活动（claim/flash_sale 等）到 endAt 后自动置为 drawn。
  // 原因：processDueDraws 只对 activityKind='lottery' 的 scheduled 活动 performDraw，
  // 而 claim 等类型无开奖流程（instant 走 spin），过 endAt 后若无人手动关闭会永远停留在
  // open（进行中），管理后台与公开页显示误导。joinDraw 已按 endAt 拦截参与（功能安全），
  // 此处仅修正状态显示。复用 drawn 状态，避免新增 closed 影响筛选/审计等消费点。
  const expiredNonLottery = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      sql`${lotteryDraws.activityKind} != 'lottery'`,
      sql`${lotteryDraws.endAt} <= ${now}`,
    ))
    .limit(limit);
  for (const draw of expiredNonLottery) {
    try {
      await db
        .update(lotteryDraws)
        .set({ status: DRAW_STATUS.DRAWN, updatedAt: now })
        .where(and(
          eq(lotteryDraws.id, draw.id),
          eq(lotteryDraws.tenantId, draw.tenantId),
          eq(lotteryDraws.status, "open"),
        ));
    } catch (err) {
      logError("lottery-service", `到期关闭失败 draw=${draw.id}`, err);
    }
  }

  // 查询到期且未开奖的定时活动
  const due = await db
    .select()
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.activityKind, "lottery"), // 纵深：仅抽奖可 performDraw；防误配 scheduled 的非 lottery
      eq(lotteryDraws.drawTrigger, "scheduled"),
      // docs/117 P0-2：instant 走 spin，Cron 不得再 performDraw
      sql`${lotteryDraws.resultMode} != 'instant'`,
      sql`${lotteryDraws.drawAt} <= ${now}`,  // 开奖时间已到
    ))
    .orderBy(lotteryDraws.drawAt)  // 按开奖时间排序，先到期的先处理
    .limit(limit);

  let processed = 0;
  let failed = 0;
  const errors: Array<{ drawId: string; message: string }> = [];

  // 先治愈卡在 drawing 状态的活动（借鉴 cf-shop 的 healStaleDrawings）
  const staleDrawings = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.status, "drawing"))
    .limit(10);
  for (const draw of staleDrawings) {
    try {
      await healDrawingState(db, draw.id, draw.tenantId);
    } catch (err) { logError("lottery-service", `状态自愈失败 draw=${draw.id}`, err); }
  }

  for (const draw of due) {
    try {
      // Cron 调用时 operatorUserId 为 "system"
      await performDraw(db, draw.tenantId, draw.id, "system", emailEnv);
      processed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "未知错误";
      errors.push({ drawId: draw.id, message });
    }
  }

  return { processed, failed, errors };
}

/**
 * 对开奖随机种子做 SHA-256 hash，用于事后公平性验证。
 *
 * 开奖前先记录 hash，开奖后可展示原始 seed 供参与者验证：
 * 1. 参与者拿到 seed，计算 SHA-256(seed)
 * 2. 比对开奖前记录的 hash 是否一致
 * 3. 一致则证明开奖结果未被篡改
 */
// hashDrawSeed（纯 SHA-256 工具）已随 #17 拆分迁至 services/lottery/utils.ts

// ═════════════════════════════════════════════════════════
// 营销邮件：开奖前 1 小时提醒
// ═════════════════════════════════════════════════════════

/**
 * 发送开奖前提醒邮件。
 *
 * 由 platform system_config 控制：
 * - marketing_draw_reminder_enabled：是否启用（默认 false，需平台运营者手动开启）
 * - marketing_draw_reminder_minutes：开奖前多少分钟发送（默认 60）
 *
 * 由 runScheduledMaintenance 触发（Cron 每 5 分钟执行一次，
 * 以配置值为中心 ±5 分钟窗口，确保每次 Cron 都能捕捉到目标活动）。
 */
export async function sendDrawReminders(
  db: DbType,
  emailEnv: { resendApiKey?: string; emailFrom?: string; emailFromName?: string },
): Promise<{ drawsProcessed: number; emailsSent: number; failed: number }> {
  if (!emailEnv.resendApiKey) return { drawsProcessed: 0, emailsSent: 0, failed: 0 };

  // 读取平台配置：是否启用 + 提前分钟数
  const configRows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(sql`${systemConfig.key} IN ('marketing_draw_reminder_enabled', 'marketing_draw_reminder_minutes')`);
  const cfg: Record<string, string> = {};
  for (const row of configRows) cfg[row.key] = row.value;

  const enabled = cfg["marketing_draw_reminder_enabled"] === "true";
  if (!enabled) return { drawsProcessed: 0, emailsSent: 0, failed: 0 };

  const minutes = Math.max(5, Math.min(1440, parseInt(cfg["marketing_draw_reminder_minutes"] || "60", 10) || 60));

  const now = new Date();
  const windowStart = new Date(now.getTime() + (minutes - 5) * 60000).toISOString();
  const windowEnd = new Date(now.getTime() + (minutes + 5) * 60000).toISOString();

  // 查找即将在 N 分钟后开奖的活动
  const dueDraws = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, title: lotteryDraws.title, publicSlug: lotteryDraws.publicSlug })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      sql`${lotteryDraws.drawAt} >= ${windowStart}`,
      sql`${lotteryDraws.drawAt} <= ${windowEnd}`,
    ))
    .limit(20);

  let drawsProcessed = 0;
  let emailsSent = 0;
  let failed = 0;

  for (const draw of dueDraws) {
    drawsProcessed++;
    try {
      const entries = await db
        .select({ identityValue: lotteryEntries.identityValue })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.tenantId, draw.tenantId), eq(lotteryEntries.drawId, draw.id)))
        .limit(500);

      const shareUrl = draw.publicSlug ? `${draw.publicSlug}` : "";
      const reminderText = minutes >= 120 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
      // 开奖提醒先写统一邮件队列，再由邮件发送器领取处理。
      // sourceId 使用 drawId:identityValue 幂等去重，避免 cron 窗口重叠时重复提醒。
      const queueResults = await runBounded(entries, 5, async (entry) => {
        if (!entry.identityValue.includes("@")) return "skip";
        const queued = await enqueueEmailDelivery(db, {
          tenantId: draw.tenantId,
          drawId: draw.id,
          sourceType: "draw_reminder",
          sourceId: `${draw.id}:${entry.identityValue}`,
          recipientEmail: entry.identityValue,
          template: "draw_reminder",
          templateData: { drawName: draw.title, shareUrl, reminderText },
        });
        return queued.enqueued ? queued.deliveryId : "skip";
      });
      const deliveryIds = queueResults
        .filter((r): r is { ok: true; value: string } => r.ok && r.value !== "skip")
        .map((r) => r.value);
      const sentResult = deliveryIds.length > 0
        ? await dispatchEmailDeliveries(db, emailEnv, { deliveryIds, limit: deliveryIds.length })
        : { sent: 0, failed: 0 };
      emailsSent += sentResult.sent;
      failed += sentResult.failed;
      for (const r of queueResults) {
        if (!r.ok) failed++;
      }
    } catch { /* 单个活动失败不影响其他 */ }
  }

  return { drawsProcessed, emailsSent, failed };
}
