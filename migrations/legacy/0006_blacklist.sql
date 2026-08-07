-- 参与者黑名单（按租户级别，防止同一人用多个邮箱参与）
CREATE TABLE IF NOT EXISTS lottery_blacklist (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_value ON lottery_blacklist(tenant_id, identity_value);