/**
 * 平台适配层类型（docs/167）。
 *
 * P0 聚焦 QQ 群增长助手，平台类型保留扩展位。业务层只依赖 qq-adapter
 * 抽象，不把 NapCat 作为领域概念写进命令服务。
 */

export type PlatformType = "qq" | "telegram";

export type BuiltinPlatformCommand =
  | "checkin"
  | "spin"
  | "share"
  | "leaderboard"
  | "my_prize"
  | "help";

export type BuiltinCommandConfig = {
  checkinEnabled: boolean;
  spinEnabled: boolean;
  shareEnabled: boolean;
  leaderboardEnabled: boolean;
  myPrizeEnabled: boolean;
  helpEnabled: boolean;
  dailyCheckinPolicy?: {
    grantSpinCount?: number;
  };
  replyOverrides?: Record<string, string>;
};

export type PlatformTargetBinding = {
  id: string;
  tenantId: string;
  platform: PlatformType;
  targetId: string;
  targetName: string;
  activeDrawId: string;
  activePublicSlug: string;
  assistantEnabled: boolean;
  builtinCommands: BuiltinCommandConfig;
};

export type PlatformMessage = {
  platform: PlatformType;
  targetId: string;
  type: "text" | "image" | "card";
  text?: string;
  imageUrl?: string;
  cardData?: Record<string, unknown>;
};

export type PlatformAdapter = {
  readonly platform: PlatformType;
  send(message: PlatformMessage): Promise<{ messageId: string; response?: unknown }>;
  sendBatch(messages: PlatformMessage[]): Promise<Array<{ messageId: string; response?: unknown }>>;
};

export type InboundPlatformEvent = {
  platform: PlatformType;
  sourceId: string;
  userId: string;
  eventType: "message" | "command" | "callback" | "member_join" | "member_leave";
  text?: string;
  messageId?: string;
  senderDisplayName?: string;
  raw?: unknown;
};

export type PlatformCommandUser = {
  identityType: "qq";
  identityValue: string;
  displayName?: string;
};

export type ExecuteBuiltinCommandInput = {
  tenantId: string;
  platformTargetId: string;
  drawId: string;
  publicSlug: string;
  command: BuiltinPlatformCommand;
  user: PlatformCommandUser;
  source: {
    platform: PlatformType;
    groupId: string;
    messageId?: string;
    raw?: unknown;
  };
};

export type PlatformCommandResult = {
  reply: string;
  handled: boolean;
};

export const DEFAULT_BUILTIN_COMMANDS: BuiltinCommandConfig = {
  checkinEnabled: true,
  spinEnabled: true,
  shareEnabled: true,
  leaderboardEnabled: true,
  myPrizeEnabled: true,
  helpEnabled: true,
};
