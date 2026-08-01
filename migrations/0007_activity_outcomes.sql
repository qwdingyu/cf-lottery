-- 活动引擎统一结果：接龙、预约、候补、审核等活动使用。
ALTER TABLE lottery_draws ADD COLUMN allocation_policy TEXT NOT NULL DEFAULT 'capacity';

CREATE TABLE activity_outcomes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL DEFAULT 'assignment',
  status TEXT NOT NULL DEFAULT 'assigned',
  sequence_no INTEGER NOT NULL,
  assignment_no INTEGER,
  result_key TEXT NOT NULL DEFAULT '',
  result_label TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, draw_id, outcome_type, entry_id),
  UNIQUE(tenant_id, draw_id, outcome_type, sequence_no),
  UNIQUE(tenant_id, draw_id, outcome_type, assignment_no)
);

CREATE INDEX idx_activity_outcomes_draw_status
  ON activity_outcomes(tenant_id, draw_id, outcome_type, status, sequence_no);
