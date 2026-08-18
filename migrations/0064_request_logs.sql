-- 请求日志表（docs/243）：记录每次受限/关键请求，含 ipHash、method、path、action、statusCode。
-- 用于审计追踪与故障排查；由清理任务按保留策略删除过期数据。
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  action TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_logs_action_time ON request_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
