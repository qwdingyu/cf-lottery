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
  const configuredToken = getEnv(c, "QQ_INBOUND_TOKEN");
  if (!configuredToken) return fail(c, "QQ_INBOUND_TOKEN 未配置", 503);
  const token = readInboundToken(c);
  if (!token || !timingSafeEqualString(token, configuredToken)) {
    return fail(c, "未授权", 403);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "请求体不是有效 JSON", 400);

  const messageType = String(body.message_type || "");
  const groupId = String(body.group_id || "").trim();
  const userId = String(body.user_id || "").trim();
  if (messageType && messageType !== "group") return ok(c, { handled: false, reason: "非群消息" });
  if (!groupId || !userId) return fail(c, "缺少 group_id 或 user_id", 400);

  const result = await handleInboundPlatformEvent(getDb(c), {
    platform: "qq",
    sourceId: groupId,
    userId,
    eventType: "message",
    text: extractPlainText(body.message),
    messageId: String(body.message_id || ""),
    senderDisplayName: extractSenderDisplayName(body),
    raw: body,
  });

  if (!result) return ok(c, { handled: false });
  return ok(c, { handled: result.handled, reply: result.reply });
});
