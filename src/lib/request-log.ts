/**
 * 请求日志（docs/243）：记录受限/关键请求到 request_logs 表。
 *
 * 借鉴 cf-shop 的 writeRequestLog，但适配 cf-lottery：
 * - ipHash 用 hashEventValue(getClientIp(c))（与参与流程的 IP 哈希一致）
 * - path 只取 pathname，不含 query string
 * - 由各业务路由在关键分支（限流、校验失败、业务拒绝）显式调用
 */
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { logError } from "./logger";
import { getDb } from "./http";
import { getClientIp } from "./platform";
import { requestLogs, consumeOnceTokens } from "../db/schema";

/**
 * SHA-256 hex 哈希（与参与流程 hashEventValue 同算法）。
 * 本地实现避免 lib → routes 循环依赖（request-log → public-lottery-helpers → rate-limit → request-log）。
 */
async function hashValue(value: string): Promise<string> {
  if (!value) return "";
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 写入一条请求日志。
 * @param c - Hono 上下文
 * @param action - 业务动作标识（如 "login"、"join_draw"）
 * @param statusCode - HTTP 状态码
 * @param ipHash - 可选，不传则自动用 getClientIp 哈希
 */
export async function writeRequestLog(
  c: Context<AppEnv>,
  action: string,
  statusCode: number,
  ipHash?: string,
): Promise<void> {
  try {
    const db = getDb(c);
    const hash = ipHash || (await hashValue(getClientIp(c) || ""));
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      ipHash: hash,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      action,
      statusCode,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // 请求日志写入失败不应影响主流程（fire-and-forget 语义）
    logError("request-log", `write failed action=${action}`, err);
  }
}

/**
 * 一次性令牌消费（docs/243）：同一 token 在 TTL 内仅允许成功消费一次。
 *
 * 复用 consume_once_tokens 表的复合主键 (action, subject_hash) 原子唯一：
 * - subjectHash = sha256(action + ":" + token)（不落明文 token）
 * - INSERT … ON CONFLICT DO NOTHING：首个成功插入 → consumed；重放 → already_used
 *
 * TTL 由调用方用 JWT exp 保证；本函数不扫表过期（清理任务按 created_at 删除）。
 */
export async function consumeOnce(
  c: Context<AppEnv>,
  action: string,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: "already_used" | "empty_token" }> {
  const raw = String(token || "").trim();
  if (!raw) return { ok: false, reason: "empty_token" };

  const db = getDb(c);
  const subjectHash = await hashValue(`${action}:${raw}`);

  // onConflictDoNothing：首个插入成功（affectedRows=1）→ consumed；
  // 重放冲突被忽略（affectedRows=0）→ already_used。原子防重放。
  const inserted = await db
    .insert(consumeOnceTokens)
    .values({
      action,
      subjectHash,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();

  if (inserted.rowsAffected > 0) return { ok: true };
  return { ok: false, reason: "already_used" };
}
