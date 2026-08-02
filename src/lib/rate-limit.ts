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
import { sql } from "drizzle-orm";

/**
 * 数据库级限流检查
 *
 * @param db - 数据库实例
 * @param key - 限流 key（如 `login:ip_hash`、`register:email`）
 * @param limit - 时间窗口内允许的最大次数
 * @param windowMs - 时间窗口（毫秒）
 * @returns 是否允许通过
 *
 * 实现（#6 修复）：单条原子条件 INSERT。
 * 修复前为"SELECT COUNT + INSERT"两条语句，并发请求可先全部通过 COUNT 检查再各自写入，
 * 导致窗口内通过数超过 limit（测试证实 20 并发/阈值 3 可全部通过）。
 * 修复后 COUNT 与 INSERT 在**同一条 INSERT...SELECT 语句**内执行：
 * - SQLite 写语句整体持有写锁，COUNT 子查询与 INSERT 原子完成，无快照竞态；
 * - 窗口内计数达到 limit 时条件不满足，rowsAffected=0 → 拒绝且不落库。
 * 该模式与 joinDraw 的活动容量检查一致，无事务、无 schema 变更。
 */
export async function checkDbRateLimit(
  db: DbType,
  key: string,
  limit: number,
  windowMs: number = 60000,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const result = await db.run(sql`
    INSERT INTO rate_limit_log (id, key, action, created_at)
    SELECT ${crypto.randomUUID()}, ${key}, ${key.split(":")[0] || "unknown"}, ${new Date().toISOString()}
    WHERE (SELECT COUNT(*) FROM rate_limit_log WHERE key = ${key} AND created_at > ${cutoff}) < ${limit}
  `);

  return (result.rowsAffected ?? 0) > 0;
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