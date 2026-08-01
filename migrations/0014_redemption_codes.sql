-- 兑换码（运营者生成，终端用户兑换获取活动额度）
CREATE TABLE IF NOT EXISTS redemption_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'custom',
  activity_quota INTEGER NOT NULL DEFAULT 0,
  participant_quota INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemption_code_status ON redemption_codes(status, expires_at, created_at);

-- 兑换记录表
CREATE TABLE IF NOT EXISTS redemption_records (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL,
  code TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_name TEXT NOT NULL DEFAULT '',
  activity_quota_granted INTEGER NOT NULL DEFAULT 0,
  participant_quota_granted INTEGER NOT NULL DEFAULT 0,
  duration_days_granted INTEGER NOT NULL DEFAULT 30,
  expires_at TEXT,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemption_record_tenant ON redemption_records(tenant_id, redeemed_at);
CREATE INDEX IF NOT EXISTS idx_redemption_record_code ON redemption_records(code_id, redeemed_at);

-- 租户表扩展额外额度字段
ALTER TABLE tenants ADD COLUMN extra_activity_quota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN extra_participant_quota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN extra_quota_expires_at TEXT;