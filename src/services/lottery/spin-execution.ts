/**
 * lottery×instant 即时 spin 结果机（docs/116 / docs/117）
 *
 * 与 performDraw 互斥：本模块只服务 result_mode=instant。
 * 事务顺序：幂等回放 → CAS 扣次 → 加权抽档 → 码 CAS → 写 spins/winners。
 * 邮件/webhook 异步，失败不回滚 spin（由路由层触发）。
 */
import type { DbType } from "../../db/client";
import { isInstantResultMode } from "../../lib/activity-utils";
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
  normalizePityConfig,
  normalizeDailyFreeSpinConfig,
} from "./spin-quota";
import { parseFlashSaleConfig } from "../../lib/flash-sale-config";
import { recordSpinLog } from "./spins-log";
import { todayStr } from "../../lib/date-utils";
import { PAYMENT_ENTRY_STATUS } from "../payment/payment-status";
import { DRAW_STATUS } from "./types";

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
  /**
   * 业务层失败标记（P0 防滥用）：非空表示一次 spin 因业务规则被拒绝而未产生任何写入。
   * 与 SpinBusinessError 不同，它不抛异常、走正常返回值路径，调用方无需在 catch 中区分
   * 「是否已扣次」。当前仅 spin.quota.exhausted 使用；其余校验错误仍走 SpinBusinessError。
   */
  businessError?: string;
  businessErrorCode?: string;
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
  if (!isInstantResultMode(draw.resultMode)) {
    throw new SpinBusinessError("该活动不是即时开奖模式", 400, "spin.result_mode.not_instant");
  }
  if (draw.status !== DRAW_STATUS.OPEN) {
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

  // 保底机制 + 每日免费抽奖（docs/218）：配置缺省时均不启用，完全不改变现有路径。
  // 与 flashSale 同层解析 promotion_config（JSON 字符串，容错：非法 JSON → 未启用）。
  let pc: Record<string, unknown> | null = null;
  try {
    pc = JSON.parse(draw.promotionConfig || "{}") as Record<string, unknown>;
  } catch { /* 非法 JSON 视为未配置 */ }
  const pityConfig = normalizePityConfig(pc?.pity);
  const dailyFreeConfig = normalizeDailyFreeSpinConfig(pc?.dailyFreeSpins);

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

      // ── 每日免费抽奖：原子条件 UPDATE 领取（docs/218 模式二） ──
      // 与签到（commands.ts:568）模式一致：WHERE 条件保证同一自然日内只有第一个并发请求能领取成功。
      // 领取成功后 spinsLeft += count，本次 spin 跳过扣次（免费）。
      // 未配置或今日已领 → dailyFreeClaimed = false，走正常扣次路径。
      // ⚠️ 日期必须用 todayStr()（本地时区），与签到系统一致——若用 UTC 日期，
      // UTC+8 等时区下"每日"刷新点会偏移到当地早上 8 点，两套系统行为不一致。
      // ⚠️ P1 修复（2026-08 审查）：不再更新 spinsTotalGranted。与签到奖励同语义——
      // "每日免费/签到"是活动额度之外的额外次数，不应计入 maxSpinsPerEntry 上限。
      // 若计入 granted，会毒化裂变/里程碑的 roomTotal = maxSpins - granted（spin-quota.ts:108），
      // granted 被每日免费推高后邀请奖励被锁死（spin-execution.ts 注释 588-592 已明示签到路径的同一决策）。
      // 副作用（与签到一致，docs/171 §11.4.2）：spinsUsed = granted - left 会低估免费次数，无用户感知。
      let dailyFreeClaimed = false;
      if (dailyFreeConfig.enabled && dailyFreeConfig.count >= 1) {
        const today = todayStr();
        const claim = await tx
          .update(lotteryEntries)
          .set({
            spinsLeft: sql`${lotteryEntries.spinsLeft} + ${dailyFreeConfig.count}`,
            lastDailyFreeSpinAt: today,
          })
          .where(and(
            eq(lotteryEntries.id, entry.id),
            eq(lotteryEntries.tenantId, draw.tenantId),
            eq(lotteryEntries.drawId, draw.id),
            sql`(${lotteryEntries.lastDailyFreeSpinAt} IS NULL OR ${lotteryEntries.lastDailyFreeSpinAt} < ${today})`,
          ));
        if ((claim.rowsAffected ?? 0) > 0) {
          dailyFreeClaimed = true;
        }
      }

      // ── CAS 扣次（docs/255 §7.3 P1-4：每日免费领取后也扣本次） ──
      // 原实现：每日免费领取成功时跳过本次扣次 → 当日实际可抽 count+1 次（成本翻倍）。
      // 采纳方案：count 已包含当次，领取后仍执行 -1 扣次，当日实际可抽 = 初始 + count。
      // 流水拆两条（daily_free +count / spin -1）保持 spinsLeft = Σdelta 审计恒等式。
      // 不可能扣穿：claim 在同一事务内已 +count（count≥1），随后 WHERE spinsLeft>=1 必命中。
      let spinsLeftAfterDeduct: number;
      {
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
          // 次数耗尽：CAS 未命中（WHERE spinsLeft>=1 无行），因此本次绝对未扣次。
          // 返回业务失败结果而非抛异常，避免调用方误判「已扣次需补偿」。
          // 返回值路径保证外部无需在 catch 中做扣次补偿（P0 防无限消耗）。
          // ⚠️ 关键：此处不能使用事务外预读的 entry.spinsLeft 回填剩余次数——
          // 并发场景下预读可能读到较高的旧值（如两人同时读到 1），导致返回的剩余次数虚高、
          // 与实际已扣减后的值不一致。因此事务内重新读取当前真实余额，保证响应与库内一致。
          // 事务内（BEGIN IMMEDIATE 串行化写锁）能读到竞争者已提交的扣减结果。
          const [fresh] = await tx
            .select({ spinsLeft: lotteryEntries.spinsLeft })
            .from(lotteryEntries)
            .where(eq(lotteryEntries.id, entry.id))
            .limit(1);
          return {
            kind: "quotaExhausted" as const,
            spinsLeft: Math.max(0, Number(fresh?.spinsLeft ?? 0)),
          };
        }
        // 扣次成功后，事务内重新读取真实余额，用于审计日志 balanceAfter。
        // 不依赖事务外预读的 entry.spinsLeft（并发下可能偏高），与 leaderboard-rewards.ts:162-166 一致。
        const [fresh] = await tx
          .select({ spinsLeft: lotteryEntries.spinsLeft })
          .from(lotteryEntries)
          .where(eq(lotteryEntries.id, entry.id))
          .limit(1);
        spinsLeftAfterDeduct = Math.max(0, Number(fresh?.spinsLeft ?? 0));
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

      // ── 保底机制（docs/218 模式一）：事务内重新读取连续未中次数 →
      // 若 >= threshold 且尚有可抽档位，强制中最低价值档（eligible 最后一位）。
      // 事务内 BEGIN IMMEDIATE 串行化写锁，读取到的值一致。
      const [entryRow] = await tx
        .select({ consecutiveNoWinSpins: lotteryEntries.consecutiveNoWinSpins })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.id, entry.id))
        .limit(1);
      const currentConsecutive = Math.max(0, Number(entryRow?.consecutiveNoWinSpins ?? 0));
      const pityTriggered = pityConfig.enabled && currentConsecutive >= pityConfig.threshold && eligible.length > 0;

      // 保底触发时强制选中最低价值档（sortOrder 最大 = eligible 数组末尾）；
      // 否则正常加权随机抽样。
      const picked = pityTriggered ? eligible[eligible.length - 1]! : weightedPickTier(eligible, random01Csprng);
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

      // ── 更新连续未中计数器（docs/218 模式一） ──
      // 中奖 → 归零；未中（含 pity 触发但 award CAS 失败）→ 累加
      const newConsecutive = won === 1 ? 0 : currentConsecutive + 1;
      await tx
        .update(lotteryEntries)
        .set({ consecutiveNoWinSpins: newConsecutive })
        .where(and(eq(lotteryEntries.id, entry.id), eq(lotteryEntries.tenantId, draw.tenantId)));

      // 写入 spins 流水日志（docs/255 §7.3 P1-4）：
      // - 每日免费：先写 daily_free（+count），再写 spin（-1），两条流水使得
      //   spinsLeft = Σdelta 审计恒等式成立（原实现跳过扣次，当日净得 count+1 次）。
      // - 正常抽奖：记录 reason=spin, delta=-1；保底触发时 refId 前缀标识触发阈值，
      //   后缀追加 spinId 保持与普通 spin 一致的审计追溯能力（可反查具体是哪一次 spin 触发保底）
      if (dailyFreeClaimed) {
        // 第一条：免费领取流水（发多少记多少）
        // balanceAfter 语义是"本条流水发生后的余额"（逐条运行余额，spins-log 的审计约定），
        // 而 daily_free 的 +count 发生在 spin 的 -1 之前，因此这里是最终余额 + 1。
        // 修复前两条流水都写事务最终余额，导致 balanceAfter - delta 与上一条余额不闭合，
        // 对账脚本按逐条运行余额校验时会把每一次每日免费判成错账（docs/255 B3）。
        await recordSpinLog(tx, {
          tenantId: draw.tenantId,
          entryId: entry.id,
          userId: entry.identityValue,
          delta: dailyFreeConfig.count,
          balanceAfter: spinsLeftAfterDeduct + 1,
          reason: "daily_free",
          refId: spinId,
        });
      }
      // 第二条：本次 spin 消耗流水（无论是否免费，都扣了 1 次）
      await recordSpinLog(tx, {
        tenantId: draw.tenantId,
        entryId: entry.id,
        userId: entry.identityValue,
        delta: -1,
        balanceAfter: spinsLeftAfterDeduct,
        reason: "spin",
        refId: pityTriggered ? `pity:${pityConfig.threshold}:${spinId}` : spinId,
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

    // 次数耗尽：返回业务失败结果（won=false，无 spin 产生，未扣次）
    if (outcome.kind === "quotaExhausted") {
      return {
        spinId: "",
        entryId: entry.id,
        won: false,
        prizeIndex: -1,
        tierId: null,
        tierName: null,
        prizeName: null,
        prizeCode: null,
        spinsLeft: outcome.spinsLeft,
        spinsUsed: maxSpins,
        maxSpinsPerEntry: maxSpins,
        resultFamily: "lottery" as const,
        resultMode: "instant" as const,
        algorithmVersion: INSTANT_ALGORITHM_VERSION,
        businessError: "抽奖次数已用完",
        businessErrorCode: "spin.quota.exhausted",
      };
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
   * 若更新 spinsTotalGranted，会与裂变邀请的 computeBonusSpinGrant 中 roomTotal = max - granted 冲突。
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

/**
 * 清理已过期（超出保留窗口）的幂等抽奖执行记录（lottery_spins）。
 *
 * 为什么需要清理：
 * - lottery_spins.idempotency_key 是「同一消息回放不重复扣次」的幂等键
 *   （docs/116），其唯一约束只对消息重试窗口（秒级~小时级）有意义，
 *   超过窗口后旧记录已无幂等价值。
 * - 用户中奖结果已固化到 lottery_winners 表（永久保留），抽奖执行流水
 *   有独立 spins_log 表承载审计（docs/175），故 lottery_spins 表可安全清理。
 * - 不做清理会导致 Turso 免费层 rows/storage 被无限增长的 spins 记录拖垮，
 *   与 cleanExpiredTokens / cleanExpiredBindings 的短时效清理策略一致。
 *
 * 保留窗口默认 7 天：既覆盖任何延迟投递/补发场景，又避免无界增长。
 * 删除只按 createdAt 过滤，不依赖租户/开奖维度，避免跨租户误删。
 *
 * @param db 数据库实例
 * @param maxAgeMs 保留时长（默认 7 天）
 * @returns 删除的行数
 */
export async function cleanExpiredSpins(db: DbType, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  // 只清理不被 lottery_winners.spinId 引用的 spins（保留 instant 中奖记录可追溯性）
  // M3: NOT IN → NOT EXISTS —— 大表下 NOT IN 子查询性能差（SQLite 需构建完整结果集再比对），
  // NOT EXISTS 用相关子查询短路，命中即停；且 lottery_winners.spinId 有联合索引可走。
  const result = await db
    .delete(lotterySpins)
    .where(
      and(
        sql`${lotterySpins.createdAt} < ${cutoff}`,
        sql`NOT EXISTS (SELECT 1 FROM lottery_winners WHERE lottery_winners.spin_id = ${lotterySpins.id})`,
      ),
    );
  return result.rowsAffected ?? 0;
}
