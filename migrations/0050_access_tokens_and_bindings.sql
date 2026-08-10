-- 0050_access_tokens_and_bindings.sql
-- 临时访问令牌 + 跨平台身份绑定（docs/179）
-- 访问令牌：用于 Bot 生成一次性 Web 链接，用户无需登录即可查看卡密
-- 平台绑定：用于同一用户关联 QQ 和 Telegram 身份

-- UP
CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'card_code',
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_access_tokens_user ON access_tokens (user_id, purpose);

CREATE TABLE IF NOT EXISTS platform_bindings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_provider_user_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_bindings_code ON platform_bindings (code);

-- DOWN
DROP INDEX IF EXISTS idx_access_tokens_hash;
DROP INDEX IF EXISTS idx_access_tokens_user;
DROP TABLE IF EXISTS access_tokens;
DROP INDEX IF EXISTS idx_platform_bindings_code;
DROP TABLE IF EXISTS platform_bindings;