import { Hono } from "hono";
import { initDatabase } from "./db/database";
import type { AppEnv } from "./bindings";
import { fail } from "./lib/http";
import { requireAdmin } from "./lib/security";
import { healthRoute } from "./routes/health";
import { productRoute } from "./routes/products";
import { orderRoute } from "./routes/orders";
import { payRoute } from "./routes/pay";
import { adminRoute, adminPublicRoute } from "./routes/admin";
import { systemConfigRoute } from "./routes/system-config";
import { redeemRoute } from "./routes/redeem";
import { voucherRoute } from "./routes/vouchers";
import { rechargeRoute } from "./routes/recharge";
import { emailAccessRoute } from "./routes/email-access";
import { memberRoute } from "./routes/member";
import { tgBot } from "./telegram-bot";
import { mediaRoute } from "./routes/media";
import { lotteryDrawRoute } from "./routes/lottery-draws";
import { getApiBodyLimitBytes } from "./lib/api-body-limit";
import { buildCsp, createCspNonce, injectCspNonce } from "./lib/csp";
import { MEDIA_IMAGE_CACHE_CONTROL } from "./lib/media-image";
import { mergeRuntimeConfig, readRuntimeConfig } from "./lib/runtime-config";
import { processDueLotteryDraws } from "./services/lottery-service";

const api = new Hono<AppEnv>();

/** API 响应统一禁止浏览器、CDN 和反向代理缓存。订单、余额、库存、支付状态及管理数据
 * 都是动态共享状态，不能依赖调用方逐个设置响应头来保证新鲜度。 */
export function withApiNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 只有成功的不可变公开媒体响应允许缓存；媒体错误响应仍必须 no-store。 */
export function shouldApplyApiNoStore(path: string, response?: Response): boolean {
  if (!path.startsWith("/media/images/")) return true;
  return !(response?.status === 200 && response.headers.get("Cache-Control") === MEDIA_IMAGE_CACHE_CONTROL);
}

// 数据库初始化中间件：创建 libsql client + Drizzle ORM 实例，存入 Hono Context
// - DB 可用时：c.set("db", orm)，所有路由正常使用
// - DB 不可用时：health 路由 c.set("db", undefined) 自行降级；其他路由直接 503
// - 同时注入 executionCtx，供服务层使用 ctx.waitUntil() 异步发邮件（节省 CPU）
api.use("*", async (c, next) => {
  const isHealth = c.req.path === "/health";
  const isPublicMedia = c.req.path.startsWith("/media/images/");
  const executionCtx = c.executionCtx as ExecutionContext<unknown>;

  // 公开图片只依赖 R2。跳过 Turso 初始化可减少每次图片读取开销，并保证数据库故障时静态图片仍可用。
  if (isPublicMedia) {
    c.set("db", undefined);
    c.set("executionCtx", executionCtx);
    await next();
    return;
  }

  try {
    const { db } = initDatabase({ TURSO_URL: c.env.TURSO_URL, TURSO_TOKEN: c.env.TURSO_TOKEN });
    c.set("db", db);
    c.set("executionCtx", executionCtx);
    await next();
  } catch (err) {
    console.error("[db-init]", err);
    if (isHealth) { c.set("db", undefined); c.set("executionCtx", executionCtx); await next(); return; }
    return fail(c, "服务暂时不可用", 503);
  }
});

// 全局请求体限制：普通 API 保持 100KB；只有管理端图片上传允许 5MiB + multipart 开销。
api.use(async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0");
  const maxBytes = getApiBodyLimitBytes(c.req.path);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return fail(c, c.req.path === "/admin/media/images" ? "图片上传请求过大（图片最大 5MiB）" : "请求体过大（最大 100KB）", 413);
  }
  await next();
});

api.route("/", healthRoute);
api.route("/", productRoute);
api.route("/", orderRoute);
api.route("/", systemConfigRoute);
api.route("/", payRoute);
api.route("/", redeemRoute);
api.route("/", voucherRoute);
api.route("/", rechargeRoute);
api.route("/", emailAccessRoute);
api.route("/", memberRoute);
api.route("/", mediaRoute);
api.route("/", lotteryDrawRoute);
// 公开 admin 路由（无需 ADMIN_TOKEN），在 requireAdmin 之前挂载
api.route("/admin", adminPublicRoute);
// 管理端路由：先处理 CORS 预检，再 requireAdmin 鉴权
api.route("/admin", new Hono<AppEnv>()
  .use("*", async (c, next) => {
    // CORS 预检请求（OPTIONS）无需鉴权，直接返回允许头，避免浏览器因 401 误判为跨域错误
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Max-Age", "86400");
      return c.body(null, 204);
    }
    await next();
  })
  .use("*", requireAdmin)
  .route("/", adminRoute));

api.notFound((c) => fail(c, "API not found", 404));

api.onError((error, c) => {
  console.error("[onError]", error?.constructor?.name, error?.message, error?.stack);
  return fail(c, "服务暂时不可用", 500);
});

export default {
  async fetch(request: Request, env: AppEnv["Bindings"], ctx: ExecutionContext<unknown>) {
    let isApiRequest = false;
    let isDynamicRequest = false;
    try {
      const url = new URL(request.url);
      isApiRequest = url.pathname === "/api" || url.pathname.startsWith("/api/");
      isDynamicRequest = isApiRequest || url.pathname === "/tg" || url.pathname.startsWith("/tg/");
      // 全局安全响应头
      const responseHeaders = new Headers({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      // 用户端/Admin 均由 Vite SPA（/_app/index.html）提供；public/admin.html 仅为历史遗留，Worker 不兜底。
      // script-src 不放行 'unsafe-eval'（现代 vendor/index 包无 eval/new Function），
      // 也不再放行 'unsafe-inline'（S-04）——入口文档改用 per-request nonce，见 lib/csp.ts。
      // 这里的默认 CSP 用于静态资源与 API 响应（不含文档，无需 nonce）。
      responseHeaders.set("Content-Security-Policy", buildCsp());

      // 给静态资源响应附加安全头（API 响应由 Hono 内置处理）
      type AssetCachePolicy = "preserve" | "immutable" | "entry";
      async function withHeaders(response: Response, cachePolicy: AssetCachePolicy = "preserve") {
        const headers = new Headers(response.headers);
        for (const [key, value] of responseHeaders) {
          headers.set(key, value);
        }
        // Vite 构建的 hash 文件设置长缓存（1 年），节省 Workers 请求配额
        // 只有成功返回的 hash 资源才允许长期缓存。若把 404 也标记为 immutable，
        // 浏览器会长期记住一次发布缺口，即使资源随后恢复也可能继续使用失败响应。
        if (cachePolicy === "immutable" && response.ok && url.pathname.startsWith("/_app/assets/")) {
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
        } else if (cachePolicy === "immutable") {
          headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
        }
        // SPA 入口必须每次重新验证；否则旧入口引用的 lazy chunk 在新部署清理后会永久 404。
        if (cachePolicy === "entry") {
          headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
          headers.set("Pragma", "no-cache");
          headers.set("Expires", "0");
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // ── Telegram Bot 路由（优先于 API，占用 /tg/* 命名空间）──
      // 自建 Hono 子应用，自管理 DB 连接和限流，不与主 API 共享中间件
      if (url.pathname === "/tg" || url.pathname.startsWith("/tg/")) {
        url.pathname = url.pathname.replace(/^\/tg/, "") || "/";
        return withApiNoStore(await tgBot.fetch(new Request(url, request), env, ctx));
      }

      // API 统一挂在 /api 下，进入 Hono 前去掉 /api 前缀，避免页面路径和接口路径混在一起。
      if (isApiRequest) {
        url.pathname = url.pathname.replace(/^\/api/, "") || "/";
        const response = await api.fetch(new Request(url, request), env, ctx);
        return shouldApplyApiNoStore(url.pathname, response) ? withApiNoStore(response) : response;
      }
      // ── Vue 单页应用入口 ──
      // 未上线阶段不保留旧 public/index.html/admin.html 兜底，避免新版用户端和 admin 后台代码被绕开。
      // 与 frontend/src/router 顶层 history 路由对齐；漏登记会导致直链/刷新落到 ASSETS 404。
      const isPageRoute =
        url.pathname === "/" ||
        url.pathname === "/shop" ||
        url.pathname.startsWith("/s/") ||
        url.pathname === "/redeem" ||
        url.pathname === "/lookup" ||
        url.pathname === "/order" ||
        url.pathname === "/refer" ||
        url.pathname === "/partner" || // 兼容旧书签；Vue 内 redirect → /refer
        url.pathname === "/lottery" || url.pathname.startsWith("/lottery/") || // 抽奖用户端 SPA 入口
        url.pathname === "/admin" ||
        url.pathname.startsWith("/admin/") ||
        (url.pathname.startsWith("/_app/") && !url.pathname.startsWith("/_app/assets/"));

      if (isPageRoute) {
        const vueEntry = "/_app/index.html";
        // 剥离条件请求头：入口文档每次都要重写（注入 nonce），若 ASSETS 返回 304
        // 则浏览器会复用旧 HTML 里的旧 nonce，与本次响应头的新 nonce 不匹配，全站脚本被拦。
        const entryRequest = new Request(new URL(vueEntry, request.url), request);
        entryRequest.headers.delete("if-none-match");
        entryRequest.headers.delete("if-modified-since");
        const vueRes = await env.ASSETS.fetch(entryRequest);
        if (vueRes.ok) {
          // 每次请求生成独立 nonce；入口文档为 no-store，不存在跨请求复用风险。
          const nonce = createCspNonce();
          const entryResponse = await withHeaders(vueRes, "entry");
          entryResponse.headers.set("Content-Security-Policy", buildCsp(nonce));
          // 响应体被重写，原 ETag/Last-Modified 不再对应实际内容，必须移除。
          entryResponse.headers.delete("ETag");
          entryResponse.headers.delete("Last-Modified");
          entryResponse.headers.delete("Content-Length");
          // 给入口文档内所有 <script>（含 @vitejs/plugin-legacy 注入的 5 段内联脚本）补 nonce。
          const html = injectCspNonce(await entryResponse.text(), nonce);
          return new Response(html, {
            status: entryResponse.status,
            statusText: entryResponse.statusText,
            headers: entryResponse.headers,
          });
        }
        return withHeaders(
          new Response("Frontend assets are missing. Run npm run frontend:build before deploy.", { status: 503 }),
          "entry",
        );
      }

      // Vue3 静态资源（/_app/assets/*）— 设置长缓存，节省 Workers 请求配额
      if (url.pathname.startsWith("/_app/")) {
        return withHeaders(await env.ASSETS.fetch(request), "immutable");
      }

      // 禁止直链旧版单页 HTML（public/admin.html、public/index.html 已删除）；
      // 防止未来重新引入旧前端绕过新版 Vue SPA 的 CSP nonce 与 session JWT。
      if (url.pathname.endsWith(".html")) {
        return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } });
      }

      // 其他静态资源交给 Static Assets。
      return withHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("[fetch]", err);
      const response = new Response(JSON.stringify({ ok: false, error: "服务暂时不可用" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
      return isDynamicRequest ? withApiNoStore(response) : response;
    }
  },

  /**
   * Cron 只处理轻量、有界的抽奖到期兜底开奖。
   * cleanup 仍由 GitHub Actions 调 /admin/cleanup，避免把重维护任务塞进 Worker Cron。
   */
  async scheduled(_controller: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext<unknown>) {
    try {
      const { db } = initDatabase({ TURSO_URL: env.TURSO_URL, TURSO_TOKEN: env.TURSO_TOKEN });
      const dbConfig = await readRuntimeConfig(db, env.CREDENTIALS_ENCRYPTION_KEY);
      const emailEnv = mergeRuntimeConfig(dbConfig, env);
      const result = await processDueLotteryDraws(db, emailEnv, ctx);
      if (result.processed > 0 || result.failed > 0 || result.healed > 0 || result.emailRetried > 0 || result.emailFailed > 0) {
        console.log("[lottery] scheduled due draw result", result);
      }
    } catch (err) {
      console.error("[lottery] scheduled due draw failed", err);
    }
  },
};
