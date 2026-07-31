/**
 * cf-lottery Worker 入口
 *
 * 从 cf-shop 抽取，只保留抽奖核心路由，新增 SaaS 认证和租户隔离。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./bindings";
import { createClient } from "@libsql/client";
import { createDb } from "./db/client";
import { authRoute } from "./routes/auth";
import { adminLotteryRoute } from "./routes/admin-lottery";
import { publicLotteryRoute } from "./routes/public-lottery";
import { processDueDraws } from "./services/lottery-service";

const app = new Hono<AppEnv>();

// ── CORS（允许前端跨域请求） ──
app.use("*", cors({
  origin: ["*"], // 生产环境应限制为具体域名
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// ── 全局错误处理 ──
app.onError((err, c) => {
  console.error(`[error] ${err.message}`, err.stack);
  return c.json({ ok: false, message: "服务器内部错误" }, 500);
});

// ── 数据库初始化中间件 ──
app.use("*", async (c, next) => {
  if (c.env.TURSO_URL) {
    try {
      const client = createClient({ url: c.env.TURSO_URL, authToken: c.env.TURSO_TOKEN });
      c.set("db", createDb(client));
    } catch (err) {
      console.error("[db] 数据库初始化失败:", err);
      // 不阻止请求，health 路由可以正常返回
    }
  }
  await next();
});

// 路由挂载
app.route("/api/auth", authRoute);
app.route("/api/admin", adminLotteryRoute);
app.route("/api/public", publicLotteryRoute);

// 健康检查
app.get("/api/health", (c) => c.json({ ok: true, db: !!c.get("db") }));

// Cron 定时开奖：每 5 分钟执行一次，处理到期活动
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
    return c.json({
      ok: false,
      message: err instanceof Error ? err.message : "Cron 执行失败",
    }, 500);
  }
});

export default app;