/**
 * lottery×instant 即时 spin 结果机（docs/116 / docs/117）
 *
 * 与 performDraw 互斥：本模块只服务 result_mode=instant。
 * 事务顺序：幂等回放 → CAS 扣次 → 加权抽档 → 码 CAS → 写 spins/winners。
 * 邮件/webhook 异步，失败不回滚 spin（由路由层触发）。
 */
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { and, eq, sql } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryPrizeTiers,
  lotterySpins,
  lotteryWinners,
  prizeCodes,
  prizes,
} from "../../db/schema";
import {
  INSTANT_ALGORITHM_VERSION,
  isInstantSpinQuotaConfigured,
  random01Csprng,
  weightedPickTier,
} from "./spin-quota";
import { parseFlashSaleConfig } from "../../lib/flash-sale-config";
import { recordSpinLog } from "./spins-log";
import { PAYMENT_ENTRY_STATUS } from "../payment/payment-status";

export class SpinBusinessError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "SpinBusinessError";
  }
}

export type SpinResult = {
  spinId: string;
  entryId: string;
  won: boolean;
  prizeIndex: number;
  tierId: string | null;
  tierName: string | null;
  prizeName: string | null;
  prizeCode: string | null;
  spinsLeft: number;
  spinsUsed: number;
  maxSpinsPerEntry: number;
  resultFamily: "lottery";
  resultMode: "instant";
  algorithmVersion: string;
  replayed?: boolean;
};

type SpinInput = {
  slug: string;
  identityType: string;
  identityValue: string;
  idempotencyKey: string;
  ipHash?: string;
};

type FreshSpinPayload = {
  id: string;
  won: number;
  tierId: string;
  prizeCodeId: string;
  prizeIndex: number;
  tierName: string | null;
  prizeName: string | null;
  prizeCodePlain: string | null;
};

/**
 * 公开 spin：身份已由路由解析；此处校验活动 + entry + 次数 + 抽奖落库。
 */
export async function performInstantSpin(db: DbType, input: SpinInput): Promise<SpinResult> {
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new SpinBusinessError("缺少有效的幂等键", 400, "spin.idempotency.required");
  }

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, input.slug))
    .limit(1);

  if (!draw) throw new SpinBusinessError("活动不存在", 404, "spin.draw.not_found");
  if (draw.activityKind !== "lottery") {
    throw new SpinBusinessError("该活动不支持即时抽奖", 400, "spin.activity.not_lottery");
  }
  if (String(draw.resultMode || "") !== "instant") {
    throw new SpinBusinessError("该活动不是即时开奖模式", 400, "spin.result_mode.not_instant");
  }
  if (draw.status !== "open") {
    throw new SpinBusinessError("活动未开启", 400, "spin.draw.not_open");
  }

  const now = new Date();
  if (now < new Date(draw.startAt) || now > new Date(draw.endAt)) {
    throw new SpinBusinessError("不在参与时间内", 400, "spin.draw.out_of_window");
  }

  const maxSpins = Number(draw.maxSpinsPerEntry || 0);
  if (!isInstantSpinQuotaConfigured(maxSpins)) {
    throw new SpinBusinessError("活动未配置抽奖次数", 400, "spin.quota.not_configured");
  }

  const identityValue = String(input.identityValue || "").trim().toLowerCase();
  const identityType = String(input.identityType || "email").trim() || "email";

  const [entry] = await db
    .select()
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      eq(lotteryEntries.identityType, identityType),
      eq(lotteryEntries.identityValue, identityValue),
    ))
    .limit(1);

  if (!entry) {
    throw new SpinBusinessError("请先参与活动再抽奖", 400, "spin.entry.required");
  }

  // 纵深防御：直付秒杀（paymentRequired）必须已付款才能 spin，防止未付款即中奖。
  // 发布预检（publish-check-service）已阻断 instant + paymentRequired 组合发布，
  // 但对已存在的存量数据仍需运行时校验（docs/166）。
  const flashSale = parseFlashSaleConfig(draw.promotionConfig);
  if (flashSale.config?.paymentRequired === true) {
    // entry 状态域只有 PAID 表示已付款（paid_fulfillment_failed 属 order/attempt 状态域）。
    // 非 PAID（NONE/RESERVED/PENDING/EXPIRED）一律拒绝 spin。
    if (entry.paymentStatus !== PAYMENT_ENTRY_STATUS.PAID) {
      throw new SpinBusinessError("请先完成支付再抽奖", 402, "spin.payment.required");
    }
  }

  const [existing] = await db
    .select()
    .from(lotterySpins)
    .where(and(
      eq(lotterySpins.tenantId, draw.tenantId),
      eq(lotterySpins.drawId, draw.id),
      eq(lotterySpins.idempotencyKey, idempotencyKey),
    ))
    .limit(1);

  if (existing) {
    return buildSpinResultFromRow(db, draw, entry, existing, true);
  }

  const nowIso = now.toISOString();

  try {
    const outcome = await withDbTransaction(db, async (tx) => {
      const [again] = await tx
        .select()
        .from(lotterySpins)
        .where(and(
          eq(lotterySpins.tenantId, draw.tenantId),
          eq(lotterySpins.drawId, draw.id),
          eq(lotterySpins.idempotencyKey, idempotencyKey),
        ))
        .limit(1);
      if (again) return { kind: "replay" as const, row: again };

      const deduct = await tx
        .update(lotteryEntries)
        .set({ spinsLeft: sql`${lotteryEntries.spinsLeft} - 1` })
        .where(and(
          eq(lotteryEntries.id, entry.id),
          eq(lotteryEntries.tenantId, draw.tenantId),
          eq(lotteryEntries.drawId, draw.id),
          sql`${lotteryEntries.spinsLeft} >= 1`,
        ));

      if ((deduct.rowsAffected ?? 0) === 0) {
        throw new SpinBusinessError("抽奖次数已用完", 409, "spin.quota.exhausted");
      }

      const tiers = await tx
        .select({
          id: lotteryPrizeTiers.id,
          tierName: lotteryPrizeTiers.tierName,
          prizeId: lotteryPrizeTiers.prizeId,
          winnerCount: lotteryPrizeTiers.winnerCount,
          /** 已发放计数器（CAS 乐观锁），替代 COUNT(lottery_winners) 读改写 */
          awardedCount: lotteryPrizeTiers.awardedCount,
          weight: lotteryPrizeTiers.weight,
          sortOrder: lotteryPrizeTiers.sortOrder,
          prizeName: prizes.name,
          prizeType: prizes.prizeType,
        })
        .from(lotteryPrizeTiers)
        .leftJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.tenantId, draw.tenantId)))
        .where(and(
          eq(lotteryPrizeTiers.tenantId, draw.tenantId),
          eq(lotteryPrizeTiers.drawId, draw.id),
        ))
        .orderBy(lotteryPrizeTiers.sortOrder);

      const eligible: Array<{
        id: string;
        weight: number;
        tierName: string;
        prizeId: string;
        prizeName: string | null;
        prizeType: string | null;
        prizeIndex: number;
        /** 奖档名额上限，用于 award 阶段的 CAS 占用 */
        cap: number;
      }> = [];

      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i]!;
        const w = Number(t.weight || 0);
        if (w <= 0) continue;
        const cap = Math.max(0, Number(t.winnerCount || 0));
        if (cap < 1) continue;
        // 用 awarded_count 计数器替代 COUNT(lottery_winners) 读改写（docs/148 §四）。
        // 这里只做过滤供加权抽样；名额真实上限由 award 阶段的 CAS UPDATE 保证，
        // 因此并发下即使读到旧值，也不会超发。
        const awarded = Math.max(0, Number(t.awardedCount || 0));
        if (awarded >= cap) continue;
        eligible.push({
          id: t.id,
          weight: w,
          tierName: t.tierName || "中奖",
          prizeId: t.prizeId || "",
          prizeName: t.prizeName || null,
          prizeType: t.prizeType || null,
          prizeIndex: i,
          cap,
        });
      }

      const spinId = crypto.randomUUID();
      let won = 0;
      let tierId = "";
      let prizeCodeId = "";
      let prizeIndex = -1;
      let tierName: string | null = null;
      let prizeName: string | null = null;
      let prizeCodePlain: string | null = null;

      const picked = weightedPickTier(eligible, random01Csprng);
      if (picked) {
        let award = false;

        if (picked.prizeId && picked.prizeType === "code") {
          // 原子取码：子查询 UPDATE 消除 SELECT→UPDATE 之间的竞态窗口。
          // 两个并发 spin 看到同一张可用卡密时，SQLite 单写者序列化保证只有一个 UPDATE 成功，
          // 失败的 rowsAffected = 0 → 本轮 spin 未中，已扣次数不退还（与普通未中行为一致）。
          // 模式与 draw-execution.ts acquirePrizeCode 一致。
          const lockResult = await tx
            .update(prizeCodes)
            .set({
              status: "issued",
              // instant：winner_id 绑 spin，避免一人多奖回查歧义（docs/117 P0-4）
              winnerId: spinId,
              issuedAt: nowIso,
            })
            .where(and(
              eq(prizeCodes.tenantId, draw.tenantId),
              eq(prizeCodes.status, "available"),
              eq(prizeCodes.id, sql<string>`(
                SELECT id FROM prize_codes
                WHERE tenant_id = ${draw.tenantId}
                AND prize_id = ${picked.prizeId}
                AND status = 'available'
                ORDER BY id
                LIMIT 1
              )`),
            ))
            .returning({ id: prizeCodes.id, code: prizeCodes.code, secret: prizeCodes.secret });

          if (lockResult.length > 0) {
            const code = lockResult[0]!;
            prizeCodeId = code.id;
            prizeCodePlain = code.secret
              ? `${code.code}:${code.secret}`
              : code.code;
            // 码已取到，再 CAS 占用奖档名额（docs/148 §四）。
            // 先取码后 CAS 避免「占用名额但码池耗尽」的幻象 award。
            // 若 CAS 失败（并发下该档恰好在那一刻已满），释放已取码并视为未中。
            const claimTier = await tx
              .update(lotteryPrizeTiers)
              .set({ awardedCount: sql`${lotteryPrizeTiers.awardedCount} + 1` })
              .where(and(
                eq(lotteryPrizeTiers.id, picked.id),
                eq(lotteryPrizeTiers.tenantId, draw.tenantId),
                eq(lotteryPrizeTiers.drawId, draw.id),
                sql`${lotteryPrizeTiers.awardedCount} < ${picked.cap}`,
              ));
            if ((claimTier.rowsAffected ?? 0) > 0) {
              await tx.update(prizes)
                .set({ usedCount: sql`used_count + 1`, updatedAt: nowIso })
                .where(and(eq(prizes.id, picked.prizeId), eq(prizes.tenantId, draw.tenantId)));
              award = true;
            } else {
              // 奖档名额已被并发占满：释放已取到的码，视为未中（仍扣次）
              await tx
                .update(prizeCodes)
                .set({ status: "available", winnerId: null, issuedAt: null })
                .where(and(
                  eq(prizeCodes.id, prizeCodeId),
                  eq(prizeCodes.tenantId, draw.tenantId),
                ));
              prizeCodeId = "";
              prizeCodePlain = null;
            }
          }
          // 无码或竞态失败 → 未中，仍已扣次
        } else if (picked.prizeId) {
          // 非码奖品（人工履约等）：CAS 占用奖档名额（docs/148 §四）
          const claimTier = await tx
            .update(lotteryPrizeTiers)
            .set({ awardedCount: sql`${lotteryPrizeTiers.awardedCount} + 1` })
            .where(and(
              eq(lotteryPrizeTiers.id, picked.id),
              eq(lotteryPrizeTiers.tenantId, draw.tenantId),
              eq(lotteryPrizeTiers.drawId, draw.id),
              sql`${lotteryPrizeTiers.awardedCount} < ${picked.cap}`,
            ));
          if ((claimTier.rowsAffected ?? 0) > 0) {
            award = true;
          }
        }
        // 无 prizeId 的权重档不发奖（避免空奖「假中」）

        if (award) {
          won = 1;
          tierId = picked.id;
          prizeIndex = picked.prizeIndex;
          tierName = picked.tierName;
          prizeName = picked.prizeName;
        }
      }

      await tx.insert(lotterySpins).values({
        id: spinId,
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId: entry.id,
        idempotencyKey,
        won,
        tierId,
        prizeCodeId,
        prizeIndex,
        algorithmVersion: INSTANT_ALGORITHM_VERSION,
        ipHash: input.ipHash || "",
        createdAt: nowIso,
      });

      // 写入 spins 流水日志（docs/172 §5.5 P1）：记录抽奖消耗 1 次
      await recordSpinLog(tx, {
        tenantId: draw.tenantId,
        entryId: entry.id,
        userId: entry.identityValue,
        delta: -1,
        balanceAfter: Math.max(0, Number(entry.spinsLeft ?? 0) - 1),
        reason: "spin",
        refId: spinId,
      });

      if (won === 1 && tierId) {
        await tx.insert(lotteryWinners).values({
          id: crypto.randomUUID(),
          tenantId: draw.tenantId,
          drawId: draw.id,
          tierId,
          entryId: entry.id,
          spinId,
          identityType: entry.identityType,
          identityValue: entry.identityValue,
          prizeCodeId,
          drawnAt: nowIso,
          notificationStatus: "pending",
        });
      }

      const payload: FreshSpinPayload = {
        id: spinId,
        won,
        tierId,
        prizeCodeId,
        prizeIndex,
        tierName,
        prizeName,
        prizeCodePlain,
      };
      return { kind: "fresh" as const, row: payload };
    });

    if (outcome.kind === "replay") {
      return buildSpinResultFromRow(db, draw, entry, outcome.row, true);
    }

    return finalizeFreshResult(db, draw, entry, outcome.row, maxSpins);
  } catch (err) {
    if (err instanceof SpinBusinessError) throw err;
    const msg = String((err as Error)?.message || err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      const [row] = await db
        .select()
        .from(lotterySpins)
        .where(and(
          eq(lotterySpins.tenantId, draw.tenantId),
          eq(lotterySpins.drawId, draw.id),
          eq(lotterySpins.idempotencyKey, idempotencyKey),
        ))
        .limit(1);
      if (row) return buildSpinResultFromRow(db, draw, entry, row, true);
    }
    throw err;
  }
}

async function finalizeFreshResult(
  db: DbType,
  draw: typeof lotteryDraws.$inferSelect,
  entry: typeof lotteryEntries.$inferSelect,
  row: FreshSpinPayload,
  maxSpins: number,
): Promise<SpinResult> {
  const [freshEntry] = await db
    .select({
      spinsLeft: lotteryEntries.spinsLeft,
      spinsTotalGranted: lotteryEntries.spinsTotalGranted,
    })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.id, entry.id), eq(lotteryEntries.tenantId, draw.tenantId)))
    .limit(1);

  const spinsLeft = Number(freshEntry?.spinsLeft ?? 0);
  const granted = Number(freshEntry?.spinsTotalGranted ?? 0);
  /**
   * spinsUsed = granted - spinsLeft（活动额度 - 剩余次数）。
   * 注意：签到奖励（dailyCheckinPolicy.grantSpinCount）只更新 spinsLeft，不更新 spinsTotalGranted。
   * 因此当用户消耗了签到奖励发放的次数后，spinsUsed 可能小于实际消耗次数。
   * 
   * 为什么不做「完美计算」？因为签到奖励不是活动额度，不应计入 maxSpinsPerEntry 上限。
   * 若更新 spinsTotalGranted，会与裂变邀请的 computeViralSpinGrant 中 roomTotal = max - granted 冲突。
   * 
   * 影响：spinsUsed 在群命令中不展示（仅展示 spinsLeft），前端也不渲染此字段。
   * 这是一个内部不精确但无用户感知影响的设计决定（docs/171 §11.4.2）。
   */
  const spinsUsed = Math.max(0, granted - spinsLeft);

  return {
    spinId: row.id,
    entryId: entry.id,
    won: row.won === 1,
    prizeIndex: row.prizeIndex,
    tierId: row.tierId || null,
    tierName: row.tierName,
    prizeName: row.prizeName,
    prizeCode: row.prizeCodePlain,
    spinsLeft,
    spinsUsed,
    maxSpinsPerEntry: maxSpins,
    resultFamily: "lottery",
    resultMode: "instant",
    algorithmVersion: INSTANT_ALGORITHM_VERSION,
  };
}

async function buildSpinResultFromRow(
  db: DbType,
  draw: typeof lotteryDraws.$inferSelect,
  entry: typeof lotteryEntries.$inferSelect,
  spin: typeof lotterySpins.$inferSelect,
  replayed: boolean,
): Promise<SpinResult> {
  let prizeCode: string | null = null;
  let tierName: string | null = null;
  let prizeName: string | null = null;

  if (spin.prizeCodeId) {
    const [pc] = await db
      .select({ code: prizeCodes.code, secret: prizeCodes.secret })
      .from(prizeCodes)
      .where(and(eq(prizeCodes.id, spin.prizeCodeId), eq(prizeCodes.tenantId, draw.tenantId)))
      .limit(1);
    if (pc) prizeCode = pc.secret ? `${pc.code}:${pc.secret}` : pc.code;
  }
  if (spin.tierId) {
    const [tierRow] = await db
      .select({
        tierName: lotteryPrizeTiers.tierName,
        prizeName: prizes.name,
      })
      .from(lotteryPrizeTiers)
      .leftJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.tenantId, draw.tenantId)))
      // 纵深防御：同时限定 tierId + tenantId，防止跨租户枚举奖项
      .where(and(eq(lotteryPrizeTiers.id, spin.tierId), eq(lotteryPrizeTiers.tenantId, draw.tenantId)))
      .limit(1);
    if (tierRow) {
      tierName = tierRow.tierName || null;
      prizeName = tierRow.prizeName || tierRow.tierName || null;
    }
  }

  const [freshEntry] = await db
    .select({
      spinsLeft: lotteryEntries.spinsLeft,
      spinsTotalGranted: lotteryEntries.spinsTotalGranted,
    })
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.id, entry.id), eq(lotteryEntries.tenantId, draw.tenantId)))
    .limit(1);

  const spinsLeft = Number(freshEntry?.spinsLeft ?? entry.spinsLeft ?? 0);
  const granted = Number(freshEntry?.spinsTotalGranted ?? entry.spinsTotalGranted ?? 0);
  const spinsUsed = Math.max(0, granted - spinsLeft);
  const maxSpins = Number(draw.maxSpinsPerEntry || 0);

  return {
    spinId: spin.id,
    entryId: entry.id,
    won: Number(spin.won) === 1,
    prizeIndex: Number(spin.prizeIndex ?? -1),
    tierId: spin.tierId || null,
    tierName,
    prizeName,
    prizeCode,
    spinsLeft,
    spinsUsed,
    maxSpinsPerEntry: maxSpins,
    resultFamily: "lottery",
    resultMode: "instant",
    algorithmVersion: spin.algorithmVersion || INSTANT_ALGORITHM_VERSION,
    replayed,
  };
}
