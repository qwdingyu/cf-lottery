-- 平台成员表（L3 平台运营者）
-- 026 基线要求平台身份与租户身份彻底分离：
-- users 只表示登录身份，tenant_members 只表示租户内角色，
-- platform_members 只表示平台运营角色，禁止使用 tenant_id = NULL 或 __platform__ 特殊租户。
CREATE TABLE IF NOT EXISTS platform_members (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_members_status
  ON platform_members(status, role);
