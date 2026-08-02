/**
 * 抽奖服务层 — 核心业务逻辑。
 *
 * 【设计原则】
 * - 只操作抽奖相关表，不涉及电商概念（订单/支付/余额/返佣）
 * - 所有函数接受 tenant_id 参数，确保多租户数据隔离
 * - 开奖流程：随机抽取候选池 → 原子锁定奖品码 → 写入中奖记录 → 异步通知
 * - 不产生订单、不涉及支付、不扣余额
 *
 * 【状态机】
 *   draft → open → drawing → drawn
 *   open → paused → open
 *   draft/open/paused → cancelled
 *   drawing 失败 → open（记录 failureReason，禁止永久卡死）
 *
 * 【并发安全】
 * - 参与去重：UNIQUE(tenant_id, draw_id, identity_type, identity_value)
 * - 开奖防双发：CAS 更新 status（open → drawing）
 * - 邀请码防超发：条件 UPDATE WHERE used_count < max_uses
 * - 锁码防重：条件 UPDATE WHERE status = 'available'
 */
import { withDbTransaction, type DbType, type DbWriteScope } from "../db/client";
import { and, eq, count, inArray, sql, asc } from "drizzle-orm";
import { buildLotteryWinnerTemplateData, sendEmail } from "./email-service";
import { buildPublishCheckForDraw } from "./publish-check-service";
import {
  lotteryDraws,          // 抽奖活动表
  lotteryEntries,        // 候选池表
  lotteryWinners,        // 中奖记录表
  users,                 // 注册用户表（registered 模式中奖者关联真实邮箱）
  prizes,                // 奖品表
  prizeCodes,            // 奖品码池表
  lotteryPrizeTiers,     // 多奖项配置表
  lotteryRosterMembers,  // 限定名单表
  lotteryInviteCodes,    // 邀请码表
  emailAccessCodes,      // 邮箱验证码表（joinDraw 事务内消费验证码）
  auditLogs,             // 审计日志表
  lotteryBlacklist,      // 参与者黑名单
  activityOutcomes,      // 接龙/预约等活动的统一结果
  systemConfig,          // 系统配置（含动态套餐额度）
  shareRecords,          // 分享裂变归因
  activitySubmissions,   // 动态表单提交 payload
  couponCodes,           // 优惠券码池（用于未中奖自动发券）
} from "../db/schema";

// ── 拆分模块（docs/049 #17：类型/套餐/纯工具/集成已迁至 services/lottery/） ──
// 内部使用：原文件剩余业务逻辑引用的符号从子模块导入
import { DEFAULT_ACTIVITY_PARTICIPANT_CAP } from "./lottery/types";
import type { DrawResult } from "./lottery/types";
import { enforceTenantActivityQuota } from "./lottery/plan";
import { randomSelect, hashAccessPassword, verifyAccessPassword } from "./lottery/utils";
// 集成/事件域：参与域（recordAttributedJoin）与开奖域（enqueue/dispatch webhook）复用
import { recordActivityEvent, enqueueWebhookEvent, dispatchWebhookDelivery } from "./lottery/integration";

// re-export：保持既有导出 API 不变（外部 import 本文件的符号继续可用）
export * from "./lottery/types";
export * from "./lottery/plan";
export * from "./lottery/utils";
export * from "./lottery/integration";
export * from "./lottery/draws";

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
) {
  // 通过 public_slug 查找活动（不暴露活动 ID）
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有 open 状态的活动可以参与（draft/paused/drawing/drawn/cancelled 均不可参与）
  if (draw.status !== "open") throw new Error("活动未开启");

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

  const nowIso = now.toISOString();

  try {
    return await withDbTransaction(db, async (tx) => {
      // 邀请码扣减和参与记录写入必须在同一事务中，避免重复/满额时白白消耗邀请码。
      let inviteCodeId = "";
      if (draw.participationMode === "invite_code") {
        const inviteResult = await tx
          .update(lotteryInviteCodes)
          .set({ usedCount: sql`${lotteryInviteCodes.usedCount} + 1` })
          .where(and(
            eq(lotteryInviteCodes.tenantId, draw.tenantId),
            eq(lotteryInviteCodes.drawId, draw.id),
            eq(lotteryInviteCodes.code, options!.inviteCode!),
            eq(lotteryInviteCodes.active, 1),
            sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
          ));
        if ((inviteResult.rowsAffected ?? 0) === 0) {
          return { joined: false, message: "邀请码无效或已用完" };
        }
        const [invite] = await tx
          .select({ id: lotteryInviteCodes.id })
          .from(lotteryInviteCodes)
          .where(and(
            eq(lotteryInviteCodes.tenantId, draw.tenantId),
            eq(lotteryInviteCodes.drawId, draw.id),
            eq(lotteryInviteCodes.code, options!.inviteCode!),
          ))
          .limit(1);
        inviteCodeId = invite?.id || "";
      }

      const entryId = crypto.randomUUID();
      const effectiveMax = draw.maxParticipants ?? 50000;
      const acceptsWaitlist = draw.activityKind === "signup_chain" && draw.allocationPolicy === "waitlist";
      // 容量检查：仅按活动维度（draw_id）校验，不做租户级累计参与人数 COUNT。
      // 原因：租户级 COUNT 会扩大 Turso rows read 和请求延迟，不适合放在用户参与热路径。
      // 租户级累计参与人数额度未来通过快照表（定时任务预聚合）实现。
      // 详见 docs/023_Cloudflare免费版与Turso约束下认证和运行安全方案_2026-08-01.md
      const capacityClause = acceptsWaitlist
        ? sql`1 = 1`
        : sql`(SELECT COUNT(*) FROM lottery_entries WHERE tenant_id = ${draw.tenantId} AND draw_id = ${draw.id}) < ${effectiveMax}`;
      // 写入参与记录。使用条件 INSERT 确保并发安全：
      // 1. 活动级容量检查（capacityClause）：防止同时写入超过 maxParticipants
      // 2. 签到活动使用 uniqueValue（含日期后缀）作为 identity_value，
      //    使 UNIQUE 约束允许每日签到但不允许同一天重复。
      const insertResult = await tx.run(sql`
        INSERT INTO lottery_entries (id, tenant_id, draw_id, identity_type, identity_value, invite_code_id, ip_hash, joined_at)
        SELECT ${entryId}, ${draw.tenantId}, ${draw.id}, ${identityType}, ${checkinDateSuffix ? uniqueValue : normalizedValue}, ${inviteCodeId}, ${options?.ipHash || ""}, ${nowIso}
        WHERE ${capacityClause}
      `);

      if ((insertResult.rowsAffected ?? 0) === 0) {
        return { joined: false, message: acceptsWaitlist ? "参与失败，请稍后重试" : "活动名额已满" };
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
  } catch (err: any) {
    // UNIQUE 约束冲突：同一参与者重复提交
    if (err.message?.includes("UNIQUE constraint")) {
      return { joined: false, message: "您已参与此活动" };
    }
    throw err;
  }
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

  return { attributed: true, refCode, shareRecordId: share.id };
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
  emailEnv?: { resendApiKey: string; emailFrom: string },  // 邮件通知配置（可选，未配置时跳过通知）
): Promise<DrawResult> {
  const now = new Date().toISOString();

  // 1. CAS 原子夺取开奖权：仅当 status = 'open' 时才更新为 'drawing'
  //    使用 returning() 获取更新后的记录，确认 CAS 成功
  const claimResult = await db
    .update(lotteryDraws)
    .set({ status: "drawing", updatedAt: now })
    .where(and(
      eq(lotteryDraws.id, drawId),
      eq(lotteryDraws.tenantId, tenantId),
      eq(lotteryDraws.status, "open"),
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
    if (draw.status === "drawing") {
      const healed = await healDrawingState(db, drawId, tenantId);
      if (healed === "drawn") {
        return { drawId, winnerCount: 0, candidateCount: 0 };
      }
      if (healed === "open") {
        // 治愈成功，状态已回滚为 open，重新尝试夺取开奖权
        const retryResult = await db
          .update(lotteryDraws)
          .set({ status: "drawing", updatedAt: new Date().toISOString() })
          .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId), eq(lotteryDraws.status, "open")));
        if ((retryResult.rowsAffected ?? 0) === 0) {
          throw new Error("开奖权已被其他进程夺取，请稍后重试");
        }
        // 继续执行开奖流程
      }
    }
    // 已开奖活动再次开奖 → 幂等返回实际数据
    if (draw.status === "drawn") {
      const actualWinnerCount = await db
        .select({ total: count() })
        .from(lotteryWinners)
        .where(eq(lotteryWinners.drawId, drawId));
      const actualCandidateCount = await db
        .select({ total: count() })
        .from(lotteryEntries)
        .where(eq(lotteryEntries.drawId, drawId));
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
      .where(eq(lotteryDraws.id, drawId));

    // 3. 读取候选池（所有参与者）
    const entries = await db
      .select()
      .from(lotteryEntries)
      .where(eq(lotteryEntries.drawId, drawId));

    const candidateCount = entries.length;
    if (candidateCount === 0) {
      throw new Error("候选池为空，无参与者");
    }

    // 获取活动配置（读取最新状态）
    const [draw] = await db
      .select()
      .from(lotteryDraws)
      .where(eq(lotteryDraws.id, drawId))
      .limit(1);
    if (!draw) throw new Error("活动不存在");

    // 获取多奖项配置（一等奖、二等奖等）
    const tiers = await db
      .select()
      .from(lotteryPrizeTiers)
      .where(eq(lotteryPrizeTiers.drawId, drawId))
      .orderBy(lotteryPrizeTiers.sortOrder);

    // 计算总中奖人数：有奖项配置时按奖项总和，否则按活动默认 winnerCount
    const totalWinners = tiers.length > 0
      ? tiers.reduce((sum, t) => sum + t.winnerCount, 0)
      : draw.winnerCount;

    // ── 裂变加权：活动开启了裂变时，按邀请人数加权候选数组 ──
    // 每个参与者出现 1 次（基础）+ min(invitedCount, maxExtraEntries) 次（裂变加权）。
    // 不加权时 candidates = entries（保持原有行为）。
    let pc: Record<string, unknown> | null = null;
    try { pc = JSON.parse(draw.promotionConfig || "{}"); } catch { /* 忽略非法 JSON */ }
    const viral = pc?.viral as { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | undefined;
    let weightedCandidates: typeof entries;
    const inviteMap = new Map<string, number>();  // entryId → 邀请人数

    if (viral?.enabled) {
      const maxExtra = viral.maxExtraEntries ?? 10;

      // 查询该活动所有分享者的邀请人数
      const shareRows = await db
        .select({ sharerEntryId: shareRecords.sharerEntryId, joinedCount: shareRecords.joinedCount })
        .from(shareRecords)
        .where(and(eq(shareRecords.tenantId, tenantId), eq(shareRecords.drawId, drawId)));

      // 按 sharerEntryId 聚合 SUM(joinedCount)
      for (const row of shareRows) {
        inviteMap.set(row.sharerEntryId, (inviteMap.get(row.sharerEntryId) || 0) + row.joinedCount);
      }

      // 构建加权候选数组
      weightedCandidates = [];
      for (const entry of entries) {
        const invited = Math.min(inviteMap.get(entry.id) || 0, maxExtra);
        for (let i = 0; i < 1 + invited; i++) {
          weightedCandidates.push(entry);
        }
      }
    } else {
      weightedCandidates = entries;
    }

    // Fisher-Yates 随机抽取中奖者（加权候选数组）
    const selected = await randomSelect(weightedCandidates, totalWinners);

    // 4. 事务内写入中奖记录 + 原子锁码
    //    使用事务保证：锁码和写入中奖记录要么全部成功，要么全部回滚
    let entryIndex = 0;  // 已处理的中奖者数量（在事务外声明，用于审计日志）
    const seenEntryIds = new Set<string>();  // 加权候选数组去重：同一人只中一次
    await withDbTransaction(db, async (tx) => {
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

          // 加权候选数组去重：同一人可能因裂变加权被多次选中，只取第一次
          if (seenEntryIds.has(entry.id)) {
            i--;  // 当前名额未填满，继续尝试下一个候选
            continue;
          }
          seenEntryIds.add(entry.id);

          // 原子锁码：如果奖项配置了奖品，从奖品码池中取一条 available 的记录
          // 【关键】先 SELECT 获取一条可用码的 ID，再按 ID 执行 UPDATE
          // 不能直接 UPDATE ... WHERE status='available'（会更新所有可用码，导致数据损坏）
          let prizeCodeId = "";
          if (tier.prizeId) {
            // 步骤 1: SELECT 获取一条可用码（原子操作，配合事务保证并发安全）
            const [availableCode] = await tx
              .select({ id: prizeCodes.id, code: prizeCodes.code })
              .from(prizeCodes)
              .where(and(
                eq(prizeCodes.prizeId, tier.prizeId),
                eq(prizeCodes.status, "available"),
                eq(prizeCodes.tenantId, tenantId),
              ))
              .limit(1);

            if (availableCode) {
              // 步骤 2: 按 ID 原子锁定（仅更新该条码）
              const lockResult = await tx
                .update(prizeCodes)
                .set({ status: "issued", winnerId: entry.id, issuedAt: now })
                .where(and(
                  eq(prizeCodes.id, availableCode.id),
                  eq(prizeCodes.status, "available"),
                ));

            // rowsAffected = 0 表示码已用完（被其他中奖者锁定）
            if ((lockResult.rowsAffected ?? 0) > 0) {
              // 查询刚锁定的码的 ID
              const [lockedCode] = await tx
                .select({ id: prizeCodes.id })
                .from(prizeCodes)
                .where(and(
                  eq(prizeCodes.prizeId, tier.prizeId),
                  eq(prizeCodes.winnerId, entry.id),
                  eq(prizeCodes.tenantId, tenantId),
                ))
                .limit(1);
              prizeCodeId = lockedCode?.id || "";

              // 发放成功后更新奖品已用数（used_count），保证运营者可看到码池消耗
              await tx.update(prizes)
                .set({ usedCount: sql`used_count + 1`, updatedAt: now })
                .where(eq(prizes.id, tier.prizeId));
            }
            // 码不足时跳过（prizeCodeId 保持空字符串），中奖者仍记录但无码
            }
          }

          // 写入中奖记录
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
        .set({ status: "drawn", drawnAt: now, updatedAt: now, failureReason: "" })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
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

    // 异步发送中奖通知邮件（不阻塞主流程，失败不影响开奖结果）
    // 由 platform system_config.notify_winner_email_enabled 控制（默认开启）
    if (emailEnv?.resendApiKey) {
      const [notifyCfg] = await db
        .select({ value: systemConfig.value })
        .from(systemConfig)
        .where(eq(systemConfig.key, "notify_winner_email_enabled"))
        .limit(1);
      if (notifyCfg?.value !== "false") {
        void sendWinnerNotifications(db, tenantId, drawId, emailEnv).catch((err) => {
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

    // 活动后承接：未中奖自动发券（需在活动配置中启用 loserReward.enabled）
    // 在开奖状态更新之后执行，保证"是否中奖"已尘埃落定；不阻塞主流程，失败不影响开奖结果。
    try {
      const loserRewardResult = await grantLoserRewards(db, tenantId, drawId);
      if (loserRewardResult.granted > 0) {
        console.log(`[lottery] loser rewards granted: ${loserRewardResult.granted} for draw ${drawId}`);
        // 发券成功后发送安慰邮件（异步，不阻塞开奖主流程）
        if (emailEnv?.resendApiKey) {
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
    if (curDraw?.status !== "drawn") {
      await db
        .update(lotteryDraws)
        .set({ status: "open", failureReason: reason, updatedAt: new Date().toISOString() })
        .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
    }
    throw error;
  }
}

/**
 * 异步发送中奖通知邮件。
 * 在开奖完成后调用，不阻塞主流程。
 * 每个中奖者独立发送，失败不影响其他人。
 */
export async function sendWinnerNotifications(
  db: DbType,
  tenantId: string,
  drawId: string,
  emailEnv: { resendApiKey?: string; emailFrom?: string },
) {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);
  if (!draw) return;

  const winners = await db
    .select({
      winnerId: lotteryWinners.id,
      email: lotteryWinners.identityValue,
      identityType: lotteryWinners.identityType,
      prizeCodeId: lotteryWinners.prizeCodeId,
      notificationStatus: lotteryWinners.notificationStatus,
    })
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));

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

  for (const winner of winners) {
    if (winner.notificationStatus === "sent") continue;

    let accountLabel = "";
    let deliverySecret = "";

    if (winner.prizeCodeId) {
      const code = codeMap.get(winner.prizeCodeId);
      if (code) { accountLabel = code.code; deliverySecret = code.secret; }
    }

    // 收件人解析：user_id 身份的 winner 用 users 表关联的真实邮箱（见上方 userEmailMap）
    const toEmail = winner.identityType === "user_id" ? (userEmailMap.get(winner.email) || "") : winner.email;

    try {
      const result = await sendEmail(emailEnv, {
        to: toEmail,
        template: "lottery_winner",
        templateData: buildLotteryWinnerTemplateData({
          drawName: draw.title,
          productName: draw.title,
          accountLabel,
          deliverySecret,
        }),
      });

      await db
        .update(lotteryWinners)
        .set({
          notificationStatus: result.ok ? "sent" : "failed",
          notificationError: result.ok ? "" : (result.message || "").slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.winnerId));
    } catch (err) {
      await db
        .update(lotteryWinners)
        .set({
          notificationStatus: "failed",
          notificationError: (err as Error).message.slice(0, 500),
        })
        .where(eq(lotteryWinners.id, winner.winnerId));
    }
  }
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
  options?: { staleMs?: number },
): Promise<"drawn" | "open" | null> {
  const staleMs = options?.staleMs ?? 300000; // 默认 5 分钟超时

  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw || draw.status !== "drawing") return null;

  // 检查是否已有中奖记录
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryWinners)
    .where(eq(lotteryWinners.drawId, drawId));

  const nowIso = new Date().toISOString();

  if (Number(total) > 0) {
    // 中奖已落库但状态未 drawn：补状态
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: draw.drawnAt || nowIso, updatedAt: nowIso, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    return "drawn";
  }

  // 无中奖记录：检查是否超时
  const updatedAt = new Date(draw.updatedAt || draw.createdAt).getTime();
  if (Date.now() - updatedAt > staleMs) {
    // 超时且无中奖：回滚为 open
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: "开奖超时，已自动回滚", updatedAt: nowIso })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.status, "drawing")));
    return "open";
  }

  return null;
}

/* ── 奖品管理 ────────────────────────────────────────────── */

/**
 * 创建奖品。
 */
export async function createPrize(
  db: DbType,
  tenantId: string,
  data: { name: string; description?: string; prizeType?: string; imageUrl?: string; valueText?: string },
) {
  const name = String(data.name || "").trim();
  if (!name) throw new Error("奖品名称不能为空");

  const id = crypto.randomUUID();
  await db.insert(prizes).values({
    id,
    tenantId,
    name,
    description: String(data.description || "").trim(),
    imageUrl: String(data.imageUrl || "").trim(),   // 奖品图片 URL（可选）
    valueText: String(data.valueText || "").trim(), // 展示价值文案，不参与金额计算
    prizeType: data.prizeType || "code",            // 默认卡密类型
  });
  return { id };
}

/**
 * 导入奖品码（批量）。
 * 每个码独立 INSERT，不保证原子性。
 * 如果部分失败，已成功的码不会回滚。
 */
export async function importPrizeCodes(
  db: DbType,
  tenantId: string,
  prizeId: string,
  codes: Array<{ code: string; secret?: string }>,
) {
  // 校验奖品存在且属于当前租户
  const [prize] = await db
    .select()
    .from(prizes)
    .where(and(eq(prizes.id, prizeId), eq(prizes.tenantId, tenantId)))
    .limit(1);

  if (!prize) throw new Error("奖品不存在");

  // 批量 INSERT（一次写入替代 N 次往返），重复码通过 UNIQUE 约束自动跳过
  let imported = 0;
  // 分批插入：每批最多 200 条，避免单次 INSERT 过大
  const BATCH_SIZE = 200;
  for (let offset = 0; offset < codes.length; offset += BATCH_SIZE) {
    const batch = codes.slice(offset, offset + BATCH_SIZE);
    const values = batch.map(item => ({
      id: crypto.randomUUID(),
      tenantId,
      prizeId,
      code: (item.code || "").trim(),
      secret: (item.secret || "").trim(),
      status: "available" as const,
      createdAt: new Date().toISOString(),
    }));
    try {
      await db.insert(prizeCodes).values(values);
      imported += batch.length;
    } catch (err: any) {
      // UNIQUE 约束冲突时，回退到逐条插入以精确定位跳过的码
      for (const item of batch) {
        try {
          await db.insert(prizeCodes).values({
            id: crypto.randomUUID(),
            tenantId,
            prizeId,
            code: (item.code || "").trim(),
            secret: (item.secret || "").trim(),
            status: "available",
            createdAt: new Date().toISOString(),
          });
          imported++;
        } catch { /* 跳过重复 */ }
      }
    }
  }

  // 更新奖品 total_count（闭环：P0-1 已修复）
  await db.update(prizes)
    .set({ totalCount: sql`total_count + ${imported}`, updatedAt: new Date().toISOString() })
    .where(eq(prizes.id, prizeId));
}

/* ── 定时开奖兜底 ─────────────────────────────────────────── */

/**
 * 处理到期活动（Cron 定时调用）。
 *
 * 每次最多处理 limit 个活动，避免单次 Worker 请求 CPU 超限。
 * 失败的活动不影响其他活动，每个活动独立 try/catch。
 *
 * 调用频率：建议每 5 分钟执行一次（Cloudflare Cron Triggers）。
 */
export async function processDueDraws(
  db: DbType,
  options?: { limit?: number; emailEnv?: { resendApiKey: string; emailFrom: string } },
): Promise<{ processed: number; failed: number; errors: Array<{ drawId: string; message: string }> }> {
  // 单次最多处理 50 个，默认 20 个
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
  const emailEnv = options?.emailEnv;
  const now = new Date().toISOString();

  // 查询到期且未开奖的定时活动
  const due = await db
    .select()
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      eq(lotteryDraws.drawTrigger, "scheduled"),
      sql`${lotteryDraws.drawAt} <= ${now}`,  // 开奖时间已到
    ))
    .orderBy(lotteryDraws.drawAt)  // 按开奖时间排序，先到期的先处理
    .limit(limit);

  let processed = 0;
  let failed = 0;
  const errors: Array<{ drawId: string; message: string }> = [];

  // 先治愈卡在 drawing 状态的活动（借鉴 cf-shop 的 healStaleDrawings）
  const staleDrawings = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.status, "drawing"))
    .limit(10);
  for (const draw of staleDrawings) {
    try {
      await healDrawingState(db, draw.id, draw.tenantId);
    } catch (err) { console.error(`[heal] 状态自愈失败 draw=${draw.id}`, err); }
  }

  for (const draw of due) {
    try {
      // Cron 调用时 operatorUserId 为 "system"
      await performDraw(db, draw.tenantId, draw.id, "system", emailEnv);
      processed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "未知错误";
      errors.push({ drawId: draw.id, message });
    }
  }

  return { processed, failed, errors };
}

/**
 * 对开奖随机种子做 SHA-256 hash，用于事后公平性验证。
 *
 * 开奖前先记录 hash，开奖后可展示原始 seed 供参与者验证：
 * 1. 参与者拿到 seed，计算 SHA-256(seed)
 * 2. 比对开奖前记录的 hash 是否一致
 * 3. 一致则证明开奖结果未被篡改
 */
async function hashDrawSeed(seed: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ═════════════════════════════════════════════════════════
// 营销邮件：开奖前 1 小时提醒
// ═════════════════════════════════════════════════════════

/**
 * 发送开奖前提醒邮件。
 *
 * 由 platform system_config 控制：
 * - marketing_draw_reminder_enabled：是否启用（默认 false，需平台运营者手动开启）
 * - marketing_draw_reminder_minutes：开奖前多少分钟发送（默认 60）
 *
 * 由 runScheduledMaintenance 触发（Cron 每 5 分钟执行一次，
 * 以配置值为中心 ±5 分钟窗口，确保每次 Cron 都能捕捉到目标活动）。
 */
export async function sendDrawReminders(
  db: DbType,
  emailEnv: { resendApiKey?: string; emailFrom?: string; emailFromName?: string },
): Promise<{ drawsProcessed: number; emailsSent: number; failed: number }> {
  if (!emailEnv.resendApiKey) return { drawsProcessed: 0, emailsSent: 0, failed: 0 };

  // 读取平台配置：是否启用 + 提前分钟数
  const configRows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(sql`${systemConfig.key} IN ('marketing_draw_reminder_enabled', 'marketing_draw_reminder_minutes')`);
  const cfg: Record<string, string> = {};
  for (const row of configRows) cfg[row.key] = row.value;

  const enabled = cfg["marketing_draw_reminder_enabled"] === "true";
  if (!enabled) return { drawsProcessed: 0, emailsSent: 0, failed: 0 };

  const minutes = Math.max(5, Math.min(1440, parseInt(cfg["marketing_draw_reminder_minutes"] || "60", 10) || 60));

  const now = new Date();
  const windowStart = new Date(now.getTime() + (minutes - 5) * 60000).toISOString();
  const windowEnd = new Date(now.getTime() + (minutes + 5) * 60000).toISOString();

  // 查找即将在 N 分钟后开奖的活动
  const dueDraws = await db
    .select({ id: lotteryDraws.id, tenantId: lotteryDraws.tenantId, title: lotteryDraws.title, publicSlug: lotteryDraws.publicSlug })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.status, "open"),
      sql`${lotteryDraws.drawAt} >= ${windowStart}`,
      sql`${lotteryDraws.drawAt} <= ${windowEnd}`,
    ))
    .limit(20);

  let drawsProcessed = 0;
  let emailsSent = 0;
  let failed = 0;

  for (const draw of dueDraws) {
    drawsProcessed++;
    try {
      const entries = await db
        .select({ identityValue: lotteryEntries.identityValue })
        .from(lotteryEntries)
        .where(and(eq(lotteryEntries.tenantId, draw.tenantId), eq(lotteryEntries.drawId, draw.id)))
        .limit(500);

      const shareUrl = draw.publicSlug ? `${draw.publicSlug}` : "";
      const reminderText = minutes >= 120 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
      for (const entry of entries) {
        if (!entry.identityValue.includes("@")) continue;
        try {
          await sendEmail(emailEnv, {
            to: entry.identityValue,
            template: "draw_reminder",
            templateData: { drawName: draw.title, shareUrl, reminderText },
          });
          emailsSent++;
        } catch { failed++; }
      }
    } catch { /* 单个活动失败不影响其他 */ }
  }

  return { drawsProcessed, emailsSent, failed };
}

// ═════════════════════════════════════════════════════════
// 营销邮件：未中奖安慰邮件
// ═════════════════════════════════════════════════════════

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
  emailEnv: { resendApiKey?: string; emailFrom?: string; emailFromName?: string },
  tenantId: string,
  drawId: string,
  drawTitle: string,
): Promise<{ sent: number; failed: number }> {
  if (!emailEnv.resendApiKey) return { sent: 0, failed: 0 };

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

  let sent = 0;
  let failed = 0;
  const origin = "";  // APP_ORIGIN 由调用方传入，这里用相对路径

  for (const coupon of issuedCoupons) {
    if (!coupon.recipientEmail || !coupon.recipientEmail.includes("@")) continue;
    try {
      await sendEmail(emailEnv, {
        to: coupon.recipientEmail,
        template: "loser_consolation",
        templateData: {
          drawName: drawTitle,
          couponCode: coupon.code,
          couponLabel: coupon.label || "",
          nextActivityUrl: origin || "",
        },
      });
      sent++;
    } catch { failed++; }
  }

  return { sent, failed };
}



