/**
 * 持久化限流工具
 *
 * 替代内存 Map 实现多 Worker 实例下一致的限流。
 * 使用 rate_limit_log 表记录每次受限操作，按 key + action + 时间窗口 COUNT。
 *
 * 使用方式：
 *   const allowed = await checkDbRateLimit(db, "login:ip_hash", 5, 60000);
 *   if (!allowed) return fail(c, "请求过于频繁", 429);
 */
import type { DbType } from "../db/client";
import { rateLimitLog } from "../db/schema";
import { eq, and, count, sql } from "drizzle-orm";

/**
 * 数据库级限流检查
 *
 * @param db - 数据库实例
 * @param key - 限流 key（如 `login:ip_hash`、`register:email`）
 * @param limit - 时间窗口内允许的最大次数
 * @param windowMs - 时间窗口（毫秒）
 * @returns 是否允许通过
 */
export async function checkDbRateLimit(
  db: DbType,
  key: string,
  limit: number,
  windowMs: number = 60000,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  // 查询当前窗口内的记录数
  const [result] = await db
    .select({ total: count() })
    .from(rateLimitLog)
    .where(
      and(
        eq(rateLimitLog.key, key),
        sql`${rateLimitLog.createdAt} > ${cutoff}`,
      ),
    );

  const currentCount = Number(result?.total ?? 0);
  if (currentCount >= limit) {
    return false;
  }

  // 写入本次记录
  await db.insert(rateLimitLog).values({
    id: crypto.randomUUID(),
    key,
    action: key.split(":")[0] || "unknown",
    createdAt: new Date().toISOString(),
  });

  return true;
}

/**
 * 清理过期限流记录（由 Cron 定时任务调用）
 */
export async function cleanExpiredRateLimits(db: DbType, olderThanMs: number = 3600000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await db
    .delete(rateLimitLog)
    .where(sql`${rateLimitLog.createdAt} < ${cutoff}`);

  return result.rowsAffected ?? 0;
}