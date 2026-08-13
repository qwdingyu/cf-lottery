/**
 * 租户内置平台命令服务（docs/167）。
 *
 * 设计约束：
 * - 固定命令集合，不允许租户动态新增任意命令。
 * - 只接受平台服务层解析出的身份（identityType 由入站层从 event.platform 推导）。
 * - 每个命令必须复用正式业务函数，禁止拼公开 email/OTP HTTP API。
 * - 命令服务不硬编码任何平台名；所有平台特定值（ipHash、userAgent、source 等）
 *   均从 input.source.platform 动态派生。
 *
 * P0 当前已接 `/签到`、`/分享`、`/排行榜`、`/抽奖`、`/我的奖品`。
 * 涉及卡密的回复必须默认群内脱敏，不能把完整码发到公开群聊里。
 */
import type { DbType } from "../../db/client";
import { isInstantResultMode } from "../../lib/activity-utils";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { lotteryDraws, lotteryEntries, lotteryWinners, lotteryPrizeTiers, prizes, prizeCodes, shareRecords } from "../../db/schema";
import { joinDraw, recordActivityEvent } from "../lottery-service";
import { performInstantSpin, SpinBusinessError } from "../lottery/spin-execution";
import { recordSpinLog } from "../lottery/spins-log";
import {
  aggregateViralInviteCounts,
  buildPublicSharePath,
  buildViralLeaderboardRanking,
  isViralLeaderboardEnabled,
  type ViralWeightConfig,
} from "../lottery/viral-weight";
import type {
  BuiltinCommandConfig,
  BuiltinPlatformCommand,
  ExecuteBuiltinCommandInput,
  PlatformCommandResult,
} from "./types";
import {
  computeCheckinReward,
  nextStreakAfterCheckin,
} from "./checkin-reward";
import { todayStr } from "../../lib/date-utils";
/** 一次性 Web 访问令牌（docs/179）：用于 Bot 生成卡密查看链接 */
import { generateAccessToken } from "./access-token";
/** 跨平台身份绑定（docs/179）：用于 QQ/Telegram 身份关联 */
import { generateBindingCode, consumeBindingCode, parseBindingCode } from "./binding";
/** 持久化限流（docs/049）：防止命令被高频滥用，与公开端点限流共用 rate_limit_log 表 */
import { checkDbRateLimit } from "../../lib/rate-limit";
/** 社群功能运行时强制群人数上限（docs/180 §3.3） */
import { enforceGroupMemberCap } from "./community-policy";

const COMMAND_LABELS: Record<BuiltinPlatformCommand, string> = {
  checkin: "/签到",
  spin: "/抽奖",
  share: "/分享",
  leaderboard: "/排行榜",
  my_prize: "/我的奖品",
  help: "/帮助",
  flash: "/秒杀",
  card_code: "/我的卡密",
  bind: "/绑定",
};

const COMMAND_ENABLED_KEYS: Record<Exclude<BuiltinPlatformCommand, "help" | "bind">, keyof BuiltinCommandConfig> = {
  checkin: "checkinEnabled",
  spin: "spinEnabled",
  share: "shareEnabled",
  leaderboard: "leaderboardEnabled",
  my_prize: "myPrizeEnabled",
  flash: "flashEnabled",
  card_code: "myCardCodeEnabled",
};

export function recognizeBuiltinCommand(text: string): BuiltinPlatformCommand | null {
  const trimmed = text.trim();
  switch (trimmed) {
    case "/签到":
    case "签到":
    case "/checkin":
    case "checkin":
      return "checkin";
    case "/抽奖":
    case "抽奖":
    case "/spin":
    case "spin":
      return "spin";
    case "/分享":
    case "分享":
    case "/share":
    case "share":
      return "share";
    case "/排行榜":
    case "排行榜":
    case "排行":
    case "/leaderboard":
    case "leaderboard":
      return "leaderboard";
    case "/我的奖品":
    case "我的奖品":
    case "/奖品":
    case "/my_prize":
    case "my_prize":
      return "my_prize";
    case "/帮助":
    case "帮助":
    case "/help":
    case "help":
      return "help";
    case "/我的卡密":
    case "我的卡密":
    case "/卡密":
    case "卡密":
    case "/card_code":
    case "card_code":
      return "card_code";
    case "/秒杀":
    case "秒杀":
    case "购买":
    case "/flash":
    case "flash":
      return "flash";
    default:
      // /绑定 命令支持带参数：/绑定 XXXXXX（XX 为跨平台绑定码，docs/179）
      if (trimmed === "/绑定" || trimmed === "绑定" || trimmed === "/bind" || trimmed === "bind") return "bind";
      if (trimmed.startsWith("/绑定 ") || trimmed.startsWith("绑定 ") || trimmed.startsWith("/bind ") || trimmed.startsWith("bind ")) return "bind";
      return null;
  }
}

export function isBuiltinCommandEnabled(command: BuiltinPlatformCommand, config: BuiltinCommandConfig): boolean {
  if (command === "help") return config.helpEnabled !== false;
  if (command === "bind") return true; // 绑定命令始终可用（用户级工具，docs/179）
  return config[COMMAND_ENABLED_KEYS[command]] !== false;
}

/**
 * 渲染 /帮助 回复。
 *
 * 注意：`flash`（/秒杀）命令即使 `flashEnabled` 为 true，
 * 若 `purchaseConfig.url` 未配置也视为「不可用」，不在帮助列表中展示。
 * 避免「提示可用 → 执行时提示管理员未配置」的体验断层（与 executeSpinCommand 耗尽引导的策略一致）。
 */
export function renderHelpReply(config: BuiltinCommandConfig): string {
  const enabled = (Object.keys(COMMAND_LABELS) as BuiltinPlatformCommand[])
    .filter((command) => {
      // flash 命令需要同时满足：开关开启 + 购买链接已配置，否则不在帮助中展示
      if (command === "flash") {
        return config.flashEnabled !== false && !!config.purchaseConfig?.url;
      }
      return isBuiltinCommandEnabled(command, config);
    })
    .map((command) => COMMAND_LABELS[command]);
  if (enabled.length === 0) return "当前群未启用群助手命令。";
  return `当前可用命令：${enabled.join(" ")}`;
}

/**
 * 命令路由表：新命令只需在此注册一行即可接入。
 * 注意：help 特殊处理（renderHelpReply 依赖 builtinCommands 配置），不在此表中。
 */
const COMMAND_HANDLERS: Record<string, (
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
) => Promise<PlatformCommandResult>> = {
  checkin: executeCheckinCommand,
  share: executeShareCommand,
  leaderboard: executeLeaderboardCommand,
  spin: executeSpinCommand,
  my_prize: executeMyPrizeCommand,
  flash: executeFlashCommand,
  card_code: executeCardCodeCommand,
  bind: executeBindCommand,
};

export async function executeBuiltinPlatformCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  if (!isBuiltinCommandEnabled(input.command, input.builtinCommands)) {
    return {
      handled: true,
      reply: `当前群未启用 ${COMMAND_LABELS[input.command]}。`,
    };
  }

  // 群已绑定但未选择活动时给出友好提示，避免 joinDraw 抛出"活动不存在"这种模糊错误
  if (!input.drawId || !input.publicSlug) {
    return {
      handled: true,
      reply: "当前群已绑定但未选择活动，请管理员在后台为群助手绑定活动。",
    };
  }

  if (input.command === "help") {
    return { handled: true, reply: renderHelpReply(input.builtinCommands) };
  }

  // 社群功能运行时强制群人数上限（docs/180 §3.3）：
  // 在命令分发前检查，新成员超限时拒绝，存量成员放行。
  const capCheck = await enforceGroupMemberCap(db, {
    tenantId: input.tenantId,
    platformTargetId: input.platformTargetId,
    userId: input.user?.userId,
  });
  if (!capCheck.ok) {
    return { handled: true, reply: capCheck.reply };
  }

  const handler = COMMAND_HANDLERS[input.command];
  if (handler) {
    try {
      return await handler(db, input);
    } catch (err) {
      // 所有命令的意外异常统一兜底，防止 500 导致用户收不到任何回复（Silence）
      console.error(`[platform] executeBuiltinPlatformCommand ${input.command} failed:`, err);
      return {
        handled: true,
        reply: "系统繁忙，请稍后再试。",
      };
    }
  }

  /**
   * 这里有意 fail closed。
   * 新命令必须注册 handler 后才能使用，避免未接业务函数时被误调用。
   */
  return {
    handled: true,
    reply: `${COMMAND_LABELS[input.command]} 暂不支持。`,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isViralEnabled(promotionConfig: string): boolean {
  const config = parseJsonObject(promotionConfig);
  const viral = config.viral && typeof config.viral === "object"
    ? config.viral as Record<string, unknown>
    : null;
  return viral?.enabled === true;
}

function parseViralConfig(promotionConfig: string): ViralWeightConfig | null {
  const config = parseJsonObject(promotionConfig);
  const viral = config.viral && typeof config.viral === "object"
    ? config.viral as ViralWeightConfig
    : null;
  return viral;
}

function renderPlatformDisplayName(entry: { displayName: string; identityValue: string }): string {
  const name = String(entry.displayName || "").trim();
  if (name) return name.length > 16 ? `${name.slice(0, 16)}...` : name;
  // displayName 为空时使用 identityValue 脱敏展示
  // identityValue 为平台用户 ID（QQ 号 / Telegram user id 等），脱敏输出 "123***789"
  const value = String(entry.identityValue || "").trim();
  if (!value) return "***";
  return value.length <= 6 ? "***" : `${value.slice(0, 3)}***${value.slice(-3)}`;
}

async function findPlatformEntryId(db: DbType, input: ExecuteBuiltinCommandInput): Promise<string> {
  const [entry] = await db
    .select({ id: lotteryEntries.id })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.tenantId, input.tenantId),
      eq(lotteryEntries.drawId, input.drawId),
      eq(lotteryEntries.identityType, input.user.identityType),
      eq(lotteryEntries.identityValue, input.user.identityValue),
    ))
    .orderBy(desc(lotteryEntries.joinedAt))
    .limit(1);
  return entry?.id || "";
}

async function ensurePlatformEntry(
  db: DbType,
  input: ExecuteBuiltinCommandInput,
): Promise<{ ok: true; entryId: string; joinedNow: boolean } | { ok: false; message: string }> {
  try {
    const result = await joinDraw(db, input.publicSlug, input.user.identityValue, input.user.identityType, {
      // ipHash 使用平台前缀 + 群组 ID 构建，确保不同平台/群组之间隔离
      ipHash: `${input.source.platform}:${input.source.groupId}`,
      // userAgent 标记来源平台，用于审计和频率控制
      userAgent: `cf-lottery-platform-${input.source.platform}`,
    });
    if (result.joined && result.entryId) {
      if (input.user.displayName) {
        await db
          .update(lotteryEntries)
          .set({ displayName: input.user.displayName.slice(0, 80) })
          .where(and(eq(lotteryEntries.id, result.entryId), eq(lotteryEntries.tenantId, input.tenantId)));
      }
      await recordActivityEvent(db, {
        tenantId: input.tenantId,
        drawId: input.drawId,
        entryId: result.entryId,
        eventType: "participation_completed",
        // source 使用平台名 + _group 标识群组来源，用于审计分析
        source: `${input.source.platform}_group`,
        medium: "platform_command",
        campaign: input.platformTargetId,
        metadata: {
          command: input.command,
          platform: input.source.platform,
          groupId: input.source.groupId,
        },
      });
      return { ok: true, entryId: result.entryId, joinedNow: true };
    }
    if (result.alreadyJoined && result.entryId) {
      return { ok: true, entryId: result.entryId, joinedNow: false };
    }
    return { ok: false, message: result.message || "参与失败，请稍后再试。" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "参与失败，请稍后再试。" };
  }
}

async function executeShareCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      publicSlug: lotteryDraws.publicSlug,
      promotionConfig: lotteryDraws.promotionConfig,
    })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.id, input.drawId),
      eq(lotteryDraws.tenantId, input.tenantId),
    ))
    .limit(1);
  if (!draw) return { handled: true, reply: "绑定活动不存在，请管理员重新绑定群助手。" };
  if (!isViralEnabled(draw.promotionConfig)) {
    return { handled: true, reply: "当前活动未开启裂变分享，请管理员先在活动推广配置中开启。" };
  }

  const entry = await ensurePlatformEntry(db, input);
  if (!entry.ok) return { handled: true, reply: entry.message };

  const existing = await db
    .select({ shareCode: shareRecords.shareCode })
    .from(shareRecords)
    .where(and(
      eq(shareRecords.tenantId, input.tenantId),
      eq(shareRecords.drawId, input.drawId),
      eq(shareRecords.sharerEntryId, entry.entryId),
    ))
    .orderBy(desc(shareRecords.createdAt))
    .limit(1);

  let shareCode = existing[0]?.shareCode || "";
  const reused = Boolean(shareCode);
  if (!shareCode) {
    shareCode = crypto.randomUUID().slice(0, 12);
    await db.insert(shareRecords).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      drawId: input.drawId,
      sharerEntryId: entry.entryId,
      shareCode,
    });
  }

  const shareUrl = buildPublicSharePath(draw.publicSlug || input.publicSlug, shareCode);
  await recordActivityEvent(db, {
    tenantId: input.tenantId,
    drawId: input.drawId,
    entryId: entry.entryId,
    eventType: "share_created",
    source: `${input.source.platform}_group`,
    medium: "platform_command",
    campaign: input.platformTargetId,
    refCode: shareCode,
    metadata: {
      command: "share",
      reused,
      joinedNow: entry.joinedNow,
      platform: input.source.platform,
      groupId: input.source.groupId,
    },
  });

  return {
    handled: true,
    reply: `你的专属邀请链接：${shareUrl}`,
  };
}

async function executeLeaderboardCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  const [draw] = await db
    .select({
      id: lotteryDraws.id,
      tenantId: lotteryDraws.tenantId,
      promotionConfig: lotteryDraws.promotionConfig,
    })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.id, input.drawId),
      eq(lotteryDraws.tenantId, input.tenantId),
    ))
    .limit(1);
  if (!draw) return { handled: true, reply: "绑定活动不存在，请管理员重新绑定群助手。" };

  const viral = parseViralConfig(draw.promotionConfig);
  if (!isViralLeaderboardEnabled(viral)) {
    return { handled: true, reply: "当前活动未开启裂变排行榜，请管理员先在活动推广配置中开启。" };
  }

  const myEntryId = await findPlatformEntryId(db, input);
  const shareRows = await db
    .select({
      sharerEntryId: shareRecords.sharerEntryId,
      joinedCount: shareRecords.joinedCount,
    })
    .from(shareRecords)
    .where(and(eq(shareRecords.tenantId, input.tenantId), eq(shareRecords.drawId, input.drawId)));

  const ranking = buildViralLeaderboardRanking(aggregateViralInviteCounts(shareRows), {
    entryId: myEntryId,
    topN: 5,
  });
  if (ranking.entries.length === 0) {
    return {
      handled: true,
      reply: myEntryId
        ? "当前还没有邀请排行，发送 /分享 获取专属邀请链接。"
        : "当前还没有邀请排行，先发送 /分享 获取专属邀请链接。",
    };
  }

  const entryIds = Array.from(new Set([
    ...ranking.entries.map((entry) => entry.entryId),
    ...(myEntryId ? [myEntryId] : []),
  ]));
  const entryRows = entryIds.length > 0
    ? await db
      .select({
        id: lotteryEntries.id,
        displayName: lotteryEntries.displayName,
        identityValue: lotteryEntries.identityValue,
      })
      .from(lotteryEntries)
      .where(and(eq(lotteryEntries.tenantId, input.tenantId), inArray(lotteryEntries.id, entryIds)))
    : [];
  const nameMap = new Map(entryRows.map((entry) => [entry.id, renderPlatformDisplayName(entry)]));

  const lines = ranking.entries.map((entry) => {
    const name = nameMap.get(entry.entryId) || "***";
    return `${entry.rank}. ${name} 邀请${entry.invitedCount}人`;
  });
  const myRank = ranking.myRank
    ? `我的排名：${ranking.myRank.rank > 0 ? `第${ranking.myRank.rank}名` : "暂未上榜"}，邀请${ranking.myRank.invitedCount}人`
    : "你还未参与本活动，发送 /分享 获取专属邀请链接。";

  return {
    handled: true,
    reply: `邀请排行榜 Top5\n${lines.join("\n")}\n${myRank}`,
  };
}

/**
 * 执行 /签到 命令（docs/171, docs/172）。
 *
 * 流程：
 * 1. 通过 ensurePlatformEntry 确保用户有抽奖活动的 entry
 * 2. 读取当前 entry 的 lastCheckinDate 和 checkinStreak
 * 3. 计算连续天数（断签/连续判断）
 * 4. 根据奖励配置（daily/fixed/linear/step/cycle）计算应发放 spins 数
 * 5. 原子条件 UPDATE：spins 累加 + 连续天数 + 签到日期在同一条语句完成
 *    WHERE (last_checkin_date IS NULL OR last_checkin_date < today)
 *    保证只有第一个并发请求命中，第二个请求影响 0 行即判定已签到。
 * 6. 记录签到事件（仅用于数据分析，不承担去重职责）
 *
 * 奖励计算（checkin-reward.ts）：
 *   daily  : 每日固定值或区间随机（min===max 固定，min<max 区间随机）
 *   linear : 第 N 天 = base + (N-1) * increment，封顶 cap
 *   step   : 每 stepDays 天提升一次，base + floor((N-1)/stepDays) * increment
 *   cycle  : 第 cycleDays 天额外发放 cycleBonus，之后重置连续天数
 *
 * 签到奖励不更新 spinsTotalGranted（签到奖励不是活动额度，是平台奖励），
 * 避免与裂变邀请的 maxSpinsPerEntry 限制冲突。
 */
async function executeCheckinCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  // 1. 确保有抽奖活动的 entry
  const result = await ensurePlatformEntry(db, input);
  if (!result.ok) {
    return { handled: true, reply: result.message || "签到失败，请稍后再试。" };
  }

  // 2. 检查是否配置了签到奖励
  const policy = input.builtinCommands.dailyCheckinPolicy;
  const streakConfig = policy?.rewardConfig;
  const grantSpinCount = policy?.grantSpinCount;
  const randomBonus = policy?.randomBonus;

  // 无奖励配置：保持原有行为（仅参与记录）
  if (!streakConfig && (!grantSpinCount || grantSpinCount <= 0)) {
    if (result.joinedNow) return { handled: true, reply: "签到成功，已记录你的参与。" };
    return { handled: true, reply: "您已参与此活动" };
  }

  const today = todayStr();
  const eventType = "daily_checkin";

  // 3. 读取当前 entry 的连续签到信息和 spinsLeft，用于计算奖励和日志
  const [entry] = await db
    .select({
      lastCheckinDate: lotteryEntries.lastCheckinDate,
      checkinStreak: lotteryEntries.checkinStreak,
      spinsLeft: lotteryEntries.spinsLeft,
    })
    .from(lotteryEntries)
    .where(and(
      eq(lotteryEntries.id, result.entryId),
      eq(lotteryEntries.tenantId, input.tenantId),
    ))
    .limit(1);

  if (!entry) {
    return { handled: true, reply: "签到失败，未找到参与记录。" };
  }

  // 4. 计算连续天数与奖励
  const currentStreak = entry.checkinStreak ?? 0;
  const nextStreak = nextStreakAfterCheckin(entry.lastCheckinDate, currentStreak, today);

  // 计算奖励：传入 streakDays = currentStreak（签到前的连续天数）
  // 随机 bonus（P2 randomBonus）在基础奖励之上额外增加 spins，增加签到惊喜感
  const reward = computeCheckinReward(
    streakConfig,
    grantSpinCount,
    currentStreak,
    nextStreak,
    undefined, // random01 — 使用默认 Math.random
    randomBonus,
  );

  // 5. 确定要写入的连续天数（cycle 模式达到 cycleDays 后重置）
  let finalStreak = nextStreak;
  if (streakConfig?.mode === "cycle" && streakConfig.cycleDays) {
    if (nextStreak >= streakConfig.cycleDays) {
      finalStreak = 1; // 周期重置，下一天重新开始
    }
  }

  if (reward > 0) {
    // 有奖励：原子 UPDATE 包括 spins 累加
    const updateResult = await db
      .update(lotteryEntries)
      .set({
        spinsLeft: sql`${lotteryEntries.spinsLeft} + ${reward}`,
        lastCheckinDate: today,
        checkinStreak: finalStreak,
      })
      .where(and(
        eq(lotteryEntries.id, result.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        or(
          isNull(lotteryEntries.lastCheckinDate),
          sql`${lotteryEntries.lastCheckinDate} < ${today}`,
        ),
      ));

    if ((updateResult.rowsAffected ?? 0) === 0) {
      return { handled: true, reply: "今日已签到，明天再来吧！" };
    }
  } else {
    // 奖励为 0：仅更新签到日期和连续天数，不发放 spins
    const updateResult = await db
      .update(lotteryEntries)
      .set({
        lastCheckinDate: today,
        checkinStreak: finalStreak,
      })
      .where(and(
        eq(lotteryEntries.id, result.entryId),
        eq(lotteryEntries.tenantId, input.tenantId),
        or(
          isNull(lotteryEntries.lastCheckinDate),
          sql`${lotteryEntries.lastCheckinDate} < ${today}`,
        ),
      ));

    if ((updateResult.rowsAffected ?? 0) === 0) {
      return { handled: true, reply: "今日已签到，明天再来吧！" };
    }
  }

  // 6. 写入 spins 流水日志（docs/172 §5.5 P1）：记录签到奖励发放
  if (reward > 0) {
    // P2 审查项：balanceAfter 用 UPDATE 后重读的真实余额，不依赖事务外预读（并发下可能虚高）。
    // 与 spin-execution.ts「事务内重读」标准一致；SQLite 单写者 + 命令串行处理下，此处重读即准确快照。
    const [fresh] = await db
      .select({ spinsLeft: lotteryEntries.spinsLeft })
      .from(lotteryEntries)
      .where(eq(lotteryEntries.id, result.entryId))
      .limit(1);
    const balanceAfter = Math.max(0, Number(fresh?.spinsLeft ?? 0));
    await recordSpinLog(db, {
      tenantId: input.tenantId,
      entryId: result.entryId,
      userId: input.user.identityValue,
      delta: reward,
      balanceAfter,
      reason: "checkin",
    });
  }

  // 7. 记录签到事件（仅用于数据分析，不承担去重职责）
  await recordActivityEvent(db, {
    tenantId: input.tenantId,
    drawId: input.drawId,
    entryId: result.entryId,
    eventType,
    source: `${input.source.platform}_group`,
    medium: "platform_command",
    campaign: input.platformTargetId,
    metadata: {
      command: input.command,
      reward,
      streakDays: finalStreak,
      mode: streakConfig?.mode ?? "fixed",
      platform: input.source.platform,
      groupId: input.source.groupId,
    },
  });

  // 7. 构建回复文案
  const streakMsg = finalStreak > 1
    ? ` (连续签到 ${finalStreak} 天)`
    : "";
  return {
    handled: true,
    reply: `✅ 签到成功！获得 ${reward} 次抽奖机会${streakMsg}，快去 /抽奖 试试手气吧！`,
  };
}

/**
 * 执行 /抽奖 命令（instant 即时抽奖）。
 *
 * 流程：
 * 1. 校验活动 activityKind=lottery 且 resultMode=instant
 * 2. 构建幂等键（优先使用平台 messageId，防止同一条消息重试被重复扣次）
 * 3. 调用 performInstantSpin 执行即时抽奖
 * 4. 根据结果返回中奖/未中奖消息
 */
async function executeSpinCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  // 命令层先明确收口：只有 lottery + instant 可以从公开群聊直接触发抽奖。
  // 虽然 performInstantSpin 也有纵深校验，这里提前返回更符合 SaaS 用户可理解的群内提示。
  const [draw] = await db
    .select({
      activityKind: lotteryDraws.activityKind,
      resultMode: lotteryDraws.resultMode,
    })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.id, input.drawId),
      eq(lotteryDraws.tenantId, input.tenantId),
    ))
    .limit(1);
  if (!draw) return { handled: true, reply: "绑定活动不存在，请管理员重新绑定群助手。" };

  if (String(draw.activityKind || "") !== "lottery") {
    return { handled: true, reply: "当前绑定活动不是抽奖活动，不能使用 /抽奖。请管理员绑定即时抽奖活动。" };
  }

  if (!isInstantResultMode(draw.resultMode)) {
    return { handled: true, reply: "当前活动为手动开奖，开奖后可用 /我的奖品 查看结果。" };
  }

  const entry = await ensurePlatformEntry(db, input);
  if (!entry.ok) return { handled: true, reply: entry.message };

  // 优先使用平台消息 ID 做幂等：同一条消息重试只回放一次，不会阻止用户后续发送新消息继续消耗抽奖次数。
  const idempotencyKey = buildPlatformSpinIdempotencyKey(input);

  try {
    const result = await performInstantSpin(db, {
      slug: input.publicSlug,
      identityType: input.user.identityType,
      identityValue: input.user.identityValue,
      idempotencyKey,
      // ipHash 使用平台前缀 + 群组 ID，确保不同平台/群组之间抽奖隔离
      ipHash: `${input.source.platform}:${input.source.groupId}`,
    });

    // 次数耗尽走正常返回值路径（businessError 非空），不再抛 SpinBusinessError。
    // 这样调用方无需在 catch 中区分「是否已扣次」——返回 businessError 即代表未扣次、
    // 未产生任何 spin/winner 写入，杜绝无限消耗（P0）。
    if (result.businessError) {
      const quotaGuide =
        result.businessErrorCode === "spin.quota.exhausted"
          ? buildQuotaPurchaseGuide(input.builtinCommands)
          : "";
      return { handled: true, reply: `${result.businessError}${quotaGuide}` };
    }

    if (result.won) {
      const prizeText = result.prizeName || result.tierName || "奖品";
      // 卡密奖品：群内回复只告知已私聊发送，实际卡密通过私聊传递。
      // 路由层（platform-qq.ts）在私聊发送失败后会在回复中追加降级提示。
      if (result.prizeCode) {
        return {
          handled: true,
          reply: `🎉 恭喜你抽中了「${prizeText}」！\n💰 卡密已私聊发送，请查看私聊消息。\n剩余抽奖次数：${result.spinsLeft} 次`,
          privateMessages: [
            {
              userId: input.user.identityValue,
              groupId: input.source.groupId,
              text: `🎉 恭喜你抽中了「${prizeText}」！\n\n🔑 卡密：${result.prizeCode}\n\n请妥善保管，勿将卡密泄露给他人。`,
            },
          ],
        };
      }
      return {
        handled: true,
        reply: `🎉 恭喜你抽中了「${prizeText}」！\n剩余抽奖次数：${result.spinsLeft} 次`,
      };
    }

    return {
      handled: true,
      reply: `😅 很遗憾，本次未中奖。剩余抽奖次数：${result.spinsLeft} 次`,
    };
  } catch (err) {
    if (err instanceof SpinBusinessError) {
      // SpinBusinessError 已经包含友好的中文错误消息
      // 注意：spin.quota.exhausted 已改为返回值路径（businessError），
      // 不会进入此 catch 块。此处只处理前置校验错误（draw not found 等）。
      return { handled: true, reply: err.message };
    }
    return { handled: true, reply: "抽奖失败，请稍后再试。" };
  }
}

/**
 * 构建抽奖次数耗尽时的购买引导文案。
 *
 * 打通「免费积分告急 → 秒杀购买」转化漏斗（docs/171 §断层B）。
 * 仅当租户同时满足以下条件才追加引导，避免「提示可用 → 实际不可用」的体验断层：
 * 1. 配置了购买链接（purchaseConfig.url 非空）
 * 2. flashEnabled 为 true（/秒杀 命令处于启用状态）
 *
 * @returns 引导文案（含前导逗号）；不满足条件时返回空字符串
 */
function buildQuotaPurchaseGuide(builtinCommands: BuiltinCommandConfig): string {
  const cfg = builtinCommands.purchaseConfig;
  if (cfg && cfg.url && builtinCommands.flashEnabled !== false) {
    return "，可使用 /秒杀 购买更多机会。";
  }
  return "";
}

/**
 * 构建平台抽奖幂等键。
 * 使用平台前缀 + targetId + messageId 确保跨平台不冲突：
 *   - qq:pt-xxx:msg-123   → QQ 平台某群某消息
 *   - telegram:pt-yyy:msg-456 → Telegram 平台某群某消息
 * 缺失 messageId 时使用随机 UUID 兜底，确保幂等性。
 */
function buildPlatformSpinIdempotencyKey(input: ExecuteBuiltinCommandInput): string {
  const messageId = String(input.source.messageId || "").trim();
  if (messageId) {
    return `${input.source.platform}:${input.platformTargetId}:${messageId}`.slice(0, 128);
  }
  return `${input.source.platform}:${input.platformTargetId}:no-message:${crypto.randomUUID()}`.slice(0, 128);
}

/**
 * 执行 /我的奖品 命令。
 *
 * 查询该用户在绑定活动中的所有中奖记录。群内只展示奖品摘要，不展示卡密明文。
 */
async function executeMyPrizeCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  // 先查找用户在该活动的参与记录
  const entry = await findPlatformEntryId(db, input);
  if (!entry) {
    return { handled: true, reply: "你还未参与本活动，发送 /抽奖 或 /签到 参与吧。" };
  }

  // 查询中奖记录，关联奖项名称。卡密明文不进入群消息响应，避免公开群泄露。
  // 使用 isNotNull 将 prizeCodeId 转为布尔标记 hasCode，不查 prizeCodes 表明文。
  const winners = await db
    .select({
      tierName: lotteryPrizeTiers.tierName,
      prizeName: prizes.name,
      hasCode: isNotNull(lotteryWinners.prizeCodeId),
      drawnAt: lotteryWinners.drawnAt,
    })
    .from(lotteryWinners)
    .leftJoin(lotteryPrizeTiers, and(
      eq(lotteryPrizeTiers.id, lotteryWinners.tierId),
      eq(lotteryPrizeTiers.tenantId, input.tenantId),
    ))
    .leftJoin(prizes, and(
      eq(prizes.id, lotteryPrizeTiers.prizeId),
      eq(prizes.tenantId, input.tenantId),
    ))
    .where(and(
      eq(lotteryWinners.tenantId, input.tenantId),
      eq(lotteryWinners.drawId, input.drawId),
      eq(lotteryWinners.entryId, entry),
    ))
    .orderBy(lotteryWinners.drawnAt);

  if (winners.length === 0) {
    return { handled: true, reply: "你还没有获得奖品，发送 /抽奖 试试手气吧！" };
  }

  const lines = winners.map((w, idx) => {
    const name = w.prizeName || w.tierName || `奖品 #${idx + 1}`;
    const code = w.hasCode ? "（卡密已发放，群内不展示）" : "";
    return `${idx + 1}. ${name}${code}`;
  });

  return {
    handled: true,
    reply: `🎁 你的奖品（共 ${winners.length} 件）：\n${lines.join("\n")}\n为避免泄露，卡密不在群内展示。`,
  };
}

/**
 * 执行 /我的卡密 命令（docs/173 卡密闭环断裂修复）。
 *
 * 卡密奖品通过私聊投递，但私聊可能因用户关闭临时会话/适配器异常而失败。
 * 本命令允许用户通过群内指令主动请求卡密重发，私聊发送失败时群内追加降级提示。
 *
 * 设计决策：
 * - 只查询 prizeCodeId IS NOT NULL 的 winner，与 /我的奖品 的 hasCode 标记一致。
 * - 卡密明文通过 privateMessages 侧写私聊发送，群内回复不包含卡密。
 * - 无卡密奖品时给予明确提示，引导用户使用 /我的奖品 查看全部奖品。
 * - 群内回复明确告知卡密数量，使用户能确认是否全部收到。
 */
async function executeCardCodeCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  // 限流：每人每 30 秒最多查询一次卡密，防止高频生成访问令牌
  if (!await checkDbRateLimit(db, `card_code:${input.user.userId}`, 1, 30000)) {
    return { handled: true, reply: "操作过于频繁，请稍后再试。" };
  }
  // 1. 查找用户在该活动的参与记录
  const entry = await findPlatformEntryId(db, input);
  if (!entry) {
    return { handled: true, reply: "你还未参与本活动，发送 /抽奖 参与吧。" };
  }

  // 2. 查询该用户所有带卡密的中奖记录，关联 prizeCodes 表取出卡密明文
  // 只查询 prizeCodeId IS NOT NULL 的 winner（有卡密的中奖记录）
  const winners = await db
    .select({
      tierName: lotteryPrizeTiers.tierName,
      prizeName: prizes.name,
      code: prizeCodes.code,
      // 同时取 secret（密码）：有 secret 的卡密若只返回 code，用户拿到卡号却无密码无法核销
      secret: prizeCodes.secret,
      drawnAt: lotteryWinners.drawnAt,
    })
    .from(lotteryWinners)
    .leftJoin(lotteryPrizeTiers, and(
      eq(lotteryPrizeTiers.id, lotteryWinners.tierId),
      eq(lotteryPrizeTiers.tenantId, input.tenantId),
    ))
    .leftJoin(prizes, and(
      eq(prizes.id, lotteryPrizeTiers.prizeId),
      eq(prizes.tenantId, input.tenantId),
    ))
    .leftJoin(prizeCodes, and(
      eq(prizeCodes.id, lotteryWinners.prizeCodeId),
      eq(prizeCodes.tenantId, input.tenantId),
    ))
    .where(and(
      eq(lotteryWinners.tenantId, input.tenantId),
      eq(lotteryWinners.drawId, input.drawId),
      eq(lotteryWinners.entryId, entry),
      isNotNull(lotteryWinners.prizeCodeId),
    ))
    .orderBy(lotteryWinners.drawnAt);

  if (winners.length === 0) {
    return { handled: true, reply: "你还没有获得卡密奖品。发送 /我的奖品 查看全部奖品。" };
  }

  // 3. 组装私聊消息：每条卡密一条私聊消息（含 Web 访问链接兜底）
  // 生成一次性 Web 访问链接：解决私聊失败后卡密无法 Web 找回的闭环（docs/179）
  // 仅当 Phase B 已关联本地 userId（input.user.userId）时生成；否则降级为纯私聊。
  // 安全：accessUrl 只在私聊消息中下发，绝不写进群回复。
  // P1 修复（防群内先点者窃卡）：私聊发送失败时，路由层也不再把 accessUrl 追加到群回复，
  // 只提示「发送 /卡密 重试或联系管理员」，重试会重新走私聊投递（见路由层实现）。
  const accessUrl = await buildCardCodeAccessUrl(db, input);
  const accessHint = accessUrl
    ? `\n\n💻 网页查看（5 分钟内有效，仅可查看一次）：\n${accessUrl}`
    : "";

  const privateMessages = winners.map((w) => {
    const name = w.prizeName || w.tierName || "奖品";
    // 卡密拼接规则与 spin-execution.ts 的 prizeCodePlain 保持一致：
    // 有 secret（密码）时拼成 "code:secret"，确保用户拿到完整卡密用于核销
    // 无 secret 的卡密（如纯数字兑换码）只返回 code，不拼接 ":secret" 后缀
    const fullCard = w.code
      ? (w.secret ? `${w.code}:${w.secret}` : w.code)
      : "（卡密待补发，请联系管理员）";
    return {
      userId: input.user.identityValue,
      groupId: input.source.groupId,
      text: `🔑 你的卡密：\n奖品：${name}\n卡密：${fullCard}\n\n请妥善保管，勿将卡密泄露给他人。${accessHint}`,
    };
  });

  // 群内回复：只告知数量和私聊发送，不泄露卡密明文，也不放访问链接（防群内截胡）。
  return {
    handled: true,
    reply: `🔑 你有 ${winners.length} 条卡密，已通过私聊发送，请查看私聊消息。`,
    privateMessages,
    accessUrl,
  };
}

/**
 * 为卡密命令生成一次性 Web 访问链接。
 *
 * 前置条件：
 * - input.user.userId 已存在（Phase B 已关联 users.id）
 * - input.appOrigin 已配置（APP_ORIGIN 环境变量）
 *
 * 返回 null 表示无法生成（无 userId 或 appOrigin），命令降级为纯私聊。
 */
async function buildCardCodeAccessUrl(
  db: DbType,
  input: ExecuteBuiltinCommandInput,
): Promise<string | undefined> {
  if (!input.user.userId || !input.appOrigin) return undefined;
  try {
    // P0-1 安全修复：令牌绑定 drawId，确保 Web 页只返回该 draw 下的卡密（跨租户隔离）
    const { token } = await generateAccessToken(db, input.user.userId, "card_code", { drawId: input.drawId });
    const origin = input.appOrigin.replace(/\/+$/, "");
    return `${origin}/access/card-codes?token=${encodeURIComponent(token)}`;
  } catch (err) {
    // 令牌生成失败不阻断卡密私聊主流程（降级为纯私聊）
    console.error(`[platform] 生成卡密访问链接失败: ${String(err)}`);
    return undefined;
  }
}

/**
 * 执行 /秒杀 命令（docs/171 §断层B）。
 *
 * 返回租户配置的购买链接，引导用户从免费积分→付费购买。
 * 不处理支付（用户点击链接后在浏览器中完成支付流程）。
 *
 * 配置项（builtinCommandsJson）：
 *   purchaseConfig.url  — 购买链接（公开活动页 URL）
 *   purchaseConfig.label — 链接展示文案
 */
async function executeFlashCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  const cfg = input.builtinCommands.purchaseConfig;
  if (!cfg || !cfg.url) {
    return { handled: true, reply: "管理员尚未配置购买链接，请联系管理员设置。可通过活动推广配置中的「购买链接」进行配置。" };
  }
  return {
    handled: true,
    reply: `${cfg.label}\n${cfg.url}`,
  };
}

/**
 * 执行 /绑定 命令（docs/179 跨平台身份绑定）。
 *
 * 两种模式：
 * 1. 无参数（/绑定）：生成绑定码，返回给用户，用于在另一个平台完成绑定。
 * 2. 带参数（/绑定 XXXXXX）：消费绑定码，将当前平台身份合并到发起方用户的 users.id。
 *
 * 安全约束：
 * - 绑定码 6 位高熵字符，10 分钟有效期，一次性使用。
 * - 禁止同一平台自我绑定（QQ 不能绑定 QQ）。
 * - 必须存在 Phase B 关联的 userId（input.user.userId）。
 */
async function executeBindCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  // 必须已关联本地 userId（Phase B 前置条件）
  if (!input.user.userId) {
    return { handled: true, reply: "绑定失败：系统未找到你的身份信息，请稍后再试。" };
  }

  // 解析命令文本中的绑定码
  const raw = String(input.source.raw || "").trim();
  const code = parseBindingCode(raw);

  // 模式 1：无参数 → 生成绑定码
  if (!code) {
    // 限流：每人每 60 秒最多生成一次绑定码，防止滥用填充 platform_bindings 表
    if (!await checkDbRateLimit(db, `bind_gen:${input.user.userId}`, 1, 60000)) {
      return { handled: true, reply: "操作过于频繁，请稍后再试。" };
    }
    try {
      const { code: bindingCode, expiresAt } = await generateBindingCode(
        db,
        input.source.platform,
        input.user.identityValue,
        input.user.userId,
      );
      const expiresIn = Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000 / 60);
      // 安全：绑定码通过私聊下发，不在群内显示明文（防群内截胡，P0-2 安全修复）
      // 私聊失败时，路由层会在群回复追加降级提示，但不会显示绑定码明文
      return {
        handled: true,
        reply: `🔗 绑定码已通过私聊发送，请查看私聊消息。\n\n⏰ 绑定码 ${expiresIn} 分钟内有效，请尽快在另一个平台操作。`,
        privateMessages: [{
          userId: input.user.identityValue,
          groupId: input.source.groupId,
          text: `🔗 你的绑定码：${bindingCode}\n\n请在另一个平台（如 ${input.source.platform === "qq" ? "Telegram" : "QQ"} 群）发送 /绑定 ${bindingCode} 完成关联。\n⏰ 绑定码 ${expiresIn} 分钟内有效，请尽快操作。\n\n⚠️ 请勿将绑定码分享给任何人，此码可让对方查看你的卡密。`,
        }],
      };
    } catch (err) {
      console.error(`[platform] 生成绑定码失败: ${String(err)}`);
      return { handled: true, reply: "生成绑定码失败，请稍后再试。" };
    }
  }

  // 模式 2：带参数 → 消费绑定码，完成身份合并
  // 限流：每用户每 10 秒最多消费一次绑定码，防止对绑定码做暴力破解。
  // P2 审查项：原实现用全局键 "bind_consume:global"——任意用户的高频请求会阻塞所有用户
  // 的绑定消费（全局互斥 DoS 面）；改为 per-user 键，单用户试探仍被限制、不影响他人。
  // 绑定码本身 28^6 高熵 + 一次性 + 10 分钟短时效，per-user 限流足够兜底。
  if (!await checkDbRateLimit(db, `bind_consume:${input.user.userId || input.user.identityValue || "unknown"}`, 1, 10000)) {
    return { handled: true, reply: "操作过于频繁，请稍后再试。" };
  }
  try {
    const result = await consumeBindingCode(
      db,
      code,
      input.source.platform,
      input.user.identityValue,
      input.user.userId,
    );

    if (!result.ok) {
      return { handled: true, reply: result.reason };
    }

    if (result.merged) {
      return {
        handled: true,
        reply: "✅ 绑定成功！你的 QQ 和 Telegram 账号已关联到同一个账户。现在你可以在任一平台查看卡密、参与活动。",
      };
    }

    // 已指向同一用户，无需重复合并
    return {
      handled: true,
      reply: "你的 QQ 和 Telegram 账号已关联到同一个账户，无需重复绑定。",
    };
  } catch (err) {
    console.error(`[platform] 消费绑定码失败: ${String(err)}`);
    return { handled: true, reply: "绑定失败，请稍后再试。" };
  }
}
