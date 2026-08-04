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
import type { ActivityEventType } from "../services/lottery-service";

/** 简单内存限流：同一 key 每窗口最多 N 次（单实例预过滤） */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string, limit = 10, windowMs = 60000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/**
 * 公开端统一限流：内存 Map 预过滤 + DB 跨实例闸门。
 */
export async function checkPublicRateLimit(
  db: DbType,
  key: string,
  limit = 10,
  windowMs = 60000,
): Promise<boolean> {
  if (!checkRateLimit(key, limit, windowMs)) return false;
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

/** 安全解析 JSON 字符串 */
export function tryParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
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

/** HTML 转义（OG / 防 XSS） */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
