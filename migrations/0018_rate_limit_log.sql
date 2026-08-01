-- 持久化限流日志
--
-- 用于登录/注册等低频敏感接口的跨 Worker 实例限流。
-- 公开参与热路径不能无节制写本表；如后续接入，必须先按活动规模评估 Turso rows written。
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_key_action
  ON rate_limit_log(key, action, created_at);
