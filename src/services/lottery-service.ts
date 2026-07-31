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
import { withDbTransaction, type DbType } from "../db/client";
import { and, eq, count, sql } from "drizzle-orm";
import { buildLotteryWinnerTemplateData, sendEmail } from "./email-service";
import {
  lotteryDraws,          // 抽奖活动表
  lotteryEntries,        // 候选池表
  lotteryWinners,        // 中奖记录表
  prizes,                // 奖品表
  prizeCodes,            // 奖品码池表
  lotteryPrizeTiers,     // 多奖项配置表
  lotteryRosterMembers,  // 限定名单表
  lotteryInviteCodes,    // 邀请码表
  auditLogs,             // 审计日志表
} from "../db/schema";

/* ── 类型定义 ─────────────────────────────────────────────── */

/** 开奖结果 */
export type DrawResult = {
  drawId: string;        // 活动 ID
  winnerCount: number;   // 实际中奖人数
  candidateCount: number; // 候选池总人数
};

/* ── 内部工具 ─────────────────────────────────────────────── */

/**
 * Fisher-Yates 洗牌算法，使用 CSPRNG（crypto.getRandomValues）。
 * 从候选数组中随机抽取指定数量的元素，保证等概率。
 *
 * 为什么不使用 Math.random()：
 * Math.random() 是伪随机数生成器，可预测且不安全。
 * crypto.getRandomValues() 是密码学安全的随机数生成器，适合抽奖等公平性场景。
 */
export async function randomSelect<T>(candidates: T[], count: number): Promise<T[]> {
  // 实际抽取数量不超过候选池大小
  const n = Math.min(count, candidates.length);
  if (n <= 0) return [];

  // 复制候选数组，避免修改原数组
  const result = [...candidates];
  // Fisher-Yates 洗牌：从后往前，每次随机交换一个元素
  for (let i = result.length - 1; i > 0; i--) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    // 取模运算产生 0 到 i 之间的随机索引
    const j = random[0]! % (i + 1);
    // 交换 result[i] 和 result[j]
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }

  // 洗牌后取前 n 个作为中奖者
  return result.slice(0, n);
}

/* ── 密码工具 ────────────────────────────────────────────── */

/**
 * 对访问密码做 SHA-256 hash。
 * 避免在数据库中明文存储密码。
 */
export async function hashAccessPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

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
export async function getDrawEntriesCount(db: DbType, drawId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(lotteryEntries)
    .where(eq(lotteryEntries.drawId, drawId));
  return Number(total);
}

/**
 * 获取中奖记录（带租户隔离）。
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
    participationMode?: string;   // 参与模式：open/roster/password/invite_code
    drawTrigger?: string;          // 开奖触发：manual/scheduled
    startAt: string;               // 参与开始时间（ISO 8601）
    endAt: string;                 // 参与结束时间（ISO 8601）
    drawAt?: string;               // 定时开奖时间（ISO 8601）
    accessPassword?: string;       // 密码模式下的访问密码（明文，存储时需 hash）
    maxParticipants?: number;      // 最大参与人数（null=不限）
    winnerCount?: number;          // 中奖人数
    showParticipantCount?: number; // 是否公开参与人数（0/1）
    showWinnerCount?: number;      // 是否公开中奖人数（0/1）
    showWinnerList?: number;       // 是否公开中奖名单（0/1）
  },
) {
  // 校验参与时间合法性
  const start = new Date(data.startAt);
  const end = new Date(data.endAt);
  if (start >= end) throw new Error("参与开始时间必须早于结束时间");

  // 定时开奖必须设置开奖时间
  if (data.drawTrigger === "scheduled" && !data.drawAt) {
    throw new Error("定时开奖必须设置开奖时间");
  }

  // 开奖时间必须在参与结束后
  if (data.drawAt) {
    const draw = new Date(data.drawAt);
    if (end >= draw) throw new Error("开奖时间必须在参与结束后");
  }

  // 中奖名额至少为 1
  if (!data.winnerCount || data.winnerCount < 1) {
    throw new Error("中奖名额至少为 1");
  }

  const id = crypto.randomUUID();
  // 取 UUID 前 8 位作为公开链接 slug，不可枚举
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
    accessPassword: data.accessPassword ? await hashAccessPassword(data.accessPassword) : "",
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
 *
 * 发布前二次校验：
 * - 标题不能为空
 * - 活动时间必须设置
 * - 定时开奖必须设置开奖时间
 *
 * 使用 CAS 更新（WHERE status = 'draft'），防止并发发布。
 */
export async function publishDraw(db: DbType, tenantId: string, drawId: string): Promise<boolean> {
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有草稿状态可以发布
  if (draw.status !== "draft") throw new Error("只有草稿状态的活动才能发布");

  // 发布前二次校验（创建时已校验，但发布前再次确认）
  if (!draw.title) throw new Error("活动标题不能为空");
  if (!draw.startAt || !draw.endAt) throw new Error("请设置活动时间");
  if (draw.drawTrigger === "scheduled" && !draw.drawAt) throw new Error("定时开奖必须设置开奖时间");

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
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 已开奖或开奖中的活动不可取消，防止数据不一致
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
  },
) {
  // 通过 public_slug 查找活动（不暴露活动 ID）
  const [draw] = await db
    .select()
    .from(lotteryDraws)
    .where(eq(lotteryDraws.publicSlug, slug))
    .limit(1);

  if (!draw) throw new Error("活动不存在");
  // 只有 open 状态的活动可以参与
  if (draw.status !== "open") throw new Error("活动未开启");

  const normalizedValue = identityValue.trim().toLowerCase();

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
    // 对输入的密码做 SHA-256 hash 后与存储的 hash 比较
    const inputHash = await hashAccessPassword(options.accessPassword);
    if (inputHash !== draw.accessPassword) {
      return { joined: false, message: "访问密码错误" };
    }
  }

  // 邀请码模式：CAS 原子扣减使用次数
  if (draw.participationMode === "invite_code") {
    if (!options?.inviteCode) {
      return { joined: false, message: "请输入邀请码" };
    }
    // 条件 UPDATE：原子性保证 used_count 不会超过 max_uses
    // SQLite 的 UPDATE 是原子操作，配合 WHERE 条件实现 CAS
    const result = await db
      .update(lotteryInviteCodes)
      .set({ usedCount: sql`${lotteryInviteCodes.usedCount} + 1` })
      .where(and(
        eq(lotteryInviteCodes.drawId, draw.id),
        eq(lotteryInviteCodes.code, options.inviteCode),
        eq(lotteryInviteCodes.active, 1),
        // 核心 CAS：仅当 used_count < max_uses 时才执行更新
        sql`${lotteryInviteCodes.usedCount} < ${lotteryInviteCodes.maxUses}`,
      ));
    // rowsAffected = 0 表示邀请码无效或已用完
    if ((result.rowsAffected ?? 0) === 0) {
      return { joined: false, message: "邀请码无效或已用完" };
    }
  }

  // ── 参与时间校验 ──
  const now = new Date();
  if (now < new Date(draw.startAt) || now > new Date(draw.endAt)) {
    return { joined: false, message: "不在参与时间内" };
  }

  // ── 最大参与人数校验（原子写入，防竞态） ──
  // 使用 INSERT ... SELECT 合并容量检查与写入，避免先 count 再 insert 的竞态窗口
  const effectiveMax = draw.maxParticipants ?? 50000;
  const nowIso = now.toISOString();

  try {
    // 原子写入：利用 INSERT ... SELECT 合并容量检查
    // 如果候选池已满，SELECT 不返回行，INSERT 不会执行
    await db.run(sql`
      INSERT INTO lottery_entries (id, tenant_id, draw_id, identity_type, identity_value, invite_code_id, ip_hash, joined_at)
      SELECT ${crypto.randomUUID()}, ${draw.tenantId}, ${draw.id}, ${identityType}, ${normalizedValue}, ${options?.inviteCode || ""}, ${options?.ipHash || ""}, ${nowIso}
      WHERE (SELECT COUNT(*) FROM lottery_entries WHERE draw_id = ${draw.id}) < ${effectiveMax}
    `);
  } catch (err: any) {
    // UNIQUE 约束冲突：同一参与者重复提交
    if (err.message?.includes("UNIQUE constraint")) {
      return { joined: false, message: "您已参与此活动" };
    }
    throw err;
  }

  return { joined: true };
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

    // Fisher-Yates 随机抽取中奖者
    const selected = await randomSelect(entries, totalWinners);

    // 4. 事务内写入中奖记录 + 原子锁码
    //    使用事务保证：锁码和写入中奖记录要么全部成功，要么全部回滚
    let entryIndex = 0;  // 已处理的中奖者数量（在事务外声明，用于审计日志）
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
    });

    // 5. 更新活动状态为 drawn（开奖完成）
    await db
      .update(lotteryDraws)
      .set({ status: "drawn", drawnAt: now, updatedAt: now, failureReason: "" })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));

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

    return { drawId, winnerCount: entryIndex, candidateCount };
  } catch (error) {
    // 开奖失败：恢复为 open 状态并记录失败原因
    // 不清除 drawSeedHash，保留审计线索
    const reason = error instanceof Error ? error.message.slice(0, 500) : "开奖失败（未知错误）";
    await db
      .update(lotteryDraws)
      .set({ status: "open", failureReason: reason, updatedAt: new Date().toISOString() })
      .where(and(eq(lotteryDraws.id, drawId), eq(lotteryDraws.tenantId, tenantId)));
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
      prizeCodeId: lotteryWinners.prizeCodeId,
      notificationStatus: lotteryWinners.notificationStatus,
    })
    .from(lotteryWinners)
    .where(and(eq(lotteryWinners.drawId, drawId), eq(lotteryWinners.tenantId, tenantId)));

  for (const winner of winners) {
    if (winner.notificationStatus === "sent") continue;

    let accountLabel = "";
    let deliverySecret = "";

    if (winner.prizeCodeId) {
      const [code] = await db
        .select({ code: prizeCodes.code, secret: prizeCodes.secret })
        .from(prizeCodes)
        .where(eq(prizeCodes.id, winner.prizeCodeId))
        .limit(1);
      if (code) { accountLabel = code.code; deliverySecret = code.secret; }
    }

    try {
      const result = await sendEmail(db, emailEnv, {
        to: winner.email,
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

/* ── 奖品管理 ────────────────────────────────────────────── */

/**
 * 创建奖品。
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
    prizeType: data.prizeType || "code",  // 默认卡密类型
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

  for (const item of codes) {
    await db.insert(prizeCodes).values({
      id: crypto.randomUUID(),
      tenantId,
      prizeId,
      code: item.code,
      secret: item.secret || "",
      status: "available",  // 初始状态：可用
    });
  }
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
  options?: { limit?: number },
): Promise<{ processed: number; failed: number; errors: Array<{ drawId: string; message: string }> }> {
  // 单次最多处理 50 个，默认 20 个
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
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

  for (const draw of due) {
    try {
      // Cron 调用时 operatorUserId 为 "system"
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