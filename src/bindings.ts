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
  // 奖品图、活动图等公开媒体对象。未绑定时上传/读取接口返回明确 503。
  LOTTERY_MEDIA?: R2Bucket;
  // JWT 签名密钥（必填，生产环境通过 wrangler secret put 设置）
  JWT_SECRET?: string;
  // 密码 pepper（推荐独立于 JWT_SECRET 配置），用于降低数据库单独泄漏后的离线撞库风险。
  PASSWORD_PEPPER?: string;
  // Resend API Key，用于中奖邮件通知。通过 wrangler secret put 配置。
  RESEND_API_KEY?: string;
  // Resend 已验证的发件域名
  EMAIL_FROM?: string;
  // 生成公开活动链接时使用的正式站点域名
  APP_ORIGIN?: string;
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
    /** 数据库初始化失败时的错误信息（db 中间件注入） */
    dbInitError?: string;
    /** 登录用户 ID（requireAuth 中间件注入） */
    userId: string;
    /** 登录用户所属租户 ID（requireAuth 中间件注入） */
    tenantId: string;
    /** 租户内角色（requireTenantMember 中间件注入） */
    tenantRole?: string;
    /** 平台角色（requirePlatformMember 中间件注入） */
    platformRole?: string;
  };
};
