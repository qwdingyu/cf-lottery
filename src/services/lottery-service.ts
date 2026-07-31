/**
 * 抽奖服务层 — draw / entries / winners 核心业务逻辑。
 *
 * 【定位：旁路运营能力，不得破坏交易内核】
 * - 中奖交付复用 orders + cards 原子发卡，但 orderSource 固定为 'lottery'。
 * - 主站限购 / 免费频控 / 余额支付频控 必须排除 lottery 订单（见 order-service）。
 * - 不触发支付、不扣余额、不写 referralCode、不走 tryGrantReferralReward。
 *
 * 【与 cf-shop 现有模式的约束】
 * - 邮件配置（resendApiKey/emailFrom）由路由层 readRuntimeConfig + mergeRuntimeConfig 后传入
 * - executionCtx 由路由层 c.get("executionCtx") 传入，供 waitUntil 异步发信
 * - 服务层不自行读 env、不 hack Context
 * - 订单字段约定对齐 redeem.ts（0 元 issued + fulfillCardInventory）
 * - 中奖邮件用 lottery_winner 模板，禁止 order_issued（订单文案）
 *
 * 【状态机】
 *   draft → open → drawing → drawn
 *   drawing 失败必须回到 open（并写 failureReason），禁止永久卡死
 */
import { withDbTransaction, type DbType } from "../db/client";
import { getProduct } from "./product-service";
import { fulfillCardInventory } from "./fulfillment-service";
import { createOrderNo, createOrderToken, hashOrderToken } from "../lib/token";
import { buildLotteryWinnerTemplateData, sendEmail } from "./email-service";
import { writeOrderEvent } from "./audit-service";
import { getAvailableStockMap } from "./stock-service";
import { minorToMajorString } from "../../shared/money";
import type { RuntimeConfig } from "../lib/runtime-config";
import { and, eq, count, desc, sql } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  lotteryWinners,
  orders,
  orderItems,
  cards,
  products,
} from "../db/schema";

/* ── 类型定义 ─────────────────────────────────────────────── */

/** 抽奖活动记录（对应 lottery_draws 表） */
export type LotteryDraw = {
  id: string;
  name: string;
  description: string;
  productId: string;
  startTime: string;
  endTime: string;
  drawTime: string;
  maxWinners: number;
  maxParticipants: number | null;
  expectedParticipants: number;
  visible: number;
  showWinners: number;
  limitPerEmail: number;
  status: string;
  drawnAt: string | null;
  failureReason: string;
  createdAt: string;
  updatedAt: string;
};

/** 候选池记录（对应 lottery_entries 表） */
export type LotteryEntry = {
  id: string;
  drawId: string;
  email: string;
  joinedAt: string;
};

/** 中奖记录（对应 lottery_winners 表） */
export type LotteryWinner = {
  id: string;
  drawId: string;
  email: string;
  orderId: string | null;
  orderToken: string;
  productId: string;
  quantity: number;
  drawnAt: string;
  isVoid: number;
  voidReason: string;
  emailSent: number;
  emailError: string;
  createdAt: string;
};

/** 单个中奖者的完整结果（含订单令牌和卡密明文） */
export type WinnerResult = {
  orderId: string;
  orderNo: string;
  orderToken: string;
  email: string;
  card: {
    accountLabel: string;
    deliverySecret: string;
    deliveryNote: string;
  };
};

/** 一次开奖的完整结果 */
export type DrawResult = {
  drawId: string;
  winners: WinnerResult[];
};

/** 加入候选池的结果 */
export type JoinResult = {
  drawId: string;
  joined: boolean;
  entryCount?: number;
};

export type LotteryDueDrawResult = {
  healed: number;
  processed: number;
  failed: number;
  emailRetried: number;
  emailFailed: number;
  errors: Array<{ drawId: string; message: string }>;
};

/**
 * 单个抽奖活动候选池硬上限。
 *
 * performDraw 当前需要读取候选池并做 Fisher-Yates 抽样；不允许无上限活动把 Workers 内存/CPU
 * 暴露给无限增长的候选池。运营未填写 maxParticipants 时也按此值兜底。
 */
export const LOTTERY_MAX_PARTICIPANTS_CAP = 50_000;

/* ── 内部工具 ─────────────────────────────────────────────── */

/**
 * Fisher-Yates 洗牌后取前 n 名作为中奖者。
 *
 * 【随机源】crypto.getRandomValues（Workers 可用的 CSPRNG），禁止 Math.random。
 * 【取模偏差】`uint32 % (i+1)` 在 i+1 不是 2 的幂时存在极轻微偏差；
 *   对「运营抽奖、候选池通常 < 万人」可接受。若未来要密码学公平抽签，
 *   应改为 rejection sampling（丢弃 > floor(2^32/(i+1))*(i+1) 的样本）。
 * 【为何每次循环单独取随机数】避免预分配数组在部分环境被复用/截断的隐患，逻辑更直观。
 */
async function randomSelect<T>(candidates: T[], count: number): Promise<T[]> {
  const n = Math.min(count, candidates.length);
  if (n <= 0) return [];

  const result = [...candidates];
  for (let i = result.length - 1; i > 0; i--) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    // 均匀区间上界；当前实现接受极小模偏差，见上方注释
    const j = random[0]! % (i + 1);
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }

  return result.slice(0, n);
}

/* ── 活动 CRUD ────────────────────────────────────────────── */

/**
 * 创建抽奖活动。
 *
 * 【前置校验】（任何一项不通过则抛出 Error，由路由层捕获并返回 400）
 * - 商品必须存在且已上架（getProduct 已过滤 active=1）
 * - 商品必须是卡密模式（fulfillment_mode='card'），非卡密商品无法发奖
 * - 商品必须有可用库存：maxWinners <= 可用库存数
 * - 时间必须合法：drawTime > endTime > startTime，否则用户无法在开奖前加入
 */
export async function createLotteryDraw(
  db: DbType,
  data: {
    id: string;
    name: string;
    description?: string;
    productId: string;
    startTime: string;
    endTime: string;
    drawTime: string;
    maxWinners: number;
    maxParticipants?: number | null;
    expectedParticipants?: number;
    visible?: number;
    showWinners?: number;
    limitPerEmail?: number;
  },
) {
  // 校验商品存在、已上架（getProduct 默认只返回 active=1 的商品）、是卡密模式
  const product = await getProduct(db, data.productId);
  if (!product) throw new Error("商品不存在");
  if (!product.active) throw new Error("商品已下架");
  if (product.fulfillmentMode !== "card") throw new Error("仅卡密商品支持抽奖");

  // 校验时间顺序：drawTime > endTime > startTime
  // 避免出现"开奖时间早于参与结束时间"导致用户无法加入的边界情况
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);
  const draw = new Date(data.drawTime);
  if (start >= end) throw new Error("参与开始时间必须早于结束时间");
  if (end >= draw) throw new Error("开奖时间必须在参与结束后");

  // 校验库存：maxWinners 不能超过当前可用库存
  // getAvailableStockMap 会计算已过期、已锁定、已发放的卡密，只返回真正可售的库存
  const stockMap = await getAvailableStockMap(db, [data.productId]);
  const availableStock = stockMap.get(data.productId) ?? 0;
  if (data.maxWinners > availableStock) {
    throw new Error(`库存不足：可用 ${availableStock} 张，要求 ${data.maxWinners} 张`);
  }

  // 当前候选池以 UNIQUE(draw_id, email) 强制「每邮箱 1 次」。
  // 若运营配置 >1，写入后不会真正生效，属于静默谎言——直接拒绝，避免后台展示与实际行为不一致。
  const limitPerEmail = data.limitPerEmail ?? 1;
  if (limitPerEmail !== 1) {
    throw new Error("当前版本每邮箱仅支持参与 1 次（limitPerEmail 必须为 1）");
  }
  if (data.maxWinners < 1) {
    throw new Error("中奖名额至少为 1");
  }
  if (data.maxParticipants !== undefined && data.maxParticipants !== null) {
    if (data.maxParticipants < 1 || data.maxParticipants > LOTTERY_MAX_PARTICIPANTS_CAP) {
      throw new Error(`参与人数上限必须在 1-${LOTTERY_MAX_PARTICIPANTS_CAP} 之间`);
    }
  }

  const id = data.id || crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(lotteryDraws).values({
    id,
    name: data.name,
    description: data.description || "",
    productId: data.productId,
    startTime: data.startTime,
    endTime: data.endTime,
    drawTime: data.drawTime,
    maxWinners: data.maxWinners,
    maxParticipants: data.maxParticipants ?? null,
    expectedParticipants: data.expectedParticipants ?? 0,
    visible: data.visible ?? 1,
    showWinners: data.showWinners ?? 1,
    limitPerEmail,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  return getDraw(db, id);
}

/** 根据 ID 查询单个抽奖活动 */
export async function getDraw(db: DbType, id: string): Promise<LotteryDraw | null> {
  const [draw] = await db.select().from(lotteryDraws).where(eq(lotteryDraws.id, id)).limit(1);
  return draw || null;
}

function publicEntryCount(draw: Pick<LotteryDraw, "showWinners">, entryCount: number): number | undefined {
  return Number(draw.showWinners ?? 1) === 1 ? entryCount : undefined;
}

function hidePrivatePublicStats<T extends {
  showWinners: number;
  maxWinners: number;
  entryCount: number;
  winnerCount: number;
}>(payload: T): Omit<T, "maxWinners" | "entryCount" | "winnerCount"> & {
  maxWinners?: number;
  entryCount?: number;
  winnerCount?: number;
} {
  if (Number(payload.showWinners ?? 1) === 1) return payload;
  const { maxWinners: _maxWinners, entryCount: _entryCount, winnerCount: _winnerCount, ...privatePayload } = payload;
  return privatePayload;
}

/**
 * 获取公开的活动列表（含参与人数统计）。
 * 只返回 open、drawn、drawing 状态的活动，draft 和 cancelled 不对外展示。
 * 按开奖时间升序排列，即将开奖的排在前面。
 */
export async function listPublicDraws(
  db: DbType,
): Promise<Array<Omit<LotteryDraw, "maxWinners"> & {
  maxWinners?: number;
  entryCount?: number;
  winnerCount?: number;
  productTitle: string | null;
}>> {
  // 与 listAdminDraws 一样联表 products.title，供用户端展示奖品名（只读，不扩权限面）
  const rows = await db
    .select({
      draw: lotteryDraws,
      entryCount: sql<number>`(select count(*) from ${lotteryEntries} where ${lotteryEntries.drawId} = ${lotteryDraws.id})`,
      winnerCount: sql<number>`(select count(*) from ${lotteryWinners} where ${lotteryWinners.drawId} = ${lotteryDraws.id})`,
      productTitle: products.title,
    })
    .from(lotteryDraws)
    .leftJoin(products, eq(products.id, lotteryDraws.productId))
    .where(
      sql`${lotteryDraws.status} IN ('open', 'drawn', 'drawing') AND ${lotteryDraws.visible} = 1`,
    )
    .orderBy(lotteryDraws.drawTime);

  return rows.map((r) => {
    const payload = {
      ...r.draw,
      entryCount: Number(r.entryCount),
      winnerCount: Number(r.winnerCount),
      productTitle: r.productTitle ?? null,
    };
    return hidePrivatePublicStats(payload);
  });
}

/**
 * 管理端获取全部活动列表（含草稿和已取消）。
 * 附带 entryCount（候选池人数）与 productTitle（奖品名），与优惠券/卡密列表的 relation-cell 展示一致。
 */
export async function listAdminDraws(
  db: DbType,
): Promise<Array<LotteryDraw & { entryCount: number; productTitle: string | null; winnerCount: number }>> {
  const rows = await db
    .select({
      draw: lotteryDraws,
      entryCount: sql<number>`(select count(*) from ${lotteryEntries} where ${lotteryEntries.drawId} = ${lotteryDraws.id})`,
      winnerCount: sql<number>`(select count(*) from ${lotteryWinners} where ${lotteryWinners.drawId} = ${lotteryDraws.id})`,
      productTitle: products.title,
    })
    .from(lotteryDraws)
    .leftJoin(products, eq(products.id, lotteryDraws.productId))
    .orderBy(desc(lotteryDraws.createdAt));

  return rows.map((r) => ({
    ...r.draw,
    entryCount: Number(r.entryCount),
    winnerCount: Number(r.winnerCount),
    productTitle: r.productTitle ?? null,
  }));
}

/**
 * 开启活动（draft → open）。
 * 幂等操作：只有 draft 状态可以被开启，其他状态直接返回当前记录。
 * 使用 WHERE status='draft' 条件确保并发安全。
 */
export async function openDraw(db: DbType, id: string): Promise<LotteryDraw | null> {
  const existing = await getDraw(db, id);
  if (!existing || existing.status !== "draft") return existing;
  const now = new Date().toISOString();
  await db
    .update(lotteryDraws)
    .set({ status: "open", updatedAt: now })
    .where(and(eq(lotteryDraws.id, id), eq(lotteryDraws.status, "draft")));
  return getDraw(db, id);
}

/**
 * 取消活动（draft/open → cancelled）。
 * 已开奖（drawn/drawing）的活动不可取消——中奖订单已生成，取消会导致订单悬空。
 */
export async function cancelDraw(db: DbType, id: string): Promise<LotteryDraw | null> {
  const existing = await getDraw(db, id);
  if (!existing) throw new Error("活动不存在");
  if (existing.status !== "draft" && existing.status !== "open" && existing.status !== "paused") {
    throw new Error(`当前状态不可取消（${existing.status}）`);
  }
  const now = new Date().toISOString();
  await db
    .update(lotteryDraws)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(lotteryDraws.id, id), eq(lotteryDraws.status, existing.status)));
  return getDraw(db, id);
}

/* ── 候选池 ───────────────────────────────────────────────── */

/**
 * 加入候选池。
 *
 * 【前置条件】
 * 调用方已通过 JWT 验证用户身份，email 从 JWT 中提取，路由层负责 JWT 鉴权。
 *
 * 【防重机制】
 * - 数据库层：UNIQUE(drawId, email) 唯一约束兜底
 * - 应用层：onConflictDoNothing 静默忽略重复插入
 * - 重复加入时返回 joined=true（与首次加入一致，不暴露"已存在"的细节）
 */
export async function joinDraw(db: DbType, drawId: string, email: string): Promise<JoinResult> {
  // 邮箱归一化：抽奖候选池目前只做 trim+lower，与 JWT / OTP subject 对齐。
  // 注意：这里不使用 Gmail 点号/加号 canonical 折叠——参与名单要与用户验证邮箱字面一致，
  // 避免「不同写法被合并」导致运营对账困难；限购核心链路仍用 canonical。
  const normalizedEmail = email.trim().toLowerCase();

  return withDbTransaction(db, async (tx) => {
    const draw = await getDraw(tx as DbType, drawId);
    if (!draw) throw new Error("活动不存在");
    if (draw.status !== "open") throw new Error("活动未开启");

    // 检查是否在参与时间窗口内，防止提前加入或过期加入。
    // 此检查与插入放在同一短事务，避免活动被并发暂停/取消后仍落候选池。
    const now = new Date();
    if (now < new Date(draw.startTime) || now > new Date(draw.endTime)) {
      throw new Error("不在参与时间内");
    }

    // 应用层先查再插：配合 UNIQUE(draw_id, email) 双保险。
    // 已参与者优先返回幂等成功，即使活动已满也不应把重复点击误报为失败。
    const existing = await tx
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.drawId, drawId),
        eq(lotteryEntries.email, normalizedEmail),
      ))
      .limit(1);
    if (existing.length > 0) {
      const [{ total }] = await tx
        .select({ total: count() })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.drawId, drawId));
      return {
        drawId,
        joined: true,
        ...(publicEntryCount(draw, Number(total)) === undefined ? {} : { entryCount: Number(total) }),
      };
    }

    // maxParticipants 是全局名额，不是每邮箱限额；必须用单条条件 INSERT 表达“名额未满才插入”。
    // 不能先 count 再 insert：独立连接并发争抢最后一个名额时，两个请求可能同时读到 N-1 后都插入。
    // 这里使用 INSERT ... SELECT ... WHERE，把容量检查、重复邮箱检查和写入合并到数据库单语句；
    // UNIQUE(draw_id,email) 继续兜底重复点击/重放。未显式配置上限也使用硬上限，避免候选池无限增长拖垮开奖抽样。
    const effectiveMaxParticipants = draw.maxParticipants ?? LOTTERY_MAX_PARTICIPANTS_CAP;
    const insertResult = await tx.run(sql`
      INSERT INTO lottery_entries (id, draw_id, email, joined_at)
      SELECT ${crypto.randomUUID()}, ${drawId}, ${normalizedEmail}, ${now.toISOString()}
      WHERE (SELECT COUNT(*) FROM lottery_entries WHERE draw_id = ${drawId}) < ${effectiveMaxParticipants}
        AND NOT EXISTS (
          SELECT 1 FROM lottery_entries WHERE draw_id = ${drawId} AND email = ${normalizedEmail}
        )
      ON CONFLICT(draw_id, email) DO NOTHING
    `);
    if ((insertResult.rowsAffected ?? 0) === 0) {
      const repeat = await tx
        .select({ id: lotteryEntries.id })
        .from(lotteryEntries)
        .where(and(
          eq(lotteryEntries.drawId, drawId),
          eq(lotteryEntries.email, normalizedEmail),
        ))
        .limit(1);
      if (repeat.length === 0) throw new Error("参与人数已达上限");
    }

    const [{ total }] = await tx
      .select({ total: count() })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId));

    return {
      drawId,
      joined: true,
      ...(publicEntryCount(draw, Number(total)) === undefined ? {} : { entryCount: Number(total) }),
    };
  });
}

/** 获取指定活动的候选池列表 */
export async function getDrawEntries(db: DbType, drawId: string): Promise<LotteryEntry[]> {
  return db.select().from(lotteryEntries).where(eq(lotteryEntries.drawId, drawId));
}

/** 获取指定活动的候选池总人数 */
export async function getDrawEntriesCount(db: DbType, drawId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, drawId));
  return Number(total);
}

/* ── drawing 半状态治愈 ───────────────────────────────────── */

/**
 * drawing 卡死判定窗口。
 *
 * 同步开奖路径（claim → 事务发卡 → drawn）在 Workers 上通常为秒级；
 * 若进程在 claim 之后、restore/drawn 之前被强杀，会留下 status=drawing。
 * 窗口过短可能误抢仍在执行的请求（双开奖灾难）；过长则运营长时间无法自愈。
 * 10 分钟远高于正常开奖耗时，又明显短于「永远卡死」。
 */
export const LOTTERY_DRAWING_STALE_MS = 10 * 60 * 1000;

async function countWinnersForDraw(db: DbType, drawId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));
  return Number(row?.total ?? 0);
}

export type HealDrawingResult = "drawn" | "open" | null;

/**
 * 治愈 status=drawing 的半状态（不新增状态机分支）。
 *
 * 安全约束（防双开奖）：
 * - 已有中奖行 → 只把活动标为 drawn（补齐状态，不再抽、不再发卡）
 * - 无中奖行且（超时 | force）→ 原子 drawing→open，允许重试
 * - 无中奖且未超时且非 force → 返回 null（视为仍有存活开奖在跑）
 * - 所有写库都带 WHERE status='drawing'，与并发完成/恢复互斥
 *
 * @param force 仅管理端人工「解除卡死」：无视超时，但仍要求无中奖行才回 open
 */
export async function healDrawingState(
  db: DbType,
  drawId: string,
  options?: { force?: boolean; nowMs?: number; staleMs?: number },
): Promise<HealDrawingResult> {
  const force = options?.force === true;
  const nowMs = options?.nowMs ?? Date.now();
  const staleMs = options?.staleMs ?? LOTTERY_DRAWING_STALE_MS;

  const draw = await getDraw(db, drawId);
  if (!draw || draw.status !== "drawing") return null;

  const winnerCount = await countWinnersForDraw(db, drawId);
  const nowIso = new Date(nowMs).toISOString();

  if (winnerCount > 0) {
    // 中奖已落库但状态未 drawn：只补状态，绝不二次抽取
    await db
      .update(lotteryDraws)
      .set({
        status: "drawn",
        drawnAt: draw.drawnAt || nowIso,
        updatedAt: nowIso,
        failureReason: "",
      })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    const after = await getDraw(db, drawId);
    return after?.status === "drawn" ? "drawn" : null;
  }

  const updatedAtMs = Date.parse(draw.updatedAt || "");
  const ageMs = Number.isFinite(updatedAtMs) ? nowMs - updatedAtMs : Number.POSITIVE_INFINITY;
  if (!force && ageMs < staleMs) {
    return null;
  }

  const reason = force
    ? "管理员解除 drawing 卡死，恢复为可开奖"
    : `drawing 超过 ${Math.round(staleMs / 60000)} 分钟未完成，自动恢复为 open`;

  const restored = await db
    .update(lotteryDraws)
    .set({
      status: "open",
      failureReason: reason.slice(0, 500),
      updatedAt: nowIso,
    })
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")))
    .returning({ id: lotteryDraws.id });

  if (restored.length > 0) return "open";

  // 并发下可能已被标 drawn / 再次 open
  const again = await getDraw(db, drawId);
  if (again?.status === "drawn") return "drawn";
  if (again?.status === "open") return "open";
  return null;
}

/** 批量治愈超时 drawing（定时兜底开奖前调用；不 force） */
export async function healStaleDrawings(db: DbType, options?: { nowMs?: number; staleMs?: number }): Promise<number> {
  const rows = await db
    .select({ id: lotteryDraws.id })
    .from(lotteryDraws)
    .where(eq(lotteryDraws.status, "drawing"));

  let healed = 0;
  for (const row of rows) {
    const result = await healDrawingState(db, row.id, options);
    if (result === "open" || result === "drawn") healed += 1;
  }
  return healed;
}

/**
 * 定时兜底开奖：修复超时 drawing 后，按 draw_time 顺序处理已到期 open 活动。
 *
 * 设计约束：
 * - 不在内存中过滤全量活动，只用 status/draw_time 谓词查到期活动。
 * - 每轮限制数量，避免一次 Cron 因积压活动过多耗尽 Worker CPU。
 * - 并发安全继续交给 performDraw 的原子 open→drawing claim，不引入额外锁。
 */
export async function processDueLotteryDraws(
  db: DbType,
  emailEnv: RuntimeConfig,
  executionCtx?: ExecutionContext,
  options?: { now?: string; limit?: number },
): Promise<LotteryDueDrawResult> {
  const now = options?.now ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(50, Math.floor(options?.limit ?? 20)));
  const healed = await healStaleDrawings(db);
  const due = await db
    .select({ id: lotteryDraws.id })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      sql`${lotteryDraws.drawTime} <= ${now}`,
    ))
    .orderBy(lotteryDraws.drawTime)
    .limit(limit);

  let processed = 0;
  let failed = 0;
  let emailRetried = 0;
  let emailFailed = 0;
  const errors: Array<{ drawId: string; message: string }> = [];
  for (const draw of due) {
    try {
      await performDraw(db, draw.id, emailEnv, executionCtx, "system");
      processed++;
    } catch (err) {
      failed++;
      const message = summarizeLotteryFailure(err);
      errors.push({ drawId: draw.id, message });
      console.error(`[lottery] due draw failed for ${draw.id}:`, message);
    }
  }

  // 邮件兜底：系统开奖使用 waitUntil 异步发信，极端情况下 Worker 被回收或发信任务异常，
  // lottery_winners 可能停在 email_sent=0 且 email_error 为空/发送中。Cron 每轮有界补偿，
  // 只处理“未形成明确失败原因”的 drawn 活动，避免对已知 4xx 配置错误每 5 分钟重复打扰 provider。
  const pendingEmailDraws = await db
    .select({ id: lotteryDraws.id })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "drawn"),
      sql`EXISTS (
        SELECT 1 FROM ${lotteryWinners}
        WHERE ${lotteryWinners.drawId} = ${lotteryDraws.id}
          AND ${lotteryWinners.emailSent} = 0
          AND (${lotteryWinners.emailError} = '' OR ${lotteryWinners.emailError} = '邮件发送中')
      )`,
    ))
    .orderBy(lotteryDraws.drawTime)
    .limit(limit);

  for (const draw of pendingEmailDraws) {
    try {
      const retry = await retrySendEmail(db, draw.id, emailEnv, executionCtx);
      emailRetried += retry.sent;
      emailFailed += retry.failed;
      for (const message of retry.errors) errors.push({ drawId: draw.id, message });
    } catch (err) {
      emailFailed++;
      const message = summarizeLotteryFailure(err);
      errors.push({ drawId: draw.id, message });
      console.error(`[lottery] pending winner email retry failed for ${draw.id}:`, message);
    }
  }

  return { healed, processed, failed, emailRetried, emailFailed, errors };
}

async function loadDrawnResult(db: DbType, drawId: string): Promise<DrawResult> {
  const existingWinners = await db
    .select()
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));
  return {
    drawId,
    winners: existingWinners.map((w) => ({
      orderId: w.orderId || "",
      orderNo: "",
      orderToken: "",
      email: w.email,
      card: { accountLabel: "", deliverySecret: "", deliveryNote: "" },
    })),
  };
}

/* ── 开奖核心 ─────────────────────────────────────────────── */

/**
 * 将 libSQL/Drizzle 的冗长 Failed query 收敛成可展示、可诊断的短文案。
 * 完整 SQL 不得写入 failure_reason：会撑爆 admin 列表名称列，且对运营无帮助。
 *
 * 注意：Drizzle 常把真实 SQLite 原因放在 Error.cause，message 只剩
 * `Failed query: insert into "lottery_winners" (...order_id...)`。
 * 绝不能仅凭 SQL 文本里出现 order_id 就判定外键——那会把「缺列」误诊成 FK。
 */
export function summarizeLotteryFailure(reason: unknown): string {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (value instanceof Error) {
      if (value.message) parts.push(value.message);
      if (value.cause) push(value.cause);
      return;
    }
    if (value && typeof value === "object" && "message" in value) {
      const msg = (value as { message?: unknown }).message;
      if (typeof msg === "string" && msg) parts.push(msg);
      return;
    }
    if (typeof value === "string" && value) parts.push(value);
  };
  push(reason);

  const message = parts.join(" | ").replace(/\s+/g, " ").trim();
  if (!message) return "开奖失败（未知错误）";

  const lower = message.toLowerCase();

  // 缺列：生产曾因旧 0022 无 order_token/email_sent/email_error 而失败（见 0026）
  const noColumn = message.match(/no column named\s+["`]?(\w+)/i);
  if (noColumn || lower.includes("has no column")) {
    const col = noColumn?.[1] || "unknown";
    return `开奖失败：数据表缺列 ${col}，请执行数据库迁移后重试`.slice(0, 500);
  }

  // 真正的外键错误（SQLite/libSQL 会带 foreign key / CONSTRAINT 字样）
  if (
    lower.includes("foreign key") ||
    (lower.includes("constraint failed") && lower.includes("foreign"))
  ) {
    return "开奖失败：中奖订单外键约束，请重试".slice(0, 500);
  }
  if (lower.includes("unique") && lower.includes("lottery_winners")) {
    return "开奖失败：中奖记录已存在（可能重复开奖，请先查看中奖名单）".slice(0, 500);
  }
  if (message.includes("卡密库存不足")) {
    return message.slice(0, 500);
  }
  if (message.includes("Failed query:")) {
    const tableMatch = message.match(/into\s+"([^"]+)"/i);
    const table = tableMatch?.[1] || "unknown";
    return `开奖失败：写入 ${table} 被数据库拒绝`.slice(0, 500);
  }
  return message.slice(0, 500);
}

/**
 * 执行开奖：原子状态夺取 → 随机抽取 → 事务内创建订单+发卡 → 失败恢复 → 异步发邮件。
 *
 * 【并发防护】
 * 1. 原子 UPDATE status='drawing' WHERE status='open' 确保同一时刻只有一个开奖进程
 * 2. 夺取失败时：
 *    - drawn：幂等返回已有中奖结果
 *    - drawing：先 healDrawingState（超时无中奖 → open；有中奖 → drawn）；治愈为 open 后允许再抢一次
 *    - 仍为 drawing（未超时）：抛出「正在开奖中」，绝不强行双开
 * 3. 事务内 drawn 必须 returning 校验；行数为 0 则整单回滚（开奖权已丢失，防超发）
 * 4. 业务失败 restoreOpenAfterFailure：drawing→open + failureReason
 *
 * 【订单字段约定（与 redeem.ts 旁路交付一致）】
 * - 不填写 storefrontSlugSnapshot/storefrontNameSnapshot（抽奖订单无店铺归属）
 * - paymentProvider 固定为 'lottery'（非支付通道；排除 external payment_ref 唯一索引与余额/免费结算）
 * - 不填写 deliveryJson/fulfillmentInputJson（无自定义交付/输入）
 * - amountCents=0、status=issued、orderSource=lottery；referralCode/campaignCode 置空，不触发返佣
 */
export async function performDraw(
  db: DbType,
  drawId: string,
  emailEnv: RuntimeConfig,
  executionCtx?: ExecutionContext,
  operator = "system",
): Promise<DrawResult> {
  const nowStr = new Date().toISOString();

  // ── 第一步：原子夺取开奖权（最多 2 次：一次治愈超时 drawing 后重试）──
  let claimed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimResult = await db
      .update(lotteryDraws)
      .set({ status: "drawing", updatedAt: nowStr })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "open")))
      .returning({ id: lotteryDraws.id, status: lotteryDraws.status });

    if (claimResult.length > 0) {
      claimed = true;
      break;
    }

    const draw = await getDraw(db, drawId);
    if (!draw) throw new Error("活动不存在");
    if (draw.status === "drawn") {
      return loadDrawnResult(db, drawId);
    }
    if (draw.status === "drawing") {
      const healed = await healDrawingState(db, drawId);
      if (healed === "drawn") {
        return loadDrawnResult(db, drawId);
      }
      if (healed === "open" && attempt === 0) {
        // 已恢复为 open，循环再抢一次；仍失败则走下方统一错误
        continue;
      }
      throw new Error("活动正在开奖中，请稍后查看结果");
    }
    throw new Error(`当前状态不可开奖（${draw.status}）`);
  }
  if (!claimed) {
    throw new Error("活动正在开奖中，请稍后查看结果");
  }

  // ── 失败恢复函数 ──
  // 开奖过程中任何异常都会触发此函数，将状态恢复为 open 并记录失败原因
  const restoreOpenAfterFailure = async (reason: unknown) => {
    await db
      .update(lotteryDraws)
      .set({
        status: "open",
        failureReason: summarizeLotteryFailure(reason),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
  };

  // ── 第二步：验证活动仍然有效 ──
  const draw = await getDraw(db, drawId);
  if (!draw) {
    await restoreOpenAfterFailure("活动不存在");
    throw new Error("活动不存在");
  }

  // ── 第三步：检查候选池是否为空 ──
  // 候选池为空时直接标记为 drawn，不创建订单
  const entries = await getDrawEntries(db, drawId);
  if (entries.length === 0) {
    const finalized = await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: nowStr, updatedAt: nowStr })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")))
      .returning({ id: lotteryDraws.id });
    if (finalized.length === 0) {
      throw new Error("开奖权已失效，已回滚（未超发）");
    }
    return { drawId, winners: [] };
  }

  // ── 第四步：验证奖品商品 ──
  const product = await getProduct(db, draw.productId);
  if (!product) {
    await restoreOpenAfterFailure("奖品商品不存在");
    throw new Error("奖品商品不存在");
  }

  // ── 第五步：随机抽取中奖者 ──
  // 从候选池中随机抽取 maxWinners 个，使用密码学安全的 Fisher-Yates 算法
  const winners = await randomSelect(entries, draw.maxWinners);

  // ── 第六步：事务内创建订单和发卡 ──
  // 事务内完成：订单 → 明细 → 原子发卡 → 中奖记录 → status=drawn
  // 【FK 顺序】lottery_winners.order_id → orders.id；必须先落订单再写中奖行。
  // 线上曾「先 winner 后 order」在 foreign_keys=ON 时直接 SQLITE_CONSTRAINT_FOREIGNKEY，
  // 整单回滚，failureReason 被刷成整段 Failed query SQL，列表名称列被撑爆。
  // 【关键一致性】中奖记录 + 订单 + 发卡 + 活动 status=drawn 必须在同一事务。
  // 若 drawn 写在事务外：事务成功后进程崩溃 → 卡已发、中奖已落库，但活动仍 drawing/open，
  // 定时任务可能再次开奖，造成超发。drawn 进事务后，失败统一回滚并由 restoreOpenAfterFailure 恢复。
  let drawResults: WinnerResult[];
  try {
    drawResults = await withDbTransaction(db, async (tx) => {
      const results: WinnerResult[] = [];

      for (const winner of winners) {
        const orderId = crypto.randomUUID();
        const orderNo = createOrderNo();
        const orderToken = createOrderToken();
        const orderTokenHash = await hashOrderToken(orderToken);
        const now = new Date().toISOString();

        // 1. 中奖订单：orderSource='lottery'，0 元，直接 issued。
        //    不走支付/余额/返佣；paymentMethod 标记为 lottery，便于后台订单表和筛选直观看到“抽奖”。
        //    抽奖奖品可能是未发布到 /shop 的 active 商品，因此这里绝不能复用 storefront 下单校验。
        //    限购/免费频控已在 order-service 显式排除 lottery，避免污染主交易。
        //    必须先于 lottery_winners 插入，满足 order_id 外键。
        await tx.insert(orders).values({
          id: orderId,
          orderNo,
          productId: product.id,
          orderSource: "lottery",
          storefrontId: null,
          buyerContact: "",
          buyerEmail: winner.email,
          quantity: 1,
          amountCents: 0,
          discountCents: product.priceCents,
          currency: product.currency,
          status: "issued",
          fulfillmentMode: "card",
          paymentMethod: "lottery",
          paymentRef: "",
          paymentProvider: "lottery",
          issueMode: product.issueMode,
          orderTokenHash,
          campaignCode: "",
          referralCode: "",
          couponCode: "",
          ipHash: "",
          clientIp: "",
          userAgent: "",
          createdAt: now,
          paidAt: now,
          issuedAt: now,
          issuedCardId: "",
          deliveryVisibility: product.deliveryVisibility,
        });

        // 2. 订单明细：金额字段与主单一致，便于 admin 订单明细页展示
        await tx.insert(orderItems).values({
          id: crypto.randomUUID(),
          orderId,
          productId: product.id,
          productTitle: product.title,
          fulfillmentMode: "card",
          quantity: 1,
          unitPriceCents: product.priceCents,
          discountCents: product.priceCents,
          amountCents: 0,
          deliveryJson: "",
          createdAt: now,
        });

        // 3. 原子发卡：复用主链路 fulfillCardInventory（UPDATE ... RETURNING），与兑换码同路径
        const fulfillment = await fulfillCardInventory(tx, orderId, product.id, winner.email, "");
        if (!fulfillment?.card) throw new Error(`卡密库存不足: ${product.id}`);
        const issuedCard = fulfillment.card;

        // 4. 回填 issuedCardId，供查询/邮件/admin 中奖列表 JOIN
        await tx.update(orders)
          .set({ issuedCardId: issuedCard.id })
          .where(eq(orders.id, orderId));

        // 5. 中奖记录（UNIQUE(drawId, email) 防同一邮箱重复中奖；order 已存在，FK 可过）
        await tx.insert(lotteryWinners).values({
          id: crypto.randomUUID(),
          drawId,
          email: winner.email,
          orderId,
          orderToken,
          productId: product.id,
          quantity: 1,
          drawnAt: now,
          isVoid: 0,
          voidReason: "",
          createdAt: now,
        });

        results.push({
          orderId,
          orderNo,
          orderToken,
          email: winner.email,
          card: {
            accountLabel: issuedCard.accountLabel,
            deliverySecret: issuedCard.deliverySecret,
            deliveryNote: issuedCard.deliveryNote || "",
          },
        });
      }

      // 6. 同一事务内标记 drawn，杜绝「已发卡但活动未 drawn」的半状态。
      //    必须 returning：若开奖权已被治愈/抢走（status 不再是 drawing），整单回滚，防止超发。
      const finalized = await tx
        .update(lotteryDraws)
        .set({ status: "drawn", drawnAt: nowStr, updatedAt: nowStr, failureReason: "" })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")))
        .returning({ id: lotteryDraws.id });
      if (finalized.length === 0) {
        throw new Error("开奖权已失效，已回滚（未超发）");
      }

      return results;
    });
  } catch (err) {
    // 事务失败（含库存不足）：恢复 open，允许定时任务/管理员重试
    await restoreOpenAfterFailure(err);
    throw err;
  }

  // ── 第八步：写订单事件（审计追溯） ──
  // 记录"抽奖活动中奖"事件，操作人区分 system 和 admin
  for (const result of drawResults) {
    await writeOrderEvent(db, result.orderId, "lottery_drawn", `抽奖活动中奖，操作人: ${operator}`);
  }

  // ── 第九步：发送中奖邮件 ──
  // 管理员手动开奖需要等邮件发送态写回后再返回，避免后台中奖名单长期停在「待发送」。
  // 系统定时开奖继续使用 waitUntil，避免定时任务被邮件 provider 延迟拖长。
  // 必须使用 lottery_winner 模板：语义是「活动中奖」，禁止复用 order_issued（订单已完成）。
  if (!emailEnv.resendApiKey && drawResults.length > 0) {
    await db
      .update(lotteryWinners)
      .set({ emailSent: 0, emailError: "邮件服务未配置" })
      .where(eq(lotteryWinners.drawId, drawId));
  } else if (emailEnv.resendApiKey) {
    const emailTasks: Promise<void>[] = [];
    await db
      .update(lotteryWinners)
      .set({ emailSent: 0, emailError: "邮件发送中" })
      .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.emailSent, 0)));
    for (const result of drawResults) {
      // 通过 lotteryWinners → orders → cards 链式 JOIN 查询实际卡密信息
      // 不能使用事务内的 issuedCard 对象（事务已提交，该对象在事务外不可用）
      const [cardRow] = await db
        .select({
          accountLabel: cards.accountLabel,
          deliverySecret: cards.deliverySecret,
          deliveryNote: cards.deliveryNote,
        })
        .from(lotteryWinners)
        .innerJoin(orders, eq(orders.id, lotteryWinners.orderId))
        .innerJoin(cards, eq(cards.id, orders.issuedCardId!))
        .where(and(
          eq(lotteryWinners.drawId, drawId),
          eq(lotteryWinners.email, result.email),
        ))
        .limit(1);

      const emailPromise = sendEmail(db, emailEnv, {
        to: result.email,
        template: "lottery_winner",
        templateData: buildLotteryWinnerTemplateData({
          drawName: draw.name,
          productName: product.title || product.id,
          prizeValue: product.priceCents > 0 ? minorToMajorString(product.priceCents, product.currency) : "",
          orderNo: result.orderNo,
          accountLabel: String((cardRow as any)?.accountLabel ?? ""),
          deliverySecret: String((cardRow as any)?.deliverySecret ?? ""),
          deliveryNote: String((cardRow as any)?.deliveryNote ?? ""),
        }),
        orderId: result.orderId,
      }).then(async (emailResult) => {
        // 更新邮件发送状态到 lottery_winners，便于后续重试
        await db
          .update(lotteryWinners)
          .set({
            emailSent: emailResult.ok ? 1 : 0,
            emailError: emailResult.ok ? "" : (emailResult.message || "").slice(0, 500),
          })
          .where(and(
            eq(lotteryWinners.drawId, drawId),
            eq(lotteryWinners.email, result.email),
          ));
        if (!emailResult.ok) {
          console.warn(`[lottery] 邮件发送失败 ${result.email}:`, emailResult.message);
        }
      }).catch(async (err) => {
        const msg = (err as Error)?.message || "unknown";
        await db
          .update(lotteryWinners)
          .set({ emailSent: 0, emailError: msg.slice(0, 500) })
          .where(and(
            eq(lotteryWinners.drawId, drawId),
            eq(lotteryWinners.email, result.email),
          ));
        console.warn(`[lottery] 邮件发送异常 ${result.email}:`, msg);
      });

      emailTasks.push(emailPromise);
    }
    const emailBatch = Promise.all(emailTasks).then(() => undefined);
    if (operator === "admin") {
      await emailBatch;
    } else if (executionCtx) {
      executionCtx.waitUntil(emailBatch);
    } else {
      emailBatch.catch((e) => console.warn("[lottery] 异步邮件发送失败:", e));
    }
  }

  return { drawId, winners: drawResults };
}

/**
 * 重试发送中奖邮件（仅对 email_sent=0 的 winner）。
 * 用于管理端的"重发邮件"按钮或定时任务。
 */
export async function retrySendEmail(
  db: DbType,
  drawId: string,
  emailEnv: RuntimeConfig,
  executionCtx?: ExecutionContext,
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const draw = await getDraw(db, drawId);
  if (!draw) throw new Error("活动不存在");
  if (draw.status !== "drawn") throw new Error("活动尚未开奖");

  // 查询所有未发送邮件的 winner
  const pending = await db
    .select()
    .from(lotteryWinners)
    .where(and(
      eq(lotteryWinners.drawId, drawId),
      eq(lotteryWinners.emailSent, 0),
    ));

  if (pending.length === 0) {
    return { sent: 0, failed: 0, errors: [] };
  }

  const product = await getProduct(db, draw.productId);
  const productName = product?.title || draw.productId;

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  // 串行发送：计数器 sent/failed 必须在 await 之后累加。
  // 若全部 fire-and-forget 丢给 waitUntil，函数会在计数仍为 0 时返回，管理端会误判「无需重试」。
  for (const winner of pending) {
    const [row] = await db
      .select({
        accountLabel: cards.accountLabel,
        deliverySecret: cards.deliverySecret,
        deliveryNote: cards.deliveryNote,
        orderNo: orders.orderNo,
      })
      .from(lotteryWinners)
      .innerJoin(orders, eq(orders.id, lotteryWinners.orderId!))
      .innerJoin(cards, eq(cards.id, orders.issuedCardId!))
      .where(and(
        eq(lotteryWinners.drawId, drawId),
        eq(lotteryWinners.email, winner.email),
      ))
      .limit(1);

    try {
      const result = await sendEmail(db, emailEnv, {
        to: winner.email,
        template: "lottery_winner",
        templateData: buildLotteryWinnerTemplateData({
          drawName: draw.name,
          productName,
          orderNo: String(row?.orderNo ?? ""),
          accountLabel: String(row?.accountLabel ?? ""),
          deliverySecret: String(row?.deliverySecret ?? ""),
          deliveryNote: String(row?.deliveryNote ?? ""),
        }),
        orderId: winner.orderId || undefined,
      });
      await db
        .update(lotteryWinners)
        .set({
          emailSent: result.ok ? 1 : 0,
          emailError: result.ok ? "" : (result.message || "").slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.id));
      if (result.ok) {
        sent++;
      } else {
        failed++;
        errors.push(`${winner.email}: ${result.message}`);
      }
    } catch (err) {
      const msg = (err as Error)?.message || "unknown";
      await db
        .update(lotteryWinners)
        .set({ emailSent: 0, emailError: msg.slice(0, 500) })
        .where(eq(lotteryWinners.id, winner.id));
      failed++;
      errors.push(`${winner.email}: ${msg}`);
    }
  }

  // executionCtx 保留参数以兼容路由签名；重试路径选择同步等待以便返回真实结果。
  void executionCtx;

  return { sent, failed, errors };
}

/* ── 查询 ─────────────────────────────────────────────────── */

/**
 * 查询个人的抽奖参与记录和中奖记录。
 *
 * 【安全】orderToken 明文仅在 JWT 已证明「邮箱本人」后返回，用于生成 /order 查单链接。
 * 库内同时存 order_token 明文是有意设计（中奖邮件/个人中心需要），不是公开接口字段；
 * getDrawWinners（admin）不返回 orderToken，避免管理导出扩大令牌扩散面。
 */
export async function getMyLotteryRecords(db: DbType, email: string) {
  const normalizedEmail = email.trim().toLowerCase();

  // 查询参与记录（含活动名称和状态，便于前端展示）
  const entries = await db
    .select({
      drawId: lotteryEntries.drawId,
      joinedAt: lotteryEntries.joinedAt,
      drawName: lotteryDraws.name,
      drawStatus: lotteryDraws.status,
      drawTime: lotteryDraws.drawTime,
    })
    .from(lotteryEntries)
    .innerJoin(lotteryDraws, eq(lotteryDraws.id, lotteryEntries.drawId))
    .where(eq(lotteryEntries.email, normalizedEmail));

  // 查询中奖记录
  const winners = await db
    .select()
    .from(lotteryWinners)
    .where(eq(lotteryWinners.email, normalizedEmail));

  return {
    entries,
    winners: winners.map((w) => ({
      drawId: w.drawId,
      orderId: w.orderId,
      orderToken: w.orderToken,
      productId: w.productId,
      quantity: w.quantity,
      drawnAt: w.drawnAt,
    })),
  };
}

/**
 * 获取活动的中奖结果（含卡密信息，仅限 admin 使用）。
 * 通过 lotteryWinners → orders → cards JOIN 查询完整的中奖信息，
 * 包含订单号和卡密账号，便于管理端导出和核对。
 */
export async function getDrawWinners(db: DbType, drawId: string) {
  // 管理端核对用：订单号 + 卡密标签 + 奖品价值 + 邮件发送态；不返回 orderToken（扩大令牌扩散面）
  return db
    .select({
      id: lotteryWinners.id,
      email: lotteryWinners.email,
      orderId: lotteryWinners.orderId,
      productId: lotteryWinners.productId,
      quantity: lotteryWinners.quantity,
      drawnAt: lotteryWinners.drawnAt,
      emailSent: lotteryWinners.emailSent,
      emailError: lotteryWinners.emailError,
      orderNo: orders.orderNo,
      cardAccountLabel: cards.accountLabel,
      cardDeliverySecret: cards.deliverySecret,
      productPriceCents: orders.discountCents,
    })
    .from(lotteryWinners)
    .leftJoin(orders, eq(orders.id, lotteryWinners.orderId))
    .leftJoin(cards, eq(cards.id, orders.issuedCardId!))
    .where(eq(lotteryWinners.drawId, drawId));
}

/**
 * 获取活动详情（含参与人数、中奖人数）。
 * 管理员和用户端详情页都使用此函数，前端通过 status 字段判断展示内容。
 */
export async function getDrawDetail(db: DbType, drawId: string) {
  const draw = await getDraw(db, drawId);
  if (!draw) return null;
  const entryCount = await getDrawEntriesCount(db, drawId);
  const winners = await db
    .select({ count: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));
  // 奖品名只读联表；商品删除后 title 为空则回落 null，前端可显示 productId
  const [productRow] = await db
    .select({ title: products.title })
    .from(products)
    .where(eq(products.id, draw.productId))
    .limit(1);
  return {
    ...draw,
    entryCount,
    winnerCount: Number(winners[0]?.count ?? 0),
    productTitle: productRow?.title ?? null,
  };
}

export async function getPublicDrawDetail(db: DbType, drawId: string) {
  const detail = await getDrawDetail(db, drawId);
  if (!detail) return null;
  if (Number(detail.visible ?? 1) !== 1) return null;
  if (detail.status !== "open" && detail.status !== "drawn" && detail.status !== "drawing") return null;
  return hidePrivatePublicStats(detail);
}
