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
 * Workers 边缘：Cloudflare 会覆盖写入 CF-Connecting-IP（客户端无法伪造）。
 * Node 自托管：客户端可随意带 CF-Connecting-IP，**默认不信任**该头；
 * 仅当 TRUST_PROXY_HEADERS / TRUST_CF_CONNECTING_IP 显式开启，或运行时判定为
 * 非 Node（Workers）时才采用（docs/070 HIGH #2）。
 */
export function getClientIp(c: Context<AppEnv>): string {
  const cloudflareIp = c.req.header("CF-Connecting-IP")?.trim();
  if (cloudflareIp && isCloudflareConnectingIpTrusted(c)) {
    return cloudflareIp;
  }

  // X-Forwarded-For / X-Real-IP：仅在可信反代已覆盖/清洗时由部署显式开启。
  if (isProxyHeaderTrusted(c)) {
    return (
      c.req.header("X-Real-IP")?.trim() ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      "unknown"
    );
  }

  return "unknown";
}

/** 是否信任 CF-Connecting-IP（Workers 边缘或显式开关 / 测试）。 */
function isCloudflareConnectingIpTrusted(c: Context<AppEnv>): boolean {
  if (readTrustFlag(c, "TRUST_CF_CONNECTING_IP")) return true;
  // 与 TRUST_PROXY_HEADERS 对齐：运维已声明反代可信时，亦可信边缘注入头
  if (isProxyHeaderTrusted(c)) return true;
  // 非 Node 运行时（Cloudflare Workers）默认信任平台注入头
  if (!isNodeRuntime()) return true;
  return false;
}

function isProxyHeaderTrusted(c: Context<AppEnv>): boolean {
  return readTrustFlag(c, "TRUST_PROXY_HEADERS");
}

function readTrustFlag(c: Context<AppEnv>, key: string): boolean {
  const bindingValue = (c.env as Record<string, unknown> | undefined)?.[key];
  if (bindingValue === "true" || bindingValue === true) return true;
  try {
    return (process.env as Record<string, string | undefined>)?.[key] === "true";
  } catch {
    return false;
  }
}

function isNodeRuntime(): boolean {
  try {
    return typeof process !== "undefined" && Boolean(process.versions?.node);
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
