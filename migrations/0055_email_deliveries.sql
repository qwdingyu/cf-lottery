CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '',
  draw_id TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  template TEXT NOT NULL,
  template_data_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  provider_message_id TEXT NOT NULL DEFAULT '',
  response_body TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_status_retry_created
  ON email_deliveries (status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_email_deliveries_tenant_status
  ON email_deliveries (tenant_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_deliveries_source_unique
  ON email_deliveries (tenant_id, source_type, source_id);
