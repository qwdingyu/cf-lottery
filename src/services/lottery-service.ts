/**
 * 抽奖服务层 — 核心业务逻辑。
 *
 * 【设计原则】
 * - 只操作抽奖相关表（lottery_draws/entries/winners/prizes/prize_codes），不涉及电商概念
 * - 所有函数都接受 tenant_id 参数，确保多租户隔离
 * - 开奖 = 随机抽取候选池 → 锁定奖品码 → 写入中奖记录 → 异步通知
 * - 不产生订单、不涉及支付、不扣余额
 *
 * 【状态机】
 *   draft → open → drawing → drawn
 *   drawing 失败必须回到 open（并写 failureReason），禁止永久卡死
 */
import { withDbTransaction, type DbType } from "../db/client";
import { and, eq, count, sql } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  prizes,
  prizeCodes,
  lotteryPrizeTiers,
  auditLogs,
} from "../db/schema";

/* ── 类型定义 ─────────────────────────────────────────────── */

export type DrawResult = {
  drawId: string;
  winnerCount: number;
  candidateCount: number;
};

/* ── 内部工具 ─────────────────────────────────────────────── */

/**
 * Fisher-Yates 洗牌后取前 n 名作为中奖者。
 * 使用 crypto.getRandomValues（CSPRNG），禁止 Math.random。
 */
export async function randomSelect<T>(candidates: T[], count: number): Promise<T[]> {
  const n = Math.min(count, candidates.length);
  if (n <= 0) return [];

  const result = [...candidates];
  for (let i = result.length - 1; i > 0; i--) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const j = random[0]! % (i + 1);
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }

  return result.slice(0, n);
}

/* ── 查询函数 ────────────────────────────────────────────── */

/**
 * 查询单个活动（带租户隔离）
 */
export async function getDraw(db: DbType, drawId: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  return row || null;
}

/**
 * 获取候选池总数
 */
export async function getDrawEntriesCount(db: DbType, drawId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, drawId));
  return Number(total);
}

/**
 * 获取中奖记录
 */
export async function getDrawWinners(db: DbType, drawId: string, tenantId: string) {
  return db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));
}

/* ── 活动管理 ────────────────────────────────────────────── */

/**
 * 创建抽奖活动。
 * 校验：时间合法性、参与人数上限合理性。
 */
export async function createDraw(
  db: DbType,
  tenantId: string,
  data: {
    title: string;
    description?: string;
    participationMode?: string;
    drawTrigger?: string;
    startAt: string;
    endAt: string;
    drawAt?: string;
    accessPassword?: string;
    maxParticipants?: number;
    winnerCount?: number;
    showParticipantCount?: number;
    showWinnerCount?: number;
    showWinnerList?: number;
  },
) {
  // 校验时间
  const start = new Date(data.startAt);
  const end = new Date(data.endAt);
  if (start >= end) throw new Error("参与开始时间必须早于结束时间");

  // 定时开奖必须设置 drawAt
  if (data.drawTrigger === "scheduled" && !data.drawAt) {
    throw new Error("定时开奖必须设置开奖时间");
  }

  // 校验 drawAt 在 endAt 之后
  if (data.drawAt) {
    const draw = new Date(data.drawAt);
    if (end >= draw) throw new Error("开奖时间必须在参与结束后");
  }

  if (!data.winnerCount || data.winnerCount < 1) {
    throw new Error("中奖名额至少为 1");
  }

  const id = crypto.randomUUID();
  const publicSlug = crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();

  await db.insert(lotteryDraws).values({
    id,
    tenantId,
    publicSlug,
    title: data.title,
    description: data.description || "",
    participationMode: data.participationMode || "open",
    drawTrigger: data.drawTrigger || "manual",
    startAt: data.startAt,
    endAt: data.endAt,
    drawAt: data.drawAt || null,
    accessPassword: data.accessPassword || "",
    maxParticipants: data.maxParticipants || null,
    winnerCount: data.winnerCount || 1,
    showParticipantCount: data.showParticipantCount ?? 1,
    showWinnerCount: data.showWinnerCount ?? 1,
    showWinnerList: data.showWinnerList ?? 0,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  return { id, publicSlug };
}

/**
 * 发布活动（draft → open）。
 * 发布前校验：活动配置完整性。
 */
export async function publishDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  if (draw.status !== "draft") throw new Error("只有草稿状态的活动才能发布");

  // 发布前校验
  if (!draw.title) throw new Error("活动标题不能为空");
  if (!draw.startAt || !draw.endAt) throw new Error("请设置活动时间");
  if (draw.drawTrigger === "scheduled" && !draw.drawAt) throw new Error("定时开奖必须设置开奖时间");

  const result = await db
    .update(lotteryDraws)
    .set({ status: "open", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "draft")));

  return (result.rowsAffected ?? 0) > 0;
}

/**
 * 暂停活动（open → paused）
 */
export async function pauseDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const result = await db
    .update(lotteryDraws)
    .set({ status: "paused", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * 恢复活动（paused → open）
 */
export async function resumeDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const result = await db
    .update(lotteryDraws)
    .set({ status: "open", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "paused")));
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * 取消活动（draft/open/paused → cancelled）
 */
export async function cancelDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  if (draw.status === "drawn" || draw.status === "drawing") {
    throw new Error("已开奖或开奖中的活动不可取消");
  }

  const result = await db
    .update(lotteryDraws)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

  return (result.rowsAffected ?? 0) > 0;
}

/* ── 候选池 ───────────────────────────────────────────────── */

/**
 * 加入候选池（公开模式）。
 * 校验参与模式、时间窗口、唯一性。
 */
export async function joinDraw(
  db: DbType,
  slug: string,
  identityValue: string,
  identityType: string = "email",
  options?: { accessPassword?: string; ipHash?: string },
) {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  if (draw.status !== "open") throw new Error("活动未开启");

  // 校验参与模式
  if (draw.participationMode === "password") {
    if (!options?.accessPassword) {
      return { joined: false, message: "请输入访问密码" };
    }
    if (options.accessPassword !== draw.accessPassword) {
      return { joined: false, message: "访问密码错误" };
    }
  }

  // 校验参与时间
  const now = new Date();
  if (now < new Date(draw.startAt) || now > new Date(draw.endAt)) {
    return { joined: false, message: "不在参与时间内" };
  }

  const normalizedValue = identityValue.trim().toLowerCase();
  const nowIso = now.toISOString();

  // 原子写入：利用 UNIQUE 约束防重
  await db.insert(lotteryEntries).values({
    id: crypto.randomUUID(),
    tenantId: draw.tenantId,
    drawId: draw.id,
    identityType,
    identityValue: normalizedValue,
    ipHash: options?.ipHash || "",
    joinedAt: nowIso,
  });

  return { joined: true };
}

/**
 * 获取候选池列表（分页）
 */
export async function getEntries(
  db: DbType,
  tenantId: string,
  drawId: string,
  limit: number = 100,
  offset: number = 0,
) {
  return db
    .select()
    .from(lotteryEntries)
    .where(and(eq(lotteryEntries.drawId, drawId), eq(lotteryEntries.tenantId, tenantId)))
    .limit(limit)
    .offset(offset)
    .orderBy(lotteryEntries.joinedAt);
}

/* ── 开奖核心 ─────────────────────────────────────────────── */

/**
 * 执行手动开奖。
 *
 * 流程：
 * 1. 原子夺取开奖权（open → drawing）
 * 2. 读取候选池，随机抽取
 * 3. 原子锁码：UPDATE prize_codes SET status='issued' WHERE status='available'
 * 4. 写入 winners
 * 5. 更新状态为 drawn
 * 6. 写审计日志
 */
export async function performDraw(
  db: DbType,
  tenantId: string,
  drawId: string,
  operatorUserId: string,
): Promise<DrawResult> {
  const now = new Date().toISOString();

  // 1. 原子夺取开奖权
  const claimResult = await db
    .update(lotteryDraws)
    .set({ status: "drawing", updatedAt: now })
    .where(and(
      eq(lotteryDraws.id, drawId),
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, "open"),
    ))
    .returning({ id: lotteryDraws.id });

  if (claimResult.length === 0) {
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);

    if (!draw) throw new Error("活动不存在");
    if (draw.status === "drawn") {
      return { drawId, winnerCount: 0, candidateCount: 0 };
    }
    throw new Error("开奖权已被其他进程夺取，请稍后重试");
  }

  try {
    // 2. 读取候选池
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId));

    const candidateCount = entries.length;
    if (candidateCount === 0) {
      throw new Error("候选池为空，无参与者");
    }

    // 获取活动配置
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    // 获取奖项配置
    const tiers = await db
      .select()
      .from(lotteryPrizeTiers)
      .where(eq(lotteryPrizeTiers.drawId, drawId))
      .orderBy(lotteryPrizeTiers.sortOrder);

    // 计算总中奖人数
    const totalWinners = tiers.length > 0
      ? tiers.reduce((sum, t) => sum + t.winnerCount, 0)
      : draw.winnerCount;

    // 随机抽取中奖者
    const selected = await randomSelect(entries, totalWinners);

    // 3-4. 事务内写入中奖记录
    let entryIndex = 0;
    await withDbTransaction(db, async (tx) => {

      // 如果没有配置多奖项，创建一个默认奖项
      const effectiveTiers = tiers.length > 0 ? tiers : [{
        id: crypto.randomUUID(),
        tenantId,
        drawId,
        prizeId: "",
        tierName: "中奖",
        winnerCount: draw.winnerCount,
        sortOrder: 100,
      }];

      for (const tier of effectiveTiers) {
        for (let i = 0; i < tier.winnerCount && entryIndex < selected.length; i++) {
          const entry = selected[entryIndex]!;
          entryIndex++;

          // 锁定奖品码（如果奖项配置了奖品）
          let prizeCodeId = "";
          if (tier.prizeId) {
            const [availableCode] = await tx
              .select()
              .from(prizeCodes)
              .where(and(
                eq(prizeCodes.prizeId, tier.prizeId),
                eq(prizeCodes.status, "available"),
                eq(prizeCodes.tenantId, tenantId),
              ))
              .limit(1);

            if (availableCode) {
              await tx
                .update(prizeCodes)
                .set({
                  status: "issued",
                  winnerId: entry.id,
                  issuedAt: now,
                })
                .where(and(eq(prizeCodes.id, availableCode.id), eq(prizeCodes.status, "available")));

              prizeCodeId = availableCode.id;
            }
          }

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
            notificationStatus: "pending",
          });
        }
      }
    });

    // 5. 更新活动状态为 drawn
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: now, updatedAt: now, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

    // 6. 写审计日志
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId: operatorUserId,
      action: "draw.perform",
      targetType: "lottery_draw",
      targetId: drawId,
      metadataJson: JSON.stringify({ winnerCount: entryIndex, candidateCount }),
      createdAt: now,
    });

    return { drawId, winnerCount: entryIndex, candidateCount };
  } catch (error) {
    // 开奖失败：恢复为 open 状态并记录失败原因
    const reason = error instanceof Error ? error.message.slice(0, 500) : "开奖失败（未知错误）";
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: reason, updatedAt: new Date().toISOString() })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    throw error;
  }
}

/* ── 奖品管理 ────────────────────────────────────────────── */

/**
 * 创建奖品
 */
export async function createPrize(
  db: DbType,
  tenantId: string,
  data: { name: string; description?: string; prizeType?: string },
) {
  const id = crypto.randomUUID();
  await db.insert(prizes).values({
    id,
    tenantId,
    name: data.name,
    description: data.description || "",
    prizeType: data.prizeType || "code",
  });
  return { id };
}

/**
 * 导入奖品码
 */
export async function importPrizeCodes(
  db: DbType,
  tenantId: string,
  prizeId: string,
  codes: Array<{ code: string; secret?: string }>,
) {
  const [prize] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!prize) throw new Error("奖品不存在");

  for (const item of codes) {
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(),
      tenantId,
      prizeId,
      code: item.code,
      secret: item.secret || "",
      status: "available",
    });
  }
}

/* ── 定时开奖兜底 ─────────────────────────────────────────── */

/**
 * 处理到期活动。
 * 每次最多处理 limit 个，避免单次 Worker CPU 超限。
 * Cron 调用时 operatorUserId 为 "system"。
 */
export async function processDueDraws(
  db: DbType,
  options?: { limit?: number },
): Promise<{ processed: number; failed: number; errors: Array<{ drawId: string; message: string }> }> {
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
  const now = new Date().toISOString();

  const due = await db
    .select()
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
      sql`${lotteryDraws.drawAt} <= ${now}`,
    ))
    .orderBy(lotteryDraws.drawAt)
    .limit(limit);

  let processed = 0;
  let failed = 0;
  const errors: Array<{ drawId: string; message: string }> = [];

  for (const draw of due) {
    try {
      await performDraw(db, draw.tenantId, draw.id, "system");
      processed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "未知错误";
      errors.push({ drawId: draw.id, message });
    }
  }

  return { processed, failed, errors };
}