-- 0054_operational_hot_path_indexes.sql
-- docs/187：补齐 maintenance 与公开查询热点索引。
-- 只增加索引，不改变业务数据或约束，降低平台投递/清理任务在数据量增长后的全表扫描风险。

-- UP
CREATE INDEX IF NOT EXISTS idx_platform_deliveries_status_retry_created
  ON platform_deliveries (status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_retry_created
  ON webhook_deliveries (status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_rate_limit_key_created
  ON rate_limit_log (key, created_at);

CREATE INDEX IF NOT EXISTS idx_spins_created
  ON lottery_spins (created_at);

CREATE INDEX IF NOT EXISTS idx_entries_identity_lookup
  ON lottery_entries (draw_id, identity_type, identity_value);

-- DOWN
DROP INDEX IF EXISTS idx_entries_identity_lookup;
DROP INDEX IF EXISTS idx_spins_created;
DROP INDEX IF EXISTS idx_rate_limit_key_created;
DROP INDEX IF EXISTS idx_webhook_deliveries_status_retry_created;
DROP INDEX IF EXISTS idx_platform_deliveries_status_retry_created;
