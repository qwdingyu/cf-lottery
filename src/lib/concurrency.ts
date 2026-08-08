/**
 * 有界并发执行工具
 *
 * 用于限制同时执行的异步任务数量，避免打爆下游服务（邮件/Webhook）限流。
 * 不依赖任何外部库，纯 Node.js 原生 Promise。
 *
 * 使用方式：
 *   await runBounded(items, 5, async (item) => { await send(item); });
 *
 * 设计原则：
 * - 一个失败不影响其他任务（每个任务独立 try/catch）
 * - 队列为空时 Worker 自然退出，不保留未完成的 Promise
 * - 不保证处理顺序（FIFO 取任务但 Worker 完成顺序不确定）
 */

/** 有界并发执行单个任务，收集每个任务的结果 */
export async function runBounded<T, R = void>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ ok: boolean; value?: R; error?: unknown }[]> {
  if (concurrency < 1) concurrency = 1;
  const results: { ok: boolean; value?: R; error?: unknown }[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx]!;
      try {
        const value = await fn(item, idx);
        results[idx] = { ok: true, value };
      } catch (error) {
        results[idx] = { ok: false, error };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  if (workerCount <= 0) return [];
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}