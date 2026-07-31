/**
 * 抽奖服务层 — cf-lottery 适配版
 *
 * 从 cf-shop 抽取，核心变更：
 * - 奖品从 products 表迁移到 prizes 表
 * - 发卡从 orders + cards 迁移到 prize_codes 表
 * - 所有查询增加 tenant_id 隔离
 * - 移除 RuntimeConfig 依赖，直接使用 env
 */
import { withDbTransaction, type DbType } from "../db/client";
import { buildLotteryWinnerTemplateData, sendEmail } from "./email-service";
import { minorToMajorString } from "../../shared/money";
import { and, eq, count, sql } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  prizes,
  prizeCodes,
} from "../db/schema";

/* ── 类型定义 ── */

export type LotteryDraw = {
  id: string;
  tenantId: string;
  publicSlug: string;
  title: string;
  description: string;
  status: string;
  participationMode: string;
  drawTrigger: string;
  startAt: string;
  endAt: string;
  drawAt: string | null;
  winnerCount: number;
  maxParticipants: number | null;
  drawnAt: string | null;
  failureReason: string;
};

export type WinnerResult = {
  email: string;
  prizeCodeId?: string;
  code?: string;
  secret?: string;
  note?: string;
};

/* ── 查询函数 ── */

export async function getDraw(db: DbType, drawId: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  return row || null;
}

export async function getDrawEntriesCount(db: DbType, drawId: string) {
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, drawId));
  return Number(total);
}

export async function getDrawWinners(db: DbType, drawId: string) {
  return db
    .select()
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));
}

/* ── 开奖核心 ── */

/**
 * 执行开奖
 *
 * 流程：
 * 1. CAS 更新状态：open → drawing
 * 2. 读取候选池，随机抽取
 * 3. 原子锁码：UPDATE prize_codes SET status='issued' WHERE status='available'
 * 4. 写入 winners
 * 5. drawing → drawn
 */
export async function performDraw(
  db: DbType,
  drawId: string,
  tenantId: string,
  emailEnv: { resendApiKey?: string; emailFrom?: string },
  operator: "admin" | "cron" = "admin",
) {
  const draw = await getDraw(db, drawId, tenantId);
  if (!draw) throw new Error("活动不存在");
  if (draw.status !== "open") throw new Error("活动状态不允许开奖");

  const prize = await getDrawPrize(db, drawId, tenantId);
  if (!prize) throw new Error("奖品不存在");

  // 1. CAS：open → drawing
  const claimed = await db
    .update(lotteryDraws)
    .set({ status: "drawing", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "open")));
  if (claimed.rowsAffected === 0) throw new Error("活动正在开奖中或已结束");

  try {
    // 2. 读取候选池
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId))
      .orderBy(sql`RANDOM()`)
      .limit(draw.winnerCount);

    if (entries.length === 0) {
      throw new Error("没有参与者");
    }

    // 3. 原子锁码 + 写入中奖记录
    const winners: WinnerResult[] = [];
    await withDbTransaction(db, async (tx) => {
      for (const entry of entries) {
        // 原子锁码：从 prize_codes 中取一条 available 的记录
        const [code] = await tx
          .update(prizeCodes)
          .set({ status: "issued", winnerId: entry.id, issuedAt: new Date().toISOString() })
          .where(and(
            eq(prizeCodes.prizeId, prize.id),
            eq(prizeCodes.tenantId, tenantId),
            eq(prizeCodes.status, "available"),
          ))
          .returning();

        if (!code) break; // 码不够了

        // 写入中奖记录
        await tx.insert(lotteryWinners).values({
          id: crypto.randomUUID(),
          tenantId,
          drawId,
          tierId: "",
          entryId: entry.id,
          identityType: entry.identityType,
          identityValue: entry.identityValue,
          prizeCodeId: code.id,
          drawnAt: new Date().toISOString(),
        });

        winners.push({
          email: entry.identityValue,
          prizeCodeId: code.id,
          code: code.code,
          secret: code.secret,
          note: code.note,
        });
      }
    });

    // 4. drawing → drawn
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(lotteryDraws.id, drawId));

    // 5. 发送中奖邮件（异步）
    if (emailEnv.resendApiKey && winners.length > 0) {
      const prizeValue = prize.priceCents > 0 ? minorToMajorString(prize.priceCents, "CNY") : "";
      for (const winner of winners) {
        sendEmail(db, emailEnv, {
          to: winner.email,
          template: "lottery_winner",
          templateData: buildLotteryWinnerTemplateData({
            drawName: draw.title,
            productName: prize.name,
            prizeValue,
            accountLabel: winner.code || "",
            deliverySecret: winner.secret || "",
            deliveryNote: winner.note || "",
          }),
        }).catch(() => {});
      }
    }

    return { drawId, winners };
  } catch (err) {
    // 失败回滚
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: (err as Error).message, updatedAt: new Date().toISOString() })
      .where(eq(lotteryDraws.id, drawId));
    throw err;
  }
}

/** 获取抽奖活动的奖品信息 */
async function getDrawPrize(db: DbType, drawId: string, tenantId: string) {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return null;

  // 查询关联的奖品（通过 lottery_prize_tiers 或直接通过 prize 字段）
  // MVP：活动直接关联奖品（通过 prize_id 字段或 lottery_prize_tiers）
  const [prize] = await db
    .select({
      id: prizes.id,
      name: prizes.name,
      description: prizes.description,
      prizeType: prizes.prizeType,
      priceCents: sql<number>`0`,
    })
    .from(prizes)
    .where(and(eq(prizes.tenantId, tenantId), eq(prizes.id, draw.id))) // TODO: 关联 prize_id
    .limit(1);
  return prize || null;
}

/** 处理到期定时开奖（Cron 调用） */
export async function processDueDraws(db: DbType, limit = 10) {
  const now = new Date().toISOString();
  const due = await db
    .select()
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
      sql`${lotteryDraws.drawAt} <= ${now}`,
    ))
    .limit(limit);

  let processed = 0;
  for (const draw of due) {
    try {
      await performDraw(db, draw.id, draw.tenantId, { resendApiKey: "", emailFrom: "" }, "cron");
      processed++;
    } catch (err) {
      console.warn(`[lottery] cron draw failed for ${draw.id}:`, (err as Error).message);
    }
  }
  return processed;
}