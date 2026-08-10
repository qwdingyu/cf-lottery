/**
 * 临时访问令牌服务（docs/179）。
 *
 * 核心用途：Bot 在群内命令中生成一次性 Web 链接，
 * 用户无需登录即可在浏览器查看卡密。
 *
 * 设计决策：
 * - 令牌明文用 crypto.randomUUID() 生成（36 字符，高熵）。
 * - 库中存 SHA-256 哈希，防库泄漏后直接窃取可用令牌。
 * - 一次性（used=1）+ 短时效（5 分钟），双重安全边界。
 * - 清理过期令牌由调用方按需处理（不影响业务正确性）。
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { DbType } from "../../db/client";
import { accessTokens } from "../../db/schema";

/** 令牌用途枚举 */
export type AccessTokenPurpose = "card_code";

/** 生成令牌的返回结果 */
export type AccessTokenResult = {
  token: string; // 令牌明文（仅返回一次，不存储）
  expiresAt: string; // ISO 过期时间
};

/**
 * 生成一次性访问令牌。
 *
 * @param db 数据库实例
 * @param userId 目标 users.id
 * @param purpose 令牌用途
 * @param opts 可选参数
 * @param opts.drawId 令牌所属 drawId（必填业务约束）：公共访问接口按活动范围过滤 winner
 * @param opts.expiresInMs 过期时间（毫秒），默认 5 分钟
 */
export async function generateAccessToken(
  db: DbType,
  userId: string,
  purpose: AccessTokenPurpose = "card_code",
  opts: { drawId?: string; expiresInMs?: number } = {},
): Promise<AccessTokenResult> {
  const { drawId = "", expiresInMs = 5 * 60 * 1000 } = opts;
  const token = crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

  await db.insert(accessTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    purpose,
    drawId,
    expiresAt,
    used: 0,
  });

  return { token, expiresAt };
}

/**
 * 验证并消费一次性访问令牌。
 *
 * 验证规则：
 * 1. 令牌哈希必须存在
 * 2. 令牌未过期（expires_at > now）
 * 3. 令牌未使用（used = 0）
 *
 * 验证通过后标记为已使用（原子性：通过 used=0 条件做 CAS）。
 *
 * @returns 验证通过时返回 { userId, drawId }，否则返回 null。
 *   drawId 用于 public-access.ts 按 draw 过滤（P0-1 跨租户隔离）。
 */
export async function consumeAccessToken(
  db: DbType,
  token: string,
  purpose: AccessTokenPurpose = "card_code",
): Promise<{ userId: string; drawId: string } | null> {
  const tokenHash = await sha256Hex(token);

  // 查找有效令牌（未使用 + 未过期）
  const [existing] = await db
    .select()
    .from(accessTokens)
    .where(and(
      eq(accessTokens.tokenHash, tokenHash),
      eq(accessTokens.purpose, purpose),
      eq(accessTokens.used, 0),
      gt(accessTokens.expiresAt, sql`(datetime('now'))`),
    ))
    .limit(1);

  if (!existing) return null;

  // CAS 式标记已使用（防并发重复消费）
  const result = await db
    .update(accessTokens)
    .set({ used: 1 })
    .where(and(
      eq(accessTokens.id, existing.id),
      eq(accessTokens.used, 0),
    ))
    .returning({ id: accessTokens.id });

  return result.length > 0 ? { userId: existing.userId, drawId: existing.drawId || "" } : null;
}

/**
 * 清理已过期或已使用的令牌（由调用方按需触发）。
 */
export async function cleanExpiredTokens(
  db: DbType,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  await db
    .delete(accessTokens)
    .where(
      sql`${accessTokens.createdAt} < ${cutoff}`
    );
}

/**
 * SHA-256 哈希，返回十六进制小写字符串。
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
