-- 0029_admin_audit_logs.sql
-- P1-13：cf-core 管理员审计日志表 — 统一审计入口（替代 project 级 platform_audit_logs）
-- writeAdminAudit 写入此表，管理端审计列表从此表查询。
-- （5% 概率自动清理 90 天前旧数据，由 cf-core writeAdminAudit 内部触发）

-- UP
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_type TEXT DEFAULT '' NOT NULL,
  target_id TEXT DEFAULT '' NOT NULL,
  metadata_json TEXT DEFAULT '{}' NOT NULL,
  ip_hash TEXT DEFAULT '' NOT NULL,
  created_at TEXT DEFAULT '' NOT NULL,
  tenant_id TEXT,
  actor_user_id TEXT
);

-- 历史数据迁移：旧表 platform_audit_logs 的数据（actorRole 合并到 metadata_json）
-- INSERT OR IGNORE 确保幂等（id 相同则跳过，重复跑不会重复插入）
INSERT OR IGNORE INTO admin_audit_logs (
  id, action, target_type, target_id, metadata_json, ip_hash, created_at, tenant_id, actor_user_id
)
SELECT
  p.id, p.action, p.target_type, p.target_id,
  CASE
    WHEN p.metadata_json = '{}' OR p.metadata_json = '' THEN json_object('actorRole', p.actor_role)
    ELSE json_patch(p.metadata_json, json_object('actorRole', p.actor_role))
  END,
  '', p.created_at, p.tenant_id, p.actor_user_id
FROM platform_audit_logs p;

-- DOWN
DROP TABLE IF EXISTS admin_audit_logs;