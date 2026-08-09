/**
 * Drizzle ORM 实例工厂 — 纯 Turso/libsql 模式。
 *
 * 创建 Drizzle ORM 实例，使用 drizzle-orm/libsql 驱动。
 * 业务代码只需调用 createDb(client)，获得类型安全的 ORM 实例。
 *
 * 自 v0.5.0 起：withDbTransaction / isSqliteBusyError 委托 @usethink/cf-core/db/connection。
 */
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { withDbTransaction as coreWithDbTransaction, isSqliteBusyError as coreIsSqliteBusyError } from "@usethink/cf-core/db/connection";
import type { DrizzleInstance } from "@usethink/cf-core/db/connection";

/**
 * 创建 Drizzle ORM 实例。
 * @param client - @libsql/client Client 实例
 * @returns Drizzle ORM 数据库实例
 */
export function createDb(client: Client) {
  return drizzle(client);
}

/** Drizzle ORM 实例类型（从 createDb 返回值推断） */
export type DbType = ReturnType<typeof createDb>;

export type DbWriteScope = Pick<DbType, "select" | "insert" | "update" | "delete" | "run">;

/** 判断是否为可恢复的 SQLite/libSQL 写锁竞争（委托 cf-core） */
export function isSqliteBusyError(error: unknown): boolean {
  return coreIsSqliteBusyError(error);
}

/**
 * 统一数据库写事务入口（保留 cf-lottery 原生重试参数：5 次重试 + 50ms 基础延迟）。
 *
 * 约束：
 * - 事务内只放必须原子提交的数据库读写，禁止支付、邮件、HTTP 等外部 I/O。
 * - SQLite/libSQL 同一时刻只有一个写事务最稳妥；这里对短暂 BUSY/LOCKED 做有界指数退避重试。
 * - 测试 mock 可能没有 transaction()，此时直接执行回调，保持单元测试轻量。
 *
 * 与 cf-core 默认差异：retries=5（core=2）、baseDelayMs=50（core=500），
 * 总等待约 1.55s 仍为有界，不会无限阻塞请求。
 */
export async function withDbTransaction<T, TTx = DbType>(
  db: DbType,
  fn: (tx: TTx) => Promise<T>,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  return coreWithDbTransaction(
    db as unknown as DrizzleInstance,
    fn as (tx: unknown) => Promise<T>,
    { retries: options.retries ?? 5, baseDelayMs: options.baseDelayMs ?? 50 },
  );
}
