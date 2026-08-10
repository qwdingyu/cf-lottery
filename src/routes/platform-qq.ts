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
import { timingSafeEqualString } from "../lib/crypto-compare";
import { handleInboundPlatformEvent } from "../services/platform/inbound";
import { getActivePlatformTarget } from "../services/platform/targets";
import { hashPlatformInboundSecret } from "../services/platform/security";
import { getPlatformAdapter } from "../services/platform/adapter-factory";

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
  }, target);

  if (!result) return ok(c, { handled: false });

  // 处理命令侧写的私聊消息（如卡密私发）。
  // 私聊发送失败时在群回复中追加降级提示，不阻塞主流程。
  if (result.privateMessages?.length) {
    const adapterConfig = target.adapterConfig as Record<string, unknown>;
    const baseUrl = String(adapterConfig.baseUrl || "").trim();
    if (baseUrl) {
      const adapter = getPlatformAdapter("qq", adapterConfig);
      for (const pm of result.privateMessages) {
        try {
          await adapter.send({
            platform: "qq",
            targetType: "private",
            targetId: pm.userId,
            groupId: pm.groupId,
            type: "text",
            text: pm.text,
          });
        } catch {
          // 私发失败，在群回复中追加降级提示，不中断整个请求
          result.reply += "\n\n⚠️ 私聊发送失败，可能是您关闭了临时会话权限。请检查QQ隐私设置（设置→隐私→临时会话），或通过网页后台查看卡密。";
        }
      }
    } else {
      // 适配器未配置 baseUrl，无法发送私聊，追加降级提示
      result.reply += "\n\n⚠️ 系统未配置QQ适配器，无法私聊发送卡密。请通过网页后台查看。";
    }
  }

  return ok(c, { handled: result.handled, reply: result.reply });
});
