/**
 * cf-lottery Worker 入口
 *
 * 从 cf-shop 抽取，只保留抽奖核心路由，新增 SaaS 认证和租户隔离。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Bindings } from "./bindings";
import { createClient } from "@libsql/client";
import { createDb } from "./db/client";
import { authRoute } from "./routes/auth";
import { adminLotteryRoute } from "./routes/admin-lottery";
import { publicLotteryRoute } from "./routes/public-lottery";
import { integrationRoute } from "./routes/integration";
import { systemConfigRoute } from "./routes/system-config";
import { platformSystemConfigRoute } from "./routes/platform-system-config";
import { platformRedemptionCodesRoute } from "./routes/platform-redemption-codes";
import { cleanExpiredRateLimits } from "./lib/rate-limit";
import {
  processDueDraws,
  processPendingWebhookDeliveriesForAllTenants,
  type WebhookFetch,
} from "./services/lottery-service";

const app = new Hono<AppEnv>();

function createDbFromEnv(env: Bindings) {
  if (!env.TURSO_URL) return undefined;
  const client = createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
  return createDb(client);
}

export async function runScheduledMaintenance(
  env: Bindings,
  options?: {
    fetcher?: WebhookFetch;
    drawLimit?: number;
    webhookTenantLimit?: number;
    webhookPerTenantLimit?: number;
  },
) {
  const db = createDbFromEnv(env);
  if (!db) throw new Error("数据库未配置");

  const draws = await processDueDraws(db, {
    limit: options?.drawLimit ?? 20,
    emailEnv: {
      resendApiKey: env.RESEND_API_KEY || "",
      emailFrom: env.EMAIL_FROM || "",
    },
  });
  const webhooks = await processPendingWebhookDeliveriesForAllTenants(db, options?.fetcher ?? fetch, {
    tenantLimit: options?.webhookTenantLimit ?? 25,
    perTenantLimit: options?.webhookPerTenantLimit ?? 20,
  });
  // 限流日志只服务短窗口判断，定时清理避免 Turso 免费层 rows/storage 被长期无价值日志拖垮。
  const cleanedRateLimitLogs = await cleanExpiredRateLimits(db);

  return { draws, webhooks, cleanedRateLimitLogs };
}

// ── CORS（允许前端跨域请求） ──
// 公共 API 需要宽 CORS（活动可嵌入任意域名），管理/平台写接口已通过 JWT + RBAC 保护。
// 如果后续需要进一步收紧，可以按路由拆分 CORS 策略。
app.use("*", cors({
  origin: ["*"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// ── 全局错误处理 ──
app.onError((err, c) => {
  console.error(`[error] ${err.message}`, err.stack);
  return c.json({ ok: false, message: "服务器内部错误" }, 500);
});

// ── 请求耗时观测（用于识别慢查询和异常路由） ──
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  // 只记录管理后台和平台接口的慢请求（>500ms），公开热路径不记录避免日志爆炸
  const path = c.req.path;
  if (duration > 500 && (path.startsWith("/api/admin") || path.startsWith("/api/platform"))) {
    console.log(`[slow] ${c.req.method} ${path} ${duration}ms`);
  }
});

// ── 数据库初始化中间件 ──
app.use("*", async (c, next) => {
  try {
    c.set("db", createDbFromEnv(c.env));
  } catch (err) {
    console.error("[db] 数据库初始化失败:", err);
    // 不阻止请求，health 路由可以正常返回
  }
  await next();
});

// 路由挂载
app.route("/api/auth", authRoute);
app.route("/api/admin", adminLotteryRoute);
app.route("/api/public", publicLotteryRoute);
app.route("/api/integration", integrationRoute);
app.route("/api/system-config", systemConfigRoute);
// 平台运营后台路由（L3）
app.route("/api/platform/system-config", platformSystemConfigRoute);
app.route("/api/platform/redemption-codes", platformRedemptionCodesRoute);

// 健康检查
app.get("/api/health", (c) => c.json({ ok: true, db: !!c.get("db") }));

// Cron 手动入口：处理到期活动。线上自动任务使用 Worker scheduled() handler。
// 安全：需要通过 CRON_SECRET 认证，防止未授权触发
app.get("/api/cron/draw", async (c) => {
  const db = c.get("db");
  if (!db) return c.json({ ok: false, message: "数据库未配置" }, 500);

  // CRON_SECRET 认证：Cloudflare Cron Triggers 不支持自定义 header，
  // 因此使用查询参数 ?secret=xxx 作为认证方式。
  // 生产环境应配合 Cloudflare WAF 限制仅允许 Cloudflare IP 访问。
  const cronSecret = c.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = c.req.header("Authorization") || "";
    const querySecret = c.req.query("secret") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim() || querySecret;
    if (token !== cronSecret) {
      return c.json({ ok: false, message: "未授权" }, 403);
    }
  }

  try {
    const result = await processDueDraws(db, {
      limit: 20,
      emailEnv: {
        resendApiKey: c.env.RESEND_API_KEY || "",
        emailFrom: c.env.EMAIL_FROM || "",
      },
    });
    return c.json({
      ok: true,
      processed: result.processed,
      failed: result.failed,
      errors: result.errors.length > 0 ? result.errors.slice(0, 5) : undefined,
    });
  } catch (err) {
    console.error("[cron] draw failed:", err);
    return c.json({ ok: false, message: "定时任务执行失败" }, 500);
  }
});

// Cron 手动入口：处理到期开奖和 Webhook 重试，便于运维侧主动补偿。
app.post("/api/cron/maintenance", async (c) => {
  const cronSecret = c.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = c.req.header("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token !== cronSecret) {
      return c.json({ ok: false, message: "未授权" }, 403);
    }
  }

  try {
    const result = await runScheduledMaintenance(c.env);
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] maintenance failed:", err);
    return c.json({ ok: false, message: "定时维护任务执行失败" }, 500);
  }
});

// 前端静态资源：所有非 /api 请求返回 index.html（SPA）
app.get("*", async (c) => {
  try {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status === 404) {
      // SPA fallback: 返回 index.html
      return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
    }
    return asset;
  } catch {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  }
});

const worker: ExportedHandler<Bindings> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await runScheduledMaintenance(env);
        console.log("[cron] maintenance complete", JSON.stringify(result));
      } catch (err) {
        console.error("[cron] maintenance failed:", err);
      }
    })());
  },
};

export { app };
export default worker;
