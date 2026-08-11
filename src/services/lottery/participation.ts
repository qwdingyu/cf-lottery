/**
 * 抽奖服务层 — 参与域（lottery-service 拆分，docs/049 #17）
 *
 * 用户参与入口：joinDraw（四种参与模式：open/roster/password/invite_code，
 * 含活动级容量条件 INSERT、验证码消费、每日签到日期后缀）、接龙取消、
 * 结果查询（getActivityOutcome(s)）、候选池读取（getEntries）。
 * 依赖 utils（访问密码验证）与 integration（活动事件），无反向依赖。
 */
import type { DbType, DbWriteScope } from "../../db/client";
import { withDbTransaction } from "../../db/client";
import { and, eq, inArray, sql, count, asc } from "drizzle-orm";
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
} from "../../db/schema";
import { verifyAccessPassword } from "./utils";
import { recordActivityEvent, dispatchWebhookDelivery } from "./integration";
import { triggerRewardEarned, getSharerIdentityValue } from "./reward";
import { computeViralSpinGrant, initialSpinsForJoin } from "./spin-quota";
import { recordSpinLog } from "./spins-log";
import {
  parseFlashSaleConfig,
  resolveEffectiveStockLimit,
} from "../../lib/flash-sale-config";
import { parseActivityOperationalConfig } from "../../lib/activity-config";
import {
  isRetryablePaymentOrderStatus,
  PAYMENT_ENTRY_STATUS,
} from "../payment/payment-status";
import { DRAW_STATUS } from "./types";

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
  const checkinDateSuffix = draw.activityKind === "checkin" ? `:${new Date().toISOString().slice(0, 10)}` : "";
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
    return await withDbTransaction(db, async (tx) => {
      const flashParsed = parseFlashSaleConfig(draw.promotionConfig);
      const flashCap = resolveEffectiveStockLimit(flashParsed.config, draw.maxParticipants);
      const isFlashSaleJoin =
        flashParsed.config != null || draw.experienceType === "flash_sale";
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
          const [existingOrder] = await tx
            .select({ status: paymentOrders.status })
            .from(paymentOrders)
            .where(and(
              eq(paymentOrders.tenantId, draw.tenantId),
              eq(paymentOrders.drawId, draw.id),
              eq(paymentOrders.entryId, existingPaymentEntry.id),
            ))
            .limit(1);
          if (existingOrder && !isRetryablePaymentOrderStatus(existingOrder.status)) {
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
      const acceptsWaitlist =
        draw.activityKind === "signup_chain" &&
        draw.allocationPolicy === "waitlist" &&
        !isFlashSaleJoin; // 秒杀不做候补，满即拒
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

      if (draw.activityKind !== "signup_chain") {
        const attribution = await recordAttributedJoin(tx, {
          tenantId: draw.tenantId,
          drawId: draw.id,
          entryId,
          refCode: options?.refCode,
          ipHash: options?.ipHash,
          userAgent: options?.userAgent,
        });
        await maybeTriggerReward(tx, draw, attribution);
        return { joined: true, entryId, activityKind: draw.activityKind, attribution, submissionId };
      }

      const [{ total }] = await tx
        .select({ total: count() })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.tenantId, draw.tenantId), eq(lotteryEntries.drawId, draw.id)));
      const sequenceNo = Number(total);
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
        metadataJson: JSON.stringify({ source: "signup_chain", allocationPolicy: draw.allocationPolicy }),
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
      });

      await maybeTriggerReward(tx, draw, attribution);

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
    if (!outcome) return { cancelled: false, promoted: false };

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
 * - Webhook 投递与 performDraw 一致：在事务内 fire-and-forget + 容错。
 *   为什么 dispatchWebhookDelivery 可以在事务内异步执行？
 *   SQLite 同连接事务内，enqueueWebhookEvent 写入的 delivery 记录在 SELECT 时可见，
 *   所以 dispatchWebhookDelivery 能读到刚入队的记录。HTTP 调用的 fire-and-forget 不会
 *   阻塞事务提交——void + catch 意味着即使 HTTP 失败，事务正常提交，参与记录不丢失。
 * - 与 joinDraw 同事务执行：归因、配额消耗、奖励意图入队三者原子。
 *   如果 triggerRewardEarned 抛异常（catch 捕获），事务仍会提交参与记录：
 *   奖励是附加行为，参与主流程不应因奖励失败而回滚。
 *   此设计与 grantLoserRewards 的容错原则一致——"开奖成功，未中奖发券失败"不回滚开奖结果。
 */
async function maybeTriggerReward(
  tx: DbType,
  draw: { id: string; tenantId: string; resultMode?: string | null; maxSpinsPerEntry?: number | null; promotionConfig?: string | null },
  attribution: { attributed: boolean; sharerEntryId?: string; refCode?: string },
) {
  if (!attribution.attributed || !attribution.sharerEntryId) return;

  // instant 裂变：有效 join → 邀请人 +spins（双封顶）；失败不回滚参与（docs/116）
  if (String(draw.resultMode || "") === "instant") {
    try {
      await grantViralSpinsToSharer(tx, draw, attribution.sharerEntryId);
    } catch (err) {
      console.error(`[lottery] grantViralSpinsToSharer failed for ${draw.id}:`, err);
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
    for (const deliveryId of result.deliveryIds) {
      void dispatchWebhookDelivery(tx, draw.tenantId, deliveryId).catch((err) => {
        console.error(`[lottery] reward webhook dispatch failed for ${deliveryId}:`, err);
      });
    }
  } catch (err) {
    // 奖励触发失败不影响参与成功（与 grantLoserRewards 的容错一致）
    console.error(`[lottery] triggerRewardEarned failed for ${draw.id}:`, err);
  }
}

/**
 * 邀请人 instant +spins：actual = min(perInvite, maxSpins-granted, maxExtra-viral)。
 * 配置优先 promotion_config.viral.extraSpinsPerInvite / maxExtraSpins；
 * 缺省回退 extraEntriesPerInvite / maxExtraEntries 数字（文案仍须 instant 分键）。
 */
async function grantViralSpinsToSharer(
  tx: DbType,
  draw: { id: string; tenantId: string; maxSpinsPerEntry?: number | null; promotionConfig?: string | null },
  sharerEntryId: string,
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
    if (!viral?.enabled) return;
    extra = Number(viral.extraSpinsPerInvite ?? viral.extraEntriesPerInvite ?? 0);
    maxExtra = Number(viral.maxExtraSpins ?? viral.maxExtraEntries ?? 0);
  } catch {
    return;
  }
  if (extra <= 0 || maxExtra <= 0) return;

  const [sharer] = await tx
    .select({
      id: lotteryEntries.id,
      identityValue: lotteryEntries.identityValue,
      spinsLeft: lotteryEntries.spinsLeft,
      spinsTotalGranted: lotteryEntries.spinsTotalGranted,
      spinsViralEarned: lotteryEntries.spinsViralEarned,
    })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, sharerEntryId),
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
    ))
    .limit(1);
  if (!sharer) return;

  const grant = computeViralSpinGrant({
    maxSpinsPerEntry: maxSpins,
    extraSpinsPerInvite: extra,
    maxExtraSpins: maxExtra,
    spinsTotalGranted: Number(sharer.spinsTotalGranted || 0),
    spinsViralEarned: Number(sharer.spinsViralEarned || 0),
  });
  if (grant.actual <= 0) return;

  const updateResult = await tx
    .update(lotteryEntries)
    .set({
      spinsTotalGranted: grant.nextGranted,
      spinsViralEarned: grant.nextViralEarned,
      spinsLeft: sql`${lotteryEntries.spinsLeft} + ${grant.nextLeftDelta}`,
    })
    .where(and(
      eq(lotteryEntries.id, sharer.id),
      eq(lotteryEntries.tenantId, draw.tenantId),
      eq(lotteryEntries.drawId, draw.id),
      // 乐观：granted 未在并发下被他人改到超过预期时再写（纵深）
      eq(lotteryEntries.spinsTotalGranted, Number(sharer.spinsTotalGranted || 0)),
    ));
  if ((updateResult.rowsAffected ?? 0) === 0) {
    // 并发邀请奖励已先一步修改该邀请人的 spinsTotalGranted。
    // 此时不能继续写 spins_log，否则会产生"流水有奖励、余额未增加"的审计错账；
    // 直接放弃本次附加奖励，参与主流程仍按 maybeTriggerReward 的容错语义继续提交。
    return;
  }

  // 写入 spins 流水日志（docs/172 §5.5 P1）：记录裂变邀请奖励
  await recordSpinLog(tx, {
    tenantId: draw.tenantId,
    entryId: sharerEntryId,
    userId: sharer.identityValue ?? "",
    delta: grant.nextLeftDelta,
    balanceAfter: Number(sharer.spinsLeft ?? 0) + grant.nextLeftDelta,
    reason: "viral",
  });
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

async function recordAttributedJoin(
  db: DbWriteScope,
  input: {
    tenantId: string;
    drawId: string;
    entryId: string;
    refCode?: string;
    ipHash?: string;
    userAgent?: string;
  },
) {
  const refCode = String(input.refCode || "").trim();
  if (!refCode) return { attributed: false };

  const [share] = await db
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
  if (!share) return { attributed: false };

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
