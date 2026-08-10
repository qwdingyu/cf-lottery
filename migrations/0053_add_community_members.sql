-- 0053_add_community_members.sql
-- docs/180 §3.3：群绑定成员注册表，用于运行时强制 maxGroupMembers 上限，跨活动累计去重。
-- 注意：表名 community_members 而非 platform_members，避免与现有平台运营者表冲突。

-- UP
CREATE TABLE community_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform_target_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_community_members_target_user ON community_members (platform_target_id, user_id);
CREATE INDEX idx_community_members_tenant ON community_members (tenant_id);

-- DOWN
DROP TABLE IF EXISTS community_members;