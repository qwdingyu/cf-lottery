-- 一次性令牌消费表（docs/243）：同一 token 在 TTL 内仅允许成功消费一次。
-- 复合主键 (action, subject_hash) 确保原子唯一：INSERT ... ON CONFLICT DO NOTHING。
-- TTL 由调用方保证（JWT exp 等）；清理任务按 created_at 删除过期数据。
CREATE TABLE IF NOT EXISTS consume_once_tokens (
  action TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (action, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_consume_once_created_at ON consume_once_tokens(created_at);