/**
 * cf-lottery Worker 入口
 *
 * 从 cf-shop 抽取，只保留抽奖核心路由，新增 SaaS 认证和租户隔离。
 */
import { Hono } from "hono";
import type { AppEnv } from "./bindings";
import { createClient } from "@libsql/client";
import { createDb } from "./db/client";
import { authRoute } from "./routes/auth";
import { adminLotteryRoute } from "./routes/admin-lottery";
import { publicLotteryRoute } from "./routes/public-lottery";

const app = new Hono<AppEnv>();

// 数据库初始化中间件
app.use("*", async (c, next) => {
  if (c.env.TURSO_URL) {
    const client = createClient({ url: c.env.TURSO_URL, authToken: c.env.TURSO_TOKEN });
    c.set("db", createDb(client));
  }
  await next();
});

// 路由挂载
app.route("/api/auth", authRoute);
app.route("/api/admin", adminLotteryRoute);
app.route("/api/public", publicLotteryRoute);

// 健康检查
app.get("/api/health", (c) => c.json({ ok: true }));

// Cron 定时开奖
app.get("/api/cron/draw", async (c) => {
  const db = c.get("db");
  if (!db) return c.json({ ok: false, message: "数据库未配置" }, 500);
  const processed = await processDueDraws(db, 10);
  return c.json({ ok: true, processed });
});

export default app;