/**
 * HTTP 工具模块
 *
 * 提供统一的响应封装和数据库获取函数。
 * 不依赖 cf-shop 的 @usethink/cf-core 包，独立实现。
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
export function fail(c: Context<AppEnv>, message: string, status: number = 400) {
  return c.json({ ok: false, message }, status);
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