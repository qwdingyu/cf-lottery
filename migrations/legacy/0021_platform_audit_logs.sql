-- 平台审计日志（L3 平台运营写操作）
--
-- 不能使用 tenant_id='__platform__' 污染租户审计表。
-- 平台系统配置、额度码、租户状态、平台成员等写操作统一落到本表。
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  tenant_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created
  ON platform_audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant
  ON platform_audit_logs(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_action
  ON platform_audit_logs(action, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_actor
  ON platform_audit_logs(actor_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_audit_target
  ON platform_audit_logs(target_type, target_id, created_at);
