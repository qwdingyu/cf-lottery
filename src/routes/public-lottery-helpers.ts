/**
 * 公开参与路由 — 共享工具（限流 / 身份 / 验证码 / 脱敏）
 *
 * 从 public-lottery.ts 抽出，供主路由与 share 子模块复用。
 * 不挂载任何 endpoint，避免与 setup* 模式混淆。
 */
import type { Context } from "hono";
import type { AppEnv } from "../bindings";
import { getEnv } from "../lib/platform";
import type { DbType } from "../db/client";
import { emailAccessCodes } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { verifyJwt } from "../middleware/auth";
import { checkDbRateLimit } from "../lib/rate-limit";
import { MemoryRateLimiter } from "@usethink/cf-core/rate-limit";
import type { ActivityEventType } from "../services/lottery-service";
import { escapeHtml } from "../services/email-service";

/** 内存固定窗口限流（docs/091 P0-5：统一到 cf-core MemoryRateLimiter，替代本地 Map 实现） */
const memoryLimiter = new MemoryRateLimiter();

/**
 * 公开端统一限流：内存预过滤 + DB 跨实例闸门。
 */
export async function checkPublicRateLimit(
  db: DbType,
  key: string,
  limit = 10,
  windowMs = 60000,
): Promise<boolean> {
  if (!(await memoryLimiter.check(key, limit, windowMs)).ok) return false;
  return checkDbRateLimit(db, key, limit, windowMs);
}

/** SHA-256 hex（事件 IP / 身份限流键） */
export async function hashEventValue(value: string): Promise<string> {
  if (!value) return "";
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 按活动 + 身份再加一层持久限流，避免绕过 IP 后持续猜验证码。
 * 身份值只以 hash 写入 rate_limit_log。
 */
export async function checkPublicIdentityRateLimit(
  db: DbType,
  action: string,
  drawId: string,
  identityValue: string,
  limit = 10,
  windowMs = 60000,
): Promise<boolean> {
  const identityHash = await hashEventValue(`${drawId}:${identityValue.trim().toLowerCase()}`);
  return checkDbRateLimit(db, `${action}:identity:${identityHash}`, limit, windowMs);
}

/**
 * 统一解析参与者身份（端点层一步解析，业务层只消费）。
 * registered → JWT sub；其他模式 → email。
 */
export async function resolveParticipantIdentity(
  c: Context<AppEnv>,
  participationMode: string,
  email: string,
): Promise<{ identityType: string; identityValue: string } | null> {
  if (participationMode === "registered") {
    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const jwtSecret = getEnv(c, "JWT_SECRET");
    if (!jwtSecret) throw new Error("JWT_SECRET 未配置");
    try {
      const payload = await verifyJwt(token, jwtSecret);
      if (payload?.sub) return { identityType: "user_id", identityValue: payload.sub };
    } catch {
      /* JWT 无效 */
    }
    return null;
  }
  return { identityType: "email", identityValue: email };
}

export const PUBLIC_EVENT_TYPES = new Set<ActivityEventType>([
  "page_view",
  "participation_started",
  "participation_completed",
  "cta_impression",
  "cta_click",
  "share_click",
  "external_conversion_reported",
]);

/** 生成 6 位数字验证码 */
export function generateCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num = new DataView(bytes.buffer).getUint32(0) % 1000000;
  return String(num).padStart(6, "0");
}

/** 对验证码做 SHA-256 hash */
export async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 脱敏展示邮箱 / 身份 */
export function maskIdentity(value: string): string {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return name.slice(0, 2) + "***@" + domain;
  }
  return value.slice(0, 2) + "***";
}

/**
 * 校验邮箱验证码（参与 / 查结果 / 取消 复用）。
 * @returns 有效记录，无效 null
 */
export async function verifyEmailAccessCode(
  db: DbType,
  email: string,
  drawId: string,
  code: string,
): Promise<typeof emailAccessCodes.$inferSelect | null> {
  const codeHash = await hashCode(code);
  const now = new Date().toISOString();
  const [validCode] = await db
    .select()
    .from(emailAccessCodes)
    .where(
      and(
        eq(emailAccessCodes.email, email),
        eq(emailAccessCodes.drawId, drawId),
        eq(emailAccessCodes.codeHash, codeHash),
        eq(emailAccessCodes.used, 0),
        sql`${emailAccessCodes.expiresAt} > ${now}`,
      ),
    )
    .limit(1);
  return validCode || null;
}

/**
 * 核销邮箱 OTP（join / spin 成功路径）。
 * CAS used=0→1，避免并发双核销竞态；幂等回放不应再调用。
 */
export async function consumeEmailAccessCode(
  db: DbType,
  codeId: string,
): Promise<boolean> {
  const id = String(codeId || "").trim();
  if (!id) return false;
  const result = await db
    .update(emailAccessCodes)
    .set({ used: 1 })
    .where(and(eq(emailAccessCodes.id, id), eq(emailAccessCodes.used, 0)));
  return (result.rowsAffected ?? 0) > 0;
}

/** 安全解析 JSON 字符串 */
export function tryParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 校验并规范化 http(s) URL；非法/非 http(s) 返回空串（防 XSS/防协议注入） */
export function publicHttpUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/**
 * Open Graph 缺 description 时的兜底文案（docs/104）。
 * 终态活动禁止「快来参与」——别人点开也无法同等参与，与结果页隐藏邀请同一原则。
 */
export function ogDescriptionFallback(status: string | null | undefined): string {
  const st = String(status || "")
    .trim()
    .toLowerCase();
  if (st === "drawn" || st === "closed") {
    return "活动已结束，可打开链接查看结果。";
  }
  if (st === "cancelled") {
    return "活动已取消。";
  }
  if (st === "paused" || st === "draft") {
    return "活动暂未开放参与。";
  }
  if (st === "drawing") {
    return "活动正在出结果，可打开链接查看。";
  }
  return "快来参与活动吧！";
}

/**
 * 社交平台抓取公开活动链接时不会执行前端 JavaScript，
 * 因此 /lottery/:slug 必须在 SPA 回退前返回服务端 OG HTML。
 * 只识别已知社交抓取器，避免普通浏览器请求被误判。
 */
export function isSocialCrawler(userAgent: string | null | undefined): boolean {
  return /facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|TelegramBot|WhatsApp|LinkedInBot|Pinterest|MicroMessenger|Bytespider|Line\/|Google-InspectionTool/i
    .test(String(userAgent || ""));
}

/** URL path 参数来自外部请求，非法百分号编码只应当走正常 SPA 404/回退，不能抛出 500。 */
export function decodePublicSlug(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** 默认 OG 图片：内置彩色 SVG，始终可用且无需额外部署静态资源 */
export function defaultOgImageUrl(pageUrl: string): string {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='630' viewBox='0 0 1200 630'%3E%3Crect width='1200' height='630' fill='%234F46E5'/%3E%3Ctext x='600' y='300' text-anchor='middle' fill='white' font-size='48' font-family='sans-serif'%3E🎯%3C/text%3E%3Ctext x='600' y='370' text-anchor='middle' fill='white' font-size='24' font-family='sans-serif'%3E运营活动引擎%3C/text%3E%3C/svg%3E`;
}

/**
 * 从活动配置中提取商品信息（flashSale.imageUrl > productLink > promotionConfig.destination）。
 * 已移到 public-lottery-helpers，供 index.ts 社交爬虫和 public-lottery.ts OG 端点复用。
 * docs/245：秒杀商品图与导流配置解耦——秒杀场景优先用 flashSale.imageUrl，
 * 与活动页 buildFlashSaleMerchCard 的图片来源一致，避免店铺页/活动页显示不一致。
 */
export function productFromPublicConfig(draw: {
  title: string;
  productLink?: string | null;
  promotionConfig?: string | null;
}) {
  const productLink = tryParseJson(draw.productLink || "{}") as Record<string, unknown> | null;
  const promotion = tryParseJson(draw.promotionConfig || "{}") as Record<string, unknown> | null;
  const destination = promotion?.destination && typeof promotion.destination === "object" && !Array.isArray(promotion.destination)
    ? (promotion.destination as Record<string, unknown>)
    : null;
  // 秒杀商品图优先（docs/245）：flashSale.imageUrl > productLink.imageUrl > destination.imageUrl
  const flashSale = promotion?.flashSale && typeof promotion.flashSale === "object" && !Array.isArray(promotion.flashSale)
    ? (promotion.flashSale as Record<string, unknown>)
    : null;
  const flashImage = String(flashSale?.imageUrl ?? flashSale?.image_url ?? "").trim();
  return {
    title: String(flashSale?.title || productLink?.title || destination?.title || draw.title || "").trim(),
    imageUrl: publicHttpUrl(flashImage || productLink?.imageUrl || destination?.imageUrl),
    priceText: String(productLink?.price || productLink?.priceText || destination?.priceText || "").trim(),
    url: publicHttpUrl(productLink?.url || destination?.url),
  };
}

export function renderPublicOgHtml(input: {
  title: string;
  description?: string | null;
  status?: string | null;
  pageUrl: string;
  /** 活动/商品图片 URL，为空时使用默认 SVG 公益图 */
  imageUrl?: string | null;
}): string {
  const title = escapeHtml(input.title);
  const rawDesc = String(input.description || "").trim() || ogDescriptionFallback(input.status);
  const description = escapeHtml(rawDesc);
  const pageUrl = escapeHtml(input.pageUrl);
  // 图片优先级：活动商品图/奖品图 > 默认 SVG 公益图
  const imageUrl = escapeHtml(input.imageUrl || defaultOgImageUrl(pageUrl));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="运营活动引擎" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${imageUrl}" />
  <meta http-equiv="refresh" content="0;url=${pageUrl}" />
</head>
<body>
  <p>正在跳转到活动页…<a href="${pageUrl}">点击这里</a></p>
</body>
</html>`;
}

export { escapeHtml };
