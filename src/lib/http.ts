/**
 * HTTP 工具模块
 *
 * 提供统一的响应封装和数据库获取函数。
 * ok/fail/getDb 本地保留（message 契约）；clampInteger/isValidEmail 来自 cf-core。
 */

import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";

/**
 * 成功响应（200）
 */
export function ok(c: Context<AppEnv>, data: Record<string, unknown>) {
  return c.json({ ok: true, ...data });
}

/**
 * 失败响应
 */
export function fail(c: Context<AppEnv>, message: string, status = 400) {
  return c.json({ ok: false, message }, status as any);
}

/**
 * 获取请求来源域名
 */
export function getOrigin(c: Context<AppEnv>): string {
  const origin = c.req.header("Origin") || c.req.header("Referer") || "";
  try {
    return new URL(origin).origin;
  } catch {
    return "";
  }
}

/**
 * 安全解析 JSON 请求体
 */
export async function safeJsonBody<T>(c: Context<AppEnv>): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

/**
 * 从 Hono Context 获取已初始化的 Drizzle ORM 实例。
 */
export function getDb(c: Context<AppEnv>): DbType {
  const db = c.get("db");
  if (!db) throw new Error("database not initialized");
  return db;
}

/**
 * 整型钳位 / email 校验：纯函数上收 @usethink/cf-core/utils。
 * fail/ok 仍本地实现（message 字段契约，禁止直接换成 core fail）。
 */
export { clampInteger, isValidEmail } from "@usethink/cf-core/utils";
