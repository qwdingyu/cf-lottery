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
import { logError } from "./logger";

// ── IP 获取 ──
// 基座用 @usethink/cf-core/platform 的安全版 getClientIp（Node 环境默认不信任
// CF-Connecting-IP / X-Forwarded-For，防伪造 XFF 绕过 IP 限流）。
// 根入口 @usethink/cf-core 的 getClientIp 来自 security.ts（无条件信任代理头），
// 禁止使用——会让 IP 限流键被伪造 XFF 绕过（docs/128 安全审查）。
// 测试开关 TRUST_CF_CONNECTING_IP=true（test-setup 设置）时信任 CF-Connecting-IP，
// 用于单测模拟多 IP 限流（docs/070 HIGH #2）；生产环境不设该变量 → 保持 fail-safe。
import { getClientIp as coreGetClientIp } from "@usethink/cf-core/platform";

export function getClientIp(c: Context<AppEnv>): string {
  const trustCfIp = (globalThis as any).process?.env?.TRUST_CF_CONNECTING_IP === "true";
  if (trustCfIp) {
    const cf = c.req.header("CF-Connecting-IP");
    if (cf) return cf.trim();
  }
  // XFF 即使测试开关打开也不信任（保持 fail-safe 语义，防测试掩盖 XFF 注入风险）
  // 类型断言安全：coreGetClientIp 只读 c.req.header，不依赖 Bindings 具体类型
  return coreGetClientIp(c as unknown as Context<{ Bindings?: Record<string, string | undefined> }>);
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
  void task.catch((err) => logError("platform", "waitUntil async task failed", err));
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
