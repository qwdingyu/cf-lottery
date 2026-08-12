/**
 * cf-lottery Worker 入口
 *
 * 从 cf-shop 抽取，只保留抽奖核心路由，新增 SaaS 认证和租户隔离。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Bindings } from "./bindings";
import { createClient, type Client } from "@libsql/client";
import { createDb, type DbType } from "./db/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getEnv } from "./lib/platform";
import { systemConfig, auditLogs, lotteryDraws, paymentOrders, rateLimitLog } from "./db/schema";
import { decodePublicSlug, isSocialCrawler, renderPublicOgHtml } from "./routes/public-lottery-helpers";
import { authRoute } from "./routes/auth";
import { adminLotteryRoute } from "./routes/admin-lottery";
import { publicLotteryRoute } from "./routes/public-lottery";
import { publicAccessRoute } from "./routes/public-access";
import { paymentPublicRoute, paymentCallbackRoute } from "./routes/payment";
import { adminPaymentConfigRoute } from "./routes/admin-payment-config";
import { integrationRoute } from "./routes/integration";
import { systemConfigRoute } from "./routes/system-config";
import { platformSystemConfigRoute } from "./routes/platform-system-config";
import { platformRedemptionCodesRoute } from "./routes/platform-redemption-codes";
import { platformRoute } from "./routes/platform";
import { platformQQRoute } from "./routes/platform-qq";
import { platformTelegramRoute } from "./routes/platform-telegram";
import { adminMediaRoute, mediaRoute } from "./routes/media";
import { enforceRequestBodyLimit } from "./lib/body-limit";
import { timingSafeEqualString } from "./lib/crypto-compare";
import { refreshAllTenantSnapshots } from "./services/admin/usage-snapshots";
import {
  processDueDraws,
  processPendingWebhookDeliveriesForAllTenants,
  sendDrawReminders,
  type WebhookFetch,
} from "./services/lottery-service";
import { processPendingPlatformDeliveriesForAllTenants } from "./services/platform/delivery";
import { dispatchEmailDeliveries } from "./services/email-delivery";
import { cleanExpiredTokens } from "./services/platform/access-token";
import { cleanExpiredBindings } from "./services/platform/binding";
import { cleanExpiredSpins } from "./services/lottery/spin-execution";

const app = new Hono<AppEnv>();

/** 通用登录/验证码/公开查询等短窗口限流日志最多保留 1 小时。 */
const SHORT_RATE_LIMIT_RETENTION_MS = 3600 * 1000;
/** 邀请奖励配额依赖 24 小时窗口计数，额外保留 10 分钟避免边界时间漂移误删。 */
const REWARD_RATE_LIMIT_RETENTION_MS = 24 * 3600 * 1000 + 10 * 60 * 1000;

function createDbFromEnv(env: Bindings) {
  if (!env.TURSO_URL) return undefined;
  const client = createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
  return createDb(client);
}

/**
 * runScheduledMaintenance 所需的配置项（从环境变量提取）。
 * 与 Bindings 解耦，确保 Node 环境（process.env）和 Workers 环境（c.env）均可正常注入。
 */
export interface MaintenanceEnv {
  resendApiKey?: string;
  emailFrom?: string;
  appOrigin?: string;
  credentialsEncryptionKey?: string;
  cfAuthIssuer?: string;
  cfAuthClientId?: string;
  cfAuthClientSecret?: string;
}

export async function runScheduledMaintenance(
  db: DbType,
  env: MaintenanceEnv,
  options?: {
    fetcher?: WebhookFetch;
    drawLimit?: number;
    webhookTenantLimit?: number;
    webhookPerTenantLimit?: number;
  },
) {
  const draws = await processDueDraws(db, {
    limit: options?.drawLimit ?? 20,
    emailEnv: {
      resendApiKey: env.resendApiKey || "",
      emailFrom: env.emailFrom || "",
      appOrigin: env.appOrigin || "",
    },
  });
  const webhooks = await processPendingWebhookDeliveriesForAllTenants(db, options?.fetcher ?? fetch, {
    tenantLimit: options?.webhookTenantLimit ?? 25,
    perTenantLimit: options?.webhookPerTenantLimit ?? 20,
  });
  // 平台出站消息投递（QQ 群消息）：异步发送 pending 的平台消息，3 次重试
  const platformDeliveries = await processPendingPlatformDeliveriesForAllTenants(db, {
    perTenantLimit: 20,
    credentialsEncryptionKey: env.credentialsEncryptionKey || "",
  });
  const emailDeliveries = await dispatchEmailDeliveries(db, {
    resendApiKey: env.resendApiKey || "",
    emailFrom: env.emailFrom || "",
    cfAuthIssuer: env.cfAuthIssuer || "",
    cfAuthClientId: env.cfAuthClientId || "",
    cfAuthClientSecret: env.cfAuthClientSecret || "",
  }, { limit: 50 });
  // 限流日志只服务短窗口判断，定时清理避免 Turso 免费层 rows/storage 被长期无价值日志拖垮。
  // F1 修复：reward 邀请奖励配额是【24 小时窗口】（reward.ts REWARD_QUOTA_WINDOW_MS），
  // 而通用登录/验证码限流是【1 小时窗口】。若统一按 1h 清理，会把 reward 的 24h 计数记录
  // 一并删掉，导致「每日每邀请人/每日全局」配额退化为「每小时」，奖励可刷到日上限的数倍（超发击穿）。
  // 因此按 key 前缀差异化清理：`reward:` 前缀保留 24h+（保护每日上限），其余短窗口限流保留 1h。
  const cleanedRateLimitLogs = await cleanRateLimitLogsSafely(db);
  // P2-2 清理：已过期/已使用的访问令牌，最长保留 24 小时
  const cleanedTokens = await cleanExpiredTokens(db);
  // P2-2 清理：已过期/已使用的绑定码，最长保留 24 小时
  const cleanedBindings = await cleanExpiredBindings(db);
  // P3 清理：已过期的幂等抽奖执行记录，最长保留 7 天
  const cleanedSpins = await cleanExpiredSpins(db);
  // 平台运营后台依赖快照展示租户用量；放进统一维护任务，保证 scheduled 和手动入口行为一致。
  const usageSnapshots = await refreshAllTenantSnapshots(db);
  // 数据保留清理：根据系统配置定期删除过期数据（兜底：未配置 = 不清理）
  const cleanedRetention = await runRetentionCleanup(db);
  // 营销邮件：开奖前 1 小时提醒
  const drawReminders = await sendDrawReminders(db, {
    resendApiKey: env.resendApiKey || "",
    emailFrom: env.emailFrom || "",
  });

  return { draws, webhooks, platformDeliveries, emailDeliveries, cleanedRateLimitLogs, cleanedTokens, cleanedBindings, cleanedSpins, usageSnapshots: usageSnapshots.processed, cleanedRetention, drawReminders };
}

/**
 * 按 key 前缀差异化清理限流日志（F1 修复）。
 *
 * 背景：rate_limit_log 表承载两种语义完全不同的限流：
 * 1. 通用短窗口限流（登录/验证码/注册等），窗口通常 1 分钟~1 小时；
 * 2. reward 邀请奖励配额（reward.ts），窗口固定 24 小时（REWARD_QUOTA_WINDOW_MS）。
 *
 * 若统一用「1 小时前全部删除」清理，会把 reward 的 24h 计数记录删掉，
 * 使「每日每邀请人上限 / 每日全局上限」退化为「每小时上限」，羊毛党可把奖励刷到日上限的数倍。
 *
 * 处理：
 * - `reward:` 前缀的记录按 REWARD_QUOTA_WINDOW_MS（24h）+ 余量保留；
 * - 其余短窗口限流记录按 1h 保留（与旧行为一致，防止无界增长）。
 *
 * @returns 删除的总行数
 */
export async function cleanRateLimitLogsSafely(db: ReturnType<typeof createDb>): Promise<number> {
  // 1) 清理 reward 前缀的过期记录（仅删超过 24h+ 的）
  const rewardCutoff = new Date(Date.now() - REWARD_RATE_LIMIT_RETENTION_MS).toISOString();
  const rewardDeleted = await db
    .delete(rateLimitLog)
    .where(sql`${rateLimitLog.key} LIKE 'reward:%' AND ${rateLimitLog.createdAt} < ${rewardCutoff}`);

  // 2) 清理非 reward 前缀的短窗口限流记录（超过 1h 即删）
  const shortCutoff = new Date(Date.now() - SHORT_RATE_LIMIT_RETENTION_MS).toISOString();
  const shortDeleted = await db
    .delete(rateLimitLog)
    .where(sql`(${rateLimitLog.key} NOT LIKE 'reward:%') AND ${rateLimitLog.createdAt} < ${shortCutoff}`);

  return (rewardDeleted.rowsAffected ?? 0) + (shortDeleted.rowsAffected ?? 0);
}

/**
 * 数据保留清理：读取系统配置的 data_retention_days 和 audit_log_retention_days，
 * 清理过期的草稿/已取消活动以及审计日志。
 * 仅在 cron/maintenance 定时任务中触发，不在热路径执行。
 */
export async function runRetentionCleanup(db: ReturnType<typeof createDb>) {
  const rows = await db.select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(sql`${systemConfig.key} IN ('data_retention_days', 'audit_log_retention_days')`);
  const cfg: Record<string, number> = {};
  for (const row of rows) cfg[row.key] = parseInt(row.value, 10) || 0;

  const dataDays = cfg["data_retention_days"] || 0;
  const auditDays = cfg["audit_log_retention_days"] || 0;
  let deletedData = 0;
  let deletedAudit = 0;

  if (dataDays > 0) {
    const cutoff = new Date(Date.now() - dataDays * 86400000).toISOString();
    const result = await db.delete(lotteryDraws).where(and(
      sql`${lotteryDraws.status} IN ('draft', 'cancelled')`,
      sql`${lotteryDraws.updatedAt} < ${cutoff}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${paymentOrders}
        WHERE ${paymentOrders.drawId} = ${lotteryDraws.id}
          AND ${paymentOrders.tenantId} = ${lotteryDraws.tenantId}
      )`,
    ));
    deletedData = result.rowsAffected ?? 0;
  }

  if (auditDays > 0) {
    const cutoff = new Date(Date.now() - auditDays * 86400000).toISOString();
    const result = await db.delete(auditLogs).where(sql`${auditLogs.createdAt} < ${cutoff}`);
    deletedAudit = result.rowsAffected ?? 0;
  }

  return { deletedDataRows: deletedData, deletedAuditRows: deletedAudit };
}

// ── CORS（允许前端跨域请求） ──
// 公共 API 需要宽 CORS（活动可嵌入任意域名），管理/平台写接口已通过 JWT + RBAC 保护。
// 如果后续需要进一步收紧，可以按路由拆分 CORS 策略。
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

/**
 * 基线安全响应头（轻量、不挡嵌入）。
 * - nosniff / Referrer-Policy：降低 MIME 嗅探与 referrer 泄漏
 * - 不设 X-Frame-Options: DENY：活动页需可被宿主站 iframe 嵌入（产品定位）
 * - 完整 CSP 中期再做：需拆 admin / 公开 / 嵌入三套策略，避免一次 CSP 打断现网
 */
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("X-DNS-Prefetch-Control", "off");
  // 不开放危险浏览器能力；嵌入场景仍允许自身脚本
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

// ── 全局错误处理 ──
app.onError((err, c) => {
  // 生产环境只记录 error.message，避免 err.stack 中的内部路径/凭证泄露到 Worker 日志
  console.error(`[error] ${err.message}`);
  return c.json({ ok: false, message: "服务器内部错误" }, 500);
});

// ── 请求体大小闸门 ──
// Cloudflare Workers 免费层不适合让任意 API 接收大请求体。
// 只有 /api/admin/media/images 允许 2MiB 图片上传，其余接口保持 100KB。
// #8 加固：对无 content-length（chunked 编码）的写请求流式读取计数，
// 防止绕过大小闸门；未超限时重建请求体供下游解析。实现见 lib/body-limit.ts。
app.use("*", enforceRequestBodyLimit);

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

// ── 进程级 DB client 缓存（docs/191 §5.1）──────────────────────────────
// 背景：本地 SQLite（VPS 生产形态）下，DB 中间件每请求 createClient 是最大开销
// （实测 35.6× 于连接复用，占单请求耗时约 74%，把吞吐锁死在 ~500 req/s）。
// 设计约束：
//  - 单库多租户架构（tenantId 隔离）下进程内只需 1 个连接，按 (url, token) 键缓存安全；
//  - Workers isolate 内 env 固定，缓存生命周期与 isolate 一致，无跨隔离串号风险；
//  - createClient 抛异常（如 URL 非法）时不缓存，下次请求重试，保持原 dbInitError 语义；
//  - 并发首请求同时 cache miss 时用 pending Promise 防抖，只创建一次连接。
const dbClientCache = new Map<string, Client>();
const dbClientPending = new Map<string, Promise<Client>>();

/**
 * 获取（或创建并缓存）libsql client。
 * WAL 设置持久化到库文件，只需在建连后执行一次；失败忽略（只读库等保持原 .catch 语义）。
 * @param url  TURSO_URL（file: 本地 SQLite 或 libsql:// 远程）
 * @param token TURSO_TOKEN（远程库需要；本地库可空）
 */
export async function getCachedDbClient(url: string, token?: string): Promise<Client> {
  const key = `${url}|${token || ""}`;
  const cached = dbClientCache.get(key);
  if (cached) return cached;

  let pending = dbClientPending.get(key);
  if (!pending) {
    pending = (async () => {
      const client = createClient({ url, authToken: token });
      if (url.startsWith("file:")) {
        await client.execute("PRAGMA journal_mode = WAL").catch(() => {});
      }
      dbClientCache.set(key, client);
      return client;
    })().finally(() => {
      dbClientPending.delete(key);
    });
    dbClientPending.set(key, pending);
  }
  return pending;
}

// ── 数据库初始化中间件 ──
// 如果 TURSO_URL 未配置（开发环境），db 为 undefined，health 端点返回 db: false。
// 如果初始化抛异常（凭证错误等），标记 dbInitError 让 health 端点和 getDb 区分场景。
// 用 getEnv 读取：Node（server.ts）下回退 process.env，无需等待 env 注入中间件。
// client 走进程级缓存复用（getCachedDbClient），不再每请求 createClient。
app.use("*", async (c, next) => {
  try {
    const url = getEnv(c, "TURSO_URL");
    if (url) {
      const client = await getCachedDbClient(url, getEnv(c, "TURSO_TOKEN"));
      c.set("db", createDb(client));
    } else {
      c.set("db", undefined);
    }
  } catch (err) {
    console.error("[db] 数据库初始化失败:", err);
    c.set("dbInitError", String((err as Error).message || "数据库连接失败"));
  }
  await next();
});

// 路由挂载
app.route("/api/auth", authRoute);
app.route("/api", mediaRoute);
app.route("/api/admin/media", adminMediaRoute);
app.route("/api/admin", adminLotteryRoute);
app.route("/api/admin", adminPaymentConfigRoute);
app.route("/api/public", publicLotteryRoute);
app.route("/api/public/access", publicAccessRoute);
app.route("/api/public", paymentPublicRoute);
app.route("/api/payments", paymentCallbackRoute);
app.route("/api/integration", integrationRoute);
app.route("/api/system-config", systemConfigRoute);
// 平台运营后台路由（L3）
app.route("/api/platform/system-config", platformSystemConfigRoute);
app.route("/api/platform/redemption-codes", platformRedemptionCodesRoute);
app.route("/api/platform/qq", platformQQRoute);
app.route("/api/platform/telegram", platformTelegramRoute);
app.route("/api/platform", platformRoute);

// 健康检查：只暴露布尔连通性，不回传内部错误字符串（防侦察，docs/070 LOW #12）
app.get("/api/health", (c) => c.json({
  ok: true,
  db: !!c.get("db"),
  /** 有初始化错误时仅 true，细节只写 Worker 日志 */
  dbError: Boolean(c.get("dbInitError")),
}));

// Cron 手动入口：处理到期活动。线上自动任务使用 Worker scheduled() handler。
// 安全：需要通过 CRON_SECRET 认证，防止未授权触发
app.get("/api/cron/draw", async (c) => {
  const db = c.get("db");
  if (!db) return c.json({ ok: false, message: "数据库未配置" }, 500);

  // CRON_SECRET 认证（#16）：只接受 Authorization: Bearer <secret>。
  // 线上自动任务走 scheduled() handler 不经 HTTP，本端点是运维手动触发入口；
  // 移除 query 参数 ?secret= 认证（secret 会进入访问日志/浏览器历史），与 maintenance 端点保持一致。
  const cronSecret = getEnv(c, "CRON_SECRET");
  // 未配置 CRON_SECRET 时拒绝所有 cron 请求，防止内部端点意外暴露
  if (!cronSecret) return c.json({ ok: false, message: "未配置 CRON_SECRET" }, 503);
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  // 常量时间比较：降低 Bearer secret 前缀计时面（与密码/OTP hash 比较同策略）
  if (!token || !timingSafeEqualString(token, cronSecret)) {
    return c.json({ ok: false, message: "未授权" }, 403);
  }

  try {
    const result = await processDueDraws(db, {
      limit: 20,
      emailEnv: {
        resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
        emailFrom: getEnv(c, "EMAIL_FROM") || "",
        appOrigin: getEnv(c, "APP_ORIGIN") || "",
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
  const cronSecret = getEnv(c, "CRON_SECRET");
  if (!cronSecret) return c.json({ ok: false, message: "未配置 CRON_SECRET" }, 503);
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || !timingSafeEqualString(token, cronSecret)) {
    return c.json({ ok: false, message: "未授权" }, 403);
  }

  try {
    const db = c.get("db");
    if (!db) return c.json({ ok: false, message: "数据库未配置" }, 500);
    const result = await runScheduledMaintenance(db, {
      resendApiKey: getEnv(c, "RESEND_API_KEY") || "",
      emailFrom: getEnv(c, "EMAIL_FROM") || "",
      credentialsEncryptionKey: getEnv(c, "CREDENTIALS_ENCRYPTION_KEY") || "",
      cfAuthIssuer: getEnv(c, "CF_AUTH_ISSUER") || "",
      cfAuthClientId: getEnv(c, "CF_AUTH_CLIENT_ID") || "",
      cfAuthClientSecret: getEnv(c, "CF_AUTH_CLIENT_SECRET") || "",
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] maintenance failed:", err);
    return c.json({ ok: false, message: "定时维护任务执行失败" }, 500);
  }
});

/**
 * 未知 /api/*：必须 JSON 404。
 * 若落入下方 SPA fallback，客户端会把 HTML 当 JSON 解析失败，
 * 也掩盖「路由是否存在」——排障与嵌入方集成都会踩坑。
 * 本处理器挂在全部 API 路由之后，只承接未匹配的 API。
 */
app.all("/api/*", (c) => c.json({ ok: false, message: "接口不存在" }, 404));

// 前端静态资源：所有非 /api 请求返回 index.html（SPA）
// Cloudflare：ASSETS binding 托管静态资源（run_worker_first 让 API 走 Worker）；
// Node（server.ts）：无 ASSETS binding → next() 交给 @hono/node-server 的 serveStatic。
app.get("*", async (c, next) => {
  // 双保险：/api 不应进入 SPA（正常已由上方 all /api/* 截获）
  if (c.req.path.startsWith("/api/") || c.req.path === "/api") {
    return c.json({ ok: false, message: "接口不存在" }, 404);
  }
  const lotteryMatch = c.req.path.match(/^\/lottery\/([^/]+)$/);
  if (lotteryMatch && isSocialCrawler(c.req.header("User-Agent"))) {
    const slug = decodePublicSlug(lotteryMatch[1] || "");
    const db = c.get("db");
    if (slug && db) {
      const [draw] = await db
        .select({
          title: lotteryDraws.title,
          description: lotteryDraws.description,
          status: lotteryDraws.status,
        })
        .from(lotteryDraws)
        .where(and(
          eq(lotteryDraws.publicSlug, slug),
          eq(lotteryDraws.visible, 1),
          inArray(lotteryDraws.status, ["open", "drawn"]),
        ))
        .limit(1);
      if (draw) {
        const requestUrl = new URL(c.req.url);
        return c.html(renderPublicOgHtml({
          title: draw.title,
          description: draw.description,
          status: draw.status,
          pageUrl: requestUrl.toString(),
        }));
      }
    }
  }
  const assets = c.env.ASSETS as Fetcher | undefined;
  if (!assets) return next();
  try {
    const asset = await assets.fetch(c.req.raw);
    if (asset.status === 404) {
      // SPA fallback: 返回 index.html
      return assets.fetch(new Request(new URL("/index.html", c.req.url)));
    }
    return asset;
  } catch {
    return assets.fetch(new Request(new URL("/index.html", c.req.url)));
  }
});

const worker: ExportedHandler<Bindings> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const db = createDbFromEnv(env);
        if (!db) {
          console.error("[cron] 数据库未配置，跳过 maintenance");
          return;
        }
        const result = await runScheduledMaintenance(db, {
          resendApiKey: env.RESEND_API_KEY || "",
          emailFrom: env.EMAIL_FROM || "",
          credentialsEncryptionKey: env.CREDENTIALS_ENCRYPTION_KEY || "",
          cfAuthIssuer: env.CF_AUTH_ISSUER || "",
          cfAuthClientId: env.CF_AUTH_CLIENT_ID || "",
          cfAuthClientSecret: env.CF_AUTH_CLIENT_SECRET || "",
        });
        console.log("[cron] maintenance complete", JSON.stringify(result));
      } catch (err) {
        console.error("[cron] maintenance failed:", err);
      }
    })());
  },
};

export { app };
export default worker;
