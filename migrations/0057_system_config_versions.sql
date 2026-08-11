-- 0057_system_config_versions.sql
-- docs/187：平台系统配置增加最小可回滚历史，支撑测试阶段一步回退。

-- UP
CREATE TABLE IF NOT EXISTS system_config_versions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  before_value TEXT NOT NULL DEFAULT '',
  after_value TEXT NOT NULL DEFAULT '',
  change_type TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_system_config_versions_key_revision
  ON system_config_versions (key, revision);

CREATE INDEX IF NOT EXISTS idx_system_config_versions_created
  ON system_config_versions (created_at);

-- DOWN
DROP INDEX IF EXISTS idx_system_config_versions_created;
DROP INDEX IF EXISTS idx_system_config_versions_key_revision;
DROP TABLE IF EXISTS system_config_versions;
