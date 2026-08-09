/**
 * 租户内置平台命令服务（docs/167）。
 *
 * 当前文件先落地安全边界和可测试骨架：
 * - 固定命令集合，不允许租户动态新增任意命令。
 * - 只接受平台服务层解析出的 QQ 身份。
 * - 未接入正式业务函数前返回明确提示，不写入参与/开奖数据。
 *
 * 后续实现 `/签到` `/抽奖` `/分享` `/排行榜` `/我的奖品` 时，应在这里复用
 * joinDraw / performInstantSpin / shareRecords / my-result 同源查询逻辑。
 */
import type { DbType } from "../../db/client";
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
  _db: DbType,
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
