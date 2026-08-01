-- 分享裂变记录（追踪分享带来的新参与）
CREATE TABLE IF NOT EXISTS share_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  sharer_entry_id TEXT NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  clicked_count INTEGER NOT NULL DEFAULT 0,
  joined_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_share_draw ON share_records(tenant_id, draw_id, created_at);