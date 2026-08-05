/**
 * Node.js 服务器入口（本地开发 / 云服务器部署）。
 *
 * 用法：
 *   npm run dev:local
 * 或：
 *   PLATFORM=local tsx src/server.ts
 *
 * Cloudflare 环境继续用 src/index.ts（wrangler deploy）。
 * 双平台通过 getClientIp/getEnv/waitUntil 适配层自动适配，
 * 业务路由（auth/public/admin/platform）无需改动。
 *
 * 为什么需要这个文件：
 * - 本地开发时不需要 wrangler dev，node 直连 Turso + 静态文件服务
 * - 云服务器部署时用 pm2/systemd 管理进程
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { app } from "./index";

const PORT = parseInt(process.env.PORT || "8787", 10);
const PUBLIC_DIR = join(process.cwd(), "public");

/**
 * 本地/服务器 env 注入中间件。
 */
app.use("*", async (c, next) => {
  const env = c.env as Record<string, unknown>;
  for (const [key, val] of Object.entries(process.env)) {
    if (!(key in env)) env[key] = val;
  }
  if (!c.get("executionCtx")) {
    c.set("executionCtx", { waitUntil: undefined } as any);
  }
  await next();
});

/**
 * 静态资源服务。
 * API 路由已注册在前，serveStatic 只匹配未被 API 处理的路径。
 */
app.use("/*", serveStatic({ root: PUBLIC_DIR }));

/**
 * SPA fallback：非文件路径回退到 index.html。
 * Cloudflare Workers 通过 not_found_handling: "single-page-application" 实现，
 * Node 服务器需要在 API 和静态文件之后额外处理。
 */
app.use("/*", async (c, next) => {
  await next();
  // 响应为 404 且非 API 路径 → 尝试回退到 SPA index.html
  if (c.res.status === 404 && !c.req.path.startsWith("/api/")) {
    try {
      const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8");
      c.res = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } catch { /* index.html 不存在，保持 404 */ }
  }
});

console.log(`[server] cf-lottery on http://localhost:${PORT}`);
console.log(`[server] platform: ${process.env.PLATFORM || "local"}`);

// PM2 / systemd 优雅关闭：SIGINT 时停止接收新连接，等待现有请求完成（最多 20 秒）
const httpServer = serve({ fetch: app.fetch, port: PORT });

process.on("SIGTERM", () => {
  console.log("[server] SIGTERM — graceful shutdown");
  httpServer.close(() => { console.log("[server] closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 20000);  // 20s 超时强制退出
});

process.on("SIGINT", () => {
  console.log("[server] SIGINT — graceful shutdown");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20000);
});

// 未捕获异常兜底：记录日志后退出（PM2/systemd 自动重启）
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});
