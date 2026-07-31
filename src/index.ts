/**
 * cf-lottery Worker 入口
 *
 * 从 cf-shop 抽取，只保留抽奖核心路由，新增 SaaS 认证和租户隔离。
 */
import { Hono } from "hono";
import type { AppEnv } from "./bindings";
import { initDatabase } from "./db/client";
import { authRoute } from "./routes/auth";
import { adminLotteryRoute } from "./routes/admin-lottery";
import { publicLotteryRoute } from "./routes/public-lottery";

const app = new Hono<AppEnv>();

// 数据库初始化中间件
app.use("*", async (c, next) => {
  c.set("db", initDatabase(c.env));
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
  // 处理到期活动，每次最多 10 个
  // TODO: 实现 processDueLotteryDraws
  return c.json({ ok: true, processed: 0 });
});

export default app;