-- Webhook 投递生命周期：签名、投递记录、失败重试和事件幂等键。
ALTER TABLE webhook_configs ADD COLUMN signing_secret TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  webhook_config_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  response_status INTEGER,
  response_body TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE(webhook_config_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant
  ON webhook_deliveries(tenant_id, status, created_at);
