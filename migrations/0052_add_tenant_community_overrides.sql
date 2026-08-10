-- 0052_add_tenant_community_overrides.sql
-- docs/180：社群功能套餐绑定与租户覆写
-- 新增 tenant_community_overrides 表：1:1 关联 tenants，存在即覆盖套餐社群默认值。
-- 由平台运营者（L3）通过 PATCH /api/platform/tenants/:id/community 维护。

-- UP
CREATE TABLE tenant_community_overrides (
  tenant_id TEXT PRIMARY KEY,
  community_enabled INTEGER NOT NULL DEFAULT 1,
  max_platform_targets INTEGER,
  max_group_members INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DOWN
DROP TABLE IF EXISTS tenant_community_overrides;