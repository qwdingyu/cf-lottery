-- API 密钥（用于外部系统集成）
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_key_tenant ON api_keys(tenant_id, active, created_at);

-- Webhook 配置（外部系统事件通知）
CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["draw.completed","prize.issued"]',
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_configs(tenant_id, active, created_at);