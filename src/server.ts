/**
 * Node.js 服务器入口（本地开发 / 云服务器部署）。
 *
 * 用法：
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
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
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
 * 静态资源 + SPA fallback。
 */
app.use("/*", serveStatic({ root: PUBLIC_DIR }));

console.log(`[server] cf-lottery on http://localhost:${PORT}`);
console.log(`[server] platform: ${process.env.PLATFORM || "local"}`);
serve({ fetch: app.fetch, port: PORT });
