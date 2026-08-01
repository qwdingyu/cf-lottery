-- 外部转化回传：成交、核销、注册等必须由外部系统显式回传，不能由点击或 UTM 推断。
CREATE TABLE IF NOT EXISTS external_conversions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL DEFAULT '',
  external_event_id TEXT NOT NULL,
  conversion_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  ref_code TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  identity_type TEXT NOT NULL DEFAULT '',
  identity_value TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_conversions_event
  ON external_conversions(tenant_id, source, external_event_id);

CREATE INDEX IF NOT EXISTS idx_external_conversions_draw
  ON external_conversions(tenant_id, draw_id, conversion_type, created_at);

CREATE INDEX IF NOT EXISTS idx_external_conversions_entry
  ON external_conversions(tenant_id, draw_id, entry_id, created_at);

CREATE INDEX IF NOT EXISTS idx_external_conversions_ref
  ON external_conversions(tenant_id, draw_id, ref_code, created_at);
