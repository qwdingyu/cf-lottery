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
 *
 * 自 v0.5.0 起：委托 @usethink/cf-core/concurrency（统一实现）。
 */
export { runBounded } from "@usethink/cf-core/concurrency";