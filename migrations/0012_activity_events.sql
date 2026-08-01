-- 活动事件：用于导流、归因、漏斗统计。只记录平台内事实，不直接代表外部成交。
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  medium TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  ref_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_events_draw_event
  ON activity_events(tenant_id, draw_id, event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_events_entry
  ON activity_events(tenant_id, draw_id, entry_id, created_at);

CREATE INDEX IF NOT EXISTS idx_activity_events_ref
  ON activity_events(tenant_id, draw_id, ref_code, created_at);
