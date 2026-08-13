/**
 * QQ 群助手入站路由（docs/167）。
 *
 * 这是机器入口，不走平台后台 JWT。NapCat/OneBot 上报必须携带共享 token，
 * 并且业务处理只进入租户内置命令服务，不直接伪造公开 email/OTP API。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok } from "../lib/http";
import { getEnv } from "../lib/platform";
import { timingSafeEqualString } from "../lib/crypto-compare";
import { handleInboundPlatformEvent } from "../services/platform/inbound";
import { getActivePlatformTarget, syncInboundBotIdentity } from "../services/platform/targets";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { enqueuePrivatePlatformMessage, logPrivateMessageFailure } from "../services/platform/delivery";

export const platformQQRoute = new Hono<AppEnv>();

function readInboundToken(c: Context<AppEnv>): string {
  const authHeader = c.req.header("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  return bearer || c.req.header("X-CF-Lottery-Platform-Token") || "";
}

function extractPlainText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type !== "text") return "";
      const data = record.data && typeof record.data === "object"
        ? record.data as Record<string, unknown>
        : {};
      return String(data.text || "");
    })
    .join("");
}

function extractSenderDisplayName(body: Record<string, unknown>): string {
  const sender = body.sender && typeof body.sender === "object"
    ? body.sender as Record<string, unknown>
    : {};
  return String(sender.card || sender.nickname || "").trim();
}

platformQQRoute.post("/message", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "请求体不是有效 JSON", 400);

  const messageType = String(body.message_type || "");
  const groupId = String(body.group_id || "").trim();
  const userId = String(body.user_id || "").trim();
  if (messageType && messageType !== "group") return ok(c, { handled: false, reason: "非群消息" });
  if (!groupId || !userId) return fail(c, "缺少 group_id 或 user_id", 400);

  const db = getDb(c);
  const target = await getActivePlatformTarget(db, { platform: "qq", targetId: groupId });
  if (!target) return fail(c, "QQ群未绑定", 404);
  if (!target.inboundSecretHash) return fail(c, "QQ群入站密钥未配置", 503);
  const token = readInboundToken(c);
  if (!token) return fail(c, "未授权", 403);
  const tokenHash = await hashPlatformInboundSecret(token);
  if (!timingSafeEqualString(tokenHash, target.inboundSecretHash)) {
    return fail(c, "未授权", 403);
  }

  // 自动回填/覆盖公证人 botId：NapCat/OneBot 上报事件自带 self_id = bot 登录 QQ 号（运行时权威真值）。
  // 若运营手动填写的 botId 为空或与实际上报 bot 不一致，用 self_id 覆盖，保证展示的是真正干活的 bot。
  // （docs/177 批次2）失败不阻断消息处理，仅静默跳过——botId 是展示性字段，不影响业务主流程。
  const selfId = String(body.self_id || "").trim();
  if (selfId) {
    try {
      await syncInboundBotIdentity(db, target, selfId);
    } catch {
      // 忽略写库异常，botId 回填失败不阻塞命令处理
    }
  }

  const result = await handleInboundPlatformEvent(db, {
    platform: "qq",
    sourceId: groupId,
    userId,
    eventType: "message",
    text: extractPlainText(body.message),
    messageId: String(body.message_id || ""),
    senderDisplayName: extractSenderDisplayName(body),
    raw: body,
    // 传入已在路由层查到的 target，避免 inbound 内部再查一次 DB
  }, target, getEnv(c, "APP_ORIGIN"));

  if (!result) return ok(c, { handled: false });

  // 处理命令侧写的私聊消息（如卡密私发）。
  // QQ webhook 必须尽快返回，否则 NapCat/OneBot 会阻塞上报链路；
  // 私聊统一写入 platform_deliveries，由 maintenance 异步调用 /send_private_msg 并重试。
  // P1 安全修复：私聊失败时群回复【不再追加一次性 accessUrl】——群内先看到的人可抢先点击
  // 并一次性消费掉访问链接，导致真正的卡密获得者无法网页查看（防群内先点者窃卡）。
  // 改为引导用户在群内发送 /卡密 重试（重走私聊投递）或联系管理员。
  if (result.privateMessages?.length) {
    const adapterConfig = target.adapterConfig as Record<string, unknown>;
    const baseUrl = String(adapterConfig.baseUrl || "").trim();
    if (baseUrl) {
      for (const pm of result.privateMessages) {
        try {
          await enqueuePrivatePlatformMessage(db, {
            tenantId: target.tenantId,
            platformTargetId: target.id,
            platform: "qq",
            targetId: target.targetId,
            targetUserId: pm.userId,
            groupId: pm.groupId,
            text: pm.text,
          });
        } catch {
          // 入队失败才降级；发送失败由平台投递队列记录 lastError 并按重试策略处理。
          // 只提示重试入口，不贴一次性访问链接（防群内截胡）。
          result.reply += "\n\n⚠️ 卡密私聊发送失败，请发送 /卡密 重试，或联系管理员。";
          await logPrivateMessageFailure(
            db,
            target,
            "qq",
            pm.userId,
            pm.text,
            "私聊消息入队失败（数据库异常）",
          );
        }
      }
      result.reply += "\n\n私聊消息已进入发送队列，如未收到可稍后发送 /我的卡密 重试。";
    } else {
      // 适配器未配置 baseUrl，无法发送私聊：只提示重试/联系管理员，不贴一次性链接
      result.reply += "\n\n⚠️ 系统未配置QQ适配器，无法私聊发送卡密。请发送 /卡密 重试，或联系管理员。";
    }
  }

  return ok(c, { handled: result.handled, reply: result.reply });
});
