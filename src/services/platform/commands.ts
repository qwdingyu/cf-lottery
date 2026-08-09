/**
 * 租户内置平台命令服务（docs/167）。
 *
 * 当前文件先落地安全边界和可测试骨架：
 * - 固定命令集合，不允许租户动态新增任意命令。
 * - 只接受平台服务层解析出的 QQ 身份。
 * - 每个命令必须复用正式业务函数，禁止拼公开 email/OTP HTTP API。
 *
 * P0 当前先接 `/签到`。其它命令仍 fail closed，等逐个补测试后再打开。
 */
import type { DbType } from "../../db/client";
import { and, eq } from "drizzle-orm";
import { lotteryEntries } from "../../db/schema";
import { joinDraw, recordActivityEvent } from "../lottery-service";
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

async function executeCheckinCommand(
  db: DbType,
  input: ExecuteBuiltinCommandInput & { builtinCommands: BuiltinCommandConfig },
): Promise<PlatformCommandResult> {
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
          .where(and(
            eq(lotteryEntries.id, result.entryId),
            eq(lotteryEntries.tenantId, input.tenantId),
          ));
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
          command: "checkin",
          platform: input.source.platform,
          groupId: input.source.groupId,
          deployment: "platform_target",
        },
      });
      return { handled: true, reply: "签到成功，已记录你的参与。" };
    }

    if (result.alreadyJoined) {
      return { handled: true, reply: result.message || "你今天已经签到过了。" };
    }

    return { handled: true, reply: result.message || "签到失败，请稍后再试。" };
  } catch (err) {
    return {
      handled: true,
      reply: err instanceof Error ? err.message : "签到失败，请稍后再试。",
    };
  }
}
