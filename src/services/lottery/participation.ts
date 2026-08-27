/**
 * 抽奖服务层 — 参与域（lottery-service 拆分，docs/049 #17）
 *
 * 用户参与入口：joinDraw（四种参与模式：open/roster/password/invite_code，
 * 含活动级容量条件 INSERT、验证码消费、每日签到日期后缀）、接龙取消、
 * 结果查询（getActivityOutcome(s)）、候选池读取（getEntries）。
 * 依赖 utils（访问密码验证）与 integration（活动事件），无反向依赖。
 */
import type { DbType, DbWriteScope } from "../../db/client";
import { isFlashSaleExperience } from "../../lib/activity-utils";
import { withDbTransaction } from "../../db/client";
import { todayStr } from "../../lib/date-utils";
import { and, eq, inArray, notInArray, sql, asc, desc, max, or, count, ne } from "drizzle-orm";
import {
  lotteryDraws,
  lotteryEntries,
  paymentOrders,
  lotteryRosterMembers,
  lotteryInviteCodes,
  emailAccessCodes,
  lotteryBlacklist,
  activityOutcomes,
  activitySubmissions,
  shareRecords,
  users,
  activityEvents,
} from "../../db/schema";
import { logError, logWarn } from "../../lib/logger";
import { verifyAccessPassword } from "./utils";
import { recordActivityEvent, dispatchWebhookDelivery } from "./integration";
import { triggerRewardEarned, getSharerIdentityValue } from "./reward";
import { initialSpinsForJoin } from "./spin-quota";
import { grantBonusSpin } from "./reward-exits";
import { isViralEnabled, readViralPerInvite } from "./viral-weight";
import { processReferralRewardsEngine } from "./referral-rewards-engine";
import { recordSpinLog } from "./spins-log";
import {
  parseFlashSaleConfig,
  resolveEffectiveStockLimit,
} from "../../lib/flash-sale-config";
import { parseActivityOperationalConfig } from "../../lib/activity-config";
import {
  RETRYABLE_PAYMENT_ORDER_STATUSES,
  PAYMENT_ENTRY_STATUS,
} from "../payment/payment-status";
import { DRAW_STATUS } from "./types";
import { nextStreakAfterCheckin, computeCheckinReward, parseStoredCheckinPolicy } from "../platform/checkin-reward";
import { platformTargets } from "../../db/schema";

export interface JoinDrawResult {
  joined: boolean;
  message?: string;
  alreadyJoined?: boolean;
  entryId?: string;
  soldOut?: boolean;
  code?: string;
  activityKind?: string;
  reopened?: boolean;
  attribution?: { attributed: boolean; sharerEntryId?: string; refCode?: string };
  submissionId?: string;
  outcome?: Record<string, unknown>;
}

/* ── 候选池 ───────────────────────────────────────────────── */

/**
 * 加入候选池。
 *
 * 支持四种参与模式：
 * - open（公开）：任何人都可参与，无需额外验证
 * - roster（名单）：检查参与者是否在预置名单中
 * - password（密码）：需要输入正确的访问密码
 * - invite_code（邀请码）：需要输入有效的邀请码（CAS 扣减使用次数）
 *
 * 通用校验：
 * - 活动必须处于 open 状态
 * - 参与时间必须在活动时间窗口内
 * - 不超过最大参与人数上限
 * - 同一身份不可重复参与（UNIQUE 约束）
 * - 签到活动例外：同一身份每天可签到一次（identity_value 附加日期后缀）
 */
export async function joinDraw(
  db: DbType,
  slug: string,                    // 活动公开链接 slug
  identityValue: string,           // 参与者身份标识（邮箱/手机号）
  identityType: string = "email",  // 身份类型
  options?: {
    accessPassword?: string;       // 密码模式下的访问密码
    inviteCode?: string;           // 邀请码模式下的邀请码
    ipHash?: string;               // 参与者 IP hash（用于轻量防刷）
    refCode?: string;              // 分享码。只有成功入库的新参与才计为有效邀请。
    userAgent?: string;
    /** 动态表单提交 payload（问卷答案/投票选项/资料请求等）。与 entry 同事务写入。 */
    submissionPayload?: Record<string, unknown>;
    /** verify-join 优化：事务内标记验证码已使用，失败自动回滚，省一次 DB 往返 */
    codeIdToConsume?: string;
  },
): Promise<JoinDrawResult> {
  // 通过 public_slug 查找活动（不暴露活动 ID）
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有 open 状态的活动可以参与（draft/paused/drawing/drawn/cancelled 均不可参与）
  if (draw.status !== DRAW_STATUS.OPEN) throw new Error("活动未开启");

  // ── registered 模式：参与身份必须是 user_id（端点层已解析，此处服务层兜底） ──
  // 身份由端点解析后传入（identityType/identityValue），业务层只消费不再覆盖。
  // 校验防绕过：任何端点（如 /join 快捷参与）若以 email 身份请求 registered 活动，
  // 一律拒绝——杜绝"传 email 存 userId"的兼容 hack，保证 entry 身份与模式一致。
  if (draw.participationMode === "registered" && identityType !== "user_id") {
    return { joined: false, message: "此活动需要登录后参与" };
  }

  // ── 身份标识归一化 ──
  // 统一转小写去空格，确保同一邮箱的不同写法被识别为同一身份
  let normalizedValue = identityValue.trim().toLowerCase();

  // ── 签到活动特殊处理 ──
  // 签到活动（checkin）允许同一人每天签到一次，但 UNIQUE(tenant_id,draw_id,identity_type,identity_value)
  // 约束会阻止同一天重复签到。解决方案：identity_value 附加日期后缀（如 "user@test.com:2026-08-01"），
  // 使每天生成不同的 identity_value，既允许每日签到，又防止同一天重复。
  // 注意：黑名单和名单模式使用原始 value 做校验，只有写入时使用日期后缀 value。
  // 日期用 todayStr()（本地时区），与 bot /签到（commands.ts:518）和每日免费（spin-execution.ts）
  // 同源——若用 UTC 日期（toISOString().slice(0,10)），UTC+8 等偏移时区下"每日"刷新点会偏移，
  // 导致 bot 签到与公开端 checkin 活动的"今日"不一致（同一用户同一天可能被判定为两天）。
  const checkinDateSuffix = draw.activityKind === "checkin" ? `:${todayStr()}` : "";
  const uniqueValue = normalizedValue + checkinDateSuffix;
  // ── 黑名单检查 ──
  // 黑名单按邮箱配置（L2 运营者在管理台输入邮箱）。邮箱身份直接匹配；
  // registered（user_id）身份需同时匹配 userId 和其注册邮箱——否则运营者按邮箱
  // 拉黑后，该用户换 registered 身份仍可参与（身份模型统一的副作用，必须封堵）。
  const blacklistKeys = [normalizedValue];
  if (identityType === "user_id") {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, normalizedValue)).limit(1);
    if (u?.email) blacklistKeys.push(u.email.toLowerCase());
  }
  const [banned] = await db
    .select({ id: lotteryBlacklist.id })
    .from(lotteryBlacklist)
    .where(and(eq(lotteryBlacklist.tenantId, draw.tenantId), inArray(lotteryBlacklist.identityValue, blacklistKeys)))
    .limit(1);
  if (banned) {
    return { joined: false, message: "您已被限制参与此活动" };
  }

  // ── 参与模式校验 ──

  // 名单模式：检查参与者是否在预置名单中
  if (draw.participationMode === "roster") {
    const [member] = await db
      .select({ id: lotteryRosterMembers.id })
      .from(lotteryRosterMembers)
      .where(and(
        eq(lotteryRosterMembers.drawId, draw.id),
        eq(lotteryRosterMembers.identityValue, normalizedValue),
      ))
      .limit(1);
    if (!member) {
      return { joined: false, message: "您不在参与名单中" };
    }
  }

  // 密码模式：校验访问密码（hash 比较）
  if (draw.participationMode === "password") {
    if (!options?.accessPassword) {
      return { joined: false, message: "请输入访问密码" };
    }
    // 使用 verifyAccessPassword 验证（兼容新旧两种哈希格式）
    if (!(await verifyAccessPassword(options.accessPassword, draw.accessPassword))) {
      return { joined: false, message: "访问密码错误" };
    }
  }

  if (draw.participationMode === "invite_code" && !options?.inviteCode) {
    return { joined: false, message: "请输入邀请码" };
  }

  // ── 参与时间校验 ──
  const now = new Date();
  if (now < new Date(draw.startAt) || now > new Date(draw.endAt)) {
    return { joined: false, message: "不在参与时间内" };
  }
  const operational = parseActivityOperationalConfig(draw.activityConfig);
  const lockMinutes = operational.lockJoinBeforeDrawMinutes ?? 0;
  if (lockMinutes > 0 && draw.drawAt) {
    const drawAtMs = new Date(draw.drawAt).getTime();
    if (Number.isFinite(drawAtMs) && now.getTime() >= drawAtMs - lockMinutes * 60000) {
      return { joined: false, message: `开奖前 ${lockMinutes} 分钟已停止新增参与` };
    }
  }

  const nowIso = now.toISOString();

  try {
    // 收集 reward.earned 的 deliveryIds，在事务提交后用主连接 dispatch
    // （避免 dispatchWebhookDelivery 在事务内/未提交时读不到 delivery 记录，docs/274 修正）
    let rewardDeliveryIds: string[] = [];
    const result = await withDbTransaction(db, async (tx) => {
      const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
      const flashCap = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
      const isFlashSaleJoin =
        flashParsed.config != null || isFlashSaleExperience(draw.experienceType);
      const isDirectPaymentFlashSale = isFlashSaleJoin && flashParsed.config?.paymentRequired === true;
      const effectiveMax =
        flashCap != null && flashCap > 0
          ? flashCap
          : isFlashSaleJoin && (draw.maxParticipants == null || draw.maxParticipants <= 0)
            ? 0
            : (draw.maxParticipants ?? 50000);

      // 直付秒杀是一身份一预约：同一身份已经有有效预约/已支付时，必须返回
      // 原 entryId 让公开端恢复支付或查卡，不能因为整场已满而误报“已抢光”。
      // 只有 expired 软释放状态才允许重新通过活动级 CAS 抢回名额。
      if (isDirectPaymentFlashSale) {
        const [existingPaymentEntry] = await tx
          .select({ id: lotteryEntries.id, paymentStatus: lotteryEntries.paymentStatus })
          .from(lotteryEntries)
          .where(and(
            eq(lotteryEntries.tenantId, draw.tenantId),
            eq(lotteryEntries.drawId, draw.id),
            eq(lotteryEntries.identityType, identityType),
            eq(lotteryEntries.identityValue, checkinDateSuffix ? uniqueValue : normalizedValue),
          ))
          .limit(1);
        if (existingPaymentEntry && existingPaymentEntry.paymentStatus !== PAYMENT_ENTRY_STATUS.EXPIRED) {
          return {
            joined: false,
            message: "您已参与此活动",
            alreadyJoined: true as const,
            entryId: existingPaymentEntry.id,
          };
        }
        if (existingPaymentEntry?.paymentStatus === PAYMENT_ENTRY_STATUS.EXPIRED) {
          // docs/255 P2-8 + 复审 A3：V2 是 1:N 订单模型，判断必须是
          // "存在任一不可重试订单就阻断"，而不是"取最新一条订单看是否可重试"。
          // 反例：旧订单 paid（用户已付钱） + 新订单 cancelled，按最新一条会放行，
          // 于是同一 entry 上再生成一笔订单 → 重复收款 / 重复发卡。
          // 因此直接用 NOT IN (可重试终态) 探测是否存在任一"付款事实已发生或仍在进行"的订单。
          const [blockingOrder] = await tx
            .select({ status: paymentOrders.status })
            .from(paymentOrders)
            .where(and(
              eq(paymentOrders.tenantId, draw.tenantId),
              eq(paymentOrders.drawId, draw.id),
              eq(paymentOrders.entryId, existingPaymentEntry.id),
              notInArray(paymentOrders.status, [...RETRYABLE_PAYMENT_ORDER_STATUSES]),
            ))
            .limit(1);
          if (blockingOrder) {
            return {
              joined: false,
              message: "该参与已有支付记录，请联系客服处理",
              alreadyJoined: true as const,
              entryId: existingPaymentEntry.id,
            };
          }
          if (effectiveMax <= 0) {
            return {
              joined: false,
              message: "已抢光",
              soldOut: true as const,
              code: "flash_sale.sold_out" as const,
            };
          }
          const reserved = await tx
            .update(lotteryDraws)
            .set({
              activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + 1`,
              updatedAt: sql`(datetime('now'))`,
            })
            .where(and(
              eq(lotteryDraws.id, draw.id),
              eq(lotteryDraws.tenantId, draw.tenantId),
              eq(lotteryDraws.status, DRAW_STATUS.OPEN),
              sql`${lotteryDraws.activeParticipantCount} < ${effectiveMax}`,
            ))
            .returning({ id: lotteryDraws.id });
          if (reserved.length === 0) {
            return {
              joined: false,
              message: "已抢光",
              soldOut: true as const,
              code: "flash_sale.sold_out" as const,
            };
          }
          // 把 EXPIRED 软释放的 entry 重新占位为 RESERVED。
          // 必须先做活动级 CAS（activeParticipantCount+1）成功，再尝试把 entry 改 RESERVED；
          // 但两步之间可能有并发：另一个请求也通过 CAS 抢到名额并先把 entry 改成了 RESERVED。
          // 因此这里必须检查 rowsAffected：若命中 0 行（entry 已被并发方抢占），
          // 说明本请求白占了一个活动名额，必须回滚 activeParticipantCount 并让用户恢复已有 entry，
          // 否则会产生"一条 entry 计作两个名额"的计数虚高，且该名额永久泄漏无法回收（F3）。
          const occupy = await tx
            .update(lotteryEntries)
            .set({ paymentStatus: PAYMENT_ENTRY_STATUS.RESERVED, joinedAt: nowIso })
            .where(and(
              eq(lotteryEntries.id, existingPaymentEntry.id),
              eq(lotteryEntries.paymentStatus, PAYMENT_ENTRY_STATUS.EXPIRED),
            ));
          if ((occupy.rowsAffected ?? 0) === 0) {
            // 名额已被并发请求抢占：回滚本请求刚占用的活动级计数，避免虚拟占用泄漏。
            // 回滚使用 MAX(0, count - 1) 而非精确 CAS，极端并发下 activeParticipantCount
            // 可能轻微偏移（如两个请求同时 CAS 成功 → 两个 occupy 都命中 → 无需回滚；
            // 或两个 CAS 成功但只有一个 occupy 命中 → 一个回滚正确）。
            // 偏移量 ≤ 并发请求数，且仅影响"已抢光"判断的精确度（多/少 1-2 个名额），
            // 不会导致超卖（INSERT 的 capacityClause 兜底）或资金损失。
            // 后续可考虑 SQLite RETURNING + 事务内重试消除此窗口期，当前补偿机制可接受。
            await tx
              .update(lotteryDraws)
              .set({ activeParticipantCount: sql`MAX(0, ${lotteryDraws.activeParticipantCount} - 1)` })
              .where(and(eq(lotteryDraws.id, draw.id), eq(lotteryDraws.tenantId, draw.tenantId)));
            return {
              joined: false,
              message: "您已参与此活动",
              alreadyJoined: true as const,
              entryId: existingPaymentEntry.id,
            };
          }
          return {
            joined: true,
            entryId: existingPaymentEntry.id,
            activityKind: draw.activityKind,
            reopened: true as const,
          };
        }
      }

      // 邀请码只在参与记录成功落库后扣减。这里先做可用性预检并拿到 id；
      // 真正 usedCount + 1 放在 INSERT 成功之后，避免活动满额/秒杀售罄时白白消耗资格。
      let inviteCodeId = "";
      if (draw.participationMode === "invite_code") {
        const [invite] = await tx
          .select({ id: lotteryInviteCodes.id })
          .from(lotteryInviteCodes)
          .where(and(
            eq(lotteryInviteCodes.tenantId, draw.tenantId),
            eq(lotteryInviteCodes.drawId, draw.id),
            eq(lotteryInviteCodes.code, options!.inviteCode!),
            eq(lotteryInviteCodes.active, 1),
            sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
          ))
          .limit(1);
        if (!invite) {
          return { joined: false, message: "邀请码无效或已用完" };
        }
        inviteCodeId = invite.id;
      }

      const entryId = crypto.randomUUID();
      // docs/130：秒杀硬截单以 flashSale.stockLimit 优先，再回退 maxParticipants。
      // 为什么与展示同源：公开端进度条用 resolveEffectiveStockLimit；参与路径若只认 maxParticipants，
      // 会出现「前端显示已抢光、后端仍可 join」或反过来——必须同一生效上限。
      // 直付秒杀使用活动级计数器 CAS；普通活动继续沿用条件 INSERT。
      // 仅 flashSale 启用或 experience_type=flash_sale 走秒杀截单语义；
      // 普通 claim/reveal 仍按 maxParticipants（可无限软顶），避免误杀非秒杀领取。
      // 秒杀：禁止候补超卖；其它活动仍按 maxParticipants（无上限时 50000 软顶）
      // 候补语义开放给 signup_chain 与 waitlist 两种按序分配类型；
      // 秒杀不做候补，满即拒（reservation 不候补，满即拒）。
      const acceptsWaitlist =
        (draw.activityKind === "signup_chain" || draw.activityKind === "waitlist") &&
        draw.allocationPolicy === "waitlist" &&
        !isFlashSaleJoin;
      // 普通活动仍按活动维度做条件 INSERT；直付秒杀不在热路径扫描 entries。
      const activeCapacityCountClause = sql`(
            SELECT COUNT(*) FROM lottery_entries
            WHERE tenant_id = ${draw.tenantId}
            AND draw_id = ${draw.id}
          ) < ${effectiveMax}`;
      let capacityClause = acceptsWaitlist
        ? sql`1 = 1`
        : effectiveMax > 0
          ? activeCapacityCountClause
          : sql`1 = 0`; // 秒杀无名额：拒绝写入
      if (isDirectPaymentFlashSale && effectiveMax > 0) {
        // 秒杀容量控制：CAS 原子递增 + 条件守卫（activeParticipantCount < effectiveMax）。
        //
        // 设计权衡（docs/264 审查确认）：
        // CAS 与 INSERT 是两个独立写操作，SQLite BEGIN DEFERRED 下理论上可偏移 ±1-2。
        // 但闪购路径 INSERT 用 capacityClause=1=1（不走 COUNT），原因是：
        // - activeCapacityCountClause 不过滤 paymentStatus，会把过期 entry 也算入，
        //   导致过期释放后新参与者被误拒（docs/134 场景）
        // - 过期 entry 不应阻塞新参与者，CAS 是闪购唯一的容量守卫
        // - 偏移上限 = 并发请求数（通常 1-2），不影响资金安全，仅影响"已抢光"显示精度
        // - 非闪购路径用 INSERT COUNT(*) 兜底，无此问题
        const reserved = await tx
          .update(lotteryDraws)
          .set({
            activeParticipantCount: sql`${lotteryDraws.activeParticipantCount} + 1`,
            updatedAt: sql`(datetime('now'))`,
          })
          .where(and(
            eq(lotteryDraws.id, draw.id),
            eq(lotteryDraws.tenantId, draw.tenantId),
            eq(lotteryDraws.status, DRAW_STATUS.OPEN),
            sql`${lotteryDraws.activeParticipantCount} < ${effectiveMax}`,
          ))
          .returning({ id: lotteryDraws.id });
        if (reserved.length === 0) {
          return {
            joined: false,
            message: "已抢光",
            soldOut: true as const,
            code: "flash_sale.sold_out" as const,
          };
        }
        capacityClause = sql`1 = 1`;
      }
      // instant：join 发放 initial spins（默认 1），不抽奖（docs/116）
      const spinInit = initialSpinsForJoin(
        Number((draw as { maxSpinsPerEntry?: number }).maxSpinsPerEntry ?? 0),
        1,
      );
      // 写入参与记录。使用条件 INSERT 确保并发安全：
      // 1. 活动级容量检查（capacityClause）：防止同时写入超过生效名额（秒杀=stockLimit 优先）
      // 2. 签到活动使用 uniqueValue（含日期后缀）作为 identity_value，
      //    使 UNIQUE 约束允许每日签到但不允许同一天重复。
      const insertResult = await tx.run(sql`
        INSERT INTO lottery_entries (
          id, tenant_id, draw_id, identity_type, identity_value, invite_code_id, ip_hash, joined_at,
          spins_left, spins_total_granted, spins_viral_earned, payment_status
        )
        SELECT ${entryId}, ${draw.tenantId}, ${draw.id}, ${identityType}, ${checkinDateSuffix ? uniqueValue : normalizedValue}, ${inviteCodeId}, ${options?.ipHash || ""}, ${nowIso},
          ${spinInit.spinsLeft}, ${spinInit.spinsTotalGranted}, ${spinInit.spinsViralEarned}, ${isDirectPaymentFlashSale ? PAYMENT_ENTRY_STATUS.RESERVED : PAYMENT_ENTRY_STATUS.NONE}
        WHERE ${capacityClause}
      `);

      if ((insertResult.rowsAffected ?? 0) === 0) {
        if (isDirectPaymentFlashSale) {
          await tx
            .update(lotteryDraws)
            .set({
              activeParticipantCount: sql`MAX(0, ${lotteryDraws.activeParticipantCount} - 1)`,
              updatedAt: sql`(datetime('now'))`,
            })
            .where(and(eq(lotteryDraws.id, draw.id), eq(lotteryDraws.tenantId, draw.tenantId)));
        }
        // 秒杀售罄文案与普通「名额已满」区分，便于前端映射 flashSoldOut
        if (isFlashSaleJoin && !acceptsWaitlist) {
          return {
            joined: false,
            message: "已抢光",
            soldOut: true as const,
            code: "flash_sale.sold_out" as const,
          };
        }
        return { joined: false, message: acceptsWaitlist ? "参与失败，请稍后重试" : "活动名额已满" };
      }

      // 写入 spins 流水日志（docs/172 §5.5 P1）：记录 join 初始额度发放
      if (spinInit.spinsLeft > 0) {
        await recordSpinLog(tx, {
          tenantId: draw.tenantId,
          entryId,
          userId: normalizedValue,
          delta: spinInit.spinsLeft,
          balanceAfter: spinInit.spinsLeft,
          reason: "join",
        });
      }

      // ── 签到活动：计算并维护连续签到天数 ──
      // 公开端每次签到创建新 entry（identity_value 含日期后缀），需从历史 entry 推算 streak，
      // 与平台命令（/签到）的原子 UPDATE 模式对齐——确保无论用户从哪端签到，streak 数据一致。
      // lastCheckinDate + checkinStreak 写在 entry 上，供 checkin-status API 和前端日历直接读取。
      if (draw.activityKind === "checkin") {
        const today = todayStr();
        // 查找该用户在本活动的上一次签到记录（不含本次刚插入的）
        // identity_value 格式为 "email:YYYY-MM-DD"，用 LIKE 前缀匹配同一用户的所有签到
        const [prevEntry] = await tx
          .select({
            lastCheckinDate: lotteryEntries.lastCheckinDate,
            checkinStreak: lotteryEntries.checkinStreak,
            joinedAt: lotteryEntries.joinedAt,
          })
          .from(lotteryEntries)
          .where(and(
            eq(lotteryEntries.tenantId, draw.tenantId),
            eq(lotteryEntries.drawId, draw.id),
            eq(lotteryEntries.identityType, identityType),
            sql`${lotteryEntries.identityValue} LIKE ${normalizedValue + ":%"}`,
            ne(lotteryEntries.id, entryId), // 排除刚插入的
          ))
          .orderBy(desc(lotteryEntries.joinedAt))
          .limit(1);

        // 复用平台命令的 streak 计算函数（checkin-reward.ts）
        const prevStreak = prevEntry?.checkinStreak ?? 0;
        const prevDate = prevEntry?.lastCheckinDate ?? prevEntry?.joinedAt?.slice(0, 10) ?? null;
        const newStreak = nextStreakAfterCheckin(prevDate, prevStreak, today);

        // ── 公开端签到奖励：与 Bot /签到命令对齐 ──
        // 加载 platform_targets 中的 dailyCheckinPolicy 配置，计算 spins 奖励。
        // 确保无论用户从公开网页还是 Bot 签到，都能获得相同的连续签到奖励。
        let checkinReward = 0;
        let finalStreak = newStreak;
        try {
          const [target] = await tx
            .select({ builtinCommandsJson: platformTargets.builtinCommandsJson })
            .from(platformTargets)
            .where(eq(platformTargets.activeDrawId, draw.id))
            .limit(1);
          if (target?.builtinCommandsJson) {
            const parsed = JSON.parse(target.builtinCommandsJson);
            const builtinCommands = parseStoredCheckinPolicy(parsed.dailyCheckinPolicy);
            const streakConfig = builtinCommands?.rewardConfig;
            const grantSpinCount = builtinCommands?.grantSpinCount;
            const randomBonus = builtinCommands?.randomBonus;

            // cycle 模式达到 cycleDays 后重置连续天数（与 commands.ts:555 对齐）
            if (streakConfig?.mode === "cycle" && streakConfig.cycleDays && newStreak >= streakConfig.cycleDays) {
              finalStreak = 1;
            }

            // 有奖励配置才计算（与 commands.ts:503 逻辑对齐）
            if (streakConfig || (grantSpinCount && grantSpinCount > 0)) {
              checkinReward = computeCheckinReward(
                streakConfig,
                grantSpinCount,
                prevStreak, // 签到前的连续天数
                newStreak,  // 签到后的连续天数
                undefined,
                randomBonus,
              );
            }
          }
        } catch {
          // 配置加载失败不影响签到主流程（与 commands.ts 容错一致）
        }

        // 更新刚插入的 entry，写入 streak 信息 + spins 奖励
        if (checkinReward > 0) {
          await tx
            .update(lotteryEntries)
            .set({
              lastCheckinDate: today,
              checkinStreak: finalStreak,
              spinsLeft: sql`${lotteryEntries.spinsLeft} + ${checkinReward}`,
            })
            .where(eq(lotteryEntries.id, entryId));

          // 记录签到 spins 流水日志（docs/172 §5.5 P1）
          const [fresh] = await tx
            .select({ spinsLeft: lotteryEntries.spinsLeft })
            .from(lotteryEntries)
            .where(eq(lotteryEntries.id, entryId))
            .limit(1);
          await recordSpinLog(tx, {
            tenantId: draw.tenantId,
            entryId,
            userId: normalizedValue,
            delta: checkinReward,
            balanceAfter: Math.max(0, Number(fresh?.spinsLeft ?? 0)),
            reason: "checkin",
          });
        } else {
          // 无奖励：仅更新 streak
          await tx
            .update(lotteryEntries)
            .set({
              lastCheckinDate: today,
              checkinStreak: finalStreak,
            })
            .where(eq(lotteryEntries.id, entryId));
        }

        // 记录签到活动事件（与 commands.ts:610 对齐，用于数据分析）
        await recordActivityEvent(tx, {
          tenantId: draw.tenantId,
          drawId: draw.id,
          entryId,
          eventType: "daily_checkin",
          source: "public_web",
          medium: "join_draw",
          metadata: {
            reward: checkinReward,
            streakDays: finalStreak,
            mode: "public_checkin",
          },
        });
      }

      if (inviteCodeId) {
        const inviteResult = await tx
          .update(lotteryInviteCodes)
          .set({ usedCount: sql`${lotteryInviteCodes.usedCount} + 1` })
          .where(and(
            eq(lotteryInviteCodes.id, inviteCodeId),
            eq(lotteryInviteCodes.tenantId, draw.tenantId),
            eq(lotteryInviteCodes.drawId, draw.id),
            eq(lotteryInviteCodes.active, 1),
            sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
          ));
        if ((inviteResult.rowsAffected ?? 0) === 0) {
          throw new InviteCodeUnavailableError();
        }
      }

      // 消费验证码（事务内标记 used=1，失败自动回滚）
      if (options?.codeIdToConsume) {
        await tx.update(emailAccessCodes).set({ used: 1 }).where(eq(emailAccessCodes.id, options.codeIdToConsume));
      }

      // 提交 payload（问卷/投票/资料领取等）：与 entry 同事务写入，保证原子性。
      // 当 UNIQUE(tenant_id, draw_id, entry_id) 冲突时会抛异常，事务回滚。
      let submissionId: string | undefined;
      if (options?.submissionPayload) {
        submissionId = crypto.randomUUID();
        await tx.insert(activitySubmissions).values({
          id: submissionId,
          tenantId: draw.tenantId,
          drawId: draw.id,
          entryId,
          payloadJson: JSON.stringify(options.submissionPayload),
          idempotencyKey: String((options.submissionPayload as any)._idempotencyKey || ""),
        });
      }

      // ── 结果物化（闭环修复，2026-08 审查）──
      // 只有「按序分配结果」的活动类型写 activity_outcomes：
      //   signup_chain / waitlist：assigned（占位）或 waitlisted（候补）
      //   reservation：assigned（容量占位，满即拒、无候补）
      // 旧实现只对 signup_chain 写 outcome → reservation/waitlist 参与后 my-result
      // 查不到结果（outcome=null）、取消接口因无 outcome 永远失败（断链）。
      const isAssignmentKind =
        draw.activityKind === "signup_chain" ||
        draw.activityKind === "reservation" ||
        draw.activityKind === "waitlist";
      // ── docs/272 Phase 2：解析用户级邀请码的 pending 归因 ──
      // 当推荐人通过 ?ref={inviteCode} 分享活动，好友先于推荐人加入时，
      // recordAttributedJoin 写入 pending_user_attributed_join 事件。
      // 推荐人加入后，此处追溯解析：创建 shareRecord + 写入 attributed_join 事件。
      // registered 模式下 identityType=user_id，normalizedValue 即 userId。
      if (identityType === "user_id") {
        try {
          const [userRow] = await tx
            .select({ inviteCode: users.inviteCode })
            .from(users)
            .where(eq(users.id, normalizedValue))
            .limit(1);
          if (userRow?.inviteCode) {
            // P1 修复：传 inviteCode 而非 userId，确保与写入端 refCode 口径一致。
            // 幂等键 (tenantId, drawId, sharerEntryId, eventType, refCode) 中的 refCode
            // 在直接路径和 pending 路径都使用 inviteCode，去重行为对称。
            const resolvedAttributions = await resolvePendingUserAttributions(
              tx,
              userRow.inviteCode,
              entryId,
              draw.tenantId,
              draw.id,
            );
            // 为每个解析的归因触发推荐人奖励（与正常归因链路对齐）
            for (const attr of resolvedAttributions) {
              try {
                const ids = await maybeTriggerReward(tx, db, draw, {
                  attributed: true,
                  sharerEntryId: attr.sharerEntryId,
                  refCode: userRow.inviteCode,
                  shareRecordId: attr.shareRecordId,
                });
                rewardDeliveryIds.push(...ids);
              } catch (err) {
                // 奖励失败不影响参与主流程，但必须记录日志以便排查
                logWarn("joinDraw", `pending reward failed draw=${draw.id} sharer=${attr.sharerEntryId}`, String(err));
              }
            }
          }
        } catch (err) {
          // pending 解析失败不影响本次参与（容错设计：与 recordAttributedJoin 的 try-catch 对齐）
          logError("joinDraw", `resolvePendingUserAttributions failed draw=${draw.id} user=${normalizedValue}`, err);
        }
      }

      if (!isAssignmentKind) {
        const attribution = await recordAttributedJoin(tx, {
          tenantId: draw.tenantId,
          drawId: draw.id,
          entryId,
          refCode: options?.refCode,
          ipHash: options?.ipHash,
          userAgent: options?.userAgent,
          identityType,
        });
        const rewardIds = await maybeTriggerReward(tx, db, draw, attribution);
        rewardDeliveryIds.push(...rewardIds);
        return { joined: true, entryId, activityKind: draw.activityKind, attribution, submissionId };
      }

      // sequenceNo 用 MAX(sequence_no)+1 单调递增（闭环修复，2026-08 审查）：
      // 旧实现用 COUNT(*)（含本次新插入的 entry）计算序号，删除中间参与者后序号会复用，
      // 撞 activity_outcomes 的 UNIQUE(tenant,draw,outcomeType,assignment_no) → 新参与永久失败。
      // MAX+1 保证序号不复用；「第 N 位」展示删除前绝对报名序号，语义正确。
      const [{ maxSeq }] = await tx
        .select({ maxSeq: max(activityOutcomes.sequenceNo) })
        .from(activityOutcomes)
        .where(and(eq(activityOutcomes.tenantId, draw.tenantId), eq(activityOutcomes.drawId, draw.id)));
      const sequenceNo = Number(maxSeq ?? 0) + 1;
      // reservation 满即拒（acceptsWaitlist 只对 signup_chain 开放），因此不会出现 waitlisted；
      // waitlist kind 与 signup_chain 同语义（配 waitlist 策略时满额进候补）。
      const status = draw.maxParticipants && sequenceNo > draw.maxParticipants ? "waitlisted" : "assigned";
      const assignmentNo = status === "assigned" ? sequenceNo : null;
      const resultLabel = status === "assigned"
        ? `第 ${sequenceNo} 位`
        : `候补第 ${sequenceNo - (draw.maxParticipants || 0)} 位`;
      const outcomeId = crypto.randomUUID();
      await tx.insert(activityOutcomes).values({
        id: outcomeId,
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId,
        outcomeType: "assignment",
        status,
        sequenceNo,
        assignmentNo,
        resultKey: status === "assigned" ? `slot_${sequenceNo}` : `waitlist_${sequenceNo - (draw.maxParticipants || 0)}`,
        resultLabel,
        metadataJson: JSON.stringify({ source: draw.activityKind, allocationPolicy: draw.allocationPolicy }),
        decidedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const attribution = await recordAttributedJoin(tx, {
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId,
        refCode: options?.refCode,
        ipHash: options?.ipHash,
        userAgent: options?.userAgent,
        identityType,
      });

      const rewardIds = await maybeTriggerReward(tx, db, draw, attribution);
      rewardDeliveryIds.push(...rewardIds);

      return {
        joined: true,
        entryId,
        activityKind: draw.activityKind,
        attribution,
        submissionId,
        outcome: {
          id: outcomeId,
          drawId: draw.id,
          entryId,
          outcomeType: "assignment",
          status,
          sequenceNo,
          assignmentNo,
          resultLabel,
        },
      };
    });

    // 事务外异步 dispatch reward.earned webhook（与 handlePaymentCallback 一致）：
    // 事务已提交，dispatchWebhookDelivery 能读到 delivery 记录。
    // 失败不影响参与主流程（processPendingWebhookDeliveries 定时任务会补投）。
    if (rewardDeliveryIds.length > 0) {
      for (const deliveryId of rewardDeliveryIds) {
        void dispatchWebhookDelivery(db, draw.tenantId, deliveryId).catch((err) => {
          logError("participation", `reward webhook dispatch delivery=${deliveryId}`, err);
        });
      }
    }

    return result;
  } catch (err: unknown) {
    if (err instanceof InviteCodeUnavailableError) {
      return { joined: false, message: "邀请码无效或已用完" };
    }
    // UNIQUE 约束冲突：同一参与者重复提交
    // LibSQL/Drizzle 可能把文案放在 message 或 cause 链上（docs/110）
    if (isUniqueConstraintError(err)) {
      try {
        const [exist] = await db
          .select({ id: lotteryEntries.id })
          .from(lotteryEntries)
          .where(and(
            eq(lotteryEntries.tenantId, draw.tenantId),
            eq(lotteryEntries.drawId, draw.id),
            eq(lotteryEntries.identityType, identityType),
            eq(lotteryEntries.identityValue, checkinDateSuffix ? uniqueValue : normalizedValue),
          ))
          .limit(1);
        return {
          joined: false,
          message: "您已参与此活动",
          alreadyJoined: true as const,
          entryId: exist?.id,
        };
      } catch {
        return { joined: false, message: "您已参与此活动", alreadyJoined: true as const };
      }
    }
    throw err;
  }
}

class InviteCodeUnavailableError extends Error {
  constructor() {
    super("邀请码无效或已用完");
    this.name = "InviteCodeUnavailableError";
  }
}

/** 识别 SQLite/LibSQL UNIQUE 冲突（含 cause 链与 code 字段） */
function isUniqueConstraintError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth += 1) {
    if (typeof cur === "object") {
      const o = cur as { message?: string; code?: string; cause?: unknown; rawCode?: number };
      const msg = String(o.message || "");
      const code = String(o.code || "");
      if (
        /UNIQUE constraint/i.test(msg) ||
        /SQLITE_CONSTRAINT_UNIQUE/i.test(msg) ||
        /SQLITE_CONSTRAINT_UNIQUE/i.test(code) ||
        code === "SQLITE_CONSTRAINT" && /unique/i.test(msg) ||
        o.rawCode === 2067
      ) {
        return true;
      }
      cur = o.cause;
      continue;
    }
    if (typeof cur === "string" && /UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(cur)) {
      return true;
    }
    break;
  }
  return false;
}

/**
 * 接龙活动：取消参与 + 候补转正。
 *
 * 场景：用户报名接龙后想退出（如行程变化），释放名额后应让候补队列第一位自动补位。
 *
 * 处理流程（事务内）：
 * 1. 删除该用户的活动参与记录（lottery_entries）和结果（activity_outcomes）
 * 2. 若有候补用户（status='waitlisted'），把序列号最小的一位转正为 assigned，
 *    分配被释放的序号——保证"先到先得"的候补队列公平性
 *
 * 返回：
 * - cancelled: 是否成功取消
 * - promoted: 是否有候补转正（名额被释放）
 */
export async function cancelSignupChainEntry(
  db: DbType,
  tenantId: string,
  drawId: string,
  email: string,
): Promise<{ cancelled: boolean; promoted: boolean }> {
  const normalizedEmail = email.trim().toLowerCase();
  return withDbTransaction(db, async (tx) => {
    // 查找参与记录（identity_value 为该邮箱）
    const [entry] = await tx
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.tenantId, tenantId),
        eq(lotteryEntries.drawId, drawId),
        eq(lotteryEntries.identityValue, normalizedEmail),
      ))
      .limit(1);
    if (!entry) return { cancelled: false, promoted: false };

    // 查找该参与者的结果（assigned 或 waitlisted）
    const [outcome] = await tx
      .select({ id: activityOutcomes.id, status: activityOutcomes.status, sequenceNo: activityOutcomes.sequenceNo })
      .from(activityOutcomes)
      .where(and(
        eq(activityOutcomes.tenantId, tenantId),
        eq(activityOutcomes.drawId, drawId),
        eq(activityOutcomes.entryId, entry.id),
      ))
      .limit(1);
    // 闭环修复（2026-08 审查）：旧 reservation/waitlist 数据无 outcome 行，仍允许取消——
    // 直接删除 entry 释放容量（普通容量 = COUNT(entries)），不依赖 outcome 存在。
    if (!outcome) {
      await tx.delete(lotteryEntries).where(eq(lotteryEntries.id, entry.id));
      return { cancelled: true, promoted: false };
    }

    // 删除参与记录和结果
    await tx.delete(activityOutcomes).where(eq(activityOutcomes.id, outcome.id));
    await tx.delete(lotteryEntries).where(eq(lotteryEntries.id, entry.id));

    let promoted = false;

    // 若被取消者原本占用了名额（assigned），且存在候补 → 候补第 1 位转正
    if (outcome.status === "assigned") {
      const [nextWaitlisted] = await tx
        .select({ id: activityOutcomes.id, entryId: activityOutcomes.entryId })
        .from(activityOutcomes)
        .where(and(
          eq(activityOutcomes.tenantId, tenantId),
          eq(activityOutcomes.drawId, drawId),
          eq(activityOutcomes.status, "waitlisted"),
        ))
        .orderBy(asc(activityOutcomes.sequenceNo))
        .limit(1);

      if (nextWaitlisted) {
        const now = new Date().toISOString();
        // 候补第 1 位转正：分配被释放的序号，标记为已占位
        await tx.update(activityOutcomes)
          .set({
            status: "assigned",
            assignmentNo: outcome.sequenceNo, // 复用被释放的序号
            sequenceNo: outcome.sequenceNo,
            resultKey: `slot_${outcome.sequenceNo}`,
            resultLabel: `第 ${outcome.sequenceNo} 位`,
            updatedAt: now,
            decidedAt: now,
          })
          .where(eq(activityOutcomes.id, nextWaitlisted.id));
        promoted = true;
      }
    }

    return { cancelled: true, promoted };
  });
}

/**
 * 归因成功后按活动 reward 配置触发奖励意图（docs/111 §5 阶段一）。
 *
 * - 仅当活动 activityConfig 中配置了 reward.perInviteAmount 时才触发；
 *   未配置或配额超限时静默跳过，不影响任何现有活动。这是设计原则：
 *   reward 是附加行为，不是参与的必要条件。如果 reward 触发失败，参与仍应成功。
 * - 与 joinDraw 同事务执行：归因、配额消耗、奖励意图入队三者原子。
 * - 返回 deliveryIds 给 joinDraw，由 joinDraw 在事务提交后异步 dispatch
 *   dispatchWebhookDelivery（与 handlePaymentCallback 模式一致，避免事务未提交
 *   时主连接读不到 delivery 记录，docs/274 修正）。
 *   如果 triggerRewardEarned 抛异常（catch 捕获），事务仍会提交参与记录：
 *   奖励是附加行为，参与主流程不应因奖励失败而回滚。
 *   此设计与 grantLoserRewards 的容错原则一致——"开奖成功，未中奖发券失败"不回滚开奖结果。
 */
async function maybeTriggerReward(
  tx: DbType,
  db: DbType,
  draw: { id: string; tenantId: string; activityKind?: string | null; resultMode?: string | null; maxSpinsPerEntry?: number | null; promotionConfig?: string | null },
  attribution: { attributed: boolean; sharerEntryId?: string; refCode?: string; shareRecordId?: string },
): Promise<string[]> {
  if (!attribution.attributed || !attribution.sharerEntryId) return [];

  // ── 奖励触发条件差异（docs/254 审查确认）──
  // 路径[1] grantViralSpinsToSharer：仅 resultMode === "instant" 触发（viral.extraSpinsPerInvite）
  // 路径[4] processReferralRewardsEngine：所有活动 + 有 shareRecordId（referralRewardDefs）
  // 路径[1] 与路径[4] 是互补两层，不再互斥（docs/259 D2）：
  // [1] 基础激励层（每邀请固定 +N，即时反馈/排行榜/延迟开奖权重）、
  // [4] 里程碑加成层（达阈值一次性加成 + 券码出口）。
  // 两者可同时触发，写入安全由共同出口 grantBonusSpin 的 spinsTotalGranted CAS 保证，
  // 总量由 maxSpinsPerEntry 硬顶兜底；[1] 额外受 viral.maxExtraSpins 子顶约束。
  // 所有路径容错一致：try/catch 包裹，奖励失败不影响参与主流程（docs/116 容错原则）。
  // 注：旧路径[2] processReferralMilestoneRewards（referralRewards 里程碑）已收敛删除（docs/255 P1-2），
  // 统一由路径[4] referralRewardDefs 覆盖（bonus_spin 语义完全等价）。

  // instant 裂变：有效 join → 邀请人 +spins（双封顶）；失败不回滚参与（docs/116）
  if (String(draw.resultMode || "") === "instant") {
    try {
      await grantViralSpinsToSharer(tx, draw, attribution.sharerEntryId, attribution.shareRecordId);
    } catch (err) {
      // P1-2：奖励发放失败必须落库，供管理端补发入口查询
      // P3 修复（docs/271）：DB 断连时 recordActivityEvent 也会失败，
      // .catch 降级为 logError 确保运维通过 stderr/监控感知事件记录丢失，
      // 而非静默吞掉导致管理端完全无感知。
      await recordActivityEvent(tx, {
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId: attribution.sharerEntryId,
        eventType: "reward_failed",
        refCode: attribution.refCode || "",
        metadata: {
          path: "grantViralSpinsToSharer",
          error: err instanceof Error ? err.message : String(err),
          shareRecordId: attribution.shareRecordId,
        },
      }).catch((recordErr) => {
        logError("participation", `reward_failed event also lost (grantViralSpinsToSharer) draw=${draw.id}`, recordErr);
      });
      logError("participation", `grantViralSpinsToSharer draw=${draw.id}`, err);
    }
  }

  // [4] engine-powered 推荐奖励（docs/250）：读取 referralRewardDefs。
  // 容错与旧路径一致：try/catch 包裹，奖励失败不影响参与主流程。
  if (attribution.shareRecordId) {
    try {
      await processReferralRewardsEngine(tx, draw, attribution.shareRecordId);
    } catch (err) {
      // P1-2：奖励发放失败必须落库，供管理端补发入口查询
      // P3 修复（docs/271）：DB 断连时 recordActivityEvent 也会失败，
      // .catch 降级为 logError 确保运维通过 stderr/监控感知事件记录丢失。
      await recordActivityEvent(tx, {
        tenantId: draw.tenantId,
        drawId: draw.id,
        entryId: attribution.sharerEntryId,
        eventType: "reward_failed",
        refCode: attribution.refCode || "",
        metadata: {
          path: "processReferralRewardsEngine",
          error: err instanceof Error ? err.message : String(err),
          shareRecordId: attribution.shareRecordId,
        },
      }).catch((recordErr) => {
        logError("participation", `reward_failed event also lost (processReferralRewardsEngine) draw=${draw.id}`, recordErr);
      });
      logError("participation", `processReferralRewardsEngine draw=${draw.id}`, err);
    }
  }

  try {
    const sharerIdentity = await getSharerIdentityValue(tx, draw.tenantId, draw.id, attribution.sharerEntryId);
    const result = await triggerRewardEarned(
      tx,
      draw.tenantId,
      draw.id,
      attribution.sharerEntryId,
      sharerIdentity,
      attribution.refCode || "",
    );
    // 返回 deliveryIds 给调用方（joinDraw），由调用方在事务提交后统一 dispatch。
    // 不能在事务内/未提交时 dispatch——dispatchWebhookDelivery 内含 fetch + 写库，
    // 且事务未提交时主连接读不到 delivery 记录（docs/274 修正）。
    return result.deliveryIds;
  } catch (err) {
    // 奖励触发失败不影响参与成功（与 grantLoserRewards 的容错一致）
    // P1-2：奖励发放失败必须落库，供管理端补发入口查询
    // P3 修复（docs/271）：DB 断连时 recordActivityEvent 也会失败，
    // .catch 降级为 logError 确保运维通过 stderr/监控感知事件记录丢失。
    await recordActivityEvent(tx, {
      tenantId: draw.tenantId,
      drawId: draw.id,
      entryId: attribution.sharerEntryId,
      eventType: "reward_failed",
      refCode: attribution.refCode || "",
      metadata: {
        path: "triggerRewardEarned",
        error: err instanceof Error ? err.message : String(err),
        shareRecordId: attribution.shareRecordId,
      },
    }).catch((recordErr) => {
      logError("participation", `reward_failed event also lost (triggerRewardEarned) draw=${draw.id}`, recordErr);
    });
    logError("participation", `triggerRewardEarned draw=${draw.id}`, err);
    return [];
  }
}

/**
 * 邀请人 instant +spins：actual = min(perInvite, maxSpins-granted, maxExtra-viral)。
 * 配置优先 promotion_config.viral.extraSpinsPerInvite / maxExtraSpins；
 * 缺省回退 extraEntriesPerInvite / maxExtraEntries 数字（文案仍须 instant 分键）。
 * @param shareRecordId 触发本次奖励的分享记录 id（P2 审查项：spins_log.refId 反查具体邀请事件）
 */
async function grantViralSpinsToSharer(
  tx: DbType,
  draw: { id: string; tenantId: string; maxSpinsPerEntry?: number | null; promotionConfig?: string | null },
  sharerEntryId: string,
  shareRecordId?: string,
) {
  const maxSpins = Number(draw.maxSpinsPerEntry ?? 0);
  if (maxSpins < 1) return;

  let extra = 0;
  let maxExtra = 0;
  try {
    const pc = JSON.parse(draw.promotionConfig || "{}") as {
      viral?: {
        enabled?: boolean;
        extraSpinsPerInvite?: number;
        maxExtraSpins?: number;
        extraEntriesPerInvite?: number;
        maxExtraEntries?: number;
      };
    };
    const viral = pc?.viral;
    // P2 审查项：统一严格 ===true 判定（enabled="true" 字符串视为未启用，与排行榜/发布预检一致）
    if (!isViralEnabled(viral) || !viral) return;
    // docs/255 P2-4：统一用 readViralPerInvite 读取（优先 extraSpins*，回退 extraEntries*）
    const perInviteCfg = readViralPerInvite(viral);
    extra = perInviteCfg.perInvite;
    maxExtra = perInviteCfg.maxExtra;
  } catch {
    return;
  }
  if (extra <= 0 || maxExtra <= 0) return;

  // 出口收敛（docs/259 D2 ③）：与里程碑层共用 grantBonusSpin，
  // 一处 read-then-CAS + 一处 spins_log + 一处 reward_earned 审计。
  // maxViralExtra 传入 = 本次发放计入 spinsViralEarned 并受裂变子顶裁剪（基础层语义）。
  await grantBonusSpin(
    tx,
    draw.tenantId,
    draw.id,
    sharerEntryId,
    extra,
    maxSpins,
    `viral:${shareRecordId ?? "na"}`,
    {
      source: "viral",
      maxViralExtra: maxExtra,
      // refId 关联触发本次奖励的 shareRecord（审计可反查具体邀请事件）
      refId: shareRecordId ? `share:${shareRecordId}` : undefined,
    },
  );
}
type EntryIdentityForSelfInviteCheck = {
  identityType: string | null;
  identityValue: string | null;
};

/**
 * 自邀请身份规范化。
 *
 * 签到活动会把 identity_value 写成 `邮箱:YYYY-MM-DD`，用于允许同一人每日签到。
 * 裂变归因比较时必须剥离日期后缀，否则同一人跨日带自己的 ref 会被误判为新邀请。
 */
function baseIdentityValue(value: string | null | undefined) {
  const s = String(value || "").trim().toLowerCase();
  const m = s.match(/^(.*):(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1]! : s;
}

/**
 * 判断两个 entry 是否代表同一个真实参与者。
 *
 * 同类型：直接比较规范化后的 identity_value。
 * 跨类型：仅支持 email ↔ user_id 的强证明路径，通过 users 表反查 user_id 的邮箱。
 *
 * 为什么不做更激进的字符串猜测：手机号、平台 openid、邮箱等身份体系可能存在同名但不同人的情况。
 * 自邀请拦截宁可少拦，也不能误伤正常邀请；只有能从账号表证明同一邮箱时才判定 selfInvite。
 */
async function isSameParticipantIdentity(
  db: DbWriteScope,
  left: EntryIdentityForSelfInviteCheck,
  right: EntryIdentityForSelfInviteCheck,
): Promise<boolean> {
  const leftType = String(left.identityType || "").trim().toLowerCase();
  const rightType = String(right.identityType || "").trim().toLowerCase();
  const leftValue = baseIdentityValue(left.identityValue);
  const rightValue = baseIdentityValue(right.identityValue);
  if (!leftType || !rightType || !leftValue || !rightValue) return false;

  if (leftType === rightType) {
    return leftValue === rightValue;
  }

  const pair = new Set([leftType, rightType]);
  if (!pair.has("email") || !pair.has("user_id")) {
    return false;
  }

  const emailValue = leftType === "email" ? leftValue : rightValue;
  const userIdValue = leftType === "user_id" ? leftValue : rightValue;
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userIdValue))
    .limit(1);
  return Boolean(user?.email && String(user.email).trim().toLowerCase() === emailValue);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 用户级邀请码（docs/272）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 生成用户级邀请码：8 位大写字母+数字，去掉易混淆字符（0O1Il）。
 * 31^8 ≈ 8.5×10^11 种组合，碰撞概率极低；DB UNIQUE 索引兜底防重。
 * URL 安全、易读易记，适合口头传播和社交媒体分享。
 */
const INVITE_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateUserInviteCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => INVITE_CODE_CHARS[b % INVITE_CODE_CHARS.length]).join("");
}

/**
 * 解析用户级邀请码的 pending 归因事件（docs/272 Phase 2）。
 *
 * 当推荐人（referrer）通过用户级邀请码分享活动，好友在推荐人加入前就参与时，
 * recordAttributedJoin 无法创建 shareRecord（推荐人尚无 entry），
 * 因此写入 eventType="pending_user_attributed_join" 的活动事件。
 *
 * 推荐人加入活动后，本函数：
 * 1. 查找该推荐人在当前活动的 pending 事件（仅限当前 drawId，跨活动待各自加入时解析）
 * 2. 为该活动创建或复用 shareRecord（joinedCount=组内事件数）
 * 3. 自邀请检测：推荐人 identity 与被邀请人 identity 一致时跳过
 * 4. 写入 attributed_join 事件（与正常归因链路对齐，确保奖励引擎可消费）
 * 5. 返回归因信息供调用方触发推荐人奖励
 *
 * @param db 数据库实例
 * @param referrerInviteCode 推荐人的 users.inviteCode（用于按 pending 事件 refCode 匹配）
 * @param referrerEntryId 推荐人在当前活动的 lotteryEntries.id
 * @param tenantId 租户 ID
 * @param drawId 活动 ID（仅解析该活动的 pending 事件）
 * @returns 本次解析的归因列表（含 shareRecordId、sharerEntryId，供奖励触发使用）
 */
export type ResolvedPendingAttribution = {
  shareRecordId: string;
  sharerEntryId: string;
  tenantId: string;
  drawId: string;
};

export async function resolvePendingUserAttributions(
  db: DbWriteScope,
  referrerInviteCode: string,
  referrerEntryId: string,
  tenantId: string,
  drawId: string,
): Promise<ResolvedPendingAttribution[]> {
  // 仅解析当前活动的 pending 归因事件（跨活动的待推荐人加入对应活动时再解析）
  // P1 修复：按 inviteCode 查询（与写入端 refCode 口径对齐）。
  // 旧实现按 userId 查询，但写入端已改为存 inviteCode，此处需同步。
  const pendingEvents = await db
    .select({
      id: activityEvents.id,
      drawId: activityEvents.drawId,
      entryId: activityEvents.entryId,
      refCode: activityEvents.refCode,
      ipHash: activityEvents.ipHash,
      userAgent: activityEvents.userAgent,
    })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.tenantId, tenantId),
      eq(activityEvents.eventType, "pending_user_attributed_join"),
      eq(activityEvents.refCode, referrerInviteCode),
      eq(activityEvents.drawId, drawId),
    ));

  if (pendingEvents.length === 0) return [];

  // 读取推荐人 entry 的 identity（用于自邀请检测）
  const [referrerEntry] = await db
    .select({
      identityType: lotteryEntries.identityType,
      identityValue: lotteryEntries.identityValue,
    })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, referrerEntryId),
      eq(lotteryEntries.tenantId, tenantId),
      eq(lotteryEntries.drawId, drawId),
    ))
    .limit(1);

  const resolved: ResolvedPendingAttribution[] = [];

  // SQL 已按 drawId 精确过滤，结果必然属于同一 drawId，无需分组。
  // 直接处理 pendingEvents，省去 Map 构建开销。
  if (pendingEvents.length > 0) {
    // 查找或创建该推荐人在目标活动的 shareRecord
    const [existingShare] = await db
      .select({ id: shareRecords.id, joinedCount: shareRecords.joinedCount })
      .from(shareRecords)
      .where(and(
        eq(shareRecords.tenantId, tenantId),
        eq(shareRecords.drawId, drawId),
        eq(shareRecords.sharerEntryId, referrerEntryId),
      ))
      .limit(1);

    let shareId: string;
    if (existingShare) {
      // 已有 shareRecord（推荐人先于部分被邀请人加入）→ 累加 joinedCount
      shareId = existingShare.id;
      await db
        .update(shareRecords)
        .set({ joinedCount: sql`${shareRecords.joinedCount} + ${pendingEvents.length}` })
        .where(eq(shareRecords.id, shareId));
    } else {
      // 首次为该活动创建 shareRecord（推荐码先于推荐人参与）
      // shareCode 使用合成格式确保 UNIQUE 索引不冲突（每个 draw+referrer 组合唯一）
      shareId = crypto.randomUUID();
      const syntheticShareCode = `uc_${referrerInviteCode.slice(0, 8)}_${drawId.slice(0, 6)}_${shareId.slice(0, 6)}`;
      await db.insert(shareRecords).values({
        id: shareId,
        tenantId,
        drawId,
        sharerEntryId: referrerEntryId,
        shareCode: syntheticShareCode,
        joinedCount: pendingEvents.length,
      });
    }

    // 为每个 pending 事件写入正式的 attributed_join 事件（与正常归因链路对齐）
    // 奖励引擎通过 attributed_join 事件触发，不直接读 shareRecords
    for (const evt of pendingEvents) {
      // 自邀请检测：推荐人 identity 与被邀请人 identity 一致时跳过
      if (referrerEntry) {
        const [joinerEntry] = await db
          .select({
            identityType: lotteryEntries.identityType,
            identityValue: lotteryEntries.identityValue,
          })
          .from(lotteryEntries)
          .where(and(
            eq(lotteryEntries.id, evt.entryId),
            eq(lotteryEntries.tenantId, tenantId),
            eq(lotteryEntries.drawId, drawId),
          ))
          .limit(1);
        if (joinerEntry && await isSameParticipantIdentity(db, referrerEntry, joinerEntry)) {
          // 自邀请：回滚 joinedCount 并跳过
          await db
            .update(shareRecords)
            .set({ joinedCount: sql`${shareRecords.joinedCount} - 1` })
            .where(eq(shareRecords.id, shareId));
          continue;
        }
      }

      await recordActivityEvent(db, {
        tenantId,
        drawId,
        entryId: evt.entryId,
        eventType: "attributed_join",
        refCode: String(evt.refCode || ""),
        ipHash: String(evt.ipHash || ""),
        userAgent: String(evt.userAgent || ""),
        metadata: {
          shareRecordId: shareId,
          sharerEntryId: referrerEntryId,
          resolvedFrom: "pending_user_attributed_join",
        },
      });
      resolved.push({
        shareRecordId: shareId,
        sharerEntryId: referrerEntryId,
        tenantId,
        drawId,
      });
    }

    // 清理已解析的 pending 事件（防重复解析）
    const eventIds = pendingEvents.map((e) => e.id);
    if (eventIds.length > 0) {
      await db
        .delete(activityEvents)
        .where(inArray(activityEvents.id, eventIds));
    }
  }

  return resolved;
}

async function recordAttributedJoin(
  db: DbWriteScope,
  input: {
    tenantId: string;
    drawId: string;
    entryId: string;
    refCode?: string;
    ipHash?: string;
    userAgent?: string;
    /** 活动参与者的身份类型。非 user_id 活动无用户级邀请码，跳过 pending 事件写入 */
    identityType?: string;
  },
) {
  const refCode = String(input.refCode || "").trim();
  if (!refCode) return { attributed: false };

  let [share] = await db
    .select({
      id: shareRecords.id,
      sharerEntryId: shareRecords.sharerEntryId,
    })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, input.tenantId),
      eq(shareRecords.drawId, input.drawId),
      eq(shareRecords.shareCode, refCode),
    ))
    .limit(1);

  // ── 用户级邀请码降级（docs/272 Phase 1）──
  // shareRecords 查找失败时，尝试将 refCode 识别为 users.inviteCode。
  // 用户注册时生成固定邀请码（如 "ABC12345"），通过 ?ref=ABC12345 分享活动链接，
  // 无需先参与即可邀请好友。好友加入时走此降级路径完成归因。
  if (!share) {
    const [referrerUser] = await db
      .select({ id: users.id, inviteCode: users.inviteCode })
      .from(users)
      .where(eq(users.inviteCode, refCode))
      .limit(1);
    if (!referrerUser) return { attributed: false };

    // 查找推荐人在当前活动的 entry（可能尚未参与）
    // registered 模式下 identityType=user_id，identityValue=users.id
    const [referrerEntry] = await db
      .select({ id: lotteryEntries.id })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.identityType, "user_id"),
        eq(lotteryEntries.identityValue, referrerUser.id),
        eq(lotteryEntries.drawId, input.drawId),
        eq(lotteryEntries.tenantId, input.tenantId),
      ))
      .limit(1);

    if (referrerEntry) {
      // 推荐人已参与本活动 → 即时归因
      // 自邀请检测：推荐人与被邀请人是同一人时跳过
      if (referrerEntry.id === input.entryId) {
        return { attributed: false, selfInvite: true as const, refCode };
      }

      // P0 修复：按 (sharerEntryId, drawId) 查找已有 shareRecord，而非 shareCode。
      // 原因：用户级邀请码是固定值，多人用同一邀请码时 shareCode UNIQUE 会冲突。
      // 改为按推荐人+活动维度查找，首个加入者创建 shareRecord，后续加入者累加 joinedCount。
      let shareId: string;
      const [existingShare] = await db
        .select({ id: shareRecords.id, joinedCount: shareRecords.joinedCount })
        .from(shareRecords)
        .where(and(
          eq(shareRecords.tenantId, input.tenantId),
          eq(shareRecords.drawId, input.drawId),
          eq(shareRecords.sharerEntryId, referrerEntry.id),
        ))
        .limit(1);

      if (existingShare) {
        shareId = existingShare.id;
        await db
          .update(shareRecords)
          .set({ joinedCount: sql`${shareRecords.joinedCount} + 1` })
          .where(eq(shareRecords.id, shareId));
      } else {
        shareId = crypto.randomUUID();
        // shareCode 使用合成格式，避免与 inviteCode 的 UNIQUE 约束冲突
        const syntheticShareCode = `uc_${referrerUser.id.slice(0, 8)}_${input.drawId.slice(0, 6)}_${shareId.slice(0, 6)}`;
        await db.insert(shareRecords).values({
          id: shareId,
          tenantId: input.tenantId,
          drawId: input.drawId,
          sharerEntryId: referrerEntry.id,
          shareCode: syntheticShareCode,
          joinedCount: 1,
        });
      }

      await recordActivityEvent(db, {
        tenantId: input.tenantId,
        drawId: input.drawId,
        entryId: input.entryId,
        eventType: "attributed_join",
        refCode,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
        metadata: {
          shareRecordId: shareId,
          sharerEntryId: referrerEntry.id,
          resolvedFrom: "user_invite_code",
        },
      });

      return { attributed: true, refCode, shareRecordId: shareId, sharerEntryId: referrerEntry.id };
    }

    // 推荐人尚未参与本活动 → 写入 pending 事件，推荐人加入时追溯解析
    // P1 修复：refCode 存 inviteCode（非 userId），确保与直接归因路径的幂等键口径一致。
    // 旧实现存 userId 导致 pending 路径的幂等键与直接路径不对称——同一邀请人的多个好友
    // 在直接路径被幂等拦截（refCode=inviteCode 恒定），在 pending 路径却不被拦截（refCode=joinerUserId 各异）。
    //
    // P2-1 守卫：仅 user_id 活动写入 pending 事件。
    // 非 registered 活动（email/password/roster 等）的参与者无用户级邀请码概念，
    // 且 resolvePendingUserAttributions 仅在 identityType === "user_id" 时触发，
    // 写入的 pending 事件永远不会被解析，只会膨胀 activityEvents 表。
    if (input.identityType === "user_id") {
      await recordActivityEvent(db, {
        tenantId: input.tenantId,
        drawId: input.drawId,
        entryId: input.entryId,
        eventType: "pending_user_attributed_join",
        refCode,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
        metadata: {
          referrerUserId: referrerUser.id,
          joinerEntryId: input.entryId,
        },
      });
    }

    return { attributed: false, pending: true as const, refCode, referrerUserId: referrerUser.id };
  }

  /**
   * 自邀请不计分（docs/112）：
   * - 仅比 entryId 不够：首次 join 的新 entryId 永远 ≠ 已有 sharerEntryId
   * - 真实刷票：同 identity（邮箱/user_id）用自己的 ref 再参与（签到跨日、脏路径等）
   * - 防御：分享者 entry 的 identity 与当前参与者 identity 一致 → 不涨分
   * - entryId 相等仍挡一层（脏数据 / 未来路径）
   */
  if (share.sharerEntryId && share.sharerEntryId === input.entryId) {
    return { attributed: false, selfInvite: true as const, refCode, shareRecordId: share.id };
  }
  if (share.sharerEntryId) {
    const [sharerEntry] = await db
      .select({
        identityType: lotteryEntries.identityType,
        identityValue: lotteryEntries.identityValue,
      })
      .from(lotteryEntries)
      .where(and(
        eq(lotteryEntries.id, share.sharerEntryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        eq(lotteryEntries.drawId, input.drawId),
      ))
      .limit(1);
    if (sharerEntry) {
      const [joinerEntry] = await db
        .select({
          identityType: lotteryEntries.identityType,
          identityValue: lotteryEntries.identityValue,
        })
        .from(lotteryEntries)
        .where(and(
          eq(lotteryEntries.id, input.entryId),
          eq(lotteryEntries.tenantId, input.tenantId),
          eq(lotteryEntries.drawId, input.drawId),
        ))
        .limit(1);
      if (joinerEntry) {
        if (await isSameParticipantIdentity(db, sharerEntry, joinerEntry)) {
          return { attributed: false, selfInvite: true as const, refCode, shareRecordId: share.id };
        }
      }
    }
  }

  // 原子递增 joinedCount：SQL 层面 SET joined_count = joined_count + 1，
  // SQLite 写锁序列化并发事务，不会丢失更新。
  // 注意：同一 refCode 多次归因会多次 +1（如签到跨日重复参与），
  // 但奖励引擎的 CAS 幂等标记（rewardMilestonesGranted）防止重复发放。
  await db
    .update(shareRecords)
    .set({ joinedCount: sql`${shareRecords.joinedCount} + 1` })
    .where(eq(shareRecords.id, share.id));

  await recordActivityEvent(db, {
    tenantId: input.tenantId,
    drawId: input.drawId,
    entryId: input.entryId,
    eventType: "attributed_join",
    refCode,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
    metadata: {
      shareRecordId: share.id,
      sharerEntryId: share.sharerEntryId,
    },
  });

  return { attributed: true, refCode, shareRecordId: share.id, sharerEntryId: share.sharerEntryId };
}

/**
 * 查询参与者在活动中的结果。
 * 公开接口只能通过活动 slug + 身份查找，管理接口必须额外传租户。
 */
export async function getActivityOutcome(
  db: DbType,
  tenantId: string,
  drawId: string,
  entryId: string,
) {
  const [outcome] = await db
    .select()
    .from(activityOutcomes)
    .where(and(
      eq(activityOutcomes.tenantId, tenantId),
      eq(activityOutcomes.drawId, drawId),
      eq(activityOutcomes.entryId, entryId),
    ))
    .limit(1);
  return outcome || null;
}

export async function getActivityOutcomes(
  db: DbType,
  tenantId: string,
  drawId: string,
  limit = 100,
  offset = 0,
) {
  return db
    .select()
    .from(activityOutcomes)
    .where(and(eq(activityOutcomes.tenantId, tenantId), eq(activityOutcomes.drawId, drawId)))
    .orderBy(activityOutcomes.sequenceNo)
    .limit(limit)
    .offset(offset);
}

/**
 * 获取候选池列表（分页，带租户隔离）。
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

/**
 * 校准 activeParticipantCount 计数器 — 只读告警模式（docs/262 H1 修复）。
 *
 * 背景：activeParticipantCount 由 5 条独立路径维护（joinDraw ±1、createPaymentOrder +N、
 * expireOverdueOrders -N、cancelPaymentOrder -N），若进程在回滚前崩溃，
 * 计数器可能永久偏移（偏低→超卖，偏高→拒绝正常参与）。
 *
 * 为什么改为只读告警：
 * - 旧逻辑用 COUNT(entries) 校准，但 activeParticipantCount 语义是"占用名额数"
 *   （一个 entry 可占多份名额，如 quantity=3），COUNT 与语义不一致
 * - 自动改数可能把多占的名额压低，导致后续 CAS 放行更多销售 → 超卖
 * - 改为 diff≠0 时打日志 + 记录审计事件，人工介入，风险最低
 *
 * @returns 检测到偏差的活动数量（仅告警，不自动修正）
 */
export async function calibrateActiveParticipantCounts(db: DbType): Promise<number> {
  // 只检测 open/paused 状态的活动（drawing/drawn/cancelled 不再接受新参与，无需检测）
  const draws = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      title: lotteryDraws.title,
      currentCount: lotteryDraws.activeParticipantCount,
    })
    .from(lotteryDraws)
    .where(or(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.status, "paused"),
    ));

  let alerted = 0;
  for (const draw of draws) {
    try {
      // 有效参与 = 非空/非过期的 entry（与 joinDraw 的 CAS 条件对齐）
      // 注意：这是 entry 行数，不是名额数。一个 entry 可能占多份名额（quantity>1），
      // 所以这里只用于告警，不用于自动修正。
      const [row] = await db
        .select({ cnt: count() })
        .from(lotteryEntries)
        .where(and(
          eq(lotteryEntries.drawId, draw.id),
          eq(lotteryEntries.tenantId, draw.tenantId),
          sql`${lotteryEntries.paymentStatus} NOT IN ('', 'expired')`,
        ));
      const entryCount = row?.cnt ?? 0;
      const diff = entryCount - (draw.currentCount ?? 0);
      // 只在 diff > 0 时告警（entryCount > currentCount，计数器偏低，有超卖风险）
      // diff < 0 是正常情况（quantity>1 时 currentCount > entryCount）或计数器偏高（保守，不超卖，风险低）
      if (diff > 0) {
        // 只读告警：记录偏差但不自动修正，避免 COUNT(entries) 与名额语义不一致导致超卖
        logWarn("participation",
          `activeParticipantCount 偏差告警: draw=${draw.id} title="${draw.title}" ` +
          `currentCount=${draw.currentCount} entryCount=${entryCount} diff=${diff}`
        );
        alerted++;
      }
    } catch (err) {
      // 单活动检测失败不中断其他活动
      logError("participation", `calibrateActiveParticipantCounts draw=${draw.id} failed`, err);
    }
  }
  return alerted;
}
