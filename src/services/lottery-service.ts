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
import { and, eq, sql } from "drizzle-orm";
import { sendEmail } from "./email-service";
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

// re-export：保持既有导出 API 不变（外部 import 本文件的符号继续可用）
export * from "./lottery/types";
export * from "./lottery/plan";
export * from "./lottery/utils";
export * from "./lottery/integration";
export * from "./lottery/draws";
export * from "./lottery/participation";
export * from "./lottery/draw-execution";
export * from "./lottery/penalty";
export * from "./lottery/reward";

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
 * 每个码独立 INSERT，不保证原子性。
 * 如果部分失败，已成功的码不会回滚。
 */
export async function importPrizeCodes(
  db: DbType,
  tenantId: string,
  prizeId: string,
  codes: Array<{ code: string; secret?: string }>,
) {
  // 校验奖品存在且属于当前租户
  const [prize] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!prize) throw new Error("奖品不存在");

  // 批量 INSERT（一次写入替代 N 次往返），重复码通过 UNIQUE 约束自动跳过
  let imported = 0;
  // 分批插入：每批最多 200 条，避免单次 INSERT 过大
  const BATCH_SIZE = 200;
  for (let offset = 0; offset < codes.length; offset += BATCH_SIZE) {
    const batch = codes.slice(offset, offset + BATCH_SIZE);
    const values = batch.map(item => ({
      id: crypto.randomUUID(),
      tenantId,
      prizeId,
      code: (item.code || "").trim(),
      secret: (item.secret || "").trim(),
      status: "available" as const,
      createdAt: new Date().toISOString(),
    }));
    try {
      await db.insert(prizeCodes).values(values);
      imported += batch.length;
    } catch (err: any) {
      // UNIQUE 约束冲突时，回退到逐条插入以精确定位跳过的码
      for (const item of batch) {
        try {
          await db.insert(prizeCodes).values({
            id: crypto.randomUUID(),
            tenantId,
            prizeId,
            code: (item.code || "").trim(),
            secret: (item.secret || "").trim(),
            status: "available",
            createdAt: new Date().toISOString(),
          });
          imported++;
        } catch { /* 跳过重复 */ }
      }
    }
  }

  // 更新奖品 total_count（闭环：P0-1 已修复）
  await db.update(prizes)
    .set({ totalCount: sql`total_count + ${imported}`, updatedAt: new Date().toISOString() })
    .where(eq(prizes.id, prizeId));
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
  options?: { limit?: number; emailEnv?: { resendApiKey: string; emailFrom: string } },
): Promise<{ processed: number; failed: number; errors: Array<{ drawId: string; message: string }> }> {
  // 单次最多处理 50 个，默认 20 个
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
  const emailEnv = options?.emailEnv;
  const now = new Date().toISOString();

  // 查询到期且未开奖的定时活动
  const due = await db
    .select()
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
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
    } catch (err) { console.error(`[heal] 状态自愈失败 draw=${draw.id}`, err); }
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
      for (const entry of entries) {
        if (!entry.identityValue.includes("@")) continue;
        try {
          await sendEmail(emailEnv, {
            to: entry.identityValue,
            template: "draw_reminder",
            templateData: { drawName: draw.title, shareUrl, reminderText },
          });
          emailsSent++;
        } catch { failed++; }
      }
    } catch { /* 单个活动失败不影响其他 */ }
  }

  return { drawsProcessed, emailsSent, failed };
}

