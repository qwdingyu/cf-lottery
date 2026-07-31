/**
 * cf-lottery Worker 环境变量绑定
 *
 * 仅保留抽奖 SaaS 所需的配置项，移除了 cf-shop 电商相关配置。
 */
import type { DbType } from "./db/client";

export type Bindings = {
  // 数据库连接（必填）
  TURSO_URL: string;
  TURSO_TOKEN?: string;
  // 静态资源绑定（前端构建产物）
  ASSETS: Fetcher;
  // JWT 签名密钥（必填，生产环境通过 wrangler secret put 设置）
  JWT_SECRET?: string;
  /**
   * 可选：抽奖 JWT 签名材料。未配置时回退 JWT_SECRET 派生。
   * 配置后抽奖会话与 Admin 密钥隔离。
   */
  LOTTERY_JWT_SECRET?: string;
  // Resend API Key，用于中奖邮件通知。通过 wrangler secret put 配置。
  RESEND_API_KEY?: string;
  // Resend 已验证的发件域名
  EMAIL_FROM?: string;
  // 生成公开活动链接时使用的正式站点域名
  APP_ORIGIN?: string;
  // 用于把真实 IP 哈希化后写入 audit_logs，避免日志里保存明文 IP
  RATE_LIMIT_SALT?: string;
  // Cron 调用的认证密钥，防止未授权触发定时开奖
  CRON_SECRET?: string;
  // 敏感配置加密密钥（64 位 hex 字符串），用于加密存储敏感配置项
  CREDENTIALS_ENCRYPTION_KEY?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    db: DbType | undefined;
    executionCtx: ExecutionContext;
    /** 登录用户 ID（requireAuth 中间件注入） */
    userId: string;
    /** 登录用户所属租户 ID（requireAuth 中间件注入） */
    tenantId: string;
  };
};