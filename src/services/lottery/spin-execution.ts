/**
 * lottery×instant 即时 spin 结果机（docs/116 / docs/117）
 *
 * 与 performDraw 互斥：本模块只服务 result_mode=instant。
 * 事务顺序：幂等回放 → CAS 扣次 → 加权抽档 → 码 CAS → 写 spins/winners。
 * 邮件/webhook 异步，失败不回滚 spin（由路由层触发）。
 */
import type { DbType } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { and, count, eq, sql } from "drizzle-orm";
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
      }> = [];

      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i]!;
        const w = Number(t.weight || 0);
        if (w <= 0) continue;
        const cap = Math.max(0, Number(t.winnerCount || 0));
        if (cap < 1) continue;
        const [{ total }] = await tx
          .select({ total: count() })
          .from(lotteryWinners)
          .where(and(
            eq(lotteryWinners.tenantId, draw.tenantId),
            eq(lotteryWinners.drawId, draw.id),
            eq(lotteryWinners.tierId, t.id),
          ));
        if (Number(total || 0) >= cap) continue;
        eligible.push({
          id: t.id,
          weight: w,
          tierName: t.tierName || "中奖",
          prizeId: t.prizeId || "",
          prizeName: t.prizeName || null,
          prizeType: t.prizeType || null,
          prizeIndex: i,
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
          const [availableCode] = await tx
            .select({ id: prizeCodes.id, code: prizeCodes.code, secret: prizeCodes.secret })
            .from(prizeCodes)
            .where(and(
              eq(prizeCodes.prizeId, picked.prizeId),
              eq(prizeCodes.status, "available"),
              eq(prizeCodes.tenantId, draw.tenantId),
            ))
            .limit(1);

          if (availableCode) {
            const lockResult = await tx
              .update(prizeCodes)
              .set({
                status: "issued",
                // instant：winner_id 绑 spin，避免一人多奖回查歧义（docs/117 P0-4）
                winnerId: spinId,
                issuedAt: nowIso,
              })
              .where(and(
                eq(prizeCodes.id, availableCode.id),
                eq(prizeCodes.status, "available"),
              ));

            if ((lockResult.rowsAffected ?? 0) > 0) {
              prizeCodeId = availableCode.id;
              prizeCodePlain = availableCode.secret
                ? `${availableCode.code}:${availableCode.secret}`
                : availableCode.code;
              await tx.update(prizes)
                .set({ usedCount: sql`used_count + 1`, updatedAt: nowIso })
                .where(eq(prizes.id, picked.prizeId));
              award = true;
            }
          }
          // 无码或 CAS 失败 → 未中，仍已扣次
        } else if (picked.prizeId) {
          // 人工履约等非码奖品：名额已在 eligible 校验
          award = true;
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
    .where(eq(lotteryEntries.id, entry.id))
    .limit(1);

  const spinsLeft = Number(freshEntry?.spinsLeft ?? 0);
  const granted = Number(freshEntry?.spinsTotalGranted ?? 0);
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
      .where(eq(prizeCodes.id, spin.prizeCodeId))
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
      .leftJoin(prizes, eq(prizes.id, lotteryPrizeTiers.prizeId))
      .where(eq(lotteryPrizeTiers.id, spin.tierId))
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
    .where(eq(lotteryEntries.id, entry.id))
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
