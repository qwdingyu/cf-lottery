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
import { logError } from "../../lib/logger";
import { executeBuiltinPlatformCommand, recognizeBuiltinCommand } from "./commands";
import { getActivePlatformTarget } from "./targets";
import type { InboundPlatformEvent, PlatformCommandResult, PlatformTargetBinding } from "./types";
import { isCommunityFeatureEnabled } from "../../lib/system-config-registry";
import { provisionPlatformUser } from "./user-provision";

/**
 * 处理入站平台事件（如 QQ 群消息）。
 *
 * @param db 数据库实例
 * @param event 入站事件
 * @param preFetchedTarget 可选预查的平台目标绑定，避免路由层和入站处理层重复查询（platform-qq.ts 路由已查一次用于鉴权）
 */
export async function handleInboundPlatformEvent(
  db: DbType,
  event: InboundPlatformEvent,
  preFetchedTarget?: PlatformTargetBinding | null,
  appOrigin?: string,
): Promise<PlatformCommandResult | null> {
  if (event.eventType !== "message" || !event.text) return null;
  const command = recognizeBuiltinCommand(event.text);
  if (!command) return null;

  // 使用预查 target（路由层已鉴权）或自行查询
  let target = preFetchedTarget;
  if (!target) {
    target = await getActivePlatformTarget(db, {
      platform: event.platform,
      targetId: event.sourceId,
    });
  }
  if (!target || !target.assistantEnabled) {
    return {
      handled: true,
      reply: "当前群未绑定活动，请管理员先在后台启用群助手。",
    };
  }

  // 社群功能全局开关（docs/174）：平台运营者关闭后，已存在的绑定停止响应命令（业务层闭环）。
  // 这里必须再次校验，而不仅靠 L2 路由的 POST/PUT 403——否则关闭后存量绑定仍会执行 /签到 /抽奖 等命令。
  if (!(await isCommunityFeatureEnabled(db))) {
    return {
      handled: true,
      reply: "社群功能已被平台运营者暂停，当前群助手暂不响应命令，请稍后再试。",
    };
  }

  // Phase B（docs/176 §3.4）：自动将平台身份关联到本地 users 表。
  // 确保每个 QQ/Telegram 用户都有对应的 users + authIdentities 记录。
  // 失败时降级（不阻断命令执行），userId 留空。
  let userId: string | undefined;
  try {
    const result = await provisionPlatformUser(db, {
      provider: event.platform as "qq" | "telegram",
      providerUserId: event.userId,
      displayName: event.senderDisplayName,
    });
    userId = result.userId;
  } catch (err) {
    // 降级：记录错误但不阻断命令执行；userId 留空，命令走 identityType/identityValue
    logError("platform-inbound", "provisionPlatformUser 失败", String(err));
  }

  return executeBuiltinPlatformCommand(db, {
    tenantId: target.tenantId,
    platformTargetId: target.id,
    drawId: target.activeDrawId,
    publicSlug: target.activePublicSlug,
    command,
    builtinCommands: target.builtinCommands,
    user: {
      // identityType 从 event.platform 推导，不硬编码具体平台名
      identityType: event.platform,
      identityValue: event.userId,
      displayName: event.senderDisplayName,
      // Phase B：本地 users.id，可为空
      userId,
    },
    source: {
      platform: event.platform,
      groupId: event.sourceId,
      messageId: event.messageId,
      raw: event.raw,
    },
    appOrigin,
  });
}
