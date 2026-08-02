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
import { withDbTransaction, type DbType } from "../db/client";
import { and, eq, count, inArray, sql } from "drizzle-orm";
import { buildLotteryWinnerTemplateData, sendEmail } from "./email-service";
import {
  lotteryDraws,          // 抽奖活动表
  lotteryEntries,        // 候选池表
  lotteryWinners,        // 中奖记录表
  users,                 // 注册用户表（registered 模式中奖者关联真实邮箱）
  prizes,                // 奖品表
  prizeCodes,            // 奖品码池表
  lotteryPrizeTiers,     // 多奖项配置表
  auditLogs,             // 审计日志表
  systemConfig,          // 系统配置（含动态套餐额度）
  shareRecords,          // 分享裂变归因
  couponCodes,           // 优惠券码池（用于未中奖自动发券）
} from "../db/schema";

// ── 拆分模块（docs/049 #17：类型/套餐/纯工具/集成/活动管理/参与已迁至 services/lottery/） ──
// 内部使用：原文件剩余业务逻辑引用的符号从子模块导入
import type { DrawResult } from "./lottery/types";
import { randomSelect } from "./lottery/utils";
// 集成/事件域：开奖域（enqueue/dispatch webhook）复用
import { enqueueWebhookEvent, dispatchWebhookDelivery } from "./lottery/integration";

// re-export：保持既有导出 API 不变（外部 import 本文件的符号继续可用）
export * from "./lottery/types";
export * from "./lottery/plan";
export * from "./lottery/utils";
export * from "./lottery/integration";
export * from "./lottery/draws";
export * from "./lottery/participation";

/* ── 开奖核心 ─────────────────────────────────────────────── */

/**
 * 执行手动开奖。
 *
 * 流程：
 * 1. CAS 原子夺取开奖权（open → drawing）
 * 2. 生成随机种子并记录 hash（事后可验证公平性）
 * 3. 读取候选池，随机抽取中奖者
 * 4. 事务内原子锁码 + 写入中奖记录
 * 5. 更新活动状态为 drawn
 * 6. 写审计日志
 *
 * 失败处理：
 * - 任何步骤失败 → 恢复状态为 open + 记录 failureReason
 * - 已开奖活动再次开奖 → 返回已有结果（幂等）
 */
export async function performDraw(
  db: DbType,
  tenantId: string,
  drawId: string,
  operatorUserId: string,  // 操作者用户 ID（用于审计日志）
  emailEnv?: { resendApiKey: string; emailFrom: string },  // 邮件通知配置（可选，未配置时跳过通知）
): Promise<DrawResult> {
  const now = new Date().toISOString();

  // 1. CAS 原子夺取开奖权：仅当 status = 'open' 时才更新为 'drawing'
  //    使用 returning() 获取更新后的记录，确认 CAS 成功
  const claimResult = await db
    .update(lotteryDraws)
    .set({ status: "drawing", updatedAt: now })
    .where(and(
      eq(lotteryDraws.id, drawId),
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, "open"),
    ));

  // rowsAffected = 0 表示 CAS 失败（活动已被其他进程开奖或状态不是 open）
  if ((claimResult.rowsAffected ?? 0) === 0) {
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);

    if (!draw) throw new Error("活动不存在");
    // 卡在 drawing 状态的活动：尝试治愈
    if (draw.status === "drawing") {
      const healed = await healDrawingState(db, drawId, tenantId);
      if (healed === "drawn") {
        return { drawId, winnerCount: 0, candidateCount: 0 };
      }
      if (healed === "open") {
        // 治愈成功，状态已回滚为 open，重新尝试夺取开奖权
        const retryResult = await db
          .update(lotteryDraws)
          .set({ status: "drawing", updatedAt: new Date().toISOString() })
          .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
        if ((retryResult.rowsAffected ?? 0) === 0) {
          throw new Error("开奖权已被其他进程夺取，请稍后重试");
        }
        // 继续执行开奖流程
      }
    }
    // 已开奖活动再次开奖 → 幂等返回实际数据
    if (draw.status === "drawn") {
      const actualWinnerCount = await db
        .select({ total: count() })
        .from(lotteryWinners)
        .where(eq(lotteryWinners.drawId, drawId));
      const actualCandidateCount = await db
        .select({ total: count() })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.drawId, drawId));
      return {
        drawId,
        winnerCount: Number(actualWinnerCount[0]?.total ?? 0),
        candidateCount: Number(actualCandidateCount[0]?.total ?? 0),
      };
    }
    throw new Error("开奖权已被其他进程夺取，请稍后重试");
  }

  try {
    // 2. 生成开奖随机种子并记录 SHA-256 hash（公平性可验证）
    //    开奖前先记录 hash，开奖后可展示原始 seed 供参与者验证
    const seed = crypto.randomUUID();
    const seedHash = await hashDrawSeed(seed);
    await db
      .update(lotteryDraws)
      .set({ drawSeedHash: seedHash, drawSeed: seed, algorithmVersion: "uniform_v1", updatedAt: now })
      .where(eq(lotteryDraws.id, drawId));

    // 3. 读取候选池（所有参与者）
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId));

    const candidateCount = entries.length;
    if (candidateCount === 0) {
      throw new Error("候选池为空，无参与者");
    }

    // 获取活动配置（读取最新状态）
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    // 获取多奖项配置（一等奖、二等奖等）
    const tiers = await db
      .select()
      .from(lotteryPrizeTiers)
      .where(eq(lotteryPrizeTiers.drawId, drawId))
      .orderBy(lotteryPrizeTiers.sortOrder);

    // 计算总中奖人数：有奖项配置时按奖项总和，否则按活动默认 winnerCount
    const totalWinners = tiers.length > 0
      ? tiers.reduce((sum, t) => sum + t.winnerCount, 0)
      : draw.winnerCount;

    // ── 裂变加权：活动开启了裂变时，按邀请人数加权候选数组 ──
    // 每个参与者出现 1 次（基础）+ min(invitedCount, maxExtraEntries) 次（裂变加权）。
    // 不加权时 candidates = entries（保持原有行为）。
    let pc: Record<string, unknown> | null = null;
    try { pc = JSON.parse(draw.promotionConfig || "{}"); } catch { /* 忽略非法 JSON */ }
    const viral = pc?.viral as { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | undefined;
    let weightedCandidates: typeof entries;
    const inviteMap = new Map<string, number>();  // entryId → 邀请人数

    if (viral?.enabled) {
      const maxExtra = viral.maxExtraEntries ?? 10;

      // 查询该活动所有分享者的邀请人数
      const shareRows = await db
        .select({ sharerEntryId: shareRecords.sharerEntryId, joinedCount: shareRecords.joinedCount })
        .from(shareRecords)
        .where(and(eq(shareRecords.tenantId, tenantId), eq(shareRecords.drawId, drawId)));

      // 按 sharerEntryId 聚合 SUM(joinedCount)
      for (const row of shareRows) {
        inviteMap.set(row.sharerEntryId, (inviteMap.get(row.sharerEntryId) || 0) + row.joinedCount);
      }

      // 构建加权候选数组
      weightedCandidates = [];
      for (const entry of entries) {
        const invited = Math.min(inviteMap.get(entry.id) || 0, maxExtra);
        for (let i = 0; i < 1 + invited; i++) {
          weightedCandidates.push(entry);
        }
      }
    } else {
      weightedCandidates = entries;
    }

    // Fisher-Yates 随机抽取中奖者（加权候选数组）
    const selected = await randomSelect(weightedCandidates, totalWinners);

    // 4. 事务内写入中奖记录 + 原子锁码
    //    使用事务保证：锁码和写入中奖记录要么全部成功，要么全部回滚
    let entryIndex = 0;  // 已处理的中奖者数量（在事务外声明，用于审计日志）
    const seenEntryIds = new Set<string>();  // 加权候选数组去重：同一人只中一次
    await withDbTransaction(db, async (tx) => {
      // 如果没有配置多奖项，创建默认奖项"中奖"
      const effectiveTiers = tiers.length > 0 ? tiers : [{
        id: crypto.randomUUID(),
        tenantId,
        drawId,
        prizeId: "",          // 空 = 不关联奖品码
        tierName: "中奖",
        winnerCount: draw.winnerCount,
        sortOrder: 100,
      }];

      for (const tier of effectiveTiers) {
        // 按奖项名额逐个分配中奖者
        for (let i = 0; i < tier.winnerCount && entryIndex < selected.length; i++) {
          const entry = selected[entryIndex]!;
          entryIndex++;

          // 加权候选数组去重：同一人可能因裂变加权被多次选中，只取第一次
          if (seenEntryIds.has(entry.id)) {
            i--;  // 当前名额未填满，继续尝试下一个候选
            continue;
          }
          seenEntryIds.add(entry.id);

          // 原子锁码：如果奖项配置了奖品，从奖品码池中取一条 available 的记录
          // 【关键】先 SELECT 获取一条可用码的 ID，再按 ID 执行 UPDATE
          // 不能直接 UPDATE ... WHERE status='available'（会更新所有可用码，导致数据损坏）
          let prizeCodeId = "";
          if (tier.prizeId) {
            // 步骤 1: SELECT 获取一条可用码（原子操作，配合事务保证并发安全）
            const [availableCode] = await tx
              .select({ id: prizeCodes.id, code: prizeCodes.code })
              .from(prizeCodes)
              .where(and(
                eq(prizeCodes.prizeId, tier.prizeId),
                eq(prizeCodes.status, "available"),
                eq(prizeCodes.tenantId, tenantId),
              ))
              .limit(1);

            if (availableCode) {
              // 步骤 2: 按 ID 原子锁定（仅更新该条码）
              const lockResult = await tx
                .update(prizeCodes)
                .set({ status: "issued", winnerId: entry.id, issuedAt: now })
                .where(and(
                  eq(prizeCodes.id, availableCode.id),
                  eq(prizeCodes.status, "available"),
                ));

            // rowsAffected = 0 表示码已用完（被其他中奖者锁定）
            if ((lockResult.rowsAffected ?? 0) > 0) {
              // 查询刚锁定的码的 ID
              const [lockedCode] = await tx
                .select({ id: prizeCodes.id })
                .from(prizeCodes)
                .where(and(
                  eq(prizeCodes.prizeId, tier.prizeId),
                  eq(prizeCodes.winnerId, entry.id),
                  eq(prizeCodes.tenantId, tenantId),
                ))
                .limit(1);
              prizeCodeId = lockedCode?.id || "";

              // 发放成功后更新奖品已用数（used_count），保证运营者可看到码池消耗
              await tx.update(prizes)
                .set({ usedCount: sql`used_count + 1`, updatedAt: now })
                .where(eq(prizes.id, tier.prizeId));
            }
            // 码不足时跳过（prizeCodeId 保持空字符串），中奖者仍记录但无码
            }
          }

          // 写入中奖记录
          const winnerId = crypto.randomUUID();
          await tx.insert(lotteryWinners).values({
            id: winnerId,
            tenantId,
            drawId,
            tierId: tier.id,
            entryId: entry.id,
            identityType: entry.identityType,
            identityValue: entry.identityValue,
            prizeCodeId: prizeCodeId || "",
            drawnAt: now,
            notificationStatus: "pending",  // 待发送通知
          });
        }
      }

      // ── 状态与中奖记录同事务（#3.4 修复） ──
      // 修复前：winners 写入（本事务）与 status=drawn 更新（事务外）分离；
      // 事务提交后、状态更新前发生 DB 失败时，catch 会把状态回滚为 open，
      // 残留 winners 导致二次开奖 UNIQUE 冲突 → 活动永久自锁。
      // 修复后：drawn 状态与 winners 在同一事务提交，要么全部成功要么全部回滚。
      await tx
        .update(lotteryDraws)
        .set({ status: "drawn", drawnAt: now, updatedAt: now, failureReason: "" })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    });

    // 6. 写审计日志（记录谁在什么时候开奖、结果如何）
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId: operatorUserId,
      action: "draw.perform",
      targetType: "lottery_draw",
      targetId: drawId,
      metadataJson: JSON.stringify({
        winnerCount: entryIndex,
        candidateCount,
        seedHash,
        algorithmVersion: "uniform_v1",
      }),
      createdAt: now,
    });

    // 异步发送中奖通知邮件（不阻塞主流程，失败不影响开奖结果）
    // 由 platform system_config.notify_winner_email_enabled 控制（默认开启）
    if (emailEnv?.resendApiKey) {
      const [notifyCfg] = await db
        .select({ value: systemConfig.value })
        .from(systemConfig)
        .where(eq(systemConfig.key, "notify_winner_email_enabled"))
        .limit(1);
      if (notifyCfg?.value !== "false") {
        void sendWinnerNotifications(db, tenantId, drawId, emailEnv).catch((err) => {
          console.error(`[lottery] sendWinnerNotifications failed for ${drawId}:`, err);
        });
      }
    }

    const webhookEvent = await enqueueWebhookEvent(db, {
      tenantId,
      eventType: "draw.completed",
      data: { drawId, winnerCount: entryIndex, candidateCount },
    });
    for (const deliveryId of webhookEvent.deliveryIds) {
      void dispatchWebhookDelivery(db, tenantId, deliveryId).catch((err) => {
        console.error(`[lottery] dispatchWebhookDelivery failed for ${deliveryId}:`, err);
      });
    }

    // 活动后承接：未中奖自动发券（需在活动配置中启用 loserReward.enabled）
    // 在开奖状态更新之后执行，保证"是否中奖"已尘埃落定；不阻塞主流程，失败不影响开奖结果。
    try {
      const loserRewardResult = await grantLoserRewards(db, tenantId, drawId);
      if (loserRewardResult.granted > 0) {
        console.log(`[lottery] loser rewards granted: ${loserRewardResult.granted} for draw ${drawId}`);
        // 发券成功后发送安慰邮件（异步，不阻塞开奖主流程）
        if (emailEnv?.resendApiKey) {
          void sendLoserConsolationEmails(db, emailEnv, tenantId, drawId, draw.title).catch((err) => {
            console.error(`[lottery] sendLoserConsolationEmails failed for ${drawId}:`, err);
          });
        }
      }
    } catch (err) {
      console.error(`[lottery] grantLoserRewards failed for ${drawId}:`, err);
    }

    return { drawId, winnerCount: entryIndex, candidateCount };
  } catch (error) {
    // 开奖失败：恢复为 open 状态并记录失败原因
    // 不清除 drawSeedHash，保留审计线索
    const reason = error instanceof Error ? error.message.slice(0, 500) : "开奖失败（未知错误）";
    // #3.4 修复：winners 与 drawn 状态同事务提交后，若后续步骤（审计/异步通知）失败，
    // 活动已是 drawn，不得再回滚 open——否则会制造"winners 已存在 + 状态 open"的残留，
    // 使二次开奖必然 UNIQUE 冲突、活动永久自锁。
    const [curDraw] = await db
      .select({ status: lotteryDraws.status })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);
    if (curDraw?.status !== "drawn") {
      await db
        .update(lotteryDraws)
        .set({ status: "open", failureReason: reason, updatedAt: new Date().toISOString() })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    }
    throw error;
  }
}

/**
 * 异步发送中奖通知邮件。
 * 在开奖完成后调用，不阻塞主流程。
 * 每个中奖者独立发送，失败不影响其他人。
 */
export async function sendWinnerNotifications(
  db: DbType,
  tenantId: string,
  drawId: string,
  emailEnv: { resendApiKey?: string; emailFrom?: string },
) {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return;

  const winners = await db
    .select({
      winnerId: lotteryWinners.id,
      email: lotteryWinners.identityValue,
      identityType: lotteryWinners.identityType,
      prizeCodeId: lotteryWinners.prizeCodeId,
      notificationStatus: lotteryWinners.notificationStatus,
    })
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));

  // registered 模式（identity_type = user_id）中奖者：identity_value 是 userId（UUID），
  // 不是可投递邮箱，必须从 users 表关联注册时填写的真实邮箱（users.email 注册时必填）。
  const userIds = [...new Set(winners.filter(w => w.identityType === "user_id" && w.email).map(w => w.email))];
  const userEmailMap = new Map<string, string>();
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) userEmailMap.set(u.id, u.email);
  }

  // 批量查询所有中奖者的卡密信息（一次查询替代 N 次）
  const prizeCodeIds = [...new Set(winners.filter(w => w.prizeCodeId).map(w => w.prizeCodeId!))];
  const codeMap = new Map<string, { code: string; secret: string }>();
  if (prizeCodeIds.length > 0) {
    const codes = await db
      .select({ id: prizeCodes.id, code: prizeCodes.code, secret: prizeCodes.secret })
      .from(prizeCodes)
      .where(inArray(prizeCodes.id, prizeCodeIds));
    for (const c of codes) codeMap.set(c.id, { code: c.code, secret: c.secret });
  }

  for (const winner of winners) {
    if (winner.notificationStatus === "sent") continue;

    let accountLabel = "";
    let deliverySecret = "";

    if (winner.prizeCodeId) {
      const code = codeMap.get(winner.prizeCodeId);
      if (code) { accountLabel = code.code; deliverySecret = code.secret; }
    }

    // 收件人解析：user_id 身份的 winner 用 users 表关联的真实邮箱（见上方 userEmailMap）
    const toEmail = winner.identityType === "user_id" ? (userEmailMap.get(winner.email) || "") : winner.email;

    try {
      const result = await sendEmail(emailEnv, {
        to: toEmail,
        template: "lottery_winner",
        templateData: buildLotteryWinnerTemplateData({
          drawName: draw.title,
          productName: draw.title,
          accountLabel,
          deliverySecret,
        }),
      });

      await db
        .update(lotteryWinners)
        .set({
          notificationStatus: result.ok ? "sent" : "failed",
          notificationError: result.ok ? "" : (result.message || "").slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.winnerId));
    } catch (err) {
      await db
        .update(lotteryWinners)
        .set({
          notificationStatus: "failed",
          notificationError: (err as Error).message.slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.winnerId));
    }
  }
}

/**
 * 活动后承接：未中奖自动发券（安慰奖）。
 *
 * 由 performDraw 开奖完成后调用，对参与但未中奖的用户从优惠券码池发放优惠券，
 * 把"没中奖的流失用户"转化为"可再营销的潜在客户"。
 *
 * 开关控制：活动配置 activityConfig.loserReward.enabled 必须为 true 才启用。
 * 发券池：活动配置 activityConfig.loserReward.couponLabel 指定从哪个 label 的
 *         coupon_codes 池中取码；未指定时用任意 available 码。
 *
 * 安全与一致性：
 * - 不阻塞开奖主流程（由调用方 try/catch 包裹）
 * - 单码原子发放（CAS：WHERE status='available'），并发安全
 * - 优惠券不足时发放部分，不失败回滚
 */
export async function grantLoserRewards(
  db: DbType,
  tenantId: string,
  drawId: string,
): Promise<{ granted: number; totalLosers: number }> {
  // 读取活动配置，确认是否启用未中奖发券
  const [draw] = await db
    .select({ activityConfig: lotteryDraws.activityConfig, title: lotteryDraws.title })
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return { granted: 0, totalLosers: 0 };

  let config: { loserReward?: { enabled?: boolean; couponLabel?: string } } = {};
  try { config = JSON.parse(draw.activityConfig || "{}"); } catch { config = {}; }
  const loserReward = config.loserReward;
  // 默认关闭：未显式启用时不做任何发券，避免误发
  if (!loserReward?.enabled) return { granted: 0, totalLosers: 0 };

  // 查询全部参与记录
  const entries = await db
    .select({ id: lotteryEntries.id, identityValue: lotteryEntries.identityValue })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.tenantId, tenantId), eq(lotteryEntries.drawId, drawId)));

  // 查询已中奖者（排除中奖者，只给未中奖的发放）
  const winners = await db
    .select({ entryId: lotteryWinners.entryId })
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.tenantId, tenantId), eq(lotteryWinners.drawId, drawId)));
  const winnerEntryIds = new Set(winners.map((w) => w.entryId));

  const losers = entries.filter((e) => !winnerEntryIds.has(e.id));
  if (losers.length === 0) return { granted: 0, totalLosers: 0 };

  // 从优惠券码池取 available 码（按 label 过滤，未指定时取任意）
  const couponConditions = [
    eq(couponCodes.tenantId, tenantId),
    eq(couponCodes.status, "available"),
  ];
  if (loserReward.couponLabel) {
    couponConditions.push(eq(couponCodes.label, loserReward.couponLabel));
  }
  const availableCoupons = await db
    .select({ id: couponCodes.id, code: couponCodes.code })
    .from(couponCodes)
    .where(and(...couponConditions))
    .orderBy(couponCodes.createdAt)
    .limit(losers.length);

  let granted = 0;
  for (let i = 0; i < losers.length && i < availableCoupons.length; i++) {
    const loser = losers[i]!;
    const coupon = availableCoupons[i]!;
    // CAS 原子发放：仅当仍为 available 时更新为 issued，并记录领取人
    const result = await db.update(couponCodes)
      .set({
        status: "issued",
        recipientEmail: loser.identityValue,
        drawId,
        redeemedAt: new Date().toISOString(),
      })
      .where(and(
        eq(couponCodes.id, coupon.id),
        eq(couponCodes.status, "available"),
      ));
    if ((result.rowsAffected ?? 0) > 0) granted++;
  }

  return { granted, totalLosers: losers.length };
}

/**
 * 治愈卡死的 drawing 状态。
 *
 * 背景：如果一个开奖因 Worker 崩溃/超时卡在 drawing 状态，
 * 后续无法再次开奖。此函数检查 drawing 状态的活动：
 * - 如果已有中奖记录 → 补设为 drawn（开奖实际已完成）
 * - 如果无中奖记录且超时 → 回滚为 open（允许重新开奖）
 *
 * 借鉴 cf-shop 的 healDrawingState 模式。
 */
export async function healDrawingState(
  db: DbType,
  drawId: string,
  tenantId: string,
  options?: { staleMs?: number },
): Promise<"drawn" | "open" | null> {
  const staleMs = options?.staleMs ?? 300000; // 默认 5 分钟超时

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw || draw.status !== "drawing") return null;

  // 检查是否已有中奖记录
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));

  const nowIso = new Date().toISOString();

  if (Number(total) > 0) {
    // 中奖已落库但状态未 drawn：补状态
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: draw.drawnAt || nowIso, updatedAt: nowIso, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    return "drawn";
  }

  // 无中奖记录：检查是否超时
  const updatedAt = new Date(draw.updatedAt || draw.createdAt).getTime();
  if (Date.now() - updatedAt > staleMs) {
    // 超时且无中奖：回滚为 open
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: "开奖超时，已自动回滚", updatedAt: nowIso })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    return "open";
  }

  return null;
}

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
async function hashDrawSeed(seed: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

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

// ═════════════════════════════════════════════════════════
// 营销邮件：未中奖安慰邮件
// ═════════════════════════════════════════════════════════

/**
 * 对刚被 grantLoserRewards 发放优惠券的未中奖用户发送安慰邮件。
 *
 * 由 platform system_config 控制：
 * - marketing_loser_consolation_enabled：是否启用（默认 false，需平台运营者手动开启）
 *
 * 仅在 grantLoserRewards 成功发放优惠券后调用，告知用户未中奖但有专属优惠，
 * 引导用户回到平台使用优惠券，实现"流失用户再激活"。
 */
export async function sendLoserConsolationEmails(
  db: DbType,
  emailEnv: { resendApiKey?: string; emailFrom?: string; emailFromName?: string },
  tenantId: string,
  drawId: string,
  drawTitle: string,
): Promise<{ sent: number; failed: number }> {
  if (!emailEnv.resendApiKey) return { sent: 0, failed: 0 };

  // 读取平台配置：是否启用安慰邮件
  const [cfgRow] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, "marketing_loser_consolation_enabled"))
    .limit(1);
  if (cfgRow?.value !== "true") return { sent: 0, failed: 0 };

  // 查询本次开奖发放的优惠券（status='issued' 且 drawId 匹配）
  const issuedCoupons = await db
    .select({ code: couponCodes.code, label: couponCodes.label, recipientEmail: couponCodes.recipientEmail })
    .from(couponCodes)
    .where(and(
      eq(couponCodes.tenantId, tenantId),
      eq(couponCodes.drawId, drawId),
      eq(couponCodes.status, "issued"),
    ))
    .limit(500);

  let sent = 0;
  let failed = 0;
  const origin = "";  // APP_ORIGIN 由调用方传入，这里用相对路径

  for (const coupon of issuedCoupons) {
    if (!coupon.recipientEmail || !coupon.recipientEmail.includes("@")) continue;
    try {
      await sendEmail(emailEnv, {
        to: coupon.recipientEmail,
        template: "loser_consolation",
        templateData: {
          drawName: drawTitle,
          couponCode: coupon.code,
          couponLabel: coupon.label || "",
          nextActivityUrl: origin || "",
        },
      });
      sent++;
    } catch { failed++; }
  }

  return { sent, failed };
}




