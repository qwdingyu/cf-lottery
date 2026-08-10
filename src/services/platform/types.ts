/**
 * 平台适配层类型（docs/167）。
 *
 * 平台类型保留扩展位（qq/telegram/...）。业务层只依赖适配器抽象，
 * 不把具体适配器实现（如 NapCat/OneBot）作为领域概念写进命令服务。
 */

export type PlatformType = "qq" | "telegram";

export type AdapterDeploymentMode = "managed" | "tenant_hosted";

export type BuiltinPlatformCommand =
  | "checkin"
  | "spin"
  | "share"
  | "leaderboard"
  | "my_prize"
  | "help"
  /** 秒杀/购买：返回配置的购买链接，打通免费→付费转化漏斗（docs/171 §断层B） */
  | "flash";

export type BuiltinCommandConfig = {
  checkinEnabled: boolean;
  spinEnabled: boolean;
  shareEnabled: boolean;
  leaderboardEnabled: boolean;
  myPrizeEnabled: boolean;
  helpEnabled: boolean;
  /** 秒杀/购买命令开关（docs/171 §断层B） */
  flashEnabled: boolean;
  /**
   * 签到奖励配置（docs/172）。
   * 支持两种模式：
   *  1. grantSpinCount（旧字段）：简单固定值，保留向后兼容
   *  2. rewardConfig（新字段）：完整奖励配置，支持 4 种模式：
   *     - daily: 每日固定值或区间随机（min===max 为固定值）
   *     - linear: 线性递增，第 N 天 = base + (N-1) * increment
   *     - step: 阶梯递增，每 stepDays 天提升一次
   *     - cycle: 周期循环，第 cycleDays 天额外奖励后重置
   *  解析统一由 checkin-reward.ts 的 parseStoredCheckinPolicy 完成。
   */
  dailyCheckinPolicy?: {
    grantSpinCount?: number;
    rewardConfig?: import("./checkin-reward").CheckinStreakConfig;
  };
  replyOverrides?: Record<string, string>;
  /** 购买链接配置：群内 /秒杀 时返回此链接，引导用户从免费积分→付费购买（docs/171 §断层B） */
  purchaseConfig?: {
    /** 购买链接（公开活动页 URL，用户点击后进入秒杀/购买流程） */
    url: string;
    /** 链接展示文案，如 "🔥 限时秒杀 ¥9.90" */
    label: string;
  };
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
  adapterDeploymentMode: AdapterDeploymentMode;
  adapterProvider: string;
  adapterConfig: Record<string, unknown>;
  inboundSecretHash: string;
  builtinCommands: BuiltinCommandConfig;
};

export type PlatformMessage = {
  platform: PlatformType;
  /**
   * 目标 ID：
   * - targetType 为 "group"（或缺省）时 → 群 ID
   * - targetType 为 "private" 时 → 用户 ID（user_id）
   */
  targetId: string;
  /**
   * 目标类型：群聊 / 私聊（含非好友临时消息）。
   * 缺省按 "group" 处理，保持对现有调用方的向后兼容。
   */
  targetType?: "group" | "private";
  /**
   * 私聊/临时消息时用于建立临时会话上下文的群 ID。
   * NapCat 对非好友发送时，需传 group_id 以走 KCHATTYPETEMPC2CFROMGROUP 临时会话。
   */
  groupId?: string;
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

/**
 * 平台命令用户身份。
 * identityType 对应 lotteryEntries.identity_type 的字符串值（email/qq/telegram/...），
 * 由入站层从 event.platform 推导，命令服务不硬编码具体平台。
 */
export type PlatformCommandUser = {
  identityType: string;
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
  /**
   * 命令执行后的侧写私聊消息（如卡密私发）。
   * 由路由层（platform-qq.ts）在实际发送后根据结果决定是否降级回复。
   *
   * userId: 目标用户 QQ 号
   * groupId: 临时会话上下文群 ID（NapCat 非好友临时消息需要）
   * text: 私聊消息内容
   */
  privateMessages?: Array<{
    userId: string;
    groupId: string;
    text: string;
  }>;
};

export const DEFAULT_BUILTIN_COMMANDS: BuiltinCommandConfig = {
  checkinEnabled: true,
  spinEnabled: true,
  shareEnabled: true,
  leaderboardEnabled: true,
  myPrizeEnabled: true,
  helpEnabled: true,
  flashEnabled: true,
};
