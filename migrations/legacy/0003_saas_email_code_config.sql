-- UP
-- 邮箱验证码表
CREATE TABLE email_access_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_code_draw ON email_access_codes(email, draw_id, used);

-- 系统配置表（key-value 存储）
CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 公平性验证：存储原始随机种子
ALTER TABLE lottery_draws ADD COLUMN draw_seed TEXT NOT NULL DEFAULT '';

-- DOWN
ALTER TABLE lottery_draws DROP COLUMN draw_seed;
DROP TABLE IF EXISTS system_config;
DROP TABLE IF EXISTS email_access_codes;