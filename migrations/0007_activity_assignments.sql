-- 活动引擎统一分配结果：接龙、预约、候补等活动使用。
ALTER TABLE lottery_draws ADD COLUMN allocation_policy TEXT NOT NULL DEFAULT 'capacity';

CREATE TABLE activity_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  assignment_type TEXT NOT NULL DEFAULT 'slot',
  status TEXT NOT NULL DEFAULT 'confirmed',
  position INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, entry_id, assignment_type),
  UNIQUE(tenant_id, draw_id, assignment_type, position)
);

CREATE INDEX idx_activity_assignments_draw_status
  ON activity_assignments(tenant_id, draw_id, assignment_type, status, position);
