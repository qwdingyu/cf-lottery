/**
 * 平台适配层（Cloudflare Workers / Node.js 双平台兼容基础）。
 *
 * 048 方案 B 要求：所有平台差异收敛到本文件，
 * 业务路由（auth/public/admin/platform）不直接碰平台 API（CF-Connecting-IP / executionCtx / c.env）。
 *
 * Workers 与 Node 的差异：
 *   IP 获取   CF-Connecting-IP vs X-Forwarded-For
 *   异步延续  executionCtx.waitUntil vs Promise fire-and-forget
 *   env 读取  c.env vs process.env
 *   静态资源  ASSETS.fetch vs fs/express.static
 *   媒体存储  R2 bucket vs 本地磁盘 / S3
 */
import type { Context } from "hono";
import type { AppEnv } from "../bindings";

/**
 * 获取客户端真实 IP。
 *
 * Workers：Cloudflare 在 CF-Connecting-IP header 写入真实 IP。
 * Node（反代后）：只有显式配置 TRUST_PROXY_HEADERS=true 时才信任 X-Forwarded-For。
 */
export function getClientIp(c: Context<AppEnv>): string {
  const cloudflareIp = c.req.header("CF-Connecting-IP");
  if (cloudflareIp) return cloudflareIp;

  // X-Forwarded-For 是普通请求头，自托管 Node 如果默认信任它，攻击者可伪造限流 key。
  // 仅在可信反代已覆盖/清洗该头时，由部署环境显式开启。
  if (isProxyHeaderTrusted(c)) {
    return c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  }

  return "unknown";
}

function isProxyHeaderTrusted(c: Context<AppEnv>): boolean {
  const bindingValue = (c.env as Record<string, unknown> | undefined)?.TRUST_PROXY_HEADERS;
  if (bindingValue === "true") return true;
  try {
    return (process.env as Record<string, string | undefined>)?.TRUST_PROXY_HEADERS === "true";
  } catch {
    return false;
  }
}

/**
 * 异步任务延续（不阻塞响应返回）。
 *
 * Workers：ExecutionContext.waitUntil 保证即使响应已发出，任务也会完成。
 * Node：无此 API，直接 fire-and-forget（进程退出前可能未完成，仅低风险场景如日志/事件）。
 */
export function waitUntil(c: Context<AppEnv>, task: Promise<unknown>): void {
  const ctx = c.get("executionCtx");
  if (ctx?.waitUntil) {
    ctx.waitUntil(task);
    return;
  }
  void task.catch((err) => console.error("[waitUntil] async task failed:", err));
}

/**
 * 从环境读取变量（双平台兼容）。
 *
 * Workers：c.env.XXX
 * Node：process.env.XXX（入口注入）
 * 优先读 c.env（Workers 环境），回退 process.env（Node 环境）。
 */
export function getEnv(c: Context<AppEnv>, key: keyof AppEnv["Bindings"]): string | undefined {
  const val = (c.env as Record<string, unknown>)?.[key as string];
  if (typeof val === "string") return val;
  // Node 环境回退
  try {
    return (process.env as Record<string, string | undefined>)?.[key as string];
  } catch {
    return undefined;
  }
}
