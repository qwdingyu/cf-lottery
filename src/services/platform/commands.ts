/**
 * 租户内置平台命令服务（docs/167）。
 *
 * 当前文件先落地安全边界和可测试骨架：
 * - 固定命令集合，不允许租户动态新增任意命令。
 * - 只接受平台服务层解析出的 QQ 身份。
 * - 每个命令必须复用正式业务函数，禁止拼公开 email/OTP HTTP API。
 *
 * P0 当前已接 `/签到`、`/分享`、`/排行榜`、`/抽奖`、`/我的奖品`。
 * 涉及卡密的回复必须默认群内脱敏，不能把完整码发到 QQ 群里。
 */
import type { DbType } from "../../db/client";
import { and, desc, eq, inArray } from "drizzle-orm";
import { lotteryDraws, lotteryEntries, lotteryWinners, lotteryPrizeTiers, prizes, shareRecords } from "../../db/schema";
import { joinDraw, recordActivityEvent } from "../lottery-service";
import { performInstantSpin, SpinBusinessError } from "../lottery/spin-execution";
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

const COMMAND_LABELS: Record<BuiltinPlatformCommand, string> = {
  checkin: "/签到",
  spin: "/抽奖",
  share: "/分享",
  leaderboard: "/排行榜",
  my_prize: "/我的奖品",
  help: "/帮助",
};

const COMMAND_ENABLED_KEYS: Record<Exclude<BuiltinPlatformCommand, "help">, keyof BuiltinCommandConfig> = {
  checkin: "checkinEnabled",
  spin: "spinEnabled",
  share: "shareEnabled",
  leaderboard: "leaderboardEnabled",
  my_prize: "myPrizeEnabled",
};

export function recognizeBuiltinCommand(text: string): BuiltinPlatformCommand | null {
  const trimmed = text.trim();
  switch (trimmed) {
    case "/签到":
    case "签到":
      return "checkin";
    case "/抽奖":
    case "抽奖":
      return "spin";
    case "/分享":
    case "分享":
      return "share";
    case "/排行榜":
    case "排行榜":
    case "排行":
      return "leaderboard";
    case "/我的奖品":
    case "我的奖品":
    case "/奖品":
      return "my_prize";
    case "/帮助":
    case "帮助":
    case "/help":
      return "help";
    default:
      return null;
  }
}

export function isBuiltinCommandEnabled(command: BuiltinPlatformCommand, config: BuiltinCommandConfig): boolean {
  if (command === "help") return config.helpEnabled !== false;
  return config[COMMAND_ENABLED_KEYS[command]] !== false;
}

export function renderHelpReply(config: BuiltinCommandConfig): string {
  const enabled = (Object.keys(COMMAND_LABELS) as BuiltinPlatformCommand[])
    .filter((command) => isBuiltinCommandEnabled(command, config))
    .map((command) => COMMAND_LABELS[command]);
  if (enabled.length === 0) return "当前群未启用 QQ 群助手命令。";
  return `当前可用命令：${enabled.join(" ")}`;
}

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

  if (input.command === "help") {
    return { handled: true, reply: renderHelpReply(input.builtinCommands) };
  }

  if (input.command === "checkin") {
    return executeCheckinCommand(db, input);
  }

  if (input.command === "share") {
    return executeShareCommand(db, input);
  }

  if (input.command === "leaderboard") {
    return executeLeaderboardCommand(db, input);
  }

  if (input.command === "spin") {
    return executeSpinCommand(db, input);
  }

  if (input.command === "my_prize") {
    return executeMyPrizeCommand(db, input);
  }

  /**
   * 这里有意 fail closed。
   * 平台身份接入活动数据前，必须逐个命令接正式业务函数并补测试；
   * 不能临时拼公开 HTTP API，因为公开路由是 email/JWT/OTP 语义。
   */
  return {
    handled: true,
    reply: `${COMMAND_LABELS[input.command]} 已识别，平台命令服务正在接入活动「${input.publicSlug}」。`,
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
  const value = String(entry.identityValue || "").trim();
  if (!value) return "***";
  if (value.startsWith("qq:")) {
    const qq = value.slice(3).split(":")[0] || "";
    if (qq.length <= 4) return "QQ用户";
    return `QQ${qq.slice(0, 2)}***${qq.slice(-2)}`;
  }
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
      ipHash: `qq:${input.source.groupId}`,
      userAgent: "cf-lottery-platform-qq",
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
        source: "qq_group",
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
  if (!draw) return { handled: true, reply: "绑定活动不存在，请管理员重新绑定 QQ 群助手。" };
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
    source: "qq_group",
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
  if (!draw) return { handled: true, reply: "绑定活动不存在，请管理员重新绑定 QQ 群助手。" };

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

async function executeCheckinCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  const result = await ensurePlatformEntry(db, input);
  if (result.ok && result.joinedNow) return { handled: true, reply: "签到成功，已记录你的参与。" };
  if (result.ok) return { handled: true, reply: "您已参与此活动" };
  return { handled: true, reply: result.message || "签到失败，请稍后再试。" };
}

/**
 * 执行 /抽奖 命令（instant 即时抽奖）。
 *
 * 流程：
 * 1. 校验活动 resultMode 是否为 instant
 * 2. 构建幂等键（优先使用 QQ messageId，防止同一条消息重试被重复扣次）
 * 3. 调用 performInstantSpin 执行即时抽奖
 * 4. 根据结果返回中奖/未中奖消息
 */
async function executeSpinCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
  // 查询活动确认 resultMode=instant
  const [draw] = await db
    .select({ resultMode: lotteryDraws.resultMode })
    .from(lotteryDraws)
    .where(and(
      eq(lotteryDraws.id, input.drawId),
      eq(lotteryDraws.tenantId, input.tenantId),
    ))
    .limit(1);
  if (!draw) return { handled: true, reply: "绑定活动不存在，请管理员重新绑定 QQ 群助手。" };

  if (String(draw.resultMode || "") !== "instant") {
    return { handled: true, reply: "当前活动不是即时抽奖模式，请在手动开奖后查看结果。发送 /帮助 查看更多命令。" };
  }

  const entry = await ensurePlatformEntry(db, input);
  if (!entry.ok) return { handled: true, reply: entry.message };

  // 优先使用平台消息 ID 做幂等：同一条 QQ 消息重试只回放一次，不会阻止用户后续发送新消息继续消耗抽奖次数。
  const idempotencyKey = buildPlatformSpinIdempotencyKey(input);

  try {
    const result = await performInstantSpin(db, {
      slug: input.publicSlug,
      identityType: input.user.identityType,
      identityValue: input.user.identityValue,
      idempotencyKey,
      ipHash: `qq:${input.source.groupId}`,
    });

    if (result.won) {
      const prizeText = result.prizeName || result.tierName || "奖品";
      const codeText = result.prizeCode
        ? "\n卡密已发放。为避免群内泄露，请通过主办方后台核验或后续私聊/网页查看能力领取。"
        : "";
      return {
        handled: true,
        reply: `🎉 恭喜你抽中了「${prizeText}」！${codeText}\n剩余抽奖次数：${result.spinsLeft} 次`,
      };
    }

    return {
      handled: true,
      reply: `😅 很遗憾，本次未中奖。剩余抽奖次数：${result.spinsLeft} 次`,
    };
  } catch (err) {
    if (err instanceof SpinBusinessError) {
      // SpinBusinessError 已经包含友好的中文错误消息
      return { handled: true, reply: err.message };
    }
    return { handled: true, reply: "抽奖失败，请稍后再试。" };
  }
}

function buildPlatformSpinIdempotencyKey(input: ExecuteBuiltinCommandInput): string {
  const messageId = String(input.source.messageId || "").trim();
  if (messageId) {
    return `qq:${input.platformTargetId}:${messageId}`.slice(0, 128);
  }
  return `qq:${input.platformTargetId}:no-message:${crypto.randomUUID()}`.slice(0, 128);
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
  const winners = await db
    .select({
      id: lotteryWinners.id,
      tierName: lotteryPrizeTiers.tierName,
      prizeName: prizes.name,
      prizeCodeId: lotteryWinners.prizeCodeId,
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
    const code = w.prizeCodeId ? "（卡密已发放，群内不展示）" : "";
    return `${idx + 1}. ${name}${code}`;
  });

  return {
    handled: true,
    reply: `🎁 你的奖品（共 ${winners.length} 件）：\n${lines.join("\n")}\n为避免泄露，卡密不在群内展示。`,
  };
}
