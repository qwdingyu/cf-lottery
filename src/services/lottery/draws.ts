/**
 * 抽奖服务层 — 查询与活动管理域（lottery-service 拆分，docs/049 #17）
 *
 * 活动查询（getDraw/getDrawEntriesCount/getDrawWinners）与生命周期管理
 * （createDraw 创建 / publishDraw 发布 / pause/resume/cancel 状态流转）。
 * 参与域与开奖域直接查库读取活动配置，不依赖本模块（无反向依赖）。
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
  paymentOrders,
  paymentOrderAttempts,
} from "../../db/schema";
import { DEFAULT_ACTIVITY_PARTICIPANT_CAP } from "./types";
import { enforceTenantActivityQuota } from "./plan";
import { hashAccessPassword } from "./utils";
import { buildPublishCheckForDraw, type PublishCheckOptions } from "../publish-check-service";

/* ── 查询函数 ────────────────────────────────────────────── */

/**
 * 查询单个活动（带租户隔离）。
 * 返回 null 表示活动不存在或不属于该租户。
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
 * 获取候选池总数（不含租户隔离，用于公开页展示）。
 */
export async function getDrawEntriesCount(db: DbType, drawId: string, tenantId?: string): Promise<number> {
  const conditions = [eq(lotteryEntries.drawId, drawId)];
  if (tenantId) conditions.push(eq(lotteryEntries.tenantId, tenantId));
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(and(...conditions));
  return Number(total);
}

/**
 * 获取中奖记录（带租户隔离）并水合奖项/奖品/卡密，供管理端「开奖结果」展示。
 *
 * 独立孵化后**不再**创建电商 0 元订单：`orderNo` 恒为空是设计如此（docs/001、docs/102）。
 * 旧 UI 读 `cardAccountLabel` / `cardDeliverySecret`；若不 join `prize_codes`，
 * 即便开奖已锁码，结果表也会显示「订单号/卡密全是 -」——运营会误以为没发码。
 */
export async function getDrawWinners(db: DbType, drawId: string, tenantId: string) {
  const winners = await db
    .select()
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));

  if (winners.length === 0) return [];

  const tierIds = [...new Set(winners.map((w) => w.tierId).filter(Boolean))];
  const prizeCodeIds = [...new Set(winners.map((w) => w.prizeCodeId).filter((id): id is string => Boolean(id)))];

  const tierMap = new Map<string, {
    tierName: string;
    prizeId: string;
    prizeName: string | null;
    prizeType: string | null;
    fulfillmentNote: string | null;
    valueText: string | null;
  }>();
  if (tierIds.length > 0) {
    const tierRows = await db
      .select({
        id: lotteryPrizeTiers.id,
        tierName: lotteryPrizeTiers.tierName,
        prizeId: lotteryPrizeTiers.prizeId,
        prizeName: prizes.name,
        prizeType: prizes.prizeType,
        fulfillmentNote: prizes.fulfillmentNote,
        valueText: prizes.valueText,
      })
      .from(lotteryPrizeTiers)
      .leftJoin(prizes, and(eq(prizes.id, lotteryPrizeTiers.prizeId), eq(prizes.tenantId, tenantId)))
      .where(and(
        eq(lotteryPrizeTiers.tenantId, tenantId),
        inArray(lotteryPrizeTiers.id, tierIds),
      ));
    for (const row of tierRows) {
      tierMap.set(row.id, {
        tierName: row.tierName || "",
        prizeId: row.prizeId || "",
        prizeName: row.prizeName || null,
        prizeType: row.prizeType || null,
        fulfillmentNote: row.fulfillmentNote || null,
        valueText: row.valueText || null,
      });
    }
  }

  const codeMap = new Map<string, { code: string; secret: string; status: string }>();
  if (prizeCodeIds.length > 0) {
    const codeRows = await db
      .select({
        id: prizeCodes.id,
        code: prizeCodes.code,
        secret: prizeCodes.secret,
        status: prizeCodes.status,
      })
      .from(prizeCodes)
      .where(and(eq(prizeCodes.tenantId, tenantId), inArray(prizeCodes.id, prizeCodeIds)));
    for (const row of codeRows) {
      codeMap.set(row.id, { code: row.code, secret: row.secret || "", status: row.status });
    }
  }

  return winners.map((w) => {
    const tier = w.tierId ? tierMap.get(w.tierId) : undefined;
    const code = w.prizeCodeId ? codeMap.get(w.prizeCodeId) : undefined;
    const prizeType = tier?.prizeType || null;
    const isManual = prizeType === "manual_fulfillment" || prizeType === "manual";
    return {
      ...w,
      // 电商订单已剥离：保留字段兼容前端，恒空，避免假订单链接
      orderNo: null as string | null,
      tierName: tier?.tierName || null,
      prizeId: tier?.prizeId || null,
      prizeName: tier?.prizeName || null,
      prizeType,
      prizeValueText: tier?.valueText || null,
      fulfillmentNote: isManual ? (tier?.fulfillmentNote || null) : null,
      /** 卡密账号位（兼容旧列 cardAccountLabel） */
      cardAccountLabel: code?.code || null,
      cardDeliverySecret: code?.secret || null,
      /** 显式字段，导出/新 UI 优先用 */
      prizeCode: code ? (code.secret ? `${code.code}:${code.secret}` : code.code) : null,
      hasPrizeCode: Boolean(code),
      fulfillmentKind: code
        ? "code"
        : isManual
          ? "manual"
          : tier?.prizeId
            ? "code_missing"
            : "none",
    };
  });
}

/* ── 活动管理 ────────────────────────────────────────────── */

/**
 * 创建抽奖活动。
 *
 * 校验规则：
 * - 参与开始时间必须早于结束时间
 * - 定时开奖必须设置开奖时间
 * - 开奖时间必须在参与结束后
 * - 中奖名额至少为 1
 *
 * 生成的 public_slug 取 UUID 前 8 位，用于公开活动链接。
 * 不可枚举，防止遍历活动 ID。
 */
export async function createDraw(
  db: DbType,
  tenantId: string,
  data: {
    title: string;
    description?: string;
    activityKind?: string;         // 活动类型：lottery/signup_chain/reservation...
    participationMode?: string;   // 参与模式：open/roster/password/invite_code
    experienceType?: string;       // 前端体验：wheel/slot/scratch/card/submit...
    drawTrigger?: string;          // 开奖触发：manual/scheduled
    resultMode?: string;           // 结果模式：manual/scheduled/instant/ordered_assignment...
    allocationPolicy?: string;     // 分配策略：capacity/waitlist/fifo/priority...
    policyVersion?: number;        // 规则版本，便于后续活动引擎演进
    startAt: string;               // 参与开始时间（ISO 8601）
    endAt: string;                 // 参与结束时间（ISO 8601）
    drawAt?: string;               // 定时开奖时间（ISO 8601）
    accessPassword?: string;       // 密码模式下的访问密码（明文，存储时需 hash）
    maxParticipants?: number;      // 最大参与人数（null=不限）
    winnerCount?: number;          // 中奖人数
    showParticipantCount?: number; // 是否公开参与人数（0/1）
    showWinnerCount?: number;      // 是否公开中奖人数（0/1）
    showWinnerList?: number;       // 是否公开中奖名单（0/1）
    productLink?: string;          // 旧导流配置，JSON 字符串
    promotionConfig?: string;      // 活动引擎导流配置，JSON 字符串
    activityConfig?: string;       // 活动玩法配置，JSON 字符串
    /** instant：同一用户最多 spin 次数；0=未配置（delayed） */
    maxSpinsPerEntry?: number;
  },
) {
  const requestedMaxParticipants = normalizeRequestedMaxParticipants(data.maxParticipants);
  const title = String(data.title || "").trim();
  const activityKind = data.activityKind || "lottery";
  // docs/115：仅 lottery 且带 drawAt、调用方未显式传 trigger 时推断 scheduled。
  // 禁止「写了开奖时间却 manual」导致 Cron 永不扫到；显式 data.drawTrigger 仍优先。
  const drawTrigger =
    data.drawTrigger ||
    (activityKind === "lottery" && data.drawAt ? "scheduled" : "manual");
  const winnerCount = normalizeWinnerCount(activityKind, data.winnerCount);

  // 创建阶段就拒绝无法发布的活动，避免运营者生成“看似保存成功、后续必然失败”的草稿。
  if (!title) throw new Error("活动标题不能为空");

  // 校验参与时间合法性
  const start = new Date(data.startAt);
  const end = new Date(data.endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("活动时间格式无效");
  }
  if (start >= end) throw new Error("参与开始时间必须早于结束时间");

  // 定时开奖必须设置开奖时间
  if (drawTrigger === "scheduled" && !data.drawAt) {
    throw new Error("定时开奖必须设置开奖时间");
  }

  // 开奖时间必须在参与结束后
  if (data.drawAt) {
    const draw = new Date(data.drawAt);
    if (Number.isNaN(draw.getTime())) throw new Error("开奖时间格式无效");
    if (end >= draw) throw new Error("开奖时间必须在参与结束后");
  }

  // 只有抽奖类活动要求中奖名额；接龙、问卷、预约等不应被 winner 语义绑住。
  if (requiresWinnerCount(activityKind) && winnerCount < 1) {
    throw new Error("中奖名额至少为 1");
  }

  const planLimits = await enforceTenantActivityQuota(db, tenantId, requestedMaxParticipants);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const experienceType = data.experienceType || defaultExperienceForActivity(activityKind, data.participationMode || "open");
  const resultMode = data.resultMode || defaultResultModeForActivity(activityKind, drawTrigger);
  // instant 次数硬顶：仅 lottery+instant 写入；其它模式强制 0，避免脏配置
  let maxSpinsPerEntry = 0;
  if (activityKind === "lottery" && resultMode === "instant") {
    const raw = Number(data.maxSpinsPerEntry);
    if (!Number.isFinite(raw) || raw < 1) {
      throw new Error("即时开奖必须设置每人抽奖次数（≥1）");
    }
    maxSpinsPerEntry = Math.min(100, Math.floor(raw));
  }
  // 访问密码哈希移到循环外，避免 slug 冲突重试时重复计算（单次 SHA-256，成本低但没必要重复）
  const accessPasswordHash = data.accessPassword ? await hashAccessPassword(data.accessPassword) : "";

  // public_slug 取 UUID 前 8 位（32-bit 空间）：活动量增长后按生日悖论存在偶发冲突
  // （1 万活动约 1.2%、10 万约 11.6%）。INSERT 触发 UNIQUE 冲突时重新生成 slug 重试，
  // 最多 3 次；仍冲突则抛错（概率约 10⁻⁷ 量级，可忽略）。
  let publicSlug = "";
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    publicSlug = crypto.randomUUID().slice(0, 8);
    try {
      await db.insert(lotteryDraws).values({
        id,
        tenantId,
        publicSlug,
        title,
        description: data.description || "",
        activityKind,
        participationMode: data.participationMode || "open",
        experienceType,
        drawTrigger,
        resultMode,
        allocationPolicy: data.allocationPolicy || (activityKind === "signup_chain" ? "capacity" : "capacity"),
        policyVersion: data.policyVersion || 1,
        startAt: data.startAt,
        endAt: data.endAt,
        drawAt: data.drawAt || null,
        accessPassword: accessPasswordHash,
        maxParticipants: requestedMaxParticipants ?? Math.min(DEFAULT_ACTIVITY_PARTICIPANT_CAP, planLimits.maxParticipantsPerActivity),
        winnerCount,
        showParticipantCount: data.showParticipantCount ?? 1,
        showWinnerCount: data.showWinnerCount ?? 1,
        showWinnerList: data.showWinnerList ?? 0,
        // 新建默认对用户可见；运营可在 drawn 后单独关闭（docs/083）
        visible: 1,
        productLink: data.productLink || "{}",
        promotionConfig: data.promotionConfig || "{}",
        activityConfig: data.activityConfig || "{}",
        maxSpinsPerEntry,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });
      inserted = true;
    } catch (err: any) {
      // 仅当是 public_slug 唯一约束冲突时才重试；其他错误（配额、连接等）直接抛出
      if (!err?.message?.includes("UNIQUE constraint")) throw err;
    }
  }
  if (!inserted) throw new Error("创建活动失败，请重试");

  return { id, publicSlug };
}

function normalizeRequestedMaxParticipants(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error("参与人数上限必须为正整数");
  }
  return normalized;
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === "invite_code") return "slot";
  if (participationMode === "password") return "scratch";
  if (participationMode === "roster") return "card";
  return "wheel";
}

function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === "signup_chain") return "list";
  if (activityKind === "reservation") return "calendar";
  if (activityKind === "vote") return "ballot";
  if (activityKind === "survey") return "form";
  if (activityKind === "checkin") return "checkin";
  if (activityKind === "waitlist") return "queue";
  if (activityKind === "approval") return "form";
  if (activityKind === "claim") return "reveal";
  return defaultExperienceForParticipation(participationMode);
}

/**
 * 根据活动类型和开奖触发方式计算默认结果模式。
 *
 * 这是活动引擎的规则入口：不同 activity_kind 对应不同的结果分配方式。
 * 抽奖类默认 manual（管理员手动开奖）或 scheduled（定时开奖）；
 * 接龙类默认 ordered_assignment（按报名顺序分配）；
 * 问卷/签到类默认 no_result（无结果分配）。
 *
 * 该函数同时被 lottery-service（创建活动）和 admin-lottery（路由层校验）使用，
 * 因此导出为公共函数，避免两处维护不同步。
 */
export function defaultResultModeForActivity(activityKind: string, drawTrigger: string): string {
  if (activityKind === "signup_chain") return "ordered_assignment";
  if (activityKind === "reservation") return "capacity_assignment";
  if (activityKind === "vote") return "vote_tally";
  if (activityKind === "survey") return "no_result";
  if (activityKind === "checkin") return "no_result";
  if (activityKind === "waitlist") return "ordered_assignment";
  if (activityKind === "approval") return "review_decision";
  if (activityKind === "claim") return "instant";
  if (activityKind === "assignment") return "ordered_assignment";
  return drawTrigger === "scheduled" ? "scheduled" : "manual";
}

/**
 * 判断活动类型是否要求中奖名额。
 *
 * 只有抽奖（lottery）需要中奖名额；接龙、问卷、签到等活动的"结果"不是抽奖，
 * 不应被 winner 语义绑住（否则问卷活动会强制要求填中奖人数，造成困惑）。
 */
function requiresWinnerCount(activityKind: string): boolean {
  return activityKind === "lottery";
}

/**
 * 归一化中奖名额。
 *
 * - 抽奖活动：未传时默认 1，保证开奖有明确名额
 * - 非抽奖活动：未传时返回 0（不参与中奖语义）
 */
function normalizeWinnerCount(activityKind: string, winnerCount?: number): number {
  if (!requiresWinnerCount(activityKind)) return winnerCount ?? 0;
  return winnerCount ?? 1;
}

/**
 * 发布活动（draft → open）。
 *
 * 发布前二次校验：
 * - 标题不能为空
 * - 活动时间必须设置
 * - 定时开奖必须设置开奖时间
 * - 抽奖活动必须至少配置一个奖项（buildPublishCheckForDraw 统一门禁）
 *
 * 使用 CAS 更新（WHERE status = 'draft'），防止并发发布。
 */
export async function publishDraw(
  db: DbType,
  tenantId: string,
  drawId: string,
  options: PublishCheckOptions = {},
): Promise<boolean> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有草稿状态可以发布
  if (draw.status !== "draft") throw new Error("只有草稿状态的活动才能发布");

  // 发布前二次校验集中交给 publish-check-service：
  // 真实发布路径必须和后台“发布前预检”使用同一套规则，否则前端清单和服务端行为会漂移。
  const publishCheck = await buildPublishCheckForDraw(db, tenantId, draw, options);
  if (!publishCheck.canPublish) {
    throw new Error(publishCheck.errors[0]?.message || "活动未通过发布前校验");
  }

  // CAS 更新：条件为 status = 'draft'，防止并发发布
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
 * 取消活动（draft/open/paused → cancelled）。
 * 已开奖或开奖中的活动不可取消。
 */
export async function cancelDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  return withDbTransaction(db, async (tx) => {
    const [draw] = await tx
      .select({ id: lotteryDraws.id, status: lotteryDraws.status })
      .from(lotteryDraws)
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
      .limit(1);

    if (!draw) throw new Error("活动不存在");
    // 已开奖或开奖中的活动不可取消，防止结果与支付履约事实被覆盖。
    if (draw.status === "drawn" || draw.status === "drawing") {
      throw new Error("已开奖或开奖中的活动不可取消");
    }

    const cancelled = await tx
      .update(lotteryDraws)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(and(
        eq(lotteryDraws.id, drawId),
        eq(lotteryDraws.tenantId, tenantId),
        inArray(lotteryDraws.status, ["draft", "open", "paused"]),
      ))
      .returning({ id: lotteryDraws.id });
    if (cancelled.length === 0) return false;

    // 取消是终止运营，不允许继续为未支付订单重新生成支付入口。
    // 外部网关可能仍在途，订单先落 expired；迟到回调会被支付服务转为
    // paid_late_needs_refund，保留可退款审计链，而不是静默丢失付款事实。
    const pendingOrders = await tx
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(and(
        eq(paymentOrders.tenantId, tenantId),
        eq(paymentOrders.drawId, drawId),
        eq(paymentOrders.status, "pending"),
      ));
    const pendingOrderIds = pendingOrders.map((order) => order.id);
    if (pendingOrderIds.length > 0) {
      await tx
        .update(paymentOrders)
        .set({ status: "expired", updatedAt: sql`(datetime('now'))` })
        .where(and(
          eq(paymentOrders.tenantId, tenantId),
          eq(paymentOrders.drawId, drawId),
          eq(paymentOrders.status, "pending"),
        ));
      await tx
        .update(paymentOrderAttempts)
        .set({ status: "expired", updatedAt: sql`(datetime('now'))` })
        .where(and(
          eq(paymentOrderAttempts.tenantId, tenantId),
          inArray(paymentOrderAttempts.paymentOrderId, pendingOrderIds),
          eq(paymentOrderAttempts.status, "pending"),
        ));
    }

    const releasedEntries = await tx
      .update(lotteryEntries)
      .set({ paymentStatus: "expired" })
      .where(and(
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.drawId, drawId),
        inArray(lotteryEntries.paymentStatus, ["reserved", "pending"]),
      ))
      .returning({ id: lotteryEntries.id });
    if (releasedEntries.length > 0) {
      await tx
        .update(lotteryDraws)
        .set({
          activeParticipantCount: sql`MAX(0, ${lotteryDraws.activeParticipantCount} - ${releasedEntries.length})`,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    }

    return true;
  });
}
