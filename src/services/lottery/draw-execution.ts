/**
 * 抽奖服务层 — 开奖核心域（lottery-service 拆分，docs/049 #17）
 *
 * performDraw（CAS 防双发 + 裂变加权 + 事务原子落库：winners/锁码/状态同事务，#3.4）、
 * 中奖通知（registered 身份邮箱关联）、未中奖自动发券、开奖状态治愈。
 * 依赖 utils（随机/seed hash）与 integration（webhook），无反向依赖。
 */
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { and, eq, count, inArray, sql } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  lotteryPrizeTiers,
  prizes,
  prizeCodes,
  shareRecords,
  users,
  auditLogs,
  couponCodes,
  systemConfig,
} from "../../db/schema";
import { randomSelect, hashDrawSeed } from "./utils";
import { enqueueWebhookEvent, dispatchWebhookDelivery } from "./integration";
import { enqueuePlatformEvent } from "../platform/delivery";
import { buildLotteryWinnerTemplateData, type EmailEnv } from "../email-service";
import { enqueueEmailDelivery, dispatchEmailDeliveries } from "../email-delivery";
import { parseFlashSaleConfig } from "../../lib/flash-sale-config";
import { runBounded } from "../../lib/concurrency";
import { PAYMENT_ENTRY_STATUS } from "../payment/payment-status";
import {
  aggregateViralInviteCounts,
  computeViralDrawWeight,
  normalizeViralWeightNumbers,
  weightedSampleUnique,
} from "./viral-weight";
import { DRAW_STATUS, type DrawResult } from "./types";

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
  emailEnv?: EmailEnv,  // 邮件通知配置（可选，未配置时跳过通知）
): Promise<DrawResult> {
  const now = new Date().toISOString();

  // docs/116/117：instant 有独立 spin 结果机，禁止 performDraw 再抽一遍（双结果机）
  {
    const [modeRow] = await db
      .select({ resultMode: lotteryDraws.resultMode, activityKind: lotteryDraws.activityKind })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);
    if (!modeRow) throw new Error("活动不存在");
    if (String(modeRow.resultMode || "") === "instant") {
      throw new Error("即时开奖活动请使用 spin，不能统一开奖");
    }
  }

  // 1. CAS 原子夺取开奖权：仅当 status = 'open' 时才更新为 'drawing'
  //    使用 returning() 获取更新后的记录，确认 CAS 成功
  const claimResult = await db
    .update(lotteryDraws)
    .set({ status: DRAW_STATUS.DRAWING, updatedAt: now })
    .where(and(
      eq(lotteryDraws.id, drawId),
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, DRAW_STATUS.OPEN),
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
    if (draw.status === DRAW_STATUS.DRAWING) {
      const healed = await healDrawingState(db, drawId, tenantId);
      if (healed === DRAW_STATUS.DRAWN) {
        return { drawId, winnerCount: 0, candidateCount: 0 };
      }
      if (healed === DRAW_STATUS.OPEN) {
        // 治愈成功，状态已回滚为 open，重新尝试夺取开奖权
        const retryResult = await db
          .update(lotteryDraws)
          .set({ status: DRAW_STATUS.DRAWING, updatedAt: new Date().toISOString() })
          .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, DRAW_STATUS.OPEN)));
        if ((retryResult.rowsAffected ?? 0) === 0) {
          throw new Error("开奖权已被其他进程夺取，请稍后重试");
        }
        // 继续执行开奖流程
      }
    }
    // 已开奖活动再次开奖 → 幂等返回实际数据
    if (draw.status === DRAW_STATUS.DRAWN) {
      const actualWinnerCount = await db
        .select({ total: count() })
        .from(lotteryWinners)
        .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));
      const actualCandidateCount = await db
        .select({ total: count() })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.tenantId, tenantId)));
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
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

    // 获取活动配置（读取最新状态）
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    // 3. 读取候选池（所有参与者）。
    //    docs/166 纵深防御：直付秒杀（paymentRequired）下，未付款 entry（RESERVED/PENDING）
    //    不得进入候选池——否则未付款用户可能被抽中（白嫖卡密）。发布预检已阻断该组合，
    //    此处对存量/历史数据二次兜底，只允许 PAID entry 参与抽奖。
    const flashSale = parseFlashSaleConfig(draw.promotionConfig).config;
    const paymentRequired = flashSale?.paymentRequired === true;
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.drawId, drawId),
        eq(lotteryEntries.tenantId, tenantId),
        ...(paymentRequired
          ? [eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.PAID)]
          : []),
      ));

    const candidateCount = entries.length;
    if (candidateCount === 0) {
      throw new Error("候选池为空，无参与者");
    }

    // 获取多奖项配置（一等奖、二等奖等）
    const tiers = await db
      .select()
      .from(lotteryPrizeTiers)
      .where(and(eq(lotteryPrizeTiers.drawId, drawId), eq(lotteryPrizeTiers.tenantId, tenantId)))
      .orderBy(lotteryPrizeTiers.sortOrder);

    // 计算总中奖人数：有奖项配置时按奖项总和，否则按活动默认 winnerCount
    const totalWinners = tiers.length > 0
      ? tiers.reduce((sum, t) => sum + t.winnerCount, 0)
      : draw.winnerCount;

    // ── 裂变加权 / 等权抽取 ──
    // 裂变开启：权重 = 1 + min(invited × perInvite, maxExtra)（viral-weight.ts），
    // 用「按权无放回」抽唯一中奖者——禁止「扩袋只抽 n 槽再去重」导致名额不足（docs/109）。
    // 不写入额外 entries：不占 maxParticipants。
    // 未开启裂变：等权 Fisher-Yates（randomSelect）。
    let pc: Record<string, unknown> | null = null;
    try { pc = JSON.parse(draw.promotionConfig || "{}"); } catch { /* 忽略非法 JSON */ }
    const viral = pc?.viral as { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | undefined;
    const inviteMap = new Map<string, number>();  // entryId → 有效邀请人数（joinedCount 聚合）

    let selected: typeof entries;
    if (viral?.enabled) {
      const { extraEntriesPerInvite, maxExtraEntries } = normalizeViralWeightNumbers(viral);

      const shareRows = await db
        .select({ sharerEntryId: shareRecords.sharerEntryId, joinedCount: shareRecords.joinedCount })
        .from(shareRecords)
        .where(and(eq(shareRecords.tenantId, tenantId), eq(shareRecords.drawId, drawId)));

      // 与公开排行榜同一聚合函数，避免「榜上人数 ≠ 开奖权重」静默分叉
      const aggregated = aggregateViralInviteCounts(shareRows);
      for (const [id, count] of aggregated) {
        inviteMap.set(id, count);
      }

      const weightedPool = entries.map((entry) => ({
        item: entry,
        weight: computeViralDrawWeight(
          inviteMap.get(entry.id) || 0,
          extraEntriesPerInvite,
          maxExtraEntries,
        ),
      }));

      // CSPRNG → [0,1)：与 randomSelect 同源 crypto.getRandomValues
      const random01 = () => {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return (buf[0]! >>> 0) / 0x100000000;
      };
      selected = weightedSampleUnique(weightedPool, totalWinners, random01);
    } else {
      selected = await randomSelect(entries, totalWinners);
    }

    // 4. 事务内写入中奖记录 + 原子锁码
    //    使用事务保证：锁码和写入中奖记录要么全部成功，要么全部回滚
    //
    // F2 修复：entryIndex / seenEntryIds 必须声明在事务回调【内部】。
    // 原因：cf-core 的 withDbTransaction 在 SQLite BUSY 时会【整体重跑】事务回调，
    // 但外部闭包变量不会随重跑回滚。若声明在回调外，重试时 entryIndex 会从上次
    // 失败位置继续、seenEntryIds 保留旧集合 → selected[0..k-1] 永远不会被处理，
    // 造成【静默漏发中奖者】且审计计数与实际不一致。声明在回调内，每次重跑都从零开始，
    // 保证所有候选池 entry 都被公平处理一遍，且最终 entryIndex 通过返回值取回。
    const { entryIndex } = await withDbTransaction(db, async (tx) => {
      let entryIndex = 0;  // 已处理的中奖者数量（回调内局部，BUSY 重试时归零重来）
      // selected 在裂变路径已是唯一 entry；等权路径 randomSelect 也不重复。
      // 仍保留 seen 作纵深防御（异常数据/历史调用约定）。
      const seenEntryIds = new Set<string>();
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

          // 纵深：同一 entry 只落一次奖（加权路径本已唯一）
          if (seenEntryIds.has(entry.id)) {
            i--;
            continue;
          }
          seenEntryIds.add(entry.id);

          // 原子锁码：子查询 UPDATE + returning 消除 TOCTOU 窗口（与 spin-execution.ts 一致）
          // 单语句内完成"选码→锁码"，无需 SELECT 后 UPDATE 的两步往返
          // 子查询 LIMIT 1 保证只锁一条码，不会将所有可用码标记为 issued
          let prizeCodeId = "";
          if (tier.prizeId) {
            const [lockedCode] = await tx
              .update(prizeCodes)
              .set({ status: "issued", winnerId: entry.id, issuedAt: now })
              .where(and(
                eq(prizeCodes.tenantId, tenantId),
                eq(prizeCodes.status, "available"),
                eq(prizeCodes.id, sql<string>`(
                  SELECT id FROM prize_codes
                  WHERE tenant_id = ${tenantId}
                  AND prize_id = ${tier.prizeId}
                  AND status = 'available'
                  ORDER BY id
                  LIMIT 1
                )`),
              ))
              .returning({ id: prizeCodes.id });

            if (lockedCode) {
              prizeCodeId = lockedCode.id;

              // 发放成功后更新奖品已用数（used_count），保证运营者可看到码池消耗
              await tx.update(prizes)
                .set({ usedCount: sql`used_count + 1`, updatedAt: now })
                .where(and(eq(prizes.id, tier.prizeId), eq(prizes.tenantId, tenantId)));
            }
            // 码不足时跳过（prizeCodeId 保持空字符串），中奖者仍记录但无码
          }

          // 写入中奖记录
          // spin_id：delayed 无 spin 行，用 winner 自身 id 占位，满足 UNIQUE(tenant,draw,spin_id)
          // 且保持「一 entry 一奖」（应用层 seenEntryIds + 池抽样唯一）
          const winnerId = crypto.randomUUID();
          await tx.insert(lotteryWinners).values({
            id: winnerId,
            tenantId,
            drawId,
            tierId: tier.id,
            entryId: entry.id,
            spinId: winnerId,
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
        .set({ status: DRAW_STATUS.DRAWN, drawnAt: now, updatedAt: now, failureReason: "" })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

      // 返回本次实际发放的中奖者数，供事务外审计/webhook/返回值使用（F2）
      return { entryIndex };
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

    // 开奖后只负责把中奖通知写入持久化邮件队列；实际投递由 maintenance 统一处理。
    // 项目尚未发布，不保留 fire-and-forget 发送路径，避免进程崩溃造成漏发且无队列审计。
    // 由 platform system_config.notify_winner_email_enabled 控制（默认开启）
    if (emailEnv && (emailEnv.resendApiKey || emailEnv.email || (emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret))) {
      const [notifyCfg] = await db
        .select({ value: systemConfig.value })
        .from(systemConfig)
        .where(eq(systemConfig.key, "notify_winner_email_enabled"))
        .limit(1);
      if (notifyCfg?.value !== "false") {
        void enqueueWinnerNotificationDeliveries(db, tenantId, drawId).catch((err) => {
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

    // 出站平台消息（QQ 群）：活动开奖完成通知。失败不影响开奖结果（与 webhook 相同语义）。
    void enqueuePlatformEvent(db, {
      tenantId,
      drawId,
      eventType: "draw.completed",
      data: {
        drawName: draw.title,
        winnerSummary: `共 ${entryIndex} 人获奖，${candidateCount} 人参与`,
      },
    }).catch((err) => {
      console.error(`[lottery] enqueuePlatformEvent draw.completed failed for ${drawId}:`, err);
    });

    // 出站平台消息（QQ/Telegram 群）：逐个中奖结果通知。
    // 这里只写投递队列；如果社群通知失败，不能反向影响已经提交的开奖结果。
    await enqueueOutcomeAssignedPlatformEvents(db, tenantId, drawId, draw.title).catch((err) => {
      console.error(`[lottery] enqueuePlatformEvent outcome.assigned failed for ${drawId}:`, err);
    });

    // 活动后承接：未中奖自动发券（需在活动配置中启用 loserReward.enabled）
    // 在开奖状态更新之后执行，保证"是否中奖"已尘埃落定；不阻塞主流程，失败不影响开奖结果。
    try {
      const loserRewardResult = await grantLoserRewards(db, tenantId, drawId);
      if (loserRewardResult.granted > 0) {
        console.log(`[lottery] loser rewards granted: ${loserRewardResult.granted} for draw ${drawId}`);
        // 发券成功后发送安慰邮件（异步，不阻塞开奖主流程）
        if (emailEnv && (emailEnv.resendApiKey || emailEnv.email || (emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret))) {
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
    if (curDraw?.status !== DRAW_STATUS.DRAWN) {
      await db
        .update(lotteryDraws)
        .set({ status: DRAW_STATUS.OPEN, failureReason: reason, updatedAt: new Date().toISOString() })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    }
    throw error;
  }
}

async function enqueueOutcomeAssignedPlatformEvents(
  db: DbType,
  tenantId: string,
  drawId: string,
  drawName: string,
): Promise<void> {
  const winners = await db
    .select({
      winnerId: lotteryWinners.id,
      identityValue: lotteryWinners.identityValue,
      displayName: lotteryEntries.displayName,
      tierName: lotteryPrizeTiers.tierName,
      prizeName: prizes.name,
      prizeValue: prizes.valueText,
      prizeCodeId: lotteryWinners.prizeCodeId,
    })
    .from(lotteryWinners)
    .innerJoin(
      lotteryEntries,
      and(
        eq(lotteryEntries.tenantId, lotteryWinners.tenantId),
        eq(lotteryEntries.drawId, lotteryWinners.drawId),
        eq(lotteryEntries.id, lotteryWinners.entryId),
      ),
    )
    .leftJoin(
      lotteryPrizeTiers,
      and(
        eq(lotteryPrizeTiers.tenantId, lotteryWinners.tenantId),
        eq(lotteryPrizeTiers.drawId, lotteryWinners.drawId),
        eq(lotteryPrizeTiers.id, lotteryWinners.tierId),
      ),
    )
    .leftJoin(
      prizes,
      and(
        eq(prizes.tenantId, lotteryWinners.tenantId),
        eq(prizes.id, lotteryPrizeTiers.prizeId),
      ),
    )
    .where(and(eq(lotteryWinners.tenantId, tenantId), eq(lotteryWinners.drawId, drawId)));

  const results = await runBounded(winners, 5, async (winner) => {
    await enqueuePlatformEvent(db, {
      tenantId,
      drawId,
      eventType: "outcome.assigned",
      eventId: `outcome:${winner.winnerId}`,
      data: {
        drawName,
        userName: winner.displayName || winner.identityValue,
        prizeName: winner.prizeName || winner.tierName || "中奖",
        prizeValue: winner.prizeValue || "",
        claimHint: winner.prizeCodeId ? "请在活动结果页查看卡密" : "",
      },
    });
  });

  for (const result of results) {
    if (!result.ok) {
      console.error("[lottery] enqueue outcome.assigned delivery failed:", result.error);
    }
  }
}

/**
 * 发送中奖通知邮件（开奖后 fire-and-forget，也可被管理端 retry-email 同步调用）。
 *
 * - 跳过已 sent；处理 pending / failed（及空状态）
 * - 每人/每奖独立发送，一人失败不影响其他人（instant 多奖 = 多封，每封一码）
 * - winnerIds：只发指定 winner 行（instant spin 后按本 spin 的 winner 触发，避免扫全表）
 * - 返回 sent/failed 计数供运营台 toast（docs/078 闭环）
 */
export async function sendWinnerNotifications(
  db: DbType,
  tenantId: string,
  drawId: string,
  emailEnv: EmailEnv,
  options?: { winnerIds?: string[] },
): Promise<{ sent: number; failed: number }> {
  const queued = await enqueueWinnerNotificationDeliveries(db, tenantId, drawId, options);
  if (queued.deliveryIds.length === 0) return { sent: 0, failed: 0 };
  const result = await dispatchEmailDeliveries(db, emailEnv, {
    deliveryIds: queued.deliveryIds,
    limit: queued.deliveryIds.length,
  });
  return { sent: result.sent, failed: result.failed };
}

export async function enqueueWinnerNotificationDeliveries(
  db: DbType,
  tenantId: string,
  drawId: string,
  options?: { winnerIds?: string[] },
): Promise<{ deliveryIds: string[] }> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return { deliveryIds: [] };

  const winnerIdFilter = (options?.winnerIds || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);

  const winners = await db
    .select({
      winnerId: lotteryWinners.id,
      entryId: lotteryWinners.entryId,
      tierId: lotteryWinners.tierId,
      email: lotteryWinners.identityValue,
      identityType: lotteryWinners.identityType,
      prizeCodeId: lotteryWinners.prizeCodeId,
      notificationStatus: lotteryWinners.notificationStatus,
      notificationRetryCount: lotteryWinners.notificationRetryCount,
    })
    .from(lotteryWinners)
    .where(
      winnerIdFilter.length > 0
        ? and(
            eq(lotteryWinners.drawId, drawId),
            eq(lotteryWinners.tenantId, tenantId),
            inArray(lotteryWinners.id, winnerIdFilter),
          )
        : and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)),
    );

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

  // 奖项名 / 奖品名：instant 多奖时 productName 必须是「这一档」而非活动标题
  const tierIds = [...new Set(winners.map((w) => w.tierId).filter(Boolean))];
  const prizeLabelMap = new Map<string, { tierName: string; prizeName: string }>();
  if (tierIds.length > 0) {
    const tierRows = await db
      .select({
        tierId: lotteryPrizeTiers.id,
        tierName: lotteryPrizeTiers.tierName,
        prizeName: prizes.name,
      })
      .from(lotteryPrizeTiers)
      .leftJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.tenantId, tenantId)))
      .where(inArray(lotteryPrizeTiers.id, tierIds));
    for (const row of tierRows) {
      prizeLabelMap.set(row.tierId, {
        tierName: row.tierName || "",
        prizeName: row.prizeName || row.tierName || "",
      });
    }
  }

  // 同 entry 多奖：在备注里提示「本活动可多次中奖，每奖单独一封邮件」
  const entryIds = [...new Set(winners.map((w) => w.entryId).filter(Boolean))];
  const multiWinEntryIds = new Set<string>();
  if (entryIds.length > 0) {
    const entryWinCounts = await db
      .select({
        entryId: lotteryWinners.entryId,
        cnt: count(),
      })
      .from(lotteryWinners)
      .where(and(
        eq(lotteryWinners.drawId, drawId),
        eq(lotteryWinners.tenantId, tenantId),
        inArray(lotteryWinners.entryId, entryIds),
      ))
      .groupBy(lotteryWinners.entryId);
    for (const row of entryWinCounts) {
      if (Number(row.cnt) > 1 && row.entryId) multiWinEntryIds.add(row.entryId);
    }
  }

  // 读取邮件通知最大重试次数配置，默认 3 次。这里控制是否继续入队；
  // 具体发送失败后的 retry 间隔由 email_deliveries 统一处理。
  const [retryCfg] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, "email_notification_retry_max_attempts"))
    .limit(1);
  // 未配置时默认 3 次；使用 != null 而非 ||，避免合法值 "0" 被误判为假值降级为 3
  const maxRetryAttempts = retryCfg?.value != null ? Number(retryCfg.value) : 3;

  const deliveryIds: string[] = [];
  for (const winner of winners) {
    if (winner.notificationStatus === "sent") continue;
    if (winner.notificationRetryCount >= maxRetryAttempts) continue;

    let accountLabel = "";
    let deliverySecret = "";

    if (winner.prizeCodeId) {
      const code = codeMap.get(winner.prizeCodeId);
      if (code) { accountLabel = code.code; deliverySecret = code.secret; }
    }

    const labels = prizeLabelMap.get(winner.tierId);
    const productName = labels?.prizeName || labels?.tierName || draw.title;
    const deliveryNote = multiWinEntryIds.has(winner.entryId)
      ? "本活动支持多次中奖：每份奖品单独一封邮件，请注意查收其它中奖通知。"
      : "";

    // 收件人解析：user_id 身份的 winner 用 users 表关联的真实邮箱（见上方 userEmailMap）
    const toEmail = winner.identityType === "user_id" ? (userEmailMap.get(winner.email) || "") : winner.email;

    if (!toEmail || !toEmail.includes("@")) continue;
    const queued = await enqueueEmailDelivery(db, {
      tenantId,
      drawId,
      sourceType: "lottery_winner",
      sourceId: winner.winnerId,
      recipientEmail: toEmail,
      template: "lottery_winner",
      templateData: buildLotteryWinnerTemplateData({
        drawName: draw.title,
        productName,
        accountLabel,
        deliverySecret,
        deliveryNote,
      }),
    });
    if (queued.enqueued) deliveryIds.push(queued.deliveryId);
  }

  return { deliveryIds };
}

/**
 * instant spin 中奖后异步通知：只发本 spin 对应 winner 行（多奖不重发历史奖）。
 * 失败只打日志，不回滚 spin。
 */
export async function notifyInstantSpinWinner(
  db: DbType,
  tenantId: string,
  drawId: string,
  spinId: string,
  emailEnv: EmailEnv,
): Promise<void> {
  if (!emailEnv || (!emailEnv.resendApiKey && !emailEnv.email && !(emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret)) || !spinId) return;

  const [notifyCfg] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, "notify_winner_email_enabled"))
    .limit(1);
  if (notifyCfg?.value === "false") return;

  const [winner] = await db
    .select({ id: lotteryWinners.id })
    .from(lotteryWinners)
    .where(and(
      eq(lotteryWinners.tenantId, tenantId),
      eq(lotteryWinners.drawId, drawId),
      eq(lotteryWinners.spinId, spinId),
    ))
    .limit(1);
  if (!winner) return;

  await sendWinnerNotifications(db, tenantId, drawId, emailEnv, {
    winnerIds: [winner.id],
  });
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
        eq(couponCodes.tenantId, tenantId),
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
  options?: { staleMs?: number; force?: boolean },
): Promise<typeof DRAW_STATUS.DRAWN | typeof DRAW_STATUS.OPEN | null> {
  const staleMs = options?.staleMs ?? 300000; // 默认 5 分钟超时
  // force：管理端「恢复」按钮——不等待超时窗口（docs/078）
  const force = options?.force === true;

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw || draw.status !== DRAW_STATUS.DRAWING) return null;

  // 检查是否已有中奖记录
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));

  const nowIso = new Date().toISOString();

  if (Number(total) > 0) {
    // 中奖已落库但状态未 drawn：补状态
    await db
      .update(lotteryDraws)
      .set({ status: DRAW_STATUS.DRAWN, drawnAt: draw.drawnAt || nowIso, updatedAt: nowIso, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, DRAW_STATUS.DRAWING)));
    return DRAW_STATUS.DRAWN;
  }

  // 无中奖记录：超时（cron）或运营强制恢复 → 回滚为 open
  const updatedAt = new Date(draw.updatedAt || draw.createdAt).getTime();
  if (force || Date.now() - updatedAt > staleMs) {
    await db
      .update(lotteryDraws)
      .set({
        status: DRAW_STATUS.OPEN,
        failureReason: force ? "运营手动恢复开奖状态" : "开奖超时，已自动回滚",
        updatedAt: nowIso,
      })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, DRAW_STATUS.DRAWING)));
    return DRAW_STATUS.OPEN;
  }

  return null;
}

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
  emailEnv: EmailEnv,
  tenantId: string,
  drawId: string,
  drawTitle: string,
): Promise<{ sent: number; failed: number }> {
  if (!emailEnv.resendApiKey && !emailEnv.email && !(emailEnv.cfAuthIssuer && emailEnv.cfAuthClientId && emailEnv.cfAuthClientSecret)) return { sent: 0, failed: 0 };

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

  const origin = "";  // APP_ORIGIN 由调用方传入，这里用相对路径

  const deliveryIds: string[] = [];
  for (const coupon of issuedCoupons) {
    if (!coupon.recipientEmail || !coupon.recipientEmail.includes("@")) continue;
    const queued = await enqueueEmailDelivery(db, {
      tenantId,
      drawId,
      sourceType: "loser_consolation",
      sourceId: `${drawId}:${coupon.recipientEmail}:${coupon.code}`,
      recipientEmail: coupon.recipientEmail,
      template: "loser_consolation",
      templateData: {
        drawName: drawTitle,
        couponCode: coupon.code,
        couponLabel: coupon.label || "",
        nextActivityUrl: origin || "",
      },
    });
    if (queued.enqueued) deliveryIds.push(queued.deliveryId);
  }

  if (deliveryIds.length === 0) return { sent: 0, failed: 0 };
  const result = await dispatchEmailDeliveries(db, emailEnv, {
    deliveryIds,
    limit: deliveryIds.length,
  });
  return { sent: result.sent, failed: result.failed };
}
