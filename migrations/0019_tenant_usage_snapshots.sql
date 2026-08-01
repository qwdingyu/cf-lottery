-- 租户用量快照
--
-- 用途：
-- - 平台运营后台读取租户活动数、参与数、事件数、中奖数、Webhook 投递数。
-- - 避免平台列表/摘要接口每次实时 COUNT 多张大表。
-- - 当前按天保留一条快照，后续做账单或容量告警时可直接复用。
CREATE TABLE IF NOT EXISTS tenant_usage_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  activity_count INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  winner_count INTEGER NOT NULL DEFAULT 0,
  webhook_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_snapshots_date
  ON tenant_usage_snapshots(snapshot_date, tenant_id);
