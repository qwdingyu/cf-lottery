/**
 * Telegram Bot 入站路由（docs/170）。
 *
 * 接收 Telegram 通过 webhook 推送的消息更新，标准化为 InboundPlatformEvent 后
 * 交给 inbound.ts 处理（与 QQ 群助手共用同一套内置命令服务）。
 *
 * 安全设计（与 QQ 路由的差异）：
 * - QQ 可通过 NapCat/OneBot 自定义请求头携带 token；
 * - Telegram 官方 setWebhook 支持 secret_token，回调时放在
 *   `X-Telegram-Bot-Api-Secret-Token` 头中；这里优先使用该头，避免 secret 出现在 URL 日志；
 * - URL query 参数 `secret` 仅作为历史 webhook 配置的兼容入口，后续应迁移到 header 方式；
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
import { enqueuePrivatePlatformMessage, logPrivateMessageFailure } from "../services/platform/delivery";
import type { InboundPlatformEvent } from "../services/platform/types";

export const platformTelegramRoute = new Hono<AppEnv>();

/**
 * POST /api/platform/telegram/message
 *
 * Telegram webhook 回调入口（单端点，根据 chat_id 匹配平台目标）。
 * 由 Telegram Bot API 通过 webhook 推送，优先使用官方 secret_token header 鉴权。
 *
 * 配置 webhook 时 URL 格式：
 *   https://example.com/api/platform/telegram/message
 *   setWebhook 参数：secret_token=<inbound_secret>
 *
 * 设计决策：
 * - 单端点 + secret 鉴权，而非每个目标一个独立 webhook URL（简化管理）。
 * - 业务处理只进入租户内置命令服务，不直接伪造公开 email/OTP API。
 */
platformTelegramRoute.post("/message", async (c) => {
  // 官方 header 优先：避免密钥进入 URL、反向代理访问日志或错误追踪系统。
  // query secret 仅用于兼容已配置的旧 webhook，不能作为新接入推荐方式。
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") || c.req.query("secret");
  if (!secret) return fail(c, "缺少 Telegram webhook secret", 401);

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
  // Telegram webhook 必须快速返回 200，否则 Telegram 会重试同一 update；
  // 私聊发送统一入 platform_deliveries，由 maintenance 异步投递和重试。
  if (result.privateMessages?.length) {
    const adapterConfig = target.adapterConfig as Record<string, unknown>;
    const botToken = String(adapterConfig.botToken || "").trim();
    if (botToken) {
      for (const pm of result.privateMessages) {
        try {
          await enqueuePrivatePlatformMessage(db, {
            tenantId: target.tenantId,
            platformTargetId: target.id,
            platform: "telegram",
            targetId: target.targetId,
            targetUserId: pm.userId,
            text: pm.text,
          });
        } catch {
          // 入队失败才在群回复中降级；发送失败由投递队列重试和审计。
          if (result.accessUrl) {
            result.reply += `\n\n⚠️ 私聊消息入队失败，可点击下方链接网页查看（5 分钟内有效，仅可查看一次，请勿泄露）：\n${result.accessUrl}`;
          } else {
            result.reply += "\n\n⚠️ 私聊消息入队失败，请通过网页后台查看卡密。";
          }
          await logPrivateMessageFailure(
            db,
            target,
            "telegram",
            pm.userId,
            pm.text,
            "私聊消息入队失败（数据库异常）",
          );
        }
      }
      result.reply += "\n\n私聊消息已进入发送队列，如未收到可稍后发送 /我的卡密 重试。";
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
