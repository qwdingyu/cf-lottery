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
import { recordActivityEvent } from "./integration";

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
  } catch (err: unknown) {
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
        const sameType = String(sharerEntry.identityType || "") === String(joinerEntry.identityType || "");
        // 签到 identity_value 带 :YYYY-MM-DD 后缀：比「邮箱/user 主干」防跨日自邀刷权重
        const baseOf = (v: string) => {
          const s = String(v || "").trim().toLowerCase();
          const m = s.match(/^(.*):(\d{4}-\d{2}-\d{2})$/);
          return m ? m[1]! : s;
        };
        const sameIdentity =
          sameType && baseOf(sharerEntry.identityValue) === baseOf(joinerEntry.identityValue);
        if (sameIdentity) {
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

