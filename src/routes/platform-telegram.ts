/**
 * Telegram Bot 入站路由（docs/170）。
 *
 * 接收 Telegram 通过 webhook 推送的消息更新，标准化为 InboundPlatformEvent 后
 * 交给 inbound.ts 处理（与 QQ 群助手共用同一套内置命令服务）。
 *
 * 安全设计（与 QQ 路由的差异）：
 * - QQ 可通过 NapCat/OneBot 自定义请求头携带 token；
 * - Telegram webhook 不支持自定义请求头，因此鉴权改走 URL query 参数 `secret`；
 * - 每个平台目标有独立 inboundSecret，明文只在绑定向导下发一次，库中存 SHA-256 哈希。
 */
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok } from "../lib/http";
import { getEnv } from "../lib/platform";
import { timingSafeEqualString } from "../lib/crypto-compare";
import { handleInboundPlatformEvent } from "../services/platform/inbound";
import { getActivePlatformTarget } from "../services/platform/targets";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { getPlatformAdapter } from "../services/platform/adapter-factory";
import type { InboundPlatformEvent } from "../services/platform/types";

export const platformTelegramRoute = new Hono<AppEnv>();

/**
 * POST /api/platform/telegram/message
 *
 * Telegram webhook 回调入口（单端点，根据 chat_id 匹配平台目标）。
 * 由 Telegram Bot API 通过 webhook 推送，URL 中携带 secret 鉴权参数。
 *
 * 配置 webhook 时 URL 格式：
 *   https://example.com/api/platform/telegram/message?secret=<inbound_secret>
 *
 * 设计决策：
 * - 单端点 + secret 鉴权，而非每个目标一个独立 webhook URL（简化管理）。
 * - 业务处理只进入租户内置命令服务，不直接伪造公开 email/OTP API。
 */
platformTelegramRoute.post("/message", async (c) => {
  // Telegram webhook 无法自定义请求头，鉴权走 URL query 参数（见文件头注释）
  const secret = c.req.query("secret");
  if (!secret) return fail(c, "缺少 secret 参数", 401);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "请求体不是有效 JSON", 400);

  // Telegram 消息结构：update.message.chat.id 为群组/用户 ID
  const message = body.message && typeof body.message === "object"
    ? body.message as Record<string, unknown>
    : null;
  // 非消息更新（如 callback_query、channel_post）直接忽略，返回 200 避免 webhook 重试风暴
  if (!message) return ok(c, { handled: false, reason: "非消息更新" });

  const chat = message.chat && typeof message.chat === "object"
    ? message.chat as Record<string, unknown>
    : null;
  const chatId = String(chat?.id ?? "").trim();
  const from = message.from && typeof message.from === "object"
    ? message.from as Record<string, unknown>
    : null;
  const userId = String(from?.id ?? "").trim();
  // first_name 可作为展示名，username 可作退化兜底
  const senderDisplayName = String(from?.first_name ?? from?.username ?? "").trim();
  if (!chatId || !userId) return fail(c, "缺少 chat_id 或 user_id", 400);

  const db = getDb(c);

  // 通过 chatId 查找平台目标（Telegram 群组 ID 以 -100 开头，聊天气用正数）
  const target = await getActivePlatformTarget(db, { platform: "telegram", targetId: chatId });
  if (!target) return fail(c, "Telegram 目标未绑定", 404);
  if (!target.inboundSecretHash) return fail(c, "入站密钥未配置", 503);

  // 常量时间比较：降低 secret 前缀计时面（与 QQ 路由同策略）
  const secretHash = await hashPlatformInboundSecret(secret);
  if (!timingSafeEqualString(secretHash, target.inboundSecretHash)) {
    return fail(c, "未授权", 401);
  }

  const event: InboundPlatformEvent = {
    platform: "telegram",
    sourceId: chatId,
    userId,
    eventType: "message",
    // 文本消息取 message.text，带图文的媒体消息取 caption
    text: String(message.text ?? message.caption ?? ""),
    messageId: String(message.message_id ?? ""),
    senderDisplayName,
    raw: body,
  };

  const result = await handleInboundPlatformEvent(db, event, target, getEnv(c, "APP_ORIGIN"));
  if (!result) return ok(c, { handled: false });

  // 处理命令侧写的私聊消息（如卡密私发）。
  // Telegram Bot API 使用 sendMessage 统一发送群聊和私聊消息，
  // chat_id 为用户 ID 即私聊，为群 ID 即群聊。
  // 若命令同时返回了 accessUrl（一次性 Web 链接），降级提示中附加该链接（docs/179）。
  if (result.privateMessages?.length) {
    const adapterConfig = target.adapterConfig as Record<string, unknown>;
    const botToken = String(adapterConfig.botToken || "").trim();
    if (botToken) {
      const adapter = getPlatformAdapter("telegram", adapterConfig);
      for (const pm of result.privateMessages) {
        try {
          await adapter.send({
            platform: "telegram",
            targetType: "private",
            targetId: pm.userId,
            type: "text",
            text: pm.text,
          });
        } catch {
          // 私发失败，在群回复中追加降级提示
          if (result.accessUrl) {
            result.reply += `\n\n⚠️ 私聊发送失败，可点击下方链接网页查看（5 分钟内有效，仅可查看一次，请勿泄露）：\n${result.accessUrl}`;
          } else {
            result.reply += "\n\n⚠️ 私聊发送失败，请通过网页后台查看卡密。";
          }
        }
      }
    } else {
      // 适配器未配置 botToken，无法发送私聊，追加降级提示
      if (result.accessUrl) {
        result.reply += `\n\n⚠️ 系统未配置 Telegram Bot Token，无法私聊发送卡密。可点击下方链接网页查看：\n${result.accessUrl}`;
      } else {
        result.reply += "\n\n⚠️ 系统未配置 Telegram Bot Token，无法私聊发送卡密。请通过网页后台查看。";
      }
    }
  }

  return ok(c, { handled: result.handled, reply: result.reply });
});