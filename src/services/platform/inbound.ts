/**
 * 平台入站事件处理（docs/167）。
 *
 * 入站消息处理顺序：
 * 1. 识别系统内置命令；
 * 2. 通过 group_id 找平台目标绑定；
 * 3. 校验助手与命令开关；
 * 4. 进入 PlatformCommandService。
 */
import type { DbType } from "../../db/client";
import { executeBuiltinPlatformCommand, recognizeBuiltinCommand } from "./commands";
import { getActivePlatformTarget } from "./targets";
import type { InboundPlatformEvent, PlatformCommandResult } from "./types";

export async function handleInboundPlatformEvent(
  db: DbType,
  event: InboundPlatformEvent,
): Promise<PlatformCommandResult | null> {
  if (event.eventType !== "message" || !event.text) return null;
  const command = recognizeBuiltinCommand(event.text);
  if (!command) return null;

  const target = await getActivePlatformTarget(db, {
    platform: event.platform,
    targetId: event.sourceId,
  });
  if (!target || !target.assistantEnabled) {
    return {
      handled: true,
      reply: "当前群未绑定活动，请管理员先在后台启用 QQ 群助手。",
    };
  }

  return executeBuiltinPlatformCommand(db, {
    tenantId: target.tenantId,
    platformTargetId: target.id,
    drawId: target.activeDrawId,
    publicSlug: target.activePublicSlug,
    command,
    builtinCommands: target.builtinCommands,
    user: {
      identityType: "qq",
      identityValue: event.userId,
      displayName: event.senderDisplayName,
    },
    source: {
      platform: event.platform,
      groupId: event.sourceId,
      messageId: event.messageId,
      raw: event.raw,
    },
  });
}
