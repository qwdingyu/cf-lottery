/**
 * 统一日志工具（docs/255 G-4）
 *
 * 替代生产代码中的 console.error/warn 调用，提供：
 * - 统一前缀：自动添加模块标识，方便日志聚合
 * - 分级控制：可全局开关 debug 日志，降低线上噪音
 * - 可扩展：未来可接入外部日志服务（如 Sentry），只需改此文件
 *
 * 设计原则：
 * - 只封装日志输出，不改变业务逻辑
 * - 容错路径内的日志仍然记录（不静默），但用统一格式
 * - 不引入任何外部依赖，纯原生实现
 */
const LOG_PREFIX = "[lottery]";

/**
 * 错误日志：记录预期外的异常（try/catch 容错路径）。
 * 与 console.error 同级，但统一前缀方便 grep 聚合。
 */
export function logError(module: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : "";
  console.error(`${LOG_PREFIX} ${module} failed: ${message}${detail ? ` (${detail})` : ""}`);
}

/**
 * 警告日志：记录预期内的边界情况（如码池耗尽、配置不合法）。
 * 不会触发告警，但运维排查时可参考。
 */
export function logWarn(module: string, message: string, detail?: string): void {
  console.warn(`${LOG_PREFIX} ${module}: ${message}${detail ? ` (${detail})` : ""}`);
}

/**
 * 信息日志：记录关键流程节点（如活动创建、开奖完成）。
 * 生产环境默认开启，方便追踪业务流程。
 */
export function logInfo(module: string, message: string): void {
  console.log(`${LOG_PREFIX} ${module}: ${message}`);
}